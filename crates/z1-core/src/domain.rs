use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
}
impl AppError {
    pub fn new(code: &str, message: impl ToString) -> Self {
        Self {
            code: code.into(),
            message: message.to_string(),
        }
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for AppError {}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", e)
    }
}
impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new("storage", e)
    }
}
impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::new("protocol", e)
    }
}
pub type Result<T> = std::result::Result<T, AppError>;

macro_rules! id {
    ($name:ident) => {
        #[derive(Debug, Clone, Hash, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);
        impl Default for $name {
            fn default() -> Self {
                Self(Uuid::new_v4())
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }
        impl std::str::FromStr for $name {
            type Err = AppError;
            fn from_str(s: &str) -> Result<Self> {
                Uuid::parse_str(s)
                    .map(Self)
                    .map_err(|e| AppError::new("invalid_id", e))
            }
        }
    };
}
id!(WorkspaceId);
id!(ThreadId);
id!(TurnId);
id!(ApprovalId);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: WorkspaceId,
    pub root: PathBuf,
    pub label: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionState {
    Draft,
    Connecting,
    Ready,
    Running,
    Interrupting,
    Dormant,
    Unavailable { reason: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Delivery {
    Preparing,
    Sending,
    Accepted,
    NotSent { reason: String },
    Uncertain { reason: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Execution {
    NotStarted,
    Running,
    Completed,
    Interrupted,
    Failed { reason: String },
    Lost { reason: String },
}
impl Execution {
    pub fn active(&self) -> bool {
        matches!(self, Self::NotStarted | Self::Running)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Item {
    Assistant {
        id: String,
        text: String,
        complete: bool,
    },
    Command {
        id: String,
        command: String,
        output: String,
        status: String,
    },
    FileChange {
        id: String,
        text: String,
        status: String,
    },
    Other {
        id: String,
        label: String,
        text: String,
    },
}
impl Item {
    pub fn id(&self) -> &str {
        match self {
            Self::Assistant { id, .. }
            | Self::Command { id, .. }
            | Self::FileChange { id, .. }
            | Self::Other { id, .. } => id,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: TurnId,
    pub prompt: String,
    pub native_turn_id: Option<String>,
    pub delivery: Delivery,
    pub execution: Execution,
    pub items: Vec<Item>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalState {
    Pending,
    Answering,
    Answered,
    Expired,
    Uncertain,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ApprovalAction {
    Command {
        command: String,
        cwd: String,
        reason: String,
    },
    FileChange {
        text: String,
        reason: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: ApprovalId,
    pub turn_id: TurnId,
    pub action: ApprovalAction,
    pub state: ApprovalState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Accept,
    Decline,
    Cancel,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub id: ThreadId,
    pub workspace_id: WorkspaceId,
    pub title: String,
    pub native_thread_id: Option<String>,
    pub revision: u64,
    pub session: SessionState,
    pub turns: Vec<Turn>,
    pub approvals: Vec<Approval>,
    pub diagnostic: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: ThreadId,
    pub title: String,
    pub session: SessionState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub turn_id: TurnId,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeHint {
    pub thread_id: ThreadId,
    pub workspace_id: WorkspaceId,
    pub revision: u64,
    pub refresh_workspace: bool,
}
impl From<&ThreadSnapshot> for ChangeHint {
    fn from(thread: &ThreadSnapshot) -> Self {
        Self {
            thread_id: thread.id.clone(),
            workspace_id: thread.workspace_id.clone(),
            revision: thread.revision,
            refresh_workspace: matches!(
                thread.session,
                SessionState::Ready | SessionState::Unavailable { .. }
            ),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub workspace: Workspace,
    pub branch: String,
    pub files: Vec<String>,
    pub changes: Vec<GitChange>,
    pub threads: Vec<ThreadSummary>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub original_path: Option<String>,
    pub staged: bool,
    pub unstaged: bool,
    pub status: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffBasis {
    Staged,
    Unstaged,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileView {
    Text { name: String, contents: String },
    Unavailable { reason: String },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiffView {
    Text {
        old_name: String,
        old_contents: String,
        new_name: String,
        new_contents: String,
    },
    Unavailable {
        reason: String,
    },
}
