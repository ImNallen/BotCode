// Ported from T3 Code v0.0.45 apps/server/src/mcp/toolkits/pullRequests/tools.ts and preview/tools.ts.
use crate::{AppError, PullRequestKey, Result, ThreadId, TurnId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc};

pub const AGENT_TOOL_GUIDANCE: &str = "Use Bot Code preview tools for browser work. Open the preview before interacting and use locators from its snapshot. Link pull requests you work on to this thread.";
pub(crate) const PR_TOOL_GUIDANCE: &str = "Link pull requests you work on to this thread.";
pub(crate) const INPUT_LIMIT: usize = 1024 * 1024;
pub(crate) const OUTPUT_LIMIT: usize = 6_000_000;
pub(crate) const EXECUTION_TIMEOUT_SECONDS: u64 = 65;
pub(crate) const BRIDGE_TIMEOUT_SECONDS: u64 = EXECUTION_TIMEOUT_SECONDS + 5;
pub(crate) const MCP_TIMEOUT_SECONDS: u64 = BRIDGE_TIMEOUT_SECONDS + 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAnnotations {
    pub read_only_hint: bool,
    pub destructive_hint: bool,
    pub idempotent_hint: bool,
    pub open_world_hint: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub annotations: ToolAnnotations,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub struct ToolContext {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub session_epoch: u64,
    pub call_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ToolContent {
    Text {
        text: String,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub success: bool,
    pub content: Vec<ToolContent>,
}
impl ToolResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            success: true,
            content: vec![ToolContent::Text { text: text.into() }],
        }
    }
    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            success: false,
            content: vec![ToolContent::Text {
                text: message.into(),
            }],
        }
    }
    pub(crate) fn bounded(self) -> Self {
        match serde_json::to_vec(&self) {
            Ok(bytes) if bytes.len() <= OUTPUT_LIMIT && self.content.len() <= 64 => self,
            _ => Self::failure("The tool result exceeds 6 MB or 64 content items."),
        }
    }
}

pub type ToolFuture = Pin<Box<dyn Future<Output = Result<ToolResult>> + Send>>;
pub trait ToolBackend: Send + Sync {
    fn specs(&self) -> Vec<ToolSpec>;
    fn execute(&self, context: ToolContext, call: ToolCall) -> ToolFuture;
}

#[derive(Clone, Default)]
pub enum Registration {
    #[default]
    Dynamic,
    Stdio {
        executable: PathBuf,
    },
}

#[derive(Clone, Default)]
pub struct AgentTools {
    pub registration: Registration,
    pub backend: Option<Arc<dyn ToolBackend>>,
}
impl AgentTools {
    pub fn specs(&self) -> Result<Vec<ToolSpec>> {
        Ok(Registry::new(self.backend.clone())?.specs)
    }
}

pub fn pull_request_tool_specs() -> Vec<ToolSpec> {
    let identity = json!({
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Full https://github.com/owner/repo/pull/number URL."},
            "repository": {"type": "string", "description": "GitHub.com owner/repo."},
            "number": {"type": "integer", "minimum": 1}
        },
        "oneOf": [{"required": ["url"]}, {"required": ["repository", "number"]}],
        "additionalProperties": false
    });
    [
        (
            "link_pull_request",
            "Link a GitHub.com pull request to this thread. Does not create or change the PR.",
            identity.clone(),
            false,
            false,
        ),
        (
            "unlink_pull_request",
            "Remove a pull request link from this thread. Does not change the PR.",
            identity,
            false,
            false,
        ),
        (
            "list_thread_pull_requests",
            "List this thread's linked pull requests and their cached state.",
            json!({"type":"object","properties":{},"additionalProperties":false}),
            true,
            false,
        ),
    ]
    .into_iter()
    .map(
        |(name, description, input_schema, read_only_hint, destructive_hint)| ToolSpec {
            name: name.into(),
            description: description.into(),
            input_schema,
            annotations: ToolAnnotations {
                read_only_hint,
                destructive_hint,
                idempotent_hint: true,
                open_world_hint: false,
            },
        },
    )
    .collect()
}

pub(crate) struct Registry {
    pub specs: Vec<ToolSpec>,
    pub backend: Option<Arc<dyn ToolBackend>>,
}
impl Registry {
    pub fn new(backend: Option<Arc<dyn ToolBackend>>) -> Result<Self> {
        let mut specs = pull_request_tool_specs();
        if let Some(backend) = &backend {
            let preview = backend.specs();
            if preview.len() > 16 {
                return Err(AppError::new("agent_tools", "Too many preview tools."));
            }
            for spec in preview {
                if !spec.name.starts_with("preview_")
                    || spec.name.len() > 64
                    || !spec
                        .name
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b == b'_')
                    || spec.description.len() > 4096
                    || spec.input_schema.get("type").and_then(Value::as_str) != Some("object")
                    || specs.iter().any(|existing| existing.name == spec.name)
                {
                    return Err(AppError::new(
                        "agent_tools",
                        "Invalid or duplicate preview tool specification.",
                    ));
                }
                specs.push(spec);
            }
        }
        if serde_json::to_vec(&specs)?.len() > INPUT_LIMIT {
            return Err(AppError::new(
                "agent_tools",
                "Tool specifications exceed the 1 MiB limit.",
            ));
        }
        Ok(Self { specs, backend })
    }
    pub fn decode(&self, call: ToolCall) -> Result<Action> {
        if !call.arguments.is_object() || serde_json::to_vec(&call.arguments)?.len() > INPUT_LIMIT {
            return Err(AppError::new(
                "tool_arguments",
                "Tool arguments must be an object under 1 MiB.",
            ));
        }
        match call.name.as_str() {
            "link_pull_request" => Ok(Action::Link(identity(call.arguments)?)),
            "unlink_pull_request" => Ok(Action::Unlink(identity(call.arguments)?)),
            "list_thread_pull_requests"
                if call
                    .arguments
                    .as_object()
                    .is_some_and(|object| object.is_empty()) =>
            {
                Ok(Action::List)
            }
            "list_thread_pull_requests" => Err(AppError::new(
                "tool_arguments",
                "list_thread_pull_requests takes no arguments.",
            )),
            _ if self.specs.iter().any(|spec| spec.name == call.name) => Ok(Action::Preview(call)),
            _ => Err(AppError::new("unknown_tool", "Unknown Bot Code tool.")),
        }
    }
}
pub(crate) enum Action {
    Link(PullRequestKey),
    Unlink(PullRequestKey),
    List,
    Preview(ToolCall),
}

fn identity(arguments: Value) -> Result<PullRequestKey> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Identity {
        url: Option<String>,
        repository: Option<String>,
        number: Option<u64>,
    }
    let input: Identity = serde_json::from_value(arguments)
        .map_err(|_| AppError::new("tool_arguments", "Pass a PR URL or repository and number."))?;
    match (input.url, input.repository, input.number) {
        (Some(url), None, None) => PullRequestKey::from_url(&url),
        (None, Some(repository), Some(number)) => {
            let (owner, name) = repository
                .split_once('/')
                .ok_or_else(|| AppError::new("tool_arguments", "repository must be owner/repo."))?;
            PullRequestKey::new(owner, name, number)
        }
        _ => Err(AppError::new(
            "tool_arguments",
            "Pass a PR URL or repository and number, without mixing them.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_and_guidance_have_small_explicit_limits() {
        assert!(AGENT_TOOL_GUIDANCE.len() < 200);
        assert!(
            serde_json::to_vec(&pull_request_tool_specs())
                .unwrap()
                .len()
                < 2500
        );
        assert_eq!(
            pull_request_tool_specs()
                .iter()
                .map(|spec| spec.name.as_str())
                .collect::<Vec<_>>(),
            [
                "link_pull_request",
                "unlink_pull_request",
                "list_thread_pull_requests"
            ]
        );
    }

    #[test]
    fn identity_inputs_respect_github_boundary() {
        let registry = Registry::new(None).unwrap();
        for arguments in [
            json!({"url":"https://github.com/Owner/Repo/pull/42"}),
            json!({"repository":"Owner/Repo","number":42}),
        ] {
            let Action::Link(key) = registry
                .decode(ToolCall {
                    name: "link_pull_request".into(),
                    arguments,
                })
                .unwrap()
            else {
                panic!("expected link")
            };
            assert_eq!(key.url(), "https://github.com/owner/repo/pull/42");
        }
        for arguments in [
            json!({"url":"https://gitlab.com/owner/repo/pull/42"}),
            json!({"repository":"owner/repo","number":0}),
            json!({"url":"https://github.com/owner/repo/pull/42","threadId":"other"}),
            json!({"url":"https://github.com/owner/repo/pull/42","repository":"owner/repo","number":42}),
        ] {
            assert!(
                registry
                    .decode(ToolCall {
                        name: "link_pull_request".into(),
                        arguments
                    })
                    .is_err()
            );
        }
    }
}
