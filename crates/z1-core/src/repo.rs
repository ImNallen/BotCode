use crate::domain::*;
use std::{
    path::{Component, Path, PathBuf},
    process::Command,
};
const TEXT_LIMIT: usize = 1_000_000;
fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()?;
    if !out.status.success() {
        return Err(AppError::new("git", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(out.stdout)
}
pub fn open(path: &Path) -> Result<PathBuf> {
    let path = path.canonicalize()?;
    let bytes = git(&path, &["rev-parse", "--show-toplevel"])?;
    let root = PathBuf::from(String::from_utf8_lossy(&bytes).trim()).canonicalize()?;
    Ok(root)
}
pub fn add_worktree(root: &Path, worktrees: &Path) -> Result<Checkout> {
    git(root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).map_err(|_| {
        AppError::new(
            "worktree_unavailable",
            "Commit to this repository before starting a worktree.",
        )
    })?;
    let id = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let branch = format!("z1/{id}");
    let path = worktrees.join(format!("z1-{id}"));
    std::fs::create_dir_all(worktrees)?;
    git(
        root,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            &path.to_string_lossy(),
            "HEAD",
        ],
    )?;
    Ok(Checkout::Worktree {
        path: path.canonicalize()?,
        branch,
    })
}
fn relative(path: &str) -> Result<&Path> {
    let p = Path::new(path);
    if p.as_os_str().is_empty()
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
fn contained(root: &Path, path: &str) -> Result<PathBuf> {
    let p = root.join(relative(path)?);
    let canonical = p.canonicalize()?;
    if !canonical.starts_with(root.canonicalize()?) {
        return Err(AppError::new(
            "invalid_path",
            "This symlink points outside the repository.",
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
pub fn read_file(root: &Path, path: &str) -> Result<FileView> {
    let name = path.to_owned();
    let path = contained(root, path)?;
    if std::fs::metadata(&path)?.len() > TEXT_LIMIT as u64 {
        return Ok(FileView::Unavailable {
            reason: "This file exceeds the 1 MB text limit.".into(),
        });
    }
    Ok(match text(std::fs::read(&path)?) {
        Ok(contents) => FileView::Text { name, contents },
        Err(e) => FileView::Unavailable { reason: e.message },
    })
}
pub fn inspect(workspace: Workspace, threads: Vec<ThreadSummary>) -> Result<WorkspaceView> {
    let root = &workspace.root;
    let files = git(
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )?;
    let mut paths: Vec<String> = files
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect();
    paths.sort();
    paths.dedup();
    if paths.len() > 40_000 {
        return Err(AppError::new(
            "repository_too_large",
            "This first version supports up to 40,000 files.",
        ));
    }
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
        workspace,
        branch,
        files: paths,
        changes,
        threads,
    })
}
fn version(root: &Path, spec: &str) -> Result<String> {
    let size = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["cat-file", "-s", spec])
        .output()?;
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
                    match read_file(root, path)? {
                        FileView::Text { contents, .. } => contents,
                        FileView::Unavailable { reason } => {
                            return Ok(DiffView::Unavailable { reason });
                        }
                    }
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
