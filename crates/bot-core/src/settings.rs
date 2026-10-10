use crate::SettlementRules;
use crate::domain::{AUTO_SETTLE_AFTER_MS, Result, WorkspaceId};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

/// Independent inactivity and merge settlement rules, inherited by project.
#[derive(Debug, Clone, PartialEq)]
pub struct AutoSettle {
    default: SettlementRules,
    projects: HashMap<WorkspaceId, SettlementRules>,
}
impl AutoSettle {
    pub fn rules(&self, workspace: &WorkspaceId) -> SettlementRules {
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
    let default = SettlementRules {
        after_ms: settings
            .get("sidebarAutoSettleAfterDays")
            .and_then(days)
            .unwrap_or(Some(AUTO_SETTLE_AFTER_MS)),
        on_merge: settings["autoSettleOnMerge"].as_bool().unwrap_or(true),
    };
    AutoSettle {
        default,
        projects: settings["projectOverrides"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(id, project)| {
                Some((
                    id.parse().ok()?,
                    SettlementRules {
                        after_ms: project
                            .get("sidebarAutoSettleAfterDays")
                            .and_then(days)
                            .unwrap_or(default.after_ms),
                        on_merge: project["autoSettleOnMerge"]
                            .as_bool()
                            .unwrap_or(default.on_merge),
                    },
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
    if let Ok(value) = serde_json::from_str(text) {
        crate::project::validate_saved_scripts(&value)?;
    }
    let target = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CleanupRules {
    pub worktree_on_delete: bool,
    pub worktree_after_days: Option<u64>,
    pub worktree_unchanged: bool,
}
impl CleanupRules {
    pub fn enabled(self) -> bool {
        self.worktree_after_days.is_some() || self.worktree_unchanged
    }
}
/// Every malformed key, or a missing or unparseable file, reads as that rule being off.
pub fn cleanup_rules(path: &Path) -> CleanupRules {
    let settings: serde_json::Value = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let rules = &settings["storageCleanup"];
    CleanupRules {
        worktree_after_days: rules["worktreeAfterDays"]
            .as_u64()
            .filter(|days| (1..=3650).contains(days)),
        worktree_on_delete: rules["worktreeOnDelete"].as_bool() == Some(true),
        worktree_unchanged: rules["worktreeUnchanged"].as_bool() == Some(true),
    }
}

// Source-control policy adapts T3 Code v0.0.45 unified settings (MIT).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WritingStyleMode {
    #[default]
    RepoConventions,
    ConventionalCommits,
    Custom,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WritingStyle {
    pub mode: WritingStyleMode,
    pub custom_instructions: String,
    pub follow_change_request_templates: bool,
}
impl Default for WritingStyle {
    fn default() -> Self {
        Self {
            mode: WritingStyleMode::RepoConventions,
            custom_instructions: String::new(),
            follow_change_request_templates: true,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct ProjectSourceControl {
    pub writing_style: WritingStyle,
    pub auto_pull: bool,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SourceControlSettings {
    default: ProjectSourceControl,
    projects: HashMap<WorkspaceId, ProjectSourceControl>,
    interval: Option<std::time::Duration>,
}
impl SourceControlSettings {
    pub fn for_project(&self, id: &WorkspaceId) -> &ProjectSourceControl {
        self.projects.get(id).unwrap_or(&self.default)
    }
    pub fn fetch_interval(&self) -> Option<std::time::Duration> {
        self.interval
    }
}
pub(crate) fn source_control(path: &Path) -> SourceControlSettings {
    let settings: Value = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let style = |value: &Value| {
        serde_json::from_value::<WritingStyle>(value.clone())
            .ok()
            .map(|mut style| {
                style.custom_instructions = style.custom_instructions.trim().into();
                style
            })
    };
    let default = ProjectSourceControl {
        writing_style: style(&settings["sourceControlWritingStyle"]).unwrap_or_default(),
        auto_pull: settings["defaultAutoPull"].as_bool().unwrap_or(false),
    };
    let interval = settings["automaticGitFetchInterval"]
        .as_u64()
        .filter(|ms| *ms <= 9_007_199_254_740_991)
        .unwrap_or(30_000);
    SourceControlSettings {
        projects: settings["projectOverrides"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(id, project)| {
                Some((
                    id.parse().ok()?,
                    ProjectSourceControl {
                        writing_style: style(&project["sourceControlWritingStyle"])
                            .unwrap_or_else(|| default.writing_style.clone()),
                        auto_pull: project["defaultAutoPull"]
                            .as_bool()
                            .unwrap_or(default.auto_pull),
                    },
                ))
            })
            .collect(),
        default,
        interval: (interval > 0).then(|| std::time::Duration::from_millis(interval)),
    }
}

#[cfg(test)]
mod source_control_tests {
    use super::*;
    #[test]
    fn writing_styles_strip_unknown_fields_at_global_and_project_scope() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let id = WorkspaceId::default();
        fs::write(&path, serde_json::json!({ "sourceControlWritingStyle": { "mode": "custom", "customInstructions": "Global extra", "followChangeRequestTemplates": false, "futureOption": true }, "projectOverrides": { id.to_string(): { "sourceControlWritingStyle": { "mode": "conventional_commits", "customInstructions": "Project extra", "followChangeRequestTemplates": true, "futureOption": true } } } }).to_string()).unwrap();
        let settings = source_control(&path);
        assert_eq!(
            settings
                .for_project(&WorkspaceId::default())
                .writing_style
                .custom_instructions,
            "Global extra"
        );
        assert_eq!(
            settings.for_project(&id).writing_style.mode,
            WritingStyleMode::ConventionalCommits
        );
        assert_eq!(
            settings.for_project(&id).writing_style.custom_instructions,
            "Project extra"
        );
    }
    #[test]
    fn source_control_defaults_and_independent_project_inheritance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let id = WorkspaceId::default();
        let defaults = source_control(&path);
        assert_eq!(
            defaults.fetch_interval(),
            Some(std::time::Duration::from_secs(30))
        );
        assert!(!defaults.for_project(&id).auto_pull);
        assert!(
            defaults
                .for_project(&id)
                .writing_style
                .follow_change_request_templates
        );
        fs::write(&path, serde_json::json!({ "defaultAutoPull": true, "automaticGitFetchInterval": 0, "sourceControlWritingStyle": { "mode": "custom", "customInstructions": "  Short titles  ", "followChangeRequestTemplates": false }, "projectOverrides": { id.to_string(): { "defaultAutoPull": false, "sourceControlWritingStyle": { "mode": "invalid" } } } }).to_string()).unwrap();
        let settings = source_control(&path);
        assert_eq!(settings.fetch_interval(), None);
        assert!(!settings.for_project(&id).auto_pull);
        assert!(settings.for_project(&WorkspaceId::default()).auto_pull);
        assert_eq!(
            settings.for_project(&id).writing_style.custom_instructions,
            "Short titles"
        );
        assert!(
            !settings
                .for_project(&id)
                .writing_style
                .follow_change_request_templates
        );
        fs::write(&path, r#"{"defaultAutoPull":"yes","automaticGitFetchInterval":-1,"sourceControlWritingStyle":{}}"#).unwrap();
        assert_eq!(source_control(&path), defaults);
    }
}
