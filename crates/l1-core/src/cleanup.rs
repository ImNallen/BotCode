//! Blocking Git work for automatic worktree cleanup and restore. The actor
//! decides which threads qualify; this module decides whether the checkout on
//! disk is safe to remove and performs the removal.
use crate::{
    domain::*,
    repo::{default_branch, git},
    settings::StoragePolicy,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

const DAY_MS: u64 = 86_400_000;
/// A check that fails with the reason the sweep logs.
type Checked<T> = std::result::Result<T, String>;

/// A worktree thread the actor found idle and sole owner of its path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub thread: ThreadId,
    pub workspace: WorkspaceId,
    pub workspace_root: PathBuf,
    pub path: PathBuf,
    pub branch: String,
    pub activity: Option<u64>,
    pub linked_pr_merged: bool,
}
pub(crate) struct Eligible {
    pub candidate: Candidate,
    pub head: String,
    pub default_ref: Option<String>,
}
pub(crate) struct Sweep<'a> {
    pub worktrees: &'a Path,
    pub roots: &'a [PathBuf],
    pub policy: StoragePolicy,
    pub now: u64,
}
impl Sweep<'_> {
    /// Safety checks and rule evaluation for every candidate. Default-branch
    /// refs are resolved (and fetched) once per workspace root.
    pub fn evaluate(&self, candidates: Vec<Candidate>) -> Vec<Eligible> {
        let mut defaults: HashMap<PathBuf, Option<String>> = HashMap::new();
        let mut eligible = vec![];
        for candidate in candidates {
            let head = match self.inspect(&candidate) {
                Ok(head) => head,
                Err(reason) => {
                    skip(&candidate, &reason);
                    continue;
                }
            };
            let rules = self.policy.rules(&candidate.workspace);
            let default_ref = if rules.worktree_unchanged || rules.worktree_on_merge {
                defaults
                    .entry(candidate.workspace_root.clone())
                    .or_insert_with(|| match default_ref(&candidate.workspace_root) {
                        Ok(default) => Some(default),
                        Err(reason) => {
                            skip(&candidate, &reason);
                            None
                        }
                    })
                    .clone()
            } else {
                None
            };
            match self.eligible(&candidate, &head, default_ref.as_deref()) {
                Ok(true) => eligible.push(Eligible {
                    candidate,
                    head,
                    default_ref,
                }),
                Ok(false) => {}
                Err(reason) => skip(&candidate, &reason),
            }
        }
        eligible
    }
    /// Confirms the claim still holds under the current rules and removes the worktree.
    pub fn remove(&self, eligible: &Eligible) -> Checked<()> {
        let candidate = &eligible.candidate;
        if self.inspect(candidate)? != eligible.head {
            return Err("HEAD moved since the sweep began".into());
        }
        if !self.eligible(candidate, &eligible.head, eligible.default_ref.as_deref())? {
            return Err("no longer eligible under the current rules".into());
        }
        let path = candidate.path.to_string_lossy();
        match git(&candidate.workspace_root, &["worktree", "remove", &path]) {
            Ok(_) => Ok(()),
            Err(_) if !candidate.path.exists() => {
                git(&candidate.workspace_root, &["worktree", "prune"])
                    .map(drop)
                    .map_err(|e| e.message.trim().to_owned())
            }
            Err(e) => Err(e.message.trim().to_owned()),
        }
    }
    pub fn remove_deleted(&self, candidate: &Candidate) -> Checked<()> {
        if !candidate.path.exists() {
            return Ok(());
        }
        self.inspect(candidate)?;
        git(
            &candidate.workspace_root,
            &["worktree", "remove", &candidate.path.to_string_lossy()],
        )
        .map(drop)
        .map_err(|e| e.message.trim().to_owned())
    }
    fn eligible(
        &self,
        candidate: &Candidate,
        head: &str,
        default_ref: Option<&str>,
    ) -> Checked<bool> {
        let rules = self.policy.rules(&candidate.workspace);
        let inactive = match (rules.worktree_after_days, candidate.activity) {
            (Some(days), Some(activity)) => activity < self.now.saturating_sub(days * DAY_MS),
            _ => false,
        };
        if inactive {
            return Ok(true);
        }
        if !(rules.worktree_unchanged || (rules.worktree_on_merge && candidate.linked_pr_merged)) {
            return Ok(false);
        }
        let Some(default_ref) = default_ref else {
            return Ok(false);
        };
        let status = crate::process::command("git")
            .arg("-C")
            .arg(&candidate.path)
            .args(["merge-base", "--is-ancestor", head, default_ref])
            .output()
            .map_err(|e| e.to_string())?;
        match status.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(format!(
                "merge-base failed: {}",
                String::from_utf8_lossy(&status.stderr).trim()
            )),
        }
    }
    /// Returns the HEAD oid when the checkout is a clean linked worktree on the
    /// thread's branch, strictly inside the worktrees directory, containing no
    /// workspace root and no ignored files beyond `node_modules/`.
    fn inspect(&self, candidate: &Candidate) -> Checked<String> {
        let path = &candidate.path;
        let worktrees =
            dunce::canonicalize(self.worktrees).map_err(|e| format!("worktrees directory: {e}"))?;
        let canonical = dunce::canonicalize(path).map_err(|e| e.to_string())?;
        if !canonical.starts_with(&worktrees) || canonical == worktrees {
            return Err("path is outside the worktrees directory".into());
        }
        let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() || &canonical != path {
            return Err("path is a symlink or not canonical".into());
        }
        for root in self.roots {
            let real = dunce::canonicalize(root).unwrap_or_else(|_| root.clone());
            if root.starts_with(path) || real.starts_with(path) {
                return Err("a workspace root is inside this worktree".into());
            }
        }
        let git_file = std::fs::symlink_metadata(path.join(".git")).map_err(|e| e.to_string())?;
        if !git_file.file_type().is_file() {
            return Err(".git is not a file".into());
        }
        let status = git(path, &["status", "--porcelain=2", "--branch"])
            .map_err(|e| e.message.trim().to_owned())?;
        let (mut head, mut branch) = (None, None);
        for line in String::from_utf8_lossy(&status).lines() {
            if let Some(oid) = line.strip_prefix("# branch.oid ") {
                head = Some(oid.to_owned());
            } else if let Some(name) = line.strip_prefix("# branch.head ") {
                branch = Some(name.to_owned());
            } else if !line.starts_with('#') {
                return Err("working tree has changes".into());
            }
        }
        if branch.as_deref() != Some(candidate.branch.as_str()) {
            return Err(format!(
                "checked out {} instead of {}",
                branch.unwrap_or_default(),
                candidate.branch
            ));
        }
        let head = head.ok_or("no HEAD commit")?;
        let ignored = git(
            path,
            &[
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "--directory",
                "-z",
            ],
        )
        .map_err(|e| e.message.trim().to_owned())?;
        // Ignored files can hold secrets or local data. Dependency installs are reproducible.
        let reproducible = |entry: &str| {
            entry
                .strip_suffix("node_modules/")
                .is_some_and(|prefix| prefix.is_empty() || prefix.ends_with('/'))
        };
        if String::from_utf8_lossy(&ignored)
            .split('\0')
            .any(|entry| !entry.is_empty() && !reproducible(entry))
        {
            return Err("worktree has ignored files".into());
        }
        Ok(head)
    }
}
fn skip(candidate: &Candidate, reason: &str) {
    eprintln!(
        "l1-code storage cleanup: skipped {} ({reason})",
        candidate.path.display()
    );
}

// Ports T3 Code v0.0.45 apps/web/src/hooks/useThreadActions.ts explicit force removal (MIT).
pub(crate) fn remove_explicit(candidate: &Candidate, roots: &[PathBuf]) -> Checked<()> {
    let path = &candidate.path;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return git(&candidate.workspace_root, &["worktree", "prune"])
                .map(drop)
                .map_err(|error| error.message.trim().to_owned());
        }
        Err(error) => return Err(error.to_string()),
    };
    let canonical = dunce::canonicalize(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || &canonical != path {
        return Err("path is a symlink or not canonical".into());
    }
    if roots.iter().any(|root| {
        let real = dunce::canonicalize(root).unwrap_or_else(|_| root.clone());
        root.starts_with(path) || real.starts_with(path)
    }) {
        return Err("a workspace root is inside this worktree".into());
    }
    let git_file =
        std::fs::symlink_metadata(path.join(".git")).map_err(|error| error.to_string())?;
    if !git_file.file_type().is_file() {
        return Err(".git is not a file".into());
    }
    crate::repo::registered_worktree(&candidate.workspace_root, path)
        .map_err(|error| error.message)?;
    git(
        &candidate.workspace_root,
        &["worktree", "remove", "--force", &path.to_string_lossy()],
    )
    .map(drop)
    .map_err(|error| error.message.trim().to_owned())
}
/// `refs/remotes/origin/<default>` after a fetch when the repository has an
/// origin remote, else the local `refs/heads/<default>`.
fn default_ref(root: &Path) -> Checked<String> {
    let default = default_branch(root).ok_or("no default branch")?;
    if git(root, &["remote", "get-url", "origin"]).is_err() {
        return Ok(format!("refs/heads/{default}"));
    }
    let refspec = format!("+refs/heads/{default}:refs/remotes/origin/{default}");
    let fetch = crate::process::command("git")
        .arg("-C")
        .arg(root)
        .args(["fetch", "--quiet", "--no-tags", "origin", &refspec])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if !fetch.status.success() {
        return Err(format!(
            "fetch failed: {}",
            String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }
    Ok(format!("refs/remotes/origin/{default}"))
}
/// Where preview screenshots save, relative to the data directory.
pub const PREVIEW_SCREENSHOTS: [&str; 2] = ["preview", "screenshots"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Retained {
    BrowserArtifacts,
    RotatedLogs,
}
impl Retained {
    fn root(self, data_dir: &Path) -> PathBuf {
        match self {
            Self::BrowserArtifacts => {
                data_dir.join(PREVIEW_SCREENSHOTS.iter().collect::<PathBuf>())
            }
            Self::RotatedLogs => data_dir.join("logs"),
        }
    }
    fn days(self, policy: &StoragePolicy) -> Option<u64> {
        match self {
            Self::BrowserArtifacts => policy.browser_artifacts_after_days,
            Self::RotatedLogs => policy.logs_after_days,
        }
    }
    fn covers(self, name: &str) -> bool {
        match self {
            Self::BrowserArtifacts => true,
            Self::RotatedLogs => name.rsplit_once('.').is_some_and(|(stem, index)| {
                !index.is_empty()
                    && index.bytes().all(|b| b.is_ascii_digit())
                    && (stem.ends_with(".log") || stem.ends_with(".ndjson"))
            }),
        }
    }
}

// Ports T3 Code v0.0.45 apps/server/src/storageCleanup.ts cleanFiles (MIT).
pub(crate) fn clean_files(
    data_dir: &Path,
    kind: Retained,
    policy: &StoragePolicy,
    now: u64,
    reread_policy: &dyn Fn() -> StoragePolicy,
) {
    let Some(days) = kind.days(policy) else {
        return;
    };
    let Ok(data_dir) = dunce::canonicalize(data_dir) else {
        return;
    };
    let root = kind.root(&data_dir);
    if dunce::canonicalize(&root).ok().as_ref() != Some(&root) {
        return;
    }
    let cutoff = now.saturating_sub(days * DAY_MS);
    let mut pending = vec![root];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.is_dir() {
                if kind == Retained::RotatedLogs {
                    pending.push(path);
                }
                continue;
            }
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|age| age.as_millis() as u64);
            if !metadata.is_file()
                || !kind.covers(&entry.file_name().to_string_lossy())
                || modified.is_none_or(|modified| modified >= cutoff)
            {
                continue;
            }
            if kind.days(&reread_policy()) != Some(days) {
                return;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => eprintln!("l1-code storage cleanup: deleted {}", path.display()),
                Err(e) => eprintln!("l1-code storage cleanup: kept {} ({e})", path.display()),
            }
        }
    }
}
/// Recreates a removed worktree on its branch. Succeeds when the path already
/// holds that branch's worktree.
pub(crate) fn restore(root: &Path, path: &Path, branch: &str) -> Result<()> {
    let _ = git(root, &["worktree", "prune"]);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let added = git(root, &["worktree", "add", &path.to_string_lossy(), branch]);
    let current = || {
        git(path, &["branch", "--show-current"])
            .ok()
            .map(|out| String::from_utf8_lossy(&out).trim().to_owned())
    };
    match added {
        Ok(_) => Ok(()),
        Err(_) if path.exists() && current().as_deref() == Some(branch) => Ok(()),
        Err(e) => Err(AppError::new(
            "worktree_restore",
            format!(
                "Couldn't restore this thread's worktree: {}",
                e.message.trim()
            ),
        )),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    // `git worktree remove` also refuses untracked files, which hides this check from end-to-end tests.
    #[test]
    fn untracked_files_fail_inspection() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let repository = root.join("repository");
        let worktrees = root.join("worktrees");
        std::fs::create_dir_all(&repository).unwrap();
        git(&repository, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(repository.join("README.md"), "fixture\n").unwrap();
        git(&repository, &["add", "."]).unwrap();
        git(
            &repository,
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@e.invalid",
                "commit",
                "-qm",
                "initial",
            ],
        )
        .unwrap();
        let path = worktrees.join("l1code-test");
        git(
            &repository,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "l1code/test",
                &path.to_string_lossy(),
            ],
        )
        .unwrap();
        let candidate = Candidate {
            thread: ThreadId::default(),
            workspace: WorkspaceId::default(),
            workspace_root: repository.clone(),
            path: path.clone(),
            branch: "l1code/test".into(),
            activity: Some(0),
            linked_pr_merged: false,
        };
        let sweep = Sweep {
            worktrees: &worktrees,
            roots: &[repository],
            policy: StoragePolicy::default(),
            now: 0,
        };
        assert!(sweep.inspect(&candidate).is_ok(), "a clean worktree passes");
        std::fs::write(path.join("notes.txt"), "draft\n").unwrap();
        assert_eq!(
            sweep.inspect(&candidate),
            Err("working tree has changes".into())
        );
    }
}
