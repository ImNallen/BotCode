// Ported from pingdotgg/t3code v0.0.45 apps/server/src/keybindings.ts and atomicWrite.ts (MIT).
use crate::{AppError, Result, settings};
use serde::Serialize;
use std::{path::PathBuf, sync::Mutex};

#[derive(Debug, Serialize)]
pub struct KeybindingsFile {
    pub path: String,
    pub text: Option<String>,
}
pub(crate) struct Keybindings {
    path: PathBuf,
    writes: Mutex<()>,
}
impl Keybindings {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            writes: Mutex::new(()),
        }
    }
    pub fn read(&self) -> Result<KeybindingsFile> {
        Ok(KeybindingsFile {
            path: self.path.to_string_lossy().into_owned(),
            text: settings::read(&self.path)?,
        })
    }
    pub fn write(&self, text: &str, expected: Option<&str>) -> Result<()> {
        let _guard = self
            .writes
            .lock()
            .map_err(|_| AppError::new("keybindings_lock", "Keybindings write lock failed."))?;
        if settings::read(&self.path)?.as_deref() != expected {
            return Err(AppError::new(
                "keybindings_changed",
                "Keybindings changed on disk. Reload and try again.",
            ));
        }
        settings::write(&self.path, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conditional_writes_survive_restart_and_keep_external_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("keybindings.json");
        let file = Keybindings::new(path.clone());
        assert!(file.read().unwrap().text.is_none());
        let copied = "[{\"key\":\"mod+alt+b\",\"command\":\"sidebar.toggle\"}]\n";
        file.write(copied, None).unwrap();
        let reopened = Keybindings::new(path.clone());
        assert_eq!(reopened.read().unwrap().text.as_deref(), Some(copied));
        std::fs::write(&path, "[]\n").unwrap();
        assert_eq!(
            file.write(copied, Some(copied)).unwrap_err().code,
            "keybindings_changed"
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), "[]\n");
    }
}
