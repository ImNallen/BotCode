// Ported from T3 Code v0.0.45 apps/server/src/vcs/GitVcsDriver.ts and checkpointing/CheckpointDiffQuery.ts.
use crate::{
    domain::*,
    process::{self, Kill, kill_tree},
    vcs,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{ExitStatus, Stdio},
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: u64 = 16 * 1024 * 1024;
const TEXT_LIMIT: u64 = 1_000_000;
const FILE_LIMIT: usize = 40_000;
const PREFIX: &str = "refs/botcode/checkpoints/";
const DURABLE: [&str; 4] = [
    "-c",
    "core.fsync=objects,reference",
    "-c",
    "core.fsyncMethod=fsync",
];

struct GitOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
fn read_bounded(pipe: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    pipe.take(OUTPUT_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err(std::io::Error::other(
            "Checkpoint Git output exceeds 16 MB.",
        ));
    }
    Ok(bytes)
}
fn stop(child: &mut std::process::Child) {
    kill_tree(child.id(), Kill::Polite);
    let grace = Instant::now() + Duration::from_secs(2);
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < grace {
        std::thread::sleep(Duration::from_millis(5));
    }
    kill_tree(child.id(), Kill::Force);
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(2);
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn run(root: &Path, args: &[&str], index: Option<&Path>, input: &[u8]) -> Result<GitOutput> {
    run_with_limit(root, args, index, input, Duration::from_secs(60))
}
fn run_with_limit(
    root: &Path,
    args: &[&str],
    index: Option<&Path>,
    input: &[u8],
    limit: Duration,
) -> Result<GitOutput> {
    let mut command = process::grouped("git");
    command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.fsmonitor=false", "-c", "core.splitIndex=false"])
        .args(args)
        .envs(vcs::NON_INTERACTIVE)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env("GIT_AUTHOR_NAME", "Bot Code")
        .env("GIT_AUTHOR_EMAIL", "botcode@users.noreply.github.com")
        .env("GIT_COMMITTER_NAME", "Bot Code")
        .env("GIT_COMMITTER_EMAIL", "botcode@users.noreply.github.com")
        .stdin(if input.is_empty() {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    } else {
        command.env_remove("GIT_INDEX_FILE");
    }
    let mut child = command.spawn()?;
    let (out_send, out_recv) = std::sync::mpsc::channel();
    let (err_send, err_recv) = std::sync::mpsc::channel();
    let (write_send, write_recv) = std::sync::mpsc::channel();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    std::thread::spawn(move || {
        let _ = out_send.send(read_bounded(stdout));
    });
    std::thread::spawn(move || {
        let _ = err_send.send(read_bounded(stderr));
    });
    let mut written = if let Some(mut pipe) = child.stdin.take() {
        let input = input.to_vec();
        std::thread::spawn(move || {
            let _ = write_send.send(pipe.write_all(&input));
        });
        None
    } else {
        Some(Ok(()))
    };
    let (mut status, mut stdout, mut stderr) = (None, None, None);
    let deadline = Instant::now() + limit;
    let result = loop {
        if status.is_none() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(error) => break Err(AppError::from(error)),
            }
        }
        if stdout.is_none() {
            match out_recv.try_recv() {
                Ok(value) => stdout = Some(value),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    break Err(AppError::new(
                        "checkpoint",
                        "Checkpoint output reader failed.",
                    ));
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        if stderr.is_none() {
            match err_recv.try_recv() {
                Ok(value) => stderr = Some(value),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    break Err(AppError::new(
                        "checkpoint",
                        "Checkpoint error reader failed.",
                    ));
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        if written.is_none() {
            match write_recv.try_recv() {
                Ok(value) => written = Some(value),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    break Err(AppError::new(
                        "checkpoint",
                        "Checkpoint input writer failed.",
                    ));
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
        }
        if let Some(error) = stdout
            .as_ref()
            .and_then(|value| value.as_ref().err())
            .or_else(|| stderr.as_ref().and_then(|value| value.as_ref().err()))
            .or_else(|| written.as_ref().and_then(|value| value.as_ref().err()))
        {
            break Err(AppError::new("checkpoint", error));
        }
        if let (Some(status), Some(Ok(_)), Some(Ok(_)), Some(Ok(()))) =
            (&status, &stdout, &stderr, &written)
        {
            break Ok(GitOutput {
                status: *status,
                stdout: stdout
                    .take()
                    .expect("completed output reader")
                    .expect("checked reader result"),
                stderr: stderr
                    .take()
                    .expect("completed error reader")
                    .expect("checked reader result"),
            });
        }
        if Instant::now() >= deadline {
            break Err(AppError::new(
                "checkpoint_timeout",
                "Checkpoint Git command timed out.",
            ));
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    if result.is_err() {
        stop(&mut child);
        // Escaped descendants can retain a pipe. Collection stays bounded after group termination.
        if stdout.is_none() {
            let _ = out_recv.recv_timeout(Duration::from_millis(100));
        }
        if stderr.is_none() {
            let _ = err_recv.recv_timeout(Duration::from_millis(100));
        }
        if written.is_none() {
            let _ = write_recv.recv_timeout(Duration::from_millis(100));
        }
    }
    result
}
fn git_index(root: &Path, args: &[&str], index: Option<&Path>, input: &[u8]) -> Result<Vec<u8>> {
    let out = run(root, args, index, input)?;
    if !out.status.success() {
        return Err(AppError::new(
            "checkpoint",
            String::from_utf8_lossy(&out.stderr).trim(),
        ));
    }
    Ok(out.stdout)
}
fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    git_index(root, args, None, &[])
}
fn utf8(bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes)
        .map_err(|_| AppError::new("checkpoint", "Git returned a non-UTF-8 path."))
}
fn reference(root: &Path, reference: &str) -> Result<()> {
    if !reference.starts_with(PREFIX) || reference.len() > 1024 {
        return Err(AppError::new(
            "invalid_checkpoint",
            "Invalid checkpoint reference.",
        ));
    }
    git(root, &["check-ref-format", reference]).map(drop)
}
fn resolve(root: &Path, reference: &str) -> Result<Option<String>> {
    let out = run(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{reference}^{{commit}}"),
        ],
        None,
        &[],
    )?;
    if out.status.success() {
        return Ok(Some(utf8(out.stdout)?.trim().to_owned()));
    }
    if out.status.code() == Some(1) {
        return Ok(None);
    }
    Err(AppError::new(
        "checkpoint",
        String::from_utf8_lossy(&out.stderr),
    ))
}
fn verify(root: &Path, checkpoint: &Checkpoint) -> Result<()> {
    reference(root, &checkpoint.reference)?;
    if ![40, 64].contains(&checkpoint.commit.len())
        || !checkpoint.commit.bytes().all(|b| b.is_ascii_hexdigit())
        || resolve(root, &checkpoint.reference)?.as_deref() != Some(&checkpoint.commit)
    {
        return Err(AppError::new(
            "checkpoint_unavailable",
            "The stored filesystem checkpoint is unavailable.",
        ));
    }
    Ok(())
}
fn sparse(root: &Path) -> Result<()> {
    let out = run(
        root,
        &["config", "--bool", "core.sparseCheckout"],
        None,
        &[],
    )?;
    if out.stdout.trim_ascii() == b"true" {
        return Err(AppError::new(
            "checkpoint_unavailable",
            "Checkpoints are unavailable for sparse checkouts.",
        ));
    }
    if !out.status.success() && out.status.code() != Some(1) {
        return Err(AppError::new(
            "checkpoint",
            String::from_utf8_lossy(&out.stderr),
        ));
    }
    Ok(())
}
struct PrivateIndex(tempfile::TempPath);
impl Drop for PrivateIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(format!("{}.lock", self.0.display()));
    }
}
pub(crate) fn capture(root: &Path, checkpoint_ref: &str) -> Result<Checkpoint> {
    reference(root, checkpoint_ref)?;
    if let Some(commit) = resolve(root, checkpoint_ref)? {
        return Ok(Checkpoint {
            reference: checkpoint_ref.into(),
            commit,
        });
    }
    sparse(root)?;
    let index = PathBuf::from(
        utf8(git(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", "index"],
        )?)?
        .trim(),
    );
    let private = PrivateIndex(
        tempfile::Builder::new()
            .prefix("bot-checkpoint-index-")
            .tempfile_in(index.parent().ok_or_else(|| {
                AppError::new("checkpoint", "Git index has no parent directory.")
            })?)?
            .into_temp_path(),
    );
    let private_path: &Path = &private.0;
    if index.exists() {
        std::fs::copy(&index, private_path)?;
        git_index(
            root,
            &["update-index", "--no-split-index"],
            Some(private_path),
            &[],
        )?;
        let tracked = git_index(
            root,
            &["ls-files", "--cached", "-z"],
            Some(private_path),
            &[],
        )?;
        if !tracked.is_empty() {
            paths(&tracked)?;
            git_index(
                root,
                &[
                    "update-index",
                    "--no-assume-unchanged",
                    "--no-skip-worktree",
                    "-z",
                    "--stdin",
                ],
                Some(private_path),
                &tracked,
            )?;
        }
    } else {
        let head = run(
            root,
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            None,
            &[],
        )?;
        git_index(
            root,
            if head.status.success() {
                &["read-tree", "HEAD"]
            } else {
                &["read-tree", "--empty"]
            },
            Some(private_path),
            &[],
        )?;
    }
    git_index(
        root,
        &[&DURABLE[..], &["add", "-A", "--", "."]].concat(),
        Some(private_path),
        &[],
    )?;
    git_index(
        root,
        &[&DURABLE[..], &["add", "--renormalize", "-A", "--", "."]].concat(),
        Some(private_path),
        &[],
    )?;
    paths(&git_index(
        root,
        &["ls-files", "--cached", "-z"],
        Some(private_path),
        &[],
    )?)?;
    let tree = utf8(git_index(
        root,
        &[&DURABLE[..], &["write-tree"]].concat(),
        Some(private_path),
        &[],
    )?)?;
    let commit = utf8(git_index(
        root,
        &[
            &DURABLE[..],
            &[
                "commit-tree",
                tree.trim(),
                "-m",
                &format!("bot checkpoint ref={checkpoint_ref}"),
            ],
        ]
        .concat(),
        Some(private_path),
        &[],
    )?)?
    .trim()
    .to_owned();
    // A sibling capture of the same reference holds its lock longer than Git's 100 ms default under load.
    let publish = git(
        root,
        &[
            &DURABLE[..],
            &[
                "-c",
                "core.filesRefLockTimeout=10000",
                "update-ref",
                checkpoint_ref,
                &commit,
                "",
            ],
        ]
        .concat(),
    );
    if let Err(error) = publish {
        if let Some(commit) = resolve(root, checkpoint_ref)? {
            return Ok(Checkpoint {
                reference: checkpoint_ref.into(),
                commit,
            });
        }
        return Err(error);
    }
    Ok(Checkpoint {
        reference: checkpoint_ref.into(),
        commit,
    })
}
fn valid_path(path: &str) -> Result<()> {
    if path.len() > 4096
        || path.is_empty()
        || Path::new(path).components().any(|component| {
            !matches!(component, Component::Normal(_))
                || component.as_os_str().eq_ignore_ascii_case(".git")
        })
    {
        return Err(AppError::new(
            "invalid_path",
            "Choose a file inside the repository.",
        ));
    }
    Ok(())
}
fn paths(bytes: &[u8]) -> Result<Vec<String>> {
    let paths = bytes
        .split(|b| *b == 0)
        .filter(|path| !path.is_empty())
        .map(|path| {
            let path = std::str::from_utf8(path)
                .map_err(|_| AppError::new("checkpoint", "Git returned a non-UTF-8 path."))?;
            valid_path(path.trim_end_matches('/'))?;
            Ok(path.to_owned())
        })
        .collect::<Result<Vec<_>>>()?;
    if paths.len() > FILE_LIMIT {
        return Err(AppError::new(
            "repository_too_large",
            "Checkpoints support up to 40,000 files.",
        ));
    }
    Ok(paths)
}
pub(crate) fn files(
    root: &Path,
    before: &Checkpoint,
    after: &Checkpoint,
) -> Result<Vec<TurnDiffFile>> {
    verify(root, before)?;
    verify(root, after)?;
    let bytes = git(
        root,
        &[
            "diff",
            "--numstat",
            "-z",
            "--no-renames",
            &before.commit,
            &after.commit,
            "--",
        ],
    )?;
    let mut files = Vec::new();
    for record in bytes.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let record = std::str::from_utf8(record)
            .map_err(|_| AppError::new("checkpoint", "Git returned a non-UTF-8 path."))?;
        let mut fields = record.splitn(3, '\t');
        let number = |part: Option<&str>| -> Result<Option<u64>> {
            match part {
                Some("-") => Ok(None),
                Some(value) => value
                    .parse()
                    .map(Some)
                    .map_err(|_| AppError::new("checkpoint", "Invalid Git diff summary.")),
                None => Err(AppError::new("checkpoint", "Invalid Git diff summary.")),
            }
        };
        let additions = number(fields.next())?;
        let deletions = number(fields.next())?;
        let path = fields
            .next()
            .ok_or_else(|| AppError::new("checkpoint", "Invalid Git diff summary."))?;
        valid_path(path)?;
        files.push(TurnDiffFile {
            path: path.into(),
            additions,
            deletions,
        });
        if files.len() > FILE_LIMIT {
            return Err(AppError::new(
                "repository_too_large",
                "Checkpoints support up to 40,000 files.",
            ));
        }
    }
    Ok(files)
}
fn blob(root: &Path, commit: &str, path: &str) -> Result<Option<FileText>> {
    let entry = git(
        root,
        &["ls-tree", "-z", commit, "--", &format!(":(literal){path}")],
    )?;
    if entry.is_empty() {
        return Ok(None);
    }
    if !entry.starts_with(b"100") && !entry.starts_with(b"120000 ") {
        return Err(AppError::new(
            "file_unavailable",
            "Directories and submodules cannot be displayed as text.",
        ));
    }
    let spec = format!("{commit}:{path}");
    let length: u64 = utf8(git(root, &["cat-file", "-s", &spec])?)?
        .trim()
        .parse()
        .map_err(|_| AppError::new("checkpoint", "Invalid Git blob size."))?;
    if length > TEXT_LIMIT {
        return Err(AppError::new(
            "file_unavailable",
            "This Git blob exceeds the 1 MB text limit.",
        ));
    }
    let bytes = git(root, &["cat-file", "blob", &spec])?;
    if bytes.contains(&0) {
        return Err(AppError::new(
            "file_unavailable",
            "Binary files cannot be displayed as text.",
        ));
    }
    let contents = String::from_utf8(bytes)
        .map_err(|_| AppError::new("file_unavailable", "This file is not UTF-8 text."))?;
    Ok(Some(FileText {
        name: path.into(),
        contents,
    }))
}
pub(crate) fn view(
    root: &Path,
    before: &Checkpoint,
    after: &Checkpoint,
    path: &str,
) -> Result<TurnDiffView> {
    valid_path(path)?;
    verify(root, before)?;
    verify(root, after)?;
    match (|| -> Result<TurnDiffView> {
        Ok(TurnDiffView::Text {
            old: blob(root, &before.commit, path)?,
            new: blob(root, &after.commit, path)?,
        })
    })() {
        Err(error) if error.code == "file_unavailable" => Ok(TurnDiffView::Unavailable {
            reason: error.message,
        }),
        other => other,
    }
}
fn tree(root: &Path, commit: &str) -> Result<BTreeMap<String, String>> {
    let bytes = git(root, &["ls-tree", "-r", "-z", commit])?;
    let mut tree = BTreeMap::new();
    for entry in bytes.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let tab = entry
            .iter()
            .position(|b| *b == b'\t')
            .ok_or_else(|| AppError::new("checkpoint", "Invalid checkpoint tree."))?;
        let (meta, path) = (&entry[..tab], &entry[tab + 1..]);
        let meta = std::str::from_utf8(meta)
            .map_err(|_| AppError::new("checkpoint", "Invalid checkpoint tree."))?;
        let path = std::str::from_utf8(path)
            .map_err(|_| AppError::new("checkpoint", "Git returned a non-UTF-8 path."))?;
        valid_path(path)?;
        if meta.starts_with("160000 ") {
            return Err(AppError::new(
                "checkpoint_restore_unavailable",
                "Checkpoint restore is unavailable for submodules or nested repositories.",
            ));
        }
        tree.insert(path.to_owned(), meta.to_owned());
        if tree.len() > FILE_LIMIT {
            return Err(AppError::new(
                "repository_too_large",
                "Checkpoints support up to 40,000 files.",
            ));
        }
    }
    Ok(tree)
}
#[cfg(unix)]
type FileIdentity = (u64, u64);
#[cfg(not(unix))]
type FileIdentity = PathBuf;
fn file_identity(path: &Path) -> Result<Option<FileIdentity>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                Ok(Some((metadata.dev(), metadata.ino())))
            }
            #[cfg(not(unix))]
            {
                let _ = metadata;
                Ok(Some(dunce::canonicalize(path)?))
            }
        }
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.kind() == std::io::ErrorKind::NotADirectory =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}
fn identical(root: &Path, path: &str, meta: &str) -> Result<bool> {
    let metadata = match std::fs::symlink_metadata(root.join(path)) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let mut fields = meta.split(' ');
    let mode = fields.next().unwrap_or_default();
    let oid = fields.nth(1).unwrap_or_default();
    let bytes = if mode == "120000" && metadata.is_symlink() {
        std::fs::read_link(root.join(path))?
            .as_os_str()
            .as_encoded_bytes()
            .to_vec()
    } else if mode.starts_with("100") && metadata.is_file() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = metadata.permissions().mode() & 0o111 != 0;
            if executable != (mode == "100755") {
                return Ok(false);
            }
        }
        let hash = utf8(git(root, &["hash-object", "--", path])?)?;
        return Ok(hash.trim() == oid);
    } else {
        return Ok(false);
    };
    Ok(bytes == git(root, &["cat-file", "blob", oid])?)
}
fn restore_exclusions(root: &Path, checkpoint: &Checkpoint) -> Result<Vec<String>> {
    verify(root, checkpoint)?;
    sparse(root)?;
    let target = tree(root, &checkpoint.commit)?;
    for path in target.keys() {
        let mut parent = Path::new(path).parent();
        while let Some(directory) = parent.filter(|directory| !directory.as_os_str().is_empty()) {
            let current = root.join(directory);
            if current.join(".git").exists() {
                return Err(AppError::new(
                    "checkpoint_restore_unavailable",
                    "Checkpoint restore cannot write inside a nested repository.",
                ));
            }
            if std::fs::symlink_metadata(&current).is_ok_and(|meta| meta.is_symlink()) {
                return Err(AppError::new(
                    "checkpoint_restore_unavailable",
                    "Checkpoint restore cannot write through a directory symlink. Move it before retrying.",
                ));
            }
            parent = directory.parent();
        }
    }
    let index = git(root, &["ls-files", "--stage", "-z"])?;
    if index.split(|b| *b == 0).any(|r| r.starts_with(b"160000 ")) {
        return Err(AppError::new(
            "checkpoint_restore_unavailable",
            "Checkpoint restore is unavailable for submodules or nested repositories.",
        ));
    }
    let untracked = paths(&git(
        root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?)?;
    for path in untracked {
        if path.ends_with('/') && root.join(path.trim_end_matches('/')).join(".git").exists() {
            return Err(AppError::new(
                "checkpoint_restore_unavailable",
                "Checkpoint restore is unavailable while this checkout contains a nested repository.",
            ));
        }
    }
    let ignored = paths(&git(
        root,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ],
    )?)?;
    let mut exclusions = Vec::new();
    let ignored_paths = ignored
        .iter()
        .enumerate()
        .map(|(index, path)| (path.trim_end_matches('/').to_owned(), index))
        .collect::<BTreeMap<_, _>>();
    let mut ignored_ids = BTreeMap::<FileIdentity, Vec<usize>>::new();
    for (index, path) in ignored.iter().enumerate() {
        if let Some(identity) = file_identity(&root.join(path.trim_end_matches('/')))? {
            ignored_ids.entry(identity).or_default().push(index);
        }
    }
    let mut identities = BTreeMap::<String, Option<FileIdentity>>::new();
    for (tracked, meta) in &target {
        let mut collisions = BTreeSet::new();
        let mut path = Some(tracked.as_str());
        while let Some(current) = path {
            if let Some(index) = ignored_paths.get(current) {
                collisions.insert(*index);
            }
            if !identities.contains_key(current) {
                identities.insert(current.into(), file_identity(&root.join(current))?);
            }
            if let Some(identity) = identities.get(current).and_then(Option::as_ref)
                && let Some(indices) = ignored_ids.get(identity)
            {
                collisions.extend(indices);
            }
            path = current.rsplit_once('/').map(|(parent, _)| parent);
        }
        let prefix = format!("{tracked}/");
        for (_, index) in ignored_paths
            .range(prefix.clone()..)
            .take_while(|(path, _)| path.starts_with(&prefix))
        {
            collisions.insert(*index);
        }
        if !collisions.is_empty() {
            if identical(root, tracked, meta)? {
                exclusions.push(format!(":(exclude,literal){tracked}"));
            } else {
                let ignored_path = &ignored[*collisions.first().expect("a collision")];
                return Err(AppError::new(
                    "checkpoint_ignored_collision",
                    format!(
                        "Restoring this checkpoint would overwrite ignored file {ignored_path}. Move it before retrying."
                    ),
                ));
            }
        }
    }
    if !ignored.is_empty() {
        let mut ignore_paths = target
            .keys()
            .filter(|path| {
                Path::new(path)
                    .file_name()
                    .is_some_and(|name| name == ".gitignore")
            })
            .cloned()
            .collect::<Vec<_>>();
        ignore_paths.extend(
            paths(&git(
                root,
                &[
                    "ls-files",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "-z",
                ],
            )?)?
            .into_iter()
            .filter(|path| {
                Path::new(path)
                    .file_name()
                    .is_some_and(|name| name == ".gitignore")
            }),
        );
        ignore_paths.sort();
        ignore_paths.dedup();
        for path in ignore_paths {
            let saved =
                blob(root, &checkpoint.commit, &path)?.map(|file| file.contents.into_bytes());
            let current = match std::fs::symlink_metadata(root.join(&path)) {
                Ok(meta) if meta.is_symlink() => Some(
                    std::fs::read_link(root.join(&path))?
                        .as_os_str()
                        .as_encoded_bytes()
                        .to_vec(),
                ),
                Ok(meta) if meta.len() <= TEXT_LIMIT => Some(std::fs::read(root.join(&path))?),
                Ok(_) => {
                    return Err(AppError::new(
                        "checkpoint_restore_unavailable",
                        "This .gitignore exceeds the 1 MB text limit.",
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            if saved != current {
                return Err(AppError::new(
                    "checkpoint_ignore_rules",
                    "Restore would change .gitignore while ignored files exist. Move the ignored files before retrying.",
                ));
            }
        }
    }
    Ok(exclusions)
}
pub(crate) fn preflight_restore(root: &Path, checkpoint: &Checkpoint) -> Result<()> {
    restore_exclusions(root, checkpoint).map(drop)
}
pub(crate) fn restore(root: &Path, checkpoint: &Checkpoint) -> Result<()> {
    let exclusions = restore_exclusions(root, checkpoint)?;
    let tracked = git(
        root,
        &[
            "ls-files",
            "--cached",
            &format!("--with-tree={}", checkpoint.commit),
            "-z",
        ],
    )?;
    let excluded = exclusions
        .iter()
        .filter_map(|path| path.strip_prefix(":(exclude,literal)"))
        .collect::<BTreeSet<_>>();
    if paths(&tracked)?
        .iter()
        .any(|path| !excluded.contains(path.as_str()))
    {
        let mut args = vec![
            "restore",
            "--source",
            &checkpoint.commit,
            "--worktree",
            "--staged",
            "--",
            ".",
        ];
        args.extend(exclusions.iter().map(String::as_str));
        git(root, &args)?;
    }
    git(root, &["clean", "-fd", "--", "."])?;
    if resolve(root, "HEAD")?.is_some() {
        git(root, &["reset", "--quiet", "--", "."])?;
    }
    Ok(())
}
#[cfg(test)]
mod tests;
