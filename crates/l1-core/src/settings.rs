use crate::SettlementRules;
use crate::domain::{AUTO_SETTLE_AFTER_MS, Result, WorkspaceId};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
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
/// The model and reasoning effort for generated text. No effort uses the model's default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModelSelection {
    pub model: String,
    pub effort: Option<String>,
}
impl ModelSelection {
    // T3 Code v0.0.45 packages/contracts/src/model.ts DEFAULT_TEXT_GENERATION_MODEL and DEFAULT_TEXT_GENERATION_REASONING_EFFORT.
    pub(crate) fn text_generation_default() -> Self {
        Self {
            model: "gpt-6-luna".into(),
            effort: Some("low".into()),
        }
    }
    fn parse(value: &Value) -> Option<Self> {
        let model = value["model"].as_str().filter(|model| !model.is_empty())?;
        let effort = match &value["effort"] {
            Value::Null => None,
            Value::String(effort)
                if !effort.is_empty() && effort.bytes().all(|b| b.is_ascii_lowercase()) =>
            {
                Some(effort.clone())
            }
            _ => return None,
        };
        Some(Self {
            model: model.into(),
            effort,
        })
    }
}
/// Reads T3's `textGenerationModelSelection`: the project's override, else the device value,
/// else T3's default. A malformed layer falls through to the next one.
pub(crate) fn text_generation(path: &Path, workspace: &WorkspaceId) -> ModelSelection {
    let settings: Value = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    ModelSelection::parse(
        &settings["projectOverrides"][workspace.to_string()]["textGenerationModelSelection"],
    )
    .or_else(|| ModelSelection::parse(&settings["textGenerationModelSelection"]))
    .unwrap_or_else(ModelSelection::text_generation_default)
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
    pub worktree_on_merge: bool,
    pub worktree_unchanged: bool,
}
impl CleanupRules {
    pub fn has_sweep_rule(self) -> bool {
        self.worktree_after_days.is_some() || self.worktree_on_merge || self.worktree_unchanged
    }
    fn lenient(rules: &Value) -> Self {
        Self {
            worktree_on_delete: rules["worktreeOnDelete"].as_bool() == Some(true),
            worktree_after_days: retention_days(&rules["worktreeAfterDays"]).flatten(),
            worktree_on_merge: rules["worktreeOnMerge"].as_bool() == Some(true),
            worktree_unchanged: rules["worktreeUnchanged"].as_bool() == Some(true),
        }
    }
    fn strict(rules: &Value) -> Option<Self> {
        Some(Self {
            worktree_on_delete: rules["worktreeOnDelete"].as_bool()?,
            worktree_after_days: retention_days(&rules["worktreeAfterDays"])?,
            worktree_on_merge: rules["worktreeOnMerge"].as_bool()?,
            worktree_unchanged: rules["worktreeUnchanged"].as_bool()?,
        })
    }
}
fn retention_days(value: &Value) -> Option<Option<u64>> {
    match value {
        Value::Null => Some(None),
        _ => value
            .as_u64()
            .filter(|days| (1..=3650).contains(days))
            .map(Some),
    }
}
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StoragePolicy {
    default: CleanupRules,
    projects: HashMap<WorkspaceId, CleanupRules>,
    pub browser_artifacts_after_days: Option<u64>,
    pub logs_after_days: Option<u64>,
}
impl StoragePolicy {
    pub fn rules(&self, workspace: &WorkspaceId) -> CleanupRules {
        self.projects
            .get(workspace)
            .copied()
            .unwrap_or(self.default)
    }
    pub fn worktrees_enabled(&self) -> bool {
        self.default.has_sweep_rule() || self.projects.values().any(|rules| rules.has_sweep_rule())
    }
}
pub fn storage_policy(path: &Path) -> StoragePolicy {
    let settings: Value = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let storage = &settings["storageCleanup"];
    StoragePolicy {
        default: CleanupRules::lenient(storage),
        projects: settings["projectOverrides"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(id, project)| {
                let cleanup = &project["worktreeCleanup"];
                let rules = match cleanup["mode"].as_str()? {
                    "off" => CleanupRules::default(),
                    "custom" => CleanupRules::strict(&cleanup["rules"])?,
                    _ => return None,
                };
                Some((id.parse().ok()?, rules))
            })
            .collect(),
        browser_artifacts_after_days: retention_days(&storage["browserArtifactsAfterDays"])
            .flatten(),
        logs_after_days: retention_days(&storage["logsAfterDays"]).flatten(),
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ModelPrice {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}
pub(crate) fn usage_price_overrides(path: &Path) -> BTreeMap<String, ModelPrice> {
    let settings: Value = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let rate = |value: &Value| value.as_f64().filter(|v| v.is_finite() && *v >= 0.0);
    let optional = |entry: &Value, key: &str, input: f64| match entry.get(key) {
        None => Some(input),
        Some(value) => rate(value),
    };
    settings["usagePriceOverrides"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(model, entry)| {
            let model = model.trim();
            let input = rate(&entry["inputCostPerMillionTokens"])?;
            let price = ModelPrice {
                input,
                output: rate(&entry["outputCostPerMillionTokens"])?,
                cache_read: optional(entry, "cacheReadCostPerMillionTokens", input)?,
                cache_write: optional(entry, "cacheWriteCostPerMillionTokens", input)?,
            };
            (!model.is_empty()).then(|| (model.to_owned(), price))
        })
        .collect()
}

#[cfg(test)]
mod usage_price_tests {
    use super::*;
    #[test]
    fn price_overrides_keep_exact_ids_and_skip_only_malformed_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert!(usage_price_overrides(&path).is_empty());
        fs::write(
            &path,
            serde_json::json!({"usagePriceOverrides": {
                " Vendor/Model-A ": {"inputCostPerMillionTokens": 2, "outputCostPerMillionTokens": 8},
                "free-cache": {"inputCostPerMillionTokens": 2, "outputCostPerMillionTokens": 8, "cacheReadCostPerMillionTokens": 0, "cacheWriteCostPerMillionTokens": 3.5},
                "negative": {"inputCostPerMillionTokens": -1, "outputCostPerMillionTokens": 8},
                "missing-output": {"inputCostPerMillionTokens": 2},
                "text": {"inputCostPerMillionTokens": "2", "outputCostPerMillionTokens": 8},
                "bad-cache": {"inputCostPerMillionTokens": 2, "outputCostPerMillionTokens": 8, "cacheReadCostPerMillionTokens": null},
                "  ": {"inputCostPerMillionTokens": 2, "outputCostPerMillionTokens": 8},
                "not-an-object": 4
            }})
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            usage_price_overrides(&path),
            BTreeMap::from([
                (
                    "Vendor/Model-A".to_owned(),
                    ModelPrice {
                        input: 2.0,
                        output: 8.0,
                        cache_read: 2.0,
                        cache_write: 2.0,
                    }
                ),
                (
                    "free-cache".to_owned(),
                    ModelPrice {
                        input: 2.0,
                        output: 8.0,
                        cache_read: 0.0,
                        cache_write: 3.5,
                    }
                ),
            ])
        );
        fs::write(&path, r#"{"usagePriceOverrides":[]}"#).unwrap();
        assert!(usage_price_overrides(&path).is_empty());
    }
}

#[cfg(test)]
mod source_control_tests {
    use super::*;
    #[test]
    fn text_generation_prefers_the_project_then_the_device_then_t3s_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let project: WorkspaceId = "7d4f3c56-62f8-4a36-9a5a-0f58a5a0f0a1".parse().unwrap();
        let other = WorkspaceId::default();
        let default = ModelSelection {
            model: "gpt-6-luna".into(),
            effort: Some("low".into()),
        };
        assert_eq!(text_generation(&path, &project), default);
        fs::write(&path, serde_json::json!({ "textGenerationModelSelection": { "model": "device-writer", "effort": null }, "projectOverrides": { project.to_string(): { "textGenerationModelSelection": { "model": "project-writer", "effort": "high" } } } }).to_string()).unwrap();
        assert_eq!(
            text_generation(&path, &project),
            ModelSelection {
                model: "project-writer".into(),
                effort: Some("high".into())
            }
        );
        assert_eq!(
            text_generation(&path, &other),
            ModelSelection {
                model: "device-writer".into(),
                effort: None
            }
        );
        fs::write(&path, serde_json::json!({ "textGenerationModelSelection": { "model": "device-writer", "effort": "x\" -c sandbox=\"danger" }, "projectOverrides": { project.to_string(): { "textGenerationModelSelection": { "model": "" } } } }).to_string()).unwrap();
        assert_eq!(text_generation(&path, &project), default);
    }
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
