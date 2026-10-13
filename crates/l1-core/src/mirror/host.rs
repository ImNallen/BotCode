use super::{Head, HostHead, SyncPoint};
use crate::domain::{AppError, Result, SandboxId};
use crate::{process, vcs};
use std::{
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Output, Stdio},
    time::{Duration, Instant},
};

const LOCAL: Duration = Duration::from_secs(120);
const TRANSFER: Duration = Duration::from_secs(300);
const BUNDLE: Duration = Duration::from_secs(600);
const CONTAINER_OUTGOING: &str = super::CONTAINER_OUTGOING;
const CONTAINER_INCOMING: &str = super::CONTAINER_INCOMING;
const SYNC_IDENTITY: [(&str, &str); 6] = [
    ("GIT_AUTHOR_NAME", "L1 Code"),
    ("GIT_AUTHOR_EMAIL", "l1code@users.noreply.github.com"),
    ("GIT_AUTHOR_DATE", "1970-01-01T00:00:00Z"),
    ("GIT_COMMITTER_NAME", "L1 Code"),
    ("GIT_COMMITTER_EMAIL", "l1code@users.noreply.github.com"),
    ("GIT_COMMITTER_DATE", "1970-01-01T00:00:00Z"),
];
const OUTPUT_LIMIT: usize = 64 * 1024 * 1024;

fn host_ref(id: &SandboxId, name: &str) -> String {
    format!("refs/l1code/sandbox/{id}/{name}")
}

struct Git<'a> {
    root: &'a Path,
    index: Option<&'a Path>,
}
impl Git<'_> {
    fn run(&self, args: &[&str], input: &[u8], limit: Duration) -> Result<Output> {
        let mut command = process::grouped("git");
        command
            .arg("-C")
            .arg(self.root)
            .args(["-c", "core.fsmonitor=false", "-c", "core.splitIndex=false"])
            .args(args)
            .envs(vcs::NON_INTERACTIVE)
            .envs(SYNC_IDENTITY)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .stdin(if input.is_empty() {
                Stdio::null()
            } else {
                Stdio::piped()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match self.index {
            Some(index) => command.env("GIT_INDEX_FILE", index),
            None => command.env_remove("GIT_INDEX_FILE"),
        };
        let mut child = command.spawn()?;
        let pid = child.id();
        let feed = child.stdin.take().map(|mut pipe| {
            let input = input.to_vec();
            std::thread::spawn(move || pipe.write_all(&input))
        });
        let stdout = reader(child.stdout.take());
        let stderr = reader(child.stderr.take());
        let deadline = Instant::now() + limit;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if Instant::now() >= deadline {
                process::kill_tree(pid, process::Kill::Force);
                let _ = child.wait();
                return Err(AppError::new(
                    "mirror_timeout",
                    format!("git {} did not finish in time.", args.join(" ")),
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        if let Some(feed) = feed {
            let _ = feed.join();
        }
        let joined = |handle: std::thread::JoinHandle<std::io::Result<Vec<u8>>>| {
            handle
                .join()
                .map_err(|_| AppError::new("mirror", "git output reader failed."))?
                .map_err(AppError::from)
        };
        Ok(Output {
            status,
            stdout: joined(stdout)?,
            stderr: joined(stderr)?,
        })
    }
    fn ok(&self, args: &[&str], input: &[u8], limit: Duration) -> Result<Vec<u8>> {
        let output = self.run(args, input, limit)?;
        if !output.status.success() {
            return Err(AppError::new(
                "mirror",
                format!(
                    "git {}: {}",
                    args.join(" "),
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            ));
        }
        Ok(output.stdout)
    }
    fn out(&self, args: &[&str]) -> Result<Vec<u8>> {
        self.ok(args, &[], LOCAL)
    }
    fn text(&self, args: &[&str]) -> Result<String> {
        Ok(utf8(self.out(args)?)?.trim().to_owned())
    }
    fn git_path(&self, name: &str) -> Result<PathBuf> {
        Ok(self
            .text(&["rev-parse", "--path-format=absolute", "--git-path", name])?
            .into())
    }
    fn resolve(&self, reference: &str) -> Result<Option<String>> {
        let output = self.run(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{reference}^{{commit}}"),
            ],
            &[],
            LOCAL,
        )?;
        if output.status.success() {
            return Ok(Some(utf8(output.stdout)?.trim().to_owned()));
        }
        if output.status.code() == Some(1) {
            return Ok(None);
        }
        Err(AppError::new(
            "mirror",
            String::from_utf8_lossy(&output.stderr).trim(),
        ))
    }
    fn head(&self) -> Result<Head> {
        let commit = self.resolve("HEAD")?;
        let symbolic = self.run(&["symbolic-ref", "--quiet", "HEAD"], &[], LOCAL)?;
        let branch = symbolic
            .status
            .success()
            .then(|| utf8(symbolic.stdout))
            .transpose()?
            .and_then(|reference| {
                reference
                    .trim()
                    .strip_prefix("refs/heads/")
                    .map(str::to_owned)
            });
        Ok(match (branch, commit) {
            (Some(name), Some(commit)) => Head::Branch { name, commit },
            (Some(name), None) => Head::Unborn { name },
            (None, Some(commit)) => Head::Detached { commit },
            (None, None) => {
                return Err(AppError::new(
                    "mirror",
                    "The mirror has neither a branch nor a commit checked out.",
                ));
            }
        })
    }
}
fn reader(
    pipe: Option<impl Read + Send + 'static>,
) -> std::thread::JoinHandle<std::io::Result<Vec<u8>>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = pipe {
            pipe.take(OUTPUT_LIMIT as u64 + 1).read_to_end(&mut bytes)?;
        }
        if bytes.len() > OUTPUT_LIMIT {
            return Err(std::io::Error::other("git output exceeds 64 MB."));
        }
        Ok(bytes)
    })
}
fn utf8(bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes).map_err(|_| AppError::new("mirror", "git returned non-UTF-8 output."))
}
fn nul_list(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.split(|b| *b == 0).filter(|path| !path.is_empty())
}

pub(super) fn base(root: &Path, id: &SandboxId) -> Result<Option<String>> {
    Git { root, index: None }.resolve(&host_ref(id, "base"))
}
pub(super) fn outgoing(root: &Path, id: &SandboxId) -> Result<Option<String>> {
    Git { root, index: None }.resolve(&host_ref(id, "outgoing"))
}
pub(super) fn set_base(root: &Path, id: &SandboxId, commit: &str) -> Result<()> {
    let git = Git { root, index: None };
    git.out(&["update-ref", &host_ref(id, "outgoing"), commit])?;
    git.out(&["update-ref", &host_ref(id, "base"), commit])?;
    Ok(())
}

pub(super) fn capture(root: &Path, id: &SandboxId) -> Result<SyncPoint> {
    let git = Git { root, index: None };
    let real = git.git_path("index")?;
    let sync_path = git.git_path("l1code-sync-index")?;
    let sync = Git {
        root,
        index: Some(&sync_path),
    };
    if real.exists() {
        std::fs::copy(&real, &sync_path)?;
    } else {
        let _ = std::fs::remove_file(&sync_path);
        sync.out(&["read-tree", "--empty"])?;
    }
    sync.out(&["update-index", "--no-split-index"])?;
    let tracked = sync.out(&["ls-files", "-z"])?;
    if !tracked.is_empty() {
        sync.ok(
            &[
                "update-index",
                "--no-assume-unchanged",
                "--no-skip-worktree",
                "-z",
                "--stdin",
            ],
            &tracked,
            LOCAL,
        )?;
    }
    sync.out(&["add", "-u", "--", "."])?;
    let others = sync.out(&[
        "ls-files",
        "--others",
        "--exclude-per-directory=.gitignore",
        "-z",
    ])?;
    let files: Vec<u8> = nul_list(&others)
        .filter(|path| !path.ends_with(b"/"))
        .flat_map(|path| path.iter().copied().chain([0]))
        .collect();
    if !files.is_empty() {
        sync.ok(&["update-index", "--add", "-z", "--stdin"], &files, LOCAL)?;
    }
    let worktree_tree = sync.text(&["write-tree"])?;
    let index_tree = index_tree(&git, &real)?;
    let head = git.head()?;
    let listing =
        format!("040000 tree {index_tree}\tindex\n040000 tree {worktree_tree}\tworktree\n");
    let tree = utf8(git.ok(&["mktree"], listing.as_bytes(), LOCAL)?)?
        .trim()
        .to_owned();
    let message = format!("head: {}", head.spec());
    let mut args = vec!["commit-tree", &tree, "-m", "l1code-sync", "-m", &message];
    if let Some(parent) = head.commit() {
        args.extend(["-p", parent]);
    }
    let commit = git.text(&args)?;
    git.out(&["update-ref", &host_ref(id, "outgoing"), &commit])?;
    Ok(SyncPoint {
        commit,
        head,
        index_tree,
        worktree_tree,
    })
}
fn index_tree(git: &Git<'_>, real: &Path) -> Result<String> {
    let written = git.run(&["write-tree"], &[], LOCAL)?;
    if written.status.success() {
        return Ok(utf8(written.stdout)?.trim().to_owned());
    }
    let scratch = tempfile::NamedTempFile::new_in(
        real.parent()
            .ok_or_else(|| AppError::new("mirror", "The git index has no parent directory."))?,
    )?;
    std::fs::copy(real, scratch.path())?;
    let merged = Git {
        root: git.root,
        index: Some(scratch.path()),
    };
    let unmerged = merged.out(&["ls-files", "--unmerged", "-z"])?;
    let paths: Vec<u8> = nul_list(&unmerged)
        .filter_map(|record| record.splitn(2, |b| *b == b'\t').nth(1))
        .flat_map(|path| path.iter().copied().chain([0]))
        .collect();
    if !paths.is_empty() {
        merged.ok(
            &["update-index", "--force-remove", "-z", "--stdin"],
            &paths,
            LOCAL,
        )?;
    }
    merged.text(&["write-tree"])
}

pub(super) fn fetch(root: &Path, id: &SandboxId, transport: &str, expected: &str) -> Result<()> {
    let incoming = host_ref(id, "incoming");
    let git = Git { root, index: None };
    git.ok(
        &[
            "-c",
            "protocol.ext.allow=always",
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "core.protectHFS=true",
            "-c",
            "core.protectNTFS=true",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            "--no-auto-gc",
            transport,
            &format!("+{CONTAINER_OUTGOING}:{incoming}"),
        ],
        &[],
        TRANSFER,
    )?;
    if git.resolve(&incoming)?.as_deref() != Some(expected) {
        return Err(AppError::new(
            "mirror",
            "The sandbox changed its sync point during the fetch.",
        ));
    }
    Ok(())
}
pub(super) fn push(root: &Path, id: &SandboxId, transport: &str) -> Result<()> {
    Git { root, index: None }
        .ok(
            &[
                "-c",
                "protocol.ext.allow=always",
                "push",
                "--quiet",
                "--no-verify",
                "--recurse-submodules=no",
                transport,
                &format!("+{}:{CONTAINER_INCOMING}", host_ref(id, "outgoing")),
            ],
            &[],
            TRANSFER,
        )
        .map(drop)
}

pub(super) fn point(root: &Path, commit: &str) -> Result<SyncPoint> {
    let git = Git { root, index: None };
    let raw = utf8(git.out(&["cat-file", "commit", commit])?)?;
    let invalid = || AppError::new("mirror", "The sandbox sent an invalid sync point.");
    let (header, message) = raw.split_once("\n\n").ok_or_else(invalid)?;
    let mut tree = None;
    let mut parents = Vec::new();
    for line in header.lines() {
        match line.split_once(' ') {
            Some(("tree", value)) => tree = Some(value.to_owned()),
            Some(("parent", value)) => parents.push(value.to_owned()),
            _ => {}
        }
    }
    let tree = tree.ok_or_else(invalid)?;
    let spec = message
        .lines()
        .find_map(|line| line.strip_prefix("head: "))
        .ok_or_else(invalid)?;
    if parents.len() > 1 {
        return Err(invalid());
    }
    let head = Head::parse(spec, parents.first().map(String::as_str)).ok_or_else(invalid)?;
    if let Head::Branch { name, .. } | Head::Unborn { name } = &head {
        let checked = git.run(&["check-ref-format", "--branch", name], &[], LOCAL)?;
        if !checked.status.success() || name.starts_with('-') {
            return Err(invalid());
        }
    }
    let mut index_tree = None;
    let mut worktree_tree = None;
    for entry in nul_list(&git.out(&["ls-tree", "-z", &tree])?) {
        let entry = std::str::from_utf8(entry).map_err(|_| invalid())?;
        let (meta, name) = entry.split_once('\t').ok_or_else(invalid)?;
        let mut fields = meta.split(' ');
        let (mode, oid) = (fields.next(), fields.nth(1));
        match (mode, name) {
            (Some("040000"), "index") => index_tree = oid.map(str::to_owned),
            (Some("040000"), "worktree") => worktree_tree = oid.map(str::to_owned),
            _ => return Err(invalid()),
        }
    }
    Ok(SyncPoint {
        commit: commit.to_owned(),
        head,
        index_tree: index_tree.ok_or_else(invalid)?,
        worktree_tree: worktree_tree.ok_or_else(invalid)?,
    })
}

pub(super) struct Entry<'a> {
    pub mode: &'a str,
    pub path: &'a str,
    pub target: Option<&'a [u8]>,
}
pub(super) fn validate_entries<'a>(entries: impl IntoIterator<Item = Entry<'a>>) -> Result<()> {
    let refuse = |why: String| AppError::new("mirror_refused", why);
    for entry in entries {
        if entry.mode == "160000" {
            return Err(refuse(format!(
                "The sandbox tree contains a nested repository at {}.",
                entry.path
            )));
        }
        if !safe_components(Path::new(entry.path)) {
            return Err(refuse(format!(
                "The sandbox tree contains an invalid path: {}.",
                entry.path
            )));
        }
        if entry.mode != "120000" {
            continue;
        }
        let Some(target) = entry.target.filter(|target| !target.is_empty()) else {
            return Err(refuse(format!(
                "The sandbox tree has a symlink without a target at {}.",
                entry.path
            )));
        };
        if target.starts_with(b"/") || !safe_link(entry.path, target) {
            return Err(refuse(format!(
                "The sandbox tree has a symlink that points outside the checkout at {}.",
                entry.path
            )));
        }
    }
    Ok(())
}
fn safe_link(path: &str, target: &[u8]) -> bool {
    let Ok(target) = std::str::from_utf8(target) else {
        return false;
    };
    let mut depth = Path::new(path).components().count().saturating_sub(1);
    for component in Path::new(target).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
            }
            Component::Normal(name) if !dotgit(name) => depth += 1,
            _ => return false,
        }
    }
    true
}
fn safe_components(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(name) if !dotgit(name)))
}
/// `.git` and the spellings HFS and NTFS fold to it, as git's own `verify_path` does.
fn dotgit(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_lowercase();
    let name = name.trim_end_matches(['.', ' ']);
    name == ".git" || name == "git~1"
}
pub(super) fn validate_tree(root: &Path, tree: &str) -> Result<()> {
    let git = Git { root, index: None };
    let listing = git.out(&["ls-tree", "-r", "-z", tree])?;
    let invalid = || AppError::new("mirror", "The sandbox sent an invalid tree.");
    let mut entries = Vec::new();
    for entry in nul_list(&listing) {
        let entry = std::str::from_utf8(entry).map_err(|_| invalid())?;
        let (meta, path) = entry.split_once('\t').ok_or_else(invalid)?;
        let mut fields = meta.split(' ');
        let mode = fields.next().ok_or_else(invalid)?;
        let oid = fields.nth(1).ok_or_else(invalid)?;
        entries.push((mode, oid, path));
    }
    let links: Vec<&str> = entries
        .iter()
        .filter(|(mode, ..)| *mode == "120000")
        .map(|(_, oid, _)| *oid)
        .collect();
    let targets = blobs(&git, &links)?;
    validate_entries(entries.iter().map(|(mode, oid, path)| {
        Entry {
            mode,
            path,
            target: targets
                .iter()
                .find(|(id, _)| id == oid)
                .map(|(_, bytes)| bytes.as_slice()),
        }
    }))
}
fn blobs(git: &Git<'_>, oids: &[&str]) -> Result<Vec<(String, Vec<u8>)>> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    let input = oids.join("\n") + "\n";
    let output = git.ok(&["cat-file", "--batch"], input.as_bytes(), LOCAL)?;
    let invalid = || AppError::new("mirror", "The sandbox sent an invalid tree.");
    let mut rest = output.as_slice();
    let mut blobs = Vec::new();
    while !rest.is_empty() {
        let newline = rest.iter().position(|b| *b == b'\n').ok_or_else(invalid)?;
        let header = std::str::from_utf8(&rest[..newline]).map_err(|_| invalid())?;
        let mut fields = header.split(' ');
        let oid = fields.next().ok_or_else(invalid)?;
        let size: usize = match (fields.next(), fields.next()) {
            (Some("blob"), Some(size)) => size.parse().map_err(|_| invalid())?,
            _ => return Err(invalid()),
        };
        let body = rest
            .get(newline + 1..newline + 1 + size)
            .ok_or_else(invalid)?;
        blobs.push((oid.to_owned(), body.to_vec()));
        rest = &rest[(newline + 1 + size + 1).min(rest.len())..];
    }
    Ok(blobs)
}

pub(super) fn mac_branches(root: &Path) -> Result<super::MacBranches> {
    let git = Git { root, index: None };
    let existing = utf8(git.out(&[
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads/",
    ])?)?
    .lines()
    .filter_map(|line| {
        let (name, commit) = line.split_once(' ')?;
        Some((
            name.strip_prefix("refs/heads/")?.to_owned(),
            commit.to_owned(),
        ))
    })
    .collect();
    let own = dunce::canonicalize(root)?;
    let elsewhere = crate::repo::registered_worktrees(root)?
        .into_iter()
        .filter(|row| row.path != own)
        .filter_map(|row| row.branch)
        .collect();
    Ok(super::MacBranches {
        existing,
        elsewhere,
    })
}

pub(super) fn is_ancestor(root: &Path, old: &str, new: &str) -> bool {
    Git { root, index: None }
        .run(&["merge-base", "--is-ancestor", old, new], &[], LOCAL)
        .is_ok_and(|output| output.status.success())
}

pub(super) fn apply(
    root: &Path,
    id: &SandboxId,
    point: &SyncPoint,
    head: &HostHead,
    base: Option<&str>,
) -> Result<()> {
    let git = Git { root, index: None };
    let sync_path = git.git_path("l1code-sync-index")?;
    let sync = Git {
        root,
        index: Some(&sync_path),
    };
    if !sync_path.exists() {
        match base {
            Some(base) => {
                sync.out(&["read-tree", &format!("{base}:worktree")])?;
                sync.out(&["update-index", "-q", "--unmerged", "--refresh"])?;
            }
            None => sync.out(&["read-tree", "--empty"]).map(drop)?,
        }
    }
    sync.out(&["read-tree", "--reset", "-u", &point.worktree_tree])?;
    match head {
        HostHead::Branch { name, commit } => {
            let reference = format!("refs/heads/{name}");
            git.out(&["update-ref", &reference, commit])?;
            git.out(&["symbolic-ref", "HEAD", &reference])?;
        }
        HostHead::Detached { commit, .. } => {
            git.out(&["update-ref", "--no-deref", "HEAD", commit])?;
        }
        HostHead::Unborn { name } => {
            git.out(&["symbolic-ref", "HEAD", &format!("refs/heads/{name}")])?;
        }
        HostHead::Unmoved { .. } => {}
    }
    git.out(&["read-tree", "--reset", &point.index_tree])?;
    git.out(&["update-index", "-q", "--unmerged", "--refresh"])?;
    set_base(root, id, &point.commit)
}

pub(super) fn bundle(root: &Path, path: &Path) -> Result<Head> {
    let git = Git { root, index: None };
    let head = git.head()?;
    let path = path.to_str().ok_or_else(|| {
        AppError::new("mirror", "The temporary directory path is not valid UTF-8.")
    })?;
    match &head {
        Head::Branch { name, .. } => {
            let reference = format!("refs/heads/{name}");
            git.ok(
                &["bundle", "create", "--quiet", path, "HEAD", &reference],
                &[],
                BUNDLE,
            )?;
        }
        Head::Detached { .. } => {
            git.ok(&["bundle", "create", "--quiet", path, "HEAD"], &[], BUNDLE)?;
        }
        Head::Unborn { .. } => {}
    }
    Ok(head)
}
pub(super) fn identity(root: &Path) -> (Option<String>, Option<String>) {
    let git = Git { root, index: None };
    let setting = |key: &str| {
        git.run(&["config", "--get", key], &[], LOCAL)
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    (setting("user.name"), setting("user.email"))
}
