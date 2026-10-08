// Ports T3 Code v0.0.45 packages/contracts/src/t3ProjectFile.ts and apps/web/src/projectScripts.ts (MIT).
use crate::{AppError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScript {
    pub id: String,
    pub name: String,
    pub command: String,
    pub icon: String,
    pub run_on_worktree_create: bool,
    pub r#async: bool,
    pub preview_url: Option<String>,
    pub auto_open_preview: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub scripts: Vec<ProjectScript>,
    pub default_thread_env_mode: Option<String>,
    pub worktree_submodules: String,
    pub icon_path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetup {
    #[serde(default)]
    pub head_oid: Option<String>,
    pub id: String,
    pub script: Option<ProjectScript>,
    pub cwd: String,
    pub state: SetupState,
    pub output: Vec<String>,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub(crate) submodules: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SetupState {
    Pending,
    Running,
    Succeeded,
    Failed {
        reason: String,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
    },
    Interrupted {
        reason: String,
    },
}
impl WorktreeSetup {
    pub(crate) fn active(&self) -> bool {
        matches!(self.state, SetupState::Pending | SetupState::Running)
    }
    pub(crate) fn blocks(&self) -> bool {
        self.active() && self.script.as_ref().is_none_or(|s| !s.r#async)
    }
}
fn invalid(reason: impl std::fmt::Display) -> AppError {
    AppError::new("project_config", format!("Invalid t3.json: {reason}"))
}
fn string(v: &Value, key: &str) -> Result<Option<String>> {
    v.get(key)
        .map(|v| {
            v.as_str()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(String::from)
                .ok_or_else(|| invalid(format!("{key} must be a nonempty string")))
        })
        .transpose()
}
fn boolean(v: &Value, key: &str, default: bool) -> Result<bool> {
    v.get(key)
        .map(|v| {
            v.as_bool()
                .ok_or_else(|| invalid(format!("{key} must be a boolean")))
        })
        .unwrap_or(Ok(default))
}
fn choice(v: &Value, key: &str, choices: &[&str]) -> Result<Option<String>> {
    let value = string(v, key)?;
    if value
        .as_ref()
        .is_some_and(|v| !choices.contains(&v.as_str()))
    {
        return Err(invalid(format!("unknown {key}")));
    }
    Ok(value)
}
pub(crate) fn read(root: &Path) -> Result<ProjectConfig> {
    let text = match std::fs::read_to_string(root.join("t3.json")) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "{}".into(),
        Err(e) => return Err(invalid(e)),
    };
    let v: Value = serde_json::from_str(&jsonc(&text)?).map_err(invalid)?;
    if !v.is_object() {
        return Err(invalid("expected an object"));
    }
    if v.get("$schema").is_some_and(|v| !v.is_string()) {
        return Err(invalid("$schema must be a string"));
    }
    let icon_path = string(&v, "iconPath")?;
    if icon_path.as_ref().is_some_and(|s| s.chars().count() > 512) {
        return Err(invalid("iconPath exceeds 512 characters"));
    }
    let mut scripts: Vec<ProjectScript> = vec![];
    if let Some(raw) = v.get("scripts") {
        let raw = raw
            .as_array()
            .ok_or_else(|| invalid("scripts must be an array"))?;
        if raw.len() > 50 {
            return Err(invalid("at most 50 scripts are allowed"));
        }
        for s in raw {
            let name = string(s, "name")?.ok_or_else(|| invalid("script name is required"))?;
            let command =
                string(s, "command")?.ok_or_else(|| invalid("script command is required"))?;
            let base = name
                .to_lowercase()
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("-")
                .chars()
                .take(24)
                .collect::<String>();
            let base = base.trim_end_matches('-').to_owned();
            let base = if base.is_empty() {
                "script".into()
            } else {
                base
            };
            let mut id = base.clone();
            let mut suffix = 2;
            while scripts.iter().any(|s| s.id == id) {
                let tail = format!("-{suffix}");
                id = format!("{}{}", &base[..base.len().min(24 - tail.len())], tail);
                suffix += 1;
            }
            scripts.push(ProjectScript {
                id,
                name,
                command,
                icon: choice(
                    s,
                    "icon",
                    &["play", "test", "lint", "configure", "build", "debug"],
                )?
                .unwrap_or("play".into()),
                run_on_worktree_create: boolean(s, "runOnWorktreeCreate", false)?,
                r#async: boolean(s, "async", true)?,
                preview_url: string(s, "previewUrl")?,
                auto_open_preview: boolean(s, "autoOpenPreview", false)?,
            });
        }
    }
    Ok(ProjectConfig {
        scripts,
        icon_path,
        default_thread_env_mode: choice(&v, "defaultThreadEnvMode", &["local", "worktree"])?,
        worktree_submodules: choice(
            &v,
            "worktreeSubmodules",
            &["none", "top-level", "recursive"],
        )?
        .unwrap_or("recursive".into()),
    })
}
fn jsonc(input: &str) -> Result<String> {
    let mut bytes = input.as_bytes().to_vec();
    let mut i = 0;
    let mut quoted = false;
    while i < bytes.len() {
        if quoted {
            if bytes[i] == b'\\' {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                quoted = false;
            }
        } else if bytes[i] == b'"' {
            quoted = true;
        } else if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'/') {
            while i < bytes.len() && bytes[i] != b'\n' {
                bytes[i] = b' ';
                i += 1;
            }
            continue;
        } else if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
            bytes[i] = b' ';
            bytes[i + 1] = b' ';
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                if bytes[i] != b'\n' {
                    bytes[i] = b' ';
                }
                i += 1;
            }
            if i + 1 >= bytes.len() {
                return Err(invalid("unterminated comment"));
            }
            bytes[i] = b' ';
            bytes[i + 1] = b' ';
            i += 2;
            continue;
        }
        i += 1;
    }
    i = 0;
    quoted = false;
    while i < bytes.len() {
        if quoted {
            if bytes[i] == b'\\' {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                quoted = false;
            }
        } else if bytes[i] == b'"' {
            quoted = true;
        } else if bytes[i] == b',' {
            let next = bytes[i + 1..].iter().find(|c| !c.is_ascii_whitespace());
            if matches!(next, Some(b'}' | b']')) {
                bytes[i] = b' ';
            }
        }
        i += 1;
    }
    String::from_utf8(bytes).map_err(invalid)
}
pub(crate) fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub(crate) fn shell(configured: Option<&Path>) -> std::path::PathBuf {
    configured
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("SHELL").map(std::path::PathBuf::from))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| "/bin/sh".into())
}
