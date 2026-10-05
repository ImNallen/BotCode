use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
// T3 v0.0.45 sidebarAutoSettleAfterDays default. settings.json can change it per project.
pub const AUTO_SETTLE_AFTER_MS: u64 = 3 * 24 * 60 * 60 * 1000;
// Ports T3 v0.0.45 pinnedAt and settledOverride (orchestration/projector.ts,
// ThreadSettlementPolicy.ts). Pin and settle exclude each other, so one value holds both.
// `kept` on a pin is T3's settledOverride "active" alongside pinnedAt.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Placement {
    #[default]
    Auto,
    Kept,
    Pinned {
        at_ms: u64,
        #[serde(default)]
        kept: bool,
    },
    Settled {
        at_ms: u64,
    },
}
// Ports T3 v0.0.45 snoozedUntil and snoozedAt. Snooze overlays any placement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snooze {
    pub until_ms: u64,
    pub at_ms: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Arrange {
    Pin,
    Unpin,
    Settle,
    Unsettle,
    Snooze { until_ms: u64 },
    Wake,
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
    #[serde(default, alias = "settlement")]
    pub placement: Placement,
    #[serde(default)]
    pub snooze: Option<Snooze>,
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
    // Ports threadRaisedHandWhileSnoozed (client-runtime state/threadSettled.ts). Z1 has no
    // user-input requests, and a failed turn is its session error.
    fn raised_hand(&self, snooze: &Snooze) -> bool {
        self.approval_open()
            || self.turns.last().is_some_and(|turn| {
                matches!(
                    turn.execution,
                    Execution::Completed | Execution::Failed { .. }
                ) && turn.completed_at_ms.is_some_and(|at| at > snooze.at_ms)
            })
    }
    // The wake time while the snooze still holds. It stays set after that time passes, so
    // callers compare it with their own clock.
    pub fn snoozed_until(&self) -> Option<u64> {
        self.snooze
            .filter(|snooze| !self.raised_hand(snooze))
            .map(|snooze| snooze.until_ms)
    }
    // Auto-settling is derived on every read, so it needs no timer and survives restarts.
    // `after_ms` is the project's idle limit, and `None` turns auto-settling off.
    pub fn settled_at(&self, now: u64, after_ms: Option<u64>) -> Option<u64> {
        match self.placement {
            Placement::Settled { at_ms } => Some(at_ms),
            Placement::Kept | Placement::Pinned { kept: true, .. } => None,
            Placement::Auto | Placement::Pinned { kept: false, .. } => {
                let after_ms = after_ms?;
                let busy = matches!(
                    self.session,
                    SessionState::Connecting | SessionState::Running | SessionState::Interrupting
                );
                let snoozed = self.snoozed_until().is_some_and(|until| until > now);
                let last_activity = self
                    .turns
                    .iter()
                    .flat_map(|turn| [turn.started_at_ms, turn.completed_at_ms])
                    .flatten()
                    .max()?;
                (!busy
                    && !snoozed
                    && !self.approval_open()
                    && now.saturating_sub(last_activity) >= after_ms)
                    .then_some(last_activity)
            }
        }
    }
    // Stores a due auto-settle as T3's thread.auto-settle command would: settled at the last
    // activity, with the pin and the snooze cleared.
    pub fn auto_settle(&mut self, now: u64, after_ms: Option<u64>) {
        if let (Placement::Auto | Placement::Pinned { .. }, Some(at_ms)) =
            (self.placement, self.settled_at(now, after_ms))
        {
            self.placement = Placement::Settled { at_ms };
            self.snooze = None;
        }
    }
    // Ports the activity reset of decider.ts: it wakes a settled thread and clears a keep.
    pub fn record_activity(&mut self, now: u64, after_ms: Option<u64>) {
        self.auto_settle(now, after_ms);
        self.placement = match self.placement {
            Placement::Settled { .. } | Placement::Kept => Placement::Auto,
            Placement::Pinned { at_ms, .. } => Placement::Pinned { at_ms, kept: false },
            Placement::Auto => Placement::Auto,
        };
    }
    // Ports the pin, settle and snooze rules of orchestration/decider.ts.
    pub fn arrange(&mut self, action: Arrange, now: u64, after_ms: Option<u64>) -> Result<()> {
        self.auto_settle(now, after_ms);
        match action {
            Arrange::Pin => {
                self.placement = match self.placement {
                    Placement::Pinned { .. } => self.placement,
                    Placement::Settled { .. } | Placement::Kept => Placement::Pinned {
                        at_ms: now,
                        kept: true,
                    },
                    Placement::Auto => Placement::Pinned {
                        at_ms: now,
                        kept: false,
                    },
                };
                self.snooze = None;
            }
            Arrange::Unpin => {
                if let Placement::Pinned { kept, .. } = self.placement {
                    self.placement = if kept {
                        Placement::Kept
                    } else {
                        Placement::Auto
                    };
                }
            }
            Arrange::Settle => {
                if !matches!(self.placement, Placement::Settled { .. }) {
                    if self.approval_open() {
                        return Err(AppError::new(
                            "settle_blocked",
                            "Answer the pending approval before settling this thread.",
                        ));
                    }
                    self.placement = Placement::Settled { at_ms: now };
                }
                self.snooze = None;
            }
            Arrange::Unsettle => {
                if matches!(self.placement, Placement::Settled { .. }) {
                    self.placement = Placement::Kept;
                }
            }
            Arrange::Snooze { until_ms } => {
                if until_ms <= now {
                    return Err(AppError::new(
                        "snooze_in_past",
                        "Choose a wake time in the future.",
                    ));
                }
                if self.approval_open() {
                    return Err(AppError::new(
                        "snooze_blocked",
                        "Answer the pending approval before snoozing this thread.",
                    ));
                }
                // A raised hand would stay raised under the old time, so only a
                // snooze that still holds keeps it.
                let at_ms = match self.snooze {
                    Some(snooze) if snooze.until_ms == until_ms && !self.raised_hand(&snooze) => {
                        snooze.at_ms
                    }
                    _ => now,
                };
                self.snooze = Some(Snooze { until_ms, at_ms });
            }
            Arrange::Wake => self.snooze = None,
        }
        Ok(())
    }
    pub fn summary(&self, auto_settle_after_ms: Option<u64>) -> ThreadSummary {
        let settled_at_ms = self.settled_at(now_ms(), auto_settle_after_ms);
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
            pinned_at_ms: match self.placement {
                Placement::Pinned { at_ms, .. } if settled_at_ms.is_none() => Some(at_ms),
                _ => None,
            },
            snoozed_until_ms: self.snoozed_until(),
            settled_at_ms,
            pull_requests: Default::default(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    #[serde(default)]
    pub pull_requests: crate::ThreadPrSummary,
    pub id: ThreadId,
    pub title: String,
    pub session: SessionState,
    pub checkout: Checkout,
    pub updated_at_ms: Option<u64>,
    pub awaiting_approval: bool,
    pub pinned_at_ms: Option<u64>,
    pub snoozed_until_ms: Option<u64>,
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
impl ChangeHint {
    pub fn new(thread: &ThreadSnapshot, auto_settle_after_ms: Option<u64>) -> Self {
        Self {
            thread_id: thread.id.clone(),
            workspace_id: thread.workspace_id.clone(),
            revision: thread.revision,
            summary: thread.summary(auto_settle_after_ms),
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
    #[serde(default)]
    pub unavailable: Option<String>,
}
pub const WORKTREE_REMOVED: &str =
    "This thread's worktree was removed to save space. Send a message to restore it.";
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
/// A checkout's local Git state. Reading it never touches the network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// `None` on a detached HEAD.
    pub branch: Option<BranchStatus>,
    /// `git remote get-url origin` succeeds.
    pub origin: bool,
    /// Changes against HEAD, untracked files included with 0/0. Empty when clean.
    pub files: Vec<FileStat>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStatus {
    pub name: String,
    pub is_default: bool,
    /// The branch a pull request targets: `branch.<name>.gh-merge-base`, else the branch it
    /// was cut from when it still tracks it, else the default branch.
    pub base: String,
    /// Commits on HEAD that `origin/<base>` (else `<base>`) lacks. 0 on the default branch.
    pub ahead_of_base: u32,
    /// `None` until the branch tracks a remote branch of the same name.
    pub upstream: Option<Tracking>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracking {
    pub remote: String,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub insertions: u32,
    pub deletions: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: Option<String>,
    pub url: String,
    pub base: String,
    pub head: String,
}
/// The open pull request for a branch, as gh reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrLookup {
    None,
    Open { pr: PullRequest },
    Unavailable { reason: GhProblem, message: String },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GhProblem {
    Missing,
    Unauthenticated,
    /// Network, timeout or a non-GitHub origin.
    Failed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitAction {
    Commit { message: CommitMessage },
    CommitPush { message: CommitMessage },
    CommitPushPr { message: CommitMessage },
    Push,
    CreatePr,
    Pull,
}
/// Trimmed, non-empty and at most 10,000 bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct CommitMessage(String);
impl TryFrom<String> for CommitMessage {
    type Error = AppError;
    fn try_from(value: String) -> Result<Self> {
        let message = value.trim();
        if message.is_empty() || message.len() > 10_000 {
            return Err(AppError::new(
                "invalid_commit_message",
                "Write a commit message of up to 10,000 characters.",
            ));
        }
        Ok(Self(message.into()))
    }
}
impl From<CommitMessage> for String {
    fn from(message: CommitMessage) -> Self {
        message.0
    }
}
impl CommitMessage {
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn subject(&self) -> &str {
        self.0.lines().next().unwrap_or_default()
    }
}
/// The step a Git action is running, or the one that stopped it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitPhase {
    Commit,
    Push { remote: String },
    Pr,
    Pull,
}
/// What a started Git action did. Steps before a failure stay reported.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOutcome {
    pub commit: Option<Committed>,
    pub push: Option<Pushed>,
    pub pr: Option<PrOpened>,
    pub pull: Option<Pulled>,
    pub failure: Option<GitFailure>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Committed {
    pub sha: String,
    pub subject: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pushed {
    pub sha: String,
    /// "origin/feature".
    pub upstream: String,
    pub set_upstream: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrOpened {
    pub pr: PullRequest,
    /// False when the branch already had an open pull request.
    pub created: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pulled {
    pub upstream: String,
    pub updated: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFailure {
    pub phase: GitPhase,
    pub error: AppError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewObservation {
    pub pr_id: String,
    pub finding_id: String,
    pub head_sha: String,
    pub content_digest: String,
}
impl ReviewObservation {
    pub fn validate(&self) -> Result<()> {
        let id = |s: &str| {
            !s.is_empty()
                && s.len() <= 256
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_=-:".contains(&c))
        };
        let hex = |s: &str, len| s.len() == len && s.bytes().all(|c| c.is_ascii_hexdigit());
        if !id(&self.pr_id)
            || !id(&self.finding_id)
            || !hex(&self.head_sha, 40)
            || !hex(&self.content_digest, 64)
        {
            return Err(AppError::new(
                "invalid_review",
                "Invalid review observation.",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReviewChoice {
    Fix,
    Dismiss { reason: String },
    NeedsDecision,
}
impl ReviewChoice {
    pub fn validate(&self) -> Result<()> {
        if let Self::Dismiss { reason } = self
            && (reason.trim().is_empty() || reason.len() > 4000)
        {
            return Err(AppError::new(
                "invalid_review",
                "Dismiss needs a reason of at most 4000 bytes.",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDisposition {
    pub observation: ReviewObservation,
    pub choice: ReviewChoice,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub body: String,
    pub url: String,
    pub author: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub context: Option<ReviewContext>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewContext {
    pub original_commit: Option<String>,
    pub path: Option<String>,
    pub original_line: Option<u64>,
    pub diff_hunk: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewSource {
    Thread { resolved: bool, outdated: bool },
    Review,
    Conversation,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFinding {
    pub observation: ReviewObservation,
    pub source: ReviewSource,
    pub comments: Vec<ReviewComment>,
    pub saved: Option<SavedDisposition>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPullRequest {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub head_sha: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ReviewFindings {
    None {
        branch: String,
    },
    Ready {
        branch: String,
        checkout_head: String,
        pr: ReviewPullRequest,
        findings: Vec<ReviewFinding>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetReviewDisposition {
    pub branch: String,
    pub observation: ReviewObservation,
    pub expected: Option<SavedDisposition>,
    pub choice: Option<ReviewChoice>,
}
impl SetReviewDisposition {
    pub fn validate(&self) -> Result<()> {
        self.observation.validate()?;
        if let Some(choice) = &self.choice {
            choice.validate()?;
        }
        if let Some(expected) = &self.expected {
            expected.observation.validate()?;
            expected.choice.validate()?;
            if expected.observation.pr_id != self.observation.pr_id
                || expected.observation.finding_id != self.observation.finding_id
            {
                return Err(AppError::new(
                    "invalid_review",
                    "The saved decision belongs to another finding.",
                ));
            }
        }
        Ok(())
    }
}
