use crate::domain::Result;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

pub fn read(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
// Writing to the resolved target keeps a symlinked settings file linked.
pub fn write(path: &Path, text: &str) -> Result<()> {
    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let sibling = |suffix: &str| {
        let mut name = target.clone().into_os_string();
        name.push(suffix);
        PathBuf::from(name)
    };
    if let Ok(existing) = fs::read(&target)
        && serde_json::from_slice::<serde_json::Value>(&existing).is_err()
    {
        fs::write(sibling(".bak"), existing)?;
    }
    let temp = sibling(&format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = fs::write(&temp, text).and_then(|()| fs::rename(&temp, &target));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    Ok(result?)
}
