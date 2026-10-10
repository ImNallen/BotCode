mod worktrees;
use crate::{domain::*, process, vcs, workspace_files};
use std::{
    path::{Component, Path, PathBuf},
    process::Command,
};
pub(crate) use worktrees::{registered_worktree, registered_worktrees};
pub(crate) const TEXT_LIMIT: usize = 1_000_000;
fn command(root: &Path) -> Command {
    let mut command = process::command("git");
    command.arg("-C").arg(root).envs(vcs::NON_INTERACTIVE);
    command
}
pub(crate) fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = command(root).args(args).output()?;
    if !out.status.success() {
        return Err(AppError::new("git", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(out.stdout)
}
pub fn open(path: &Path) -> Result<PathBuf> {
    let path = dunce::canonicalize(path)?;
    let bytes = git(&path, &["rev-parse", "--show-toplevel"])?;
    let root = dunce::canonicalize(String::from_utf8_lossy(&bytes).trim())?;
    Ok(root)
}
pub fn inside_work_tree(path: &Path) -> bool {
    git(path, &["rev-parse", "--is-inside-work-tree"]).is_ok_and(|out| out.trim_ascii() == b"true")
}
pub fn add_folder(scratch: &Path, prompt: &str) -> Result<Checkout> {
    std::fs::create_dir_all(scratch)?;
    let mut words = prompt
        .to_lowercase()
        .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|word| !word.is_empty())
        .take(5)
        .collect::<Vec<_>>()
        .join("-");
    words.truncate(48);
    let words = words.trim_end_matches('-');
    let date = utc_date(now_ms() / 1000);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let folder = |id: &str| {
        let name = [date.as_str(), words, id]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        scratch.join(name)
    };
    // A non-recursive create claims the name, so a taken short id falls back to the full one.
    let short = folder(&id[..8]);
    let path = match std::fs::create_dir(&short) {
        Ok(()) => short,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let full = folder(&id);
            std::fs::create_dir(&full)?;
            full
        }
        Err(e) => return Err(e.into()),
    };
    Ok(Checkout::Folder { path })
}
fn utc_date(seconds: u64) -> String {
    let z = (seconds / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}
pub fn add_worktree(
    root: &Path,
    worktrees: &Path,
    base: &str,
    from_origin: bool,
) -> Result<Checkout> {
    git(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).map_err(|_| {
        AppError::new(
            "worktree_unavailable",
            "Commit to this repository before starting a worktree.",
        )
    })?;
    branch_name(root, base)?;
    let origin = from_origin && git(root, &["remote", "get-url", "origin"]).is_ok();
    let start = if origin {
        let refspec = format!("+refs/heads/{base}:refs/remotes/origin/{base}");
        match git(root, &["fetch", "--quiet", "--no-tags", "origin", &refspec]) {
            Err(e) if e.message.contains("couldn't find remote ref") => None,
            fetched => {
                fetched?;
                let tracking = format!("refs/remotes/origin/{base}^{{commit}}");
                git(root, &["rev-parse", "--verify", "--quiet", &tracking])
                    .ok()
                    .map(|sha| String::from_utf8_lossy(&sha).trim().to_owned())
            }
        }
    } else {
        None
    };
    let id = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let branch = format!("botcode/{id}");
    let path = worktrees.join(format!("botcode-{id}"));
    std::fs::create_dir_all(worktrees)?;
    git(
        root,
        &[
            "worktree",
            "add",
            "--no-track",
            "-b",
            &branch,
            &path.to_string_lossy(),
            start.as_deref().unwrap_or(base),
        ],
    )?;
    git(root, &["config", &merge_base_key(&branch), base])?;
    Ok(Checkout::Worktree {
        path: dunce::canonicalize(path)?,
        branch,
    })
}
pub fn switch_branch(root: &Path, name: &str, create: bool) -> Result<String> {
    branch_name(root, name)?;
    let exists = |prefix: &str| {
        git(
            root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("{prefix}{name}"),
            ],
        )
        .is_ok()
    };
    if create {
        git(root, &["switch", "-c", name])?;
    } else if exists("refs/heads/") {
        git(root, &["switch", name])?;
    } else if exists("refs/remotes/") {
        git(root, &["switch", "--track", name])?;
    } else {
        return Err(AppError::new(
            "missing_branch",
            format!("\"{name}\" was not found."),
        ));
    }
    let current = git(root, &["branch", "--show-current"])?;
    Ok(String::from_utf8_lossy(&current).trim().to_owned())
}
pub(crate) fn merge_base_key(branch: &str) -> String {
    format!("branch.{branch}.gh-merge-base")
}
pub(crate) fn branch_name(root: &Path, name: &str) -> Result<()> {
    git(root, &["check-ref-format", "--branch", name])
        .map(drop)
        .map_err(|_| {
            AppError::new(
                "invalid_branch",
                format!("\"{name}\" is not a valid branch name."),
            )
        })
}
pub fn branches(root: &Path) -> Result<Branches> {
    let refs = git(
        root,
        &[
            "for-each-ref",
            "--sort=refname",
            "--sort=-committerdate",
            "--format=%(refname)%00%(HEAD)%00%(worktreepath)%00%(symref)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let default = default_branch(root);
    let (mut local, mut remote) = (Vec::new(), Vec::new());
    for line in String::from_utf8_lossy(&refs).lines() {
        let [refname, head, worktree, symref] = line.split('\0').collect::<Vec<_>>()[..] else {
            continue;
        };
        if !symref.is_empty() {
            continue;
        }
        let branch = |name: &str, remote| Branch {
            name: name.into(),
            remote,
            current: head == "*",
            default: false,
            worktree: (!worktree.is_empty())
                .then(|| dunce::canonicalize(worktree).unwrap_or(worktree.into())),
        };
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            local.push(branch(name, false));
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            remote.push(branch(name, true));
        }
    }
    let origin = remote.iter().any(|b| b.name.starts_with("origin/"));
    remote.retain(|b| {
        b.name
            .strip_prefix("origin/")
            .is_none_or(|name| !local.iter().any(|l| l.name == name))
    });
    let mut branches: Vec<_> = local.into_iter().chain(remote).collect();
    if let Some(default) = default {
        for b in &mut branches {
            let name = if b.remote {
                b.name.strip_prefix("origin/")
            } else {
                Some(b.name.as_str())
            };
            b.default = name == Some(default.as_str());
        }
    }
    branches.sort_by_key(|b| {
        if b.current {
            0
        } else if b.default {
            1
        } else {
            2
        }
    });
    Ok(Branches { branches, origin })
}
/// The branch origin/HEAD points at, else a local `main` or `master`.
pub(crate) fn default_branch(root: &Path) -> Option<String> {
    git(
        root,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .and_then(|target| {
        String::from_utf8_lossy(&target)
            .trim()
            .strip_prefix("refs/remotes/origin/")
            .map(str::to_owned)
    })
    .or_else(|| {
        ["main", "master"].into_iter().find_map(|name| {
            let spec = format!("refs/heads/{name}");
            git(root, &["show-ref", "--verify", "--quiet", &spec])
                .is_ok()
                .then(|| name.to_owned())
        })
    })
}
fn relative(path: &str) -> Result<&Path> {
    let p = Path::new(path);
    if path
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
        || p.components().any(|c| c.as_os_str() == ".git")
    {
        return Err(AppError::new(
            "invalid_path",
            "Choose a file inside the repository.",
        ));
    }
    Ok(p)
}
pub(crate) fn existing(path: &Path) -> Result<PathBuf> {
    dunce::canonicalize(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            AppError::new("invalid_path", "This file no longer exists.")
        }
        _ => e.into(),
    })
}
pub(crate) fn contained(root: &Path, path: &str) -> Result<PathBuf> {
    let p = root.join(relative(path)?);
    let canonical = existing(&p)?;
    let Ok(inner) = canonical.strip_prefix(dunce::canonicalize(root)?) else {
        return Err(AppError::new(
            "invalid_path",
            "This symlink points outside the repository.",
        ));
    };
    // Case-insensitive volumes and Windows aliases such as `.GIT` or `GIT~1` resolve to `.git`.
    if inner
        .components()
        .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
    {
        return Err(AppError::new(
            "invalid_path",
            "Choose a file inside the repository.",
        ));
    }
    Ok(canonical)
}
fn text(bytes: Vec<u8>) -> Result<String> {
    if bytes.len() > TEXT_LIMIT {
        return Err(AppError::new(
            "file_unavailable",
            "This file exceeds the 1 MB text limit.",
        ));
    }
    if bytes.contains(&0) {
        return Err(AppError::new(
            "file_unavailable",
            "Binary files cannot be displayed as text.",
        ));
    }
    String::from_utf8(bytes)
        .map_err(|_| AppError::new("file_unavailable", "This file is not UTF-8 text."))
}
fn read_text(file: &Path) -> Result<String> {
    if std::fs::metadata(file)?.len() > TEXT_LIMIT as u64 {
        return Err(AppError::new(
            "file_unavailable",
            "This file exceeds the 1 MB text limit.",
        ));
    }
    text(std::fs::read(file)?)
}
pub fn read_file(root: &Path, path: &str) -> Result<FileView> {
    let name = path.to_owned();
    let file = contained(root, path)?;
    let meta = std::fs::metadata(&file)?;
    if meta.is_file() && workspace_files::is_media(path) {
        return Ok(FileView::Media {
            name,
            revision: workspace_files::revision(&meta),
        });
    }
    match read_text(&file) {
        Ok(contents) => Ok(FileView::Text { name, contents }),
        Err(e) if e.code == "file_unavailable" => Ok(FileView::Unavailable { reason: e.message }),
        Err(e) => Err(e),
    }
}
fn writable(root: &Path, path: &str) -> Result<PathBuf> {
    let inside = || AppError::new("invalid_path", "Choose a file inside the repository.");
    let root = dunce::canonicalize(root)?;
    let mut existing = root.join(relative(path)?);
    let mut missing = Vec::new();
    while existing.symlink_metadata().is_err() {
        missing.push(existing.file_name().ok_or_else(inside)?.to_owned());
        existing.pop();
    }
    let real_existing = dunce::canonicalize(existing).map_err(|_| inside())?;
    let mut inner = real_existing
        .strip_prefix(&root)
        .map_err(|_| {
            AppError::new(
                "invalid_path",
                "This symlink points outside the repository.",
            )
        })?
        .to_path_buf();
    if !missing.is_empty() && !real_existing.is_dir() {
        return Err(inside());
    }
    inner.extend(missing.iter().rev());
    if inner
        .components()
        .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
    {
        return Err(inside());
    }
    let real = root.join(inner);
    match std::fs::metadata(&real) {
        Ok(meta) if !meta.is_file() => Err(inside()),
        _ => Ok(real),
    }
}
pub fn write_file(root: &Path, path: &str, contents: &str) -> Result<()> {
    if contents.len() > TEXT_LIMIT {
        return Err(AppError::new(
            "file_unavailable",
            "This file exceeds the 1 MB text limit.",
        ));
    }
    let real = writable(root, path)?;
    if let Some(parent) = real.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(real, contents)?;
    Ok(())
}
pub fn inspect(workspace: Workspace, threads: Vec<ThreadSummary>) -> Result<WorkspaceView> {
    let root = &workspace.root;
    let bytes = git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut parts = bytes.split(|b| *b == 0).filter(|p| !p.is_empty());
    let mut changes = Vec::new();
    while let Some(record) = parts.next() {
        if record.len() < 4 {
            continue;
        }
        let x = record[0] as char;
        let y = record[1] as char;
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let original_path = if x == 'R' || x == 'C' {
            parts
                .next()
                .map(|p| String::from_utf8_lossy(p).into_owned())
        } else {
            None
        };
        changes.push(GitChange {
            path,
            original_path,
            staged: x != ' ' && x != '?',
            unstaged: y != ' ' || x == '?',
            status: format!("{x}{y}"),
        });
    }
    let branch = git(root, &["branch", "--show-current"])
        .map(|v| String::from_utf8_lossy(&v).trim().to_string())
        .unwrap_or_default();
    Ok(WorkspaceView {
        file_coverage: crate::SearchCoverage::Complete,
        workspace,
        branch,
        files: vec![],
        changes,
        threads,
        unavailable: None,
    })
}
pub fn inspect_folder(workspace: Workspace, threads: Vec<ThreadSummary>) -> Result<WorkspaceView> {
    Ok(WorkspaceView {
        file_coverage: crate::SearchCoverage::Complete,
        workspace,
        branch: String::new(),
        files: vec![],
        changes: vec![],
        threads,
        unavailable: None,
    })
}
fn version(root: &Path, spec: &str) -> Result<String> {
    let size = command(root).args(["cat-file", "-s", spec]).output()?;
    if !size.status.success() {
        let message = String::from_utf8_lossy(&size.stderr);
        if message.contains("does not exist")
            || message.contains("not in the index")
            || message.contains("invalid object name 'HEAD'")
            || message.contains("exists on disk, but not in")
        {
            return Ok(String::new());
        }
        return Err(AppError::new("git", message));
    }
    let length = String::from_utf8_lossy(&size.stdout)
        .trim()
        .parse::<usize>()
        .map_err(|e| AppError::new("git", e))?;
    if length > TEXT_LIMIT {
        return Err(AppError::new(
            "file_unavailable",
            "This Git blob exceeds the 1 MB text limit.",
        ));
    }
    text(git(root, &["show", spec])?)
}
pub fn diff(root: &Path, path: &str, basis: DiffBasis) -> Result<DiffView> {
    relative(path)?;
    let view = inspect(
        Workspace {
            id: WorkspaceId::default(),
            root: root.into(),
            label: String::new(),
            kind: WorkspaceKind::Repository,
            favicon_path: None,
            project_icon: None,
        },
        vec![],
    )?;
    let original = view
        .changes
        .iter()
        .find(|c| c.path == path)
        .and_then(|c| c.original_path.as_deref())
        .unwrap_or(path);
    let result = (|| -> Result<DiffView> {
        let (old, new) = match basis {
            DiffBasis::Staged => (
                version(root, &format!("HEAD:{original}"))?,
                version(root, &format!(":{path}"))?,
            ),
            DiffBasis::Unstaged => {
                let old = version(root, &format!(":{path}"))?;
                let new = if root.join(path).exists() {
                    read_text(&contained(root, path)?)?
                } else {
                    String::new()
                };
                (old, new)
            }
        };
        Ok(DiffView::Text {
            old_name: original.into(),
            old_contents: old,
            new_name: path.into(),
            new_contents: new,
        })
    })();
    match result {
        Err(e) if e.code == "file_unavailable" => Ok(DiffView::Unavailable { reason: e.message }),
        other => other,
    }
}
