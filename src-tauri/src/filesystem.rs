// Read-only local adaptation of T3 Code v0.0.45 filesystem browse (MIT).
use bot_core::{AppError, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    name: String,
    full_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseDirectory {
    path: String,
    parent_path: Option<String>,
    entries: Vec<BrowseEntry>,
}

fn resolve_path(path: &str, cwd: Option<&str>) -> Result<PathBuf> {
    let path = path.trim();
    // Windows also separates with `\`, as in `~\src`.
    let under = |prefix: &str| {
        path.strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix(std::path::is_separator))
    };
    let resolved = if path == "~" || under("~").is_some() {
        let home = std::env::home_dir()
            .ok_or_else(|| AppError::new("browse", "The home directory is unavailable."))?;
        home.join(under("~").unwrap_or(""))
    } else if under(".").is_some() || under("..").is_some() {
        let cwd = cwd
            .filter(|cwd| Path::new(cwd).is_absolute())
            .ok_or_else(|| AppError::new("browse", "Select a project to use a relative path."))?;
        Path::new(cwd).join(path)
    } else if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        return Err(AppError::new(
            "browse",
            "Enter an absolute or home-relative directory path.",
        ));
    };
    let resolved = dunce::canonicalize(resolved)?;
    if !resolved.is_dir() {
        return Err(AppError::new(
            "browse",
            "The selected path is not a directory.",
        ));
    }
    Ok(resolved)
}

fn browse(path: &str, cwd: Option<&str>) -> Result<BrowseDirectory> {
    let path = resolve_path(path, cwd)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&path)? {
        let entry = entry?;
        if !entry.path().is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(full_path) = entry.path().to_str().map(str::to_owned) else {
            continue;
        };
        entries.push(BrowseEntry { name, full_path });
    }
    entries.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(BrowseDirectory {
        path: path
            .to_str()
            .ok_or_else(|| AppError::new("browse", "This directory path is not valid UTF-8."))?
            .to_owned(),
        parent_path: path.parent().and_then(Path::to_str).map(str::to_owned),
        entries,
    })
}

#[tauri::command]
pub async fn browse_directory(path: String, cwd: Option<String>) -> Result<BrowseDirectory> {
    tauri::async_runtime::spawn_blocking(move || browse(&path, cwd.as_deref()))
        .await
        .map_err(|error| AppError::new("browse", error))?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("bot-code-browse-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn browsing_returns_sorted_directories_and_preserves_files() {
        let directory = Directory::new();
        for name in ["Beta", "alpha", ".hidden"] {
            std::fs::create_dir(directory.0.join(name)).unwrap();
        }
        std::fs::write(directory.0.join("file.txt"), "unchanged").unwrap();
        let result = browse(directory.0.to_str().unwrap(), None).unwrap();
        assert_eq!(
            result
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            [".hidden", "alpha", "Beta"]
        );
        assert_eq!(
            Path::new(&result.path),
            dunce::canonicalize(&directory.0).unwrap()
        );
        assert_eq!(
            result.parent_path.as_deref(),
            Path::new(&result.path).parent().unwrap().to_str()
        );
        assert_eq!(
            std::fs::read_to_string(directory.0.join("file.txt")).unwrap(),
            "unchanged"
        );
    }

    #[test]
    fn paths_resolve_against_the_selected_project_and_refuse_missing_targets() {
        let directory = Directory::new();
        let nested = directory.0.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let cwd = directory.0.to_str().unwrap();
        assert_eq!(
            resolve_path("./nested", Some(cwd)).unwrap(),
            dunce::canonicalize(&nested).unwrap()
        );
        assert_eq!(
            resolve_path("../", nested.to_str()).unwrap(),
            dunce::canonicalize(&directory.0).unwrap()
        );
        assert!(resolve_path("./nested", None).is_err());
        assert!(resolve_path("./missing", Some(cwd)).is_err());
        std::fs::write(directory.0.join("file"), "contents").unwrap();
        assert!(resolve_path("./file", Some(cwd)).is_err());
        let home = std::env::home_dir().unwrap();
        assert_eq!(
            resolve_path("~/", None).unwrap(),
            dunce::canonicalize(home).unwrap()
        );
    }
}
