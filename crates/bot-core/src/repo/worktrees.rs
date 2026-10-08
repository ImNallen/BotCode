use super::*;
use std::os::unix::ffi::OsStrExt;

fn common_dir(path: &Path) -> Result<PathBuf> {
    let bytes = git(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    PathBuf::from(std::ffi::OsStr::from_bytes(bytes.trim_ascii_end()))
        .canonicalize()
        .map_err(Into::into)
}

pub(crate) fn registered_worktrees(root: &Path) -> Result<Vec<RegisteredWorktree>> {
    let common = common_dir(root)?;
    let bytes = git(root, &["worktree", "list", "--porcelain", "-z"])?;
    let mut rows = Vec::new();
    let mut row: Option<RegisteredWorktree> = None;
    for field in bytes.split(|b| *b == 0) {
        if let Some(path) = field.strip_prefix(b"worktree ") {
            if let Some(row) = row.take() {
                rows.push(row);
            }
            row = Some(RegisteredWorktree {
                path: PathBuf::from(std::ffi::OsStr::from_bytes(path)),
                branch: None,
                head: String::new(),
                unavailable: None,
            });
        } else if let Some(row) = row.as_mut() {
            if let Some(head) = field.strip_prefix(b"HEAD ") {
                row.head = String::from_utf8_lossy(head).into_owned();
            }
            if let Some(branch) = field.strip_prefix(b"branch refs/heads/") {
                row.branch = Some(String::from_utf8_lossy(branch).into_owned());
            }
            if field.starts_with(b"prunable") || field == b"bare" {
                row.unavailable = Some("This registered checkout is unavailable.".into());
            }
        }
    }
    if let Some(row) = row {
        rows.push(row);
    }
    for row in &mut rows {
        match row.path.canonicalize() {
            Ok(path)
                if open(&path).is_ok_and(|actual| actual == path)
                    && common_dir(&path).is_ok_and(|dir| dir == common) =>
            {
                row.path = path
            }
            _ => {
                row.unavailable =
                    Some("The checkout is missing or belongs to another repository.".into())
            }
        }
    }
    Ok(rows)
}

pub(crate) fn registered_worktree(root: &Path, path: &Path) -> Result<RegisteredWorktree> {
    let path = path.canonicalize().map_err(|_| {
        AppError::new(
            "missing_checkout",
            "The selected worktree no longer exists.",
        )
    })?;
    let row = registered_worktrees(root)?
        .into_iter()
        .find(|row| row.path == path)
        .ok_or_else(|| {
            AppError::new(
                "invalid_checkout",
                "Select a worktree registered with this repository.",
            )
        })?;
    if let Some(reason) = &row.unavailable {
        return Err(AppError::new("missing_checkout", reason));
    }
    Ok(row)
}
