use crate::domain::{AUTO_SETTLE_AFTER_MS, Result, WorkspaceId};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

/// Idle time before a thread auto-settles, by project. `None` turns auto-settling off.
#[derive(Debug, Clone, PartialEq)]
pub struct AutoSettle {
    default: Option<u64>,
    projects: HashMap<WorkspaceId, Option<u64>>,
}
impl AutoSettle {
    pub fn after_ms(&self, workspace: &WorkspaceId) -> Option<u64> {
        self.projects
            .get(workspace)
            .copied()
            .unwrap_or(self.default)
    }
}
/// Reads T3's `sidebarAutoSettleAfterDays` and its project overrides. A missing or invalid
/// value falls back to 3 days at the top level and to the default for a project.
pub fn auto_settle(path: &Path) -> AutoSettle {
    let days = |value: &Value| match value {
        Value::Null => Some(None),
        _ => value
            .as_f64()
            .filter(|days| (1.0..=90.0).contains(days))
            .map(|days| Some((days * 86_400_000.0) as u64)),
    };
    let settings: Value = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    AutoSettle {
        default: settings
            .get("sidebarAutoSettleAfterDays")
            .and_then(days)
            .unwrap_or(Some(AUTO_SETTLE_AFTER_MS)),
        projects: settings["projectOverrides"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(id, project)| {
                Some((
                    id.parse().ok()?,
                    days(project.get("sidebarAutoSettleAfterDays")?)?,
                ))
            })
            .collect(),
    }
}
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
