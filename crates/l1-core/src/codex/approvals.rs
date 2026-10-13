// Ported from T3 Code v0.0.45 apps/server/src/provider/Layers/CodexSessionRuntime.ts.
use crate::domain::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

#[derive(Deserialize)]
#[serde(tag = "method")]
enum ServerRequest {
    #[serde(rename = "item/commandExecution/requestApproval")]
    Command { params: CommandRequest },
    #[serde(rename = "item/fileChange/requestApproval")]
    FileChange { params: FileRequest },
    #[serde(rename = "item/permissions/requestApproval")]
    Permission { params: PermissionRequest },
    #[serde(rename = "mcpServer/elicitation/request")]
    McpElicitation { params: McpRequest },
    #[serde(rename = "item/tool/requestUserInput")]
    UserInput { params: UserInputRequest },
    #[serde(rename = "execCommandApproval")]
    LegacyCommand { params: LegacyCommand },
    #[serde(rename = "applyPatchApproval")]
    LegacyFileChange { params: LegacyFileChange },
    #[serde(other)]
    Unsupported,
}

pub(crate) enum Request {
    Approval(PendingApproval),
    UserInput(UserInputRequest),
    Unsupported,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Target {
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandRequest {
    #[serde(flatten)]
    target: Target,
    command: Option<String>,
    cwd: Option<String>,
    reason: Option<String>,
    network_approval_context: Option<NetworkContext>,
}
#[derive(Deserialize)]
struct NetworkContext {
    host: String,
    protocol: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRequest {
    #[serde(flatten)]
    target: Target,
    reason: Option<String>,
    grant_root: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionRequest {
    #[serde(flatten)]
    target: Target,
    reason: Option<String>,
    permissions: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserInputRequest {
    #[serde(flatten)]
    pub target: Target,
    pub questions: Vec<UserQuestion>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpRequest {
    thread_id: String,
    turn_id: Option<String>,
    server_name: String,
    message: String,
    #[serde(flatten)]
    payload: McpPayload,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "mode")]
enum McpPayload {
    #[serde(rename = "form", alias = "openai/form", alias = "openaiForm")]
    Form {
        #[serde(rename = "_meta")]
        meta: Option<Value>,
        #[serde(rename = "requestedSchema")]
        schema: Value,
    },
    #[serde(rename = "url")]
    Url,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCommand {
    conversation_id: String,
    call_id: String,
    command: Vec<String>,
    cwd: String,
    reason: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyFileChange {
    conversation_id: String,
    call_id: String,
    file_changes: BTreeMap<String, LegacyChange>,
    reason: Option<String>,
    grant_root: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LegacyChange {
    Add {
        content: String,
    },
    Delete {
        content: String,
    },
    Update {
        unified_diff: String,
        move_path: Option<String>,
    },
}
#[derive(Clone)]
pub(crate) enum ApprovalReply {
    Item,
    Legacy,
    Permission(Value),
    Mcp(Box<McpReply>),
}
#[derive(Clone)]
pub(crate) struct McpReply {
    form: Option<Form>,
    metadata: Metadata,
}
pub(crate) struct PendingApproval {
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub item_id: String,
    pub action: ApprovalAction,
    pub options: Vec<ApprovalOption>,
    pub reply: ApprovalReply,
}
fn option(decision: ApprovalDecision, label: &str) -> ApprovalOption {
    ApprovalOption {
        decision,
        label: label.into(),
        warning: None,
    }
}
fn item_options() -> Vec<ApprovalOption> {
    vec![
        option(ApprovalDecision::Cancel, "Cancel"),
        option(ApprovalDecision::Decline, "Decline"),
        option(
            ApprovalDecision::AcceptForSession,
            "Always allow this session",
        ),
        option(ApprovalDecision::Accept, "Approve"),
    ]
}
fn pending(target: Target, action: ApprovalAction, reply: ApprovalReply) -> PendingApproval {
    PendingApproval {
        thread_id: target.thread_id,
        turn_id: Some(target.turn_id),
        item_id: target.item_id,
        action,
        options: item_options(),
        reply,
    }
}
pub(crate) fn decode(value: Value) -> Result<Request> {
    let parsed: ServerRequest = serde_json::from_value(value)?;
    Ok(match parsed {
        ServerRequest::Command { params: p } => Request::Approval(pending(
            p.target,
            ApprovalAction::Command {
                command: p
                    .command
                    .filter(|command| !command.trim().is_empty())
                    .or_else(|| {
                        p.network_approval_context
                            .filter(|context| !context.host.trim().is_empty())
                            .map(|context| {
                                format!(
                                    "Network access to {} via {}",
                                    context.host, context.protocol
                                )
                            })
                    })
                    .or_else(|| p.reason.clone().filter(|reason| !reason.trim().is_empty()))
                    .unwrap_or_default(),
                cwd: p.cwd.unwrap_or_default(),
                reason: p.reason.unwrap_or_default(),
            },
            ApprovalReply::Item,
        )),
        ServerRequest::FileChange { params: p } => Request::Approval(pending(
            p.target,
            ApprovalAction::FileChange {
                text: p
                    .grant_root
                    .filter(|root| !root.trim().is_empty())
                    .map(|root| format!("Write access under {root}"))
                    .or_else(|| p.reason.clone().filter(|reason| !reason.trim().is_empty()))
                    .unwrap_or_default(),
                reason: p.reason.unwrap_or_default(),
            },
            ApprovalReply::Item,
        )),
        ServerRequest::Permission { params: p } => {
            let detail = serde_json::to_string_pretty(&p.permissions)?;
            if !p.permissions.is_object() {
                return Err(AppError::new(
                    "protocol",
                    "Codex supplied an invalid permission profile.",
                ));
            }
            Request::Approval(pending(
                p.target,
                ApprovalAction::Permission {
                    detail,
                    reason: p.reason.unwrap_or_default(),
                },
                ApprovalReply::Permission(p.permissions),
            ))
        }
        ServerRequest::McpElicitation { params: p } => {
            let reply = match p.payload {
                McpPayload::Form { meta, schema } => McpReply {
                    form: serde_json::from_value(schema).ok(),
                    metadata: meta
                        .and_then(|meta| serde_json::from_value(meta).ok())
                        .unwrap_or_default(),
                },
                McpPayload::Url => McpReply {
                    form: None,
                    metadata: Metadata::default(),
                },
            };
            let (app_name, options) = reply.describe(&p.server_name, &p.message);
            Request::Approval(PendingApproval {
                thread_id: p.thread_id,
                turn_id: p.turn_id,
                item_id: String::new(),
                action: ApprovalAction::McpElicitation {
                    detail: p.message,
                    reason: String::new(),
                    app_name,
                },
                options,
                reply: ApprovalReply::Mcp(Box::new(reply)),
            })
        }
        ServerRequest::LegacyCommand { params: p } => Request::Approval(PendingApproval {
            thread_id: p.conversation_id,
            turn_id: None,
            item_id: p.call_id,
            action: ApprovalAction::Command {
                command: p
                    .command
                    .into_iter()
                    .map(|arg| {
                        if !arg.is_empty()
                            && arg
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || "-_/.:=".contains(c))
                        {
                            arg
                        } else {
                            format!("'{}'", arg.replace('\'', "'\"'\"'"))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
                cwd: p.cwd,
                reason: p.reason.unwrap_or_default(),
            },
            options: item_options(),
            reply: ApprovalReply::Legacy,
        }),
        ServerRequest::LegacyFileChange { params: p } => {
            let text = p
                .file_changes
                .into_iter()
                .map(|(path, change)| match change {
                    LegacyChange::Add { content } => format!("Added {path}\n{content}"),
                    LegacyChange::Delete { content } => format!("Deleted {path}\n{content}"),
                    LegacyChange::Update {
                        unified_diff,
                        move_path,
                    } => format!(
                        "Updated {path}{}\n{unified_diff}",
                        move_path
                            .map(|path| format!(" -> {path}"))
                            .unwrap_or_default()
                    ),
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let text = if text.trim().is_empty() {
                p.grant_root
                    .filter(|root| !root.trim().is_empty())
                    .map(|root| format!("Write access under {root}"))
                    .or_else(|| p.reason.clone().filter(|reason| !reason.trim().is_empty()))
                    .unwrap_or_default()
            } else {
                text
            };
            Request::Approval(PendingApproval {
                thread_id: p.conversation_id,
                turn_id: None,
                item_id: p.call_id,
                action: ApprovalAction::FileChange {
                    text,
                    reason: p.reason.unwrap_or_default(),
                },
                options: item_options(),
                reply: ApprovalReply::Legacy,
            })
        }
        ServerRequest::UserInput { params: p } => Request::UserInput(p),
        ServerRequest::Unsupported => Request::Unsupported,
    })
}
impl ApprovalReply {
    pub fn unsupported_response(&self) -> Option<Value> {
        match self {
            Self::Mcp(reply) if reply.response(ApprovalDecision::Accept)["action"] != "accept" => {
                Some(json!({"action":"decline"}))
            }
            _ => None,
        }
    }
    pub fn response(&self, decision: ApprovalDecision) -> Value {
        match self {
            Self::Item => {
                json!({"decision":match decision { ApprovalDecision::Accept => "accept", ApprovalDecision::AcceptForSession | ApprovalDecision::AcceptAlways => "acceptForSession", ApprovalDecision::Decline => "decline", ApprovalDecision::Cancel => "cancel" }})
            }
            Self::Legacy => {
                json!({"decision":match decision { ApprovalDecision::Accept => json!("approved"), ApprovalDecision::AcceptForSession | ApprovalDecision::AcceptAlways => json!("approved_for_session"), ApprovalDecision::Decline => json!({"denied":{"rejection":"Declined by the user."}}), ApprovalDecision::Cancel => json!("abort") }})
            }
            Self::Permission(permissions) => {
                json!({"permissions":if matches!(decision, ApprovalDecision::Accept | ApprovalDecision::AcceptForSession) { permissions.clone() } else { json!({}) },"scope":if decision == ApprovalDecision::AcceptForSession { "session" } else { "turn" }})
            }
            Self::Mcp(reply) => reply.response(decision),
        }
    }
}
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    app: Option<String>,
    #[serde(rename = "app_name")]
    app_name: Option<String>,
    #[serde(rename = "appName")]
    camel_app_name: Option<String>,
    #[serde(rename = "connector_name")]
    connector_name: Option<String>,
    #[serde(rename = "connectorName")]
    camel_connector_name: Option<String>,
    allow_persistent_approval: Option<bool>,
    persist: Option<Persist>,
    target: Option<MetadataTarget>,
    #[serde(rename = "tool_params")]
    tool_params: Option<ToolParams>,
}
#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum Persist {
    One(String),
    Many(Vec<String>),
}
#[derive(Clone, Deserialize)]
struct MetadataTarget {
    app: Option<String>,
    name: Option<String>,
}
#[derive(Clone, Deserialize)]
struct ToolParams {
    app: Option<String>,
    app_name: Option<String>,
}
#[derive(Clone, Default, Deserialize)]
struct Form {
    #[serde(default)]
    properties: BTreeMap<String, Field>,
    required: Option<Vec<String>>,
}
#[derive(Clone, Deserialize)]
struct Field {
    #[serde(rename = "type")]
    kind: Option<String>,
    title: Option<String>,
    description: Option<String>,
    default: Option<Value>,
    #[serde(rename = "enum")]
    values: Option<Vec<String>>,
    #[serde(rename = "enumNames")]
    names: Option<Vec<String>>,
    #[serde(rename = "oneOf")]
    one_of: Option<Vec<FieldOption>>,
}
#[derive(Clone, Deserialize)]
struct FieldOption {
    #[serde(rename = "const")]
    value: String,
    title: Option<String>,
}
fn persistence(value: &str) -> Option<ApprovalDecision> {
    let value = value.to_lowercase();
    if value.contains("session") {
        Some(ApprovalDecision::AcceptForSession)
    } else if ["always", "permanent", "forever", "persistent"]
        .iter()
        .any(|word| value.contains(word))
    {
        Some(ApprovalDecision::AcceptAlways)
    } else {
        None
    }
}
impl Field {
    fn options(&self) -> Vec<(&str, Option<&str>)> {
        if let Some(one_of) = &self.one_of {
            return one_of
                .iter()
                .map(|option| (option.value.as_str(), option.title.as_deref()))
                .collect();
        }
        self.values
            .as_ref()
            .map(|values| {
                values
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        (
                            value.as_str(),
                            self.names
                                .as_ref()
                                .and_then(|names| names.get(index))
                                .map(String::as_str),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    fn persistence(&self, key: &str) -> bool {
        key.eq_ignore_ascii_case("persist")
            || [
                key,
                self.title.as_deref().unwrap_or_default(),
                self.description.as_deref().unwrap_or_default(),
            ]
            .iter()
            .any(|value| persistence(value).is_some())
    }
}
impl McpReply {
    fn describe(&self, server: &str, message: &str) -> (String, Vec<ApprovalOption>) {
        let metadata = self.metadata.clone();
        let message_app = if message.to_lowercase().starts_with("allow chatgpt to use ") {
            message
                .strip_suffix('?')
                .map(|value| value[20..].to_owned())
        } else {
            None
        };
        let app = metadata
            .app_name
            .or(metadata.camel_app_name)
            .or(metadata.app)
            .or_else(|| {
                metadata
                    .target
                    .and_then(|target| target.app.or(target.name))
            })
            .or_else(|| {
                metadata
                    .tool_params
                    .and_then(|params| params.app_name.or(params.app))
            })
            .or(message_app)
            .or(metadata.connector_name)
            .or(metadata.camel_connector_name)
            .unwrap_or_else(|| server.into());
        let mut persistence_options = HashMap::new();
        let values = match metadata.persist {
            Some(Persist::One(value)) => vec![value],
            Some(Persist::Many(values)) => values,
            None => vec![],
        };
        for value in values {
            if let Some(decision) = persistence(&value) {
                persistence_options.insert(decision, String::new());
            }
        }
        if metadata.allow_persistent_approval == Some(true) {
            persistence_options.insert(ApprovalDecision::AcceptAlways, String::new());
        }
        for (key, field) in self.form.clone().unwrap_or_default().properties {
            for (value, label) in field.options() {
                if let Some(decision) = persistence(value) {
                    persistence_options.insert(decision, label.unwrap_or_default().to_owned());
                }
            }
            if field.kind.as_deref() == Some("boolean") && field.persistence(&key) {
                persistence_options.insert(
                    ApprovalDecision::AcceptAlways,
                    field.title.unwrap_or_default(),
                );
            }
        }
        let mut options = vec![
            option(ApprovalDecision::Cancel, "Cancel"),
            option(ApprovalDecision::Decline, "Decline"),
        ];
        for (decision, fallback) in [
            (
                ApprovalDecision::AcceptForSession,
                "Always allow this session",
            ),
            (ApprovalDecision::AcceptAlways, "Always allow"),
        ] {
            if let Some(label) = persistence_options.get(&decision)
                && self.response(decision)["action"] == "accept"
            {
                options.push(option(
                    decision,
                    if label.is_empty() { fallback } else { label },
                ));
            }
        }
        options.push(option(ApprovalDecision::Accept, "Approve"));
        (app, options)
    }
    fn response(&self, decision: ApprovalDecision) -> Value {
        match decision {
            ApprovalDecision::Decline => return json!({"action":"decline"}),
            ApprovalDecision::Cancel => return json!({"action":"cancel"}),
            _ => {}
        }
        let persist = match decision {
            ApprovalDecision::AcceptForSession => Some("session"),
            ApprovalDecision::AcceptAlways => Some("always"),
            _ => None,
        };
        let Some(form) = self.form.as_ref() else {
            return json!({"action":"decline"});
        };
        let mut content = serde_json::Map::new();
        for (key, field) in &form.properties {
            let chosen = field.options().into_iter().find(|(value, _)| {
                if persist.is_some() {
                    persistence(value) == Some(decision)
                } else {
                    ["once", "accept", "approve", "allow"]
                        .iter()
                        .any(|word| value.to_lowercase().contains(word))
                        && persistence(value).is_none()
                }
            });
            if let Some((value, _)) = chosen {
                content.insert(key.clone(), json!(value));
            } else if field.kind.as_deref() == Some("boolean") && field.persistence(key) {
                content.insert(
                    key.clone(),
                    json!(decision == ApprovalDecision::AcceptAlways),
                );
            } else if let Some(default) = &field.default {
                content.insert(key.clone(), default.clone());
            }
        }
        if form
            .required
            .as_ref()
            .is_some_and(|required| required.iter().any(|key| !content.contains_key(key)))
        {
            return json!({"action":"decline"});
        }
        let mut result = json!({"action":"accept"});
        if let Some(persist) = persist {
            result["_meta"] = json!({"persist":persist});
        }
        result["content"] = Value::Object(content);
        result
    }
}
