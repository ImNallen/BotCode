use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceKind {
    #[default]
    Repository,
    Scratch,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: WorkspaceId,
    pub root: PathBuf,
    pub label: String,
    #[serde(default)]
    pub kind: WorkspaceKind,
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
        #[serde(default)]
        paths: Vec<String>,
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    #[default]
    ApprovalRequired,
    AutoAcceptEdits,
    Auto,
    FullAccess,
}
impl PermissionMode {
    pub fn protocol(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::ApprovalRequired => ("untrusted", "user", "read-only"),
            Self::AutoAcceptEdits => ("on-request", "user", "workspace-write"),
            Self::Auto => ("on-request", "auto_review", "workspace-write"),
            Self::FullAccess => ("never", "user", "danger-full-access"),
        }
    }
    pub fn sandbox_policy(self) -> serde_json::Value {
        match self {
            Self::ApprovalRequired => serde_json::json!({"type":"readOnly"}),
            Self::AutoAcceptEdits | Self::Auto => serde_json::json!({"type":"workspaceWrite"}),
            Self::FullAccess => serde_json::json!({"type":"dangerFullAccess"}),
        }
    }
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettings {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: PermissionMode,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffortOption {
    pub reasoning_effort: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<ReasoningEffortOption>,
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
    #[serde(default)]
    pub settings: Option<SessionSettings>,
    #[serde(default)]
    pub started_at_ms: Option<u64>,
    #[serde(default)]
    pub completed_at_ms: Option<u64>,
}
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
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
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Checkout {
    #[default]
    Local,
    Worktree {
        path: PathBuf,
        branch: String,
    },
    Folder {
        path: PathBuf,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum NewCheckout {
    Local,
    Worktree { base: String, from_origin: bool },
    Folder { prompt: String },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub default: bool,
    pub worktree: Option<PathBuf>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub branches: Vec<Branch>,
    pub origin: bool,
}
// T3 v0.0.45 sidebarAutoSettleAfterDays default.
pub const AUTO_SETTLE_AFTER_MS: u64 = 3 * 24 * 60 * 60 * 1000;
// Ports T3 v0.0.45 settledOverride (orchestration/projector.ts, ThreadSettlementPolicy.ts).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Settlement {
    #[default]
    Auto,
    Settled {
        at_ms: u64,
    },
    Kept,
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
    #[serde(default)]
    pub settings: SessionSettings,
    #[serde(default)]
    pub checkout: Checkout,
    pub turns: Vec<Turn>,
    pub approvals: Vec<Approval>,
    pub diagnostic: Option<String>,
    #[serde(default)]
    pub settlement: Settlement,
}
impl ThreadSnapshot {
    pub fn root<'a>(&'a self, workspace: &'a Workspace) -> &'a Path {
        match &self.checkout {
            Checkout::Local => &workspace.root,
            Checkout::Worktree { path, .. } | Checkout::Folder { path } => path,
        }
    }
    pub fn stamp_completions(&mut self) {
        let now = now_ms();
        for turn in &mut self.turns {
            let finished = match turn.execution {
                Execution::Completed | Execution::Interrupted | Execution::Failed { .. } => true,
                Execution::NotStarted | Execution::Running | Execution::Lost { .. } => false,
            };
            if finished && turn.completed_at_ms.is_none() {
                turn.completed_at_ms = Some(now);
            }
        }
    }
    pub fn approval_open(&self) -> bool {
        self.approvals.iter().any(|approval| {
            matches!(
                approval.state,
                ApprovalState::Pending | ApprovalState::Answering
            )
        })
    }
    // Auto-settling is derived on every read, so it needs no timer and survives restarts.
    pub fn settled_at(&self, now: u64) -> Option<u64> {
        match self.settlement {
            Settlement::Settled { at_ms } => Some(at_ms),
            Settlement::Kept => None,
            Settlement::Auto => {
                let busy = matches!(
                    self.session,
                    SessionState::Connecting | SessionState::Running | SessionState::Interrupting
                );
                let last_activity = self
                    .turns
                    .iter()
                    .flat_map(|turn| [turn.started_at_ms, turn.completed_at_ms])
                    .flatten()
                    .max()?;
                (!busy
                    && !self.approval_open()
                    && now.saturating_sub(last_activity) >= AUTO_SETTLE_AFTER_MS)
                    .then_some(last_activity + AUTO_SETTLE_AFTER_MS)
            }
        }
    }
    pub fn summary(&self) -> ThreadSummary {
        ThreadSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            session: self.session.clone(),
            checkout: self.checkout.clone(),
            updated_at_ms: self.turns.iter().rev().find_map(|turn| turn.started_at_ms),
            awaiting_approval: self
                .approvals
                .iter()
                .any(|approval| approval.state == ApprovalState::Pending),
            settled_at_ms: self.settled_at(now_ms()),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: ThreadId,
    pub title: String,
    pub session: SessionState,
    pub checkout: Checkout,
    pub updated_at_ms: Option<u64>,
    pub awaiting_approval: bool,
    pub settled_at_ms: Option<u64>,
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
    pub summary: ThreadSummary,
}
impl From<&ThreadSnapshot> for ChangeHint {
    fn from(thread: &ThreadSnapshot) -> Self {
        Self {
            thread_id: thread.id.clone(),
            workspace_id: thread.workspace_id.clone(),
            revision: thread.revision,
            summary: thread.summary(),
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
