use crate::MessageContext;
use crate::usage::ContextUsage;
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
id!(UserQuestionRequestId);

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolStatus {
    InProgress,
    Completed,
    Failed,
    Declined,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubAgentActivity {
    Started,
    Interacted,
    Interrupted,
    Completed,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Item {
    UserInput {
        id: String,
        text: String,
        attachments: Vec<Attachment>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context: Option<MessageContext>,
        delivery: Delivery,
    },
    Assistant {
        id: String,
        text: String,
        complete: bool,
    },
    Plan {
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
    Reasoning {
        id: String,
        text: String,
        complete: bool,
    },
    McpToolCall {
        id: String,
        server: String,
        tool: String,
        title: String,
        status: ToolStatus,
        arguments: serde_json::Value,
        result: Option<String>,
        error: Option<String>,
        duration_ms: Option<u64>,
    },
    DynamicToolCall {
        id: String,
        tool: String,
        status: ToolStatus,
    },
    CollabAgentToolCall {
        id: String,
        tool: String,
        prompt: Option<String>,
        status: ToolStatus,
    },
    SubAgentActivity {
        id: String,
        activity: SubAgentActivity,
        agent_path: String,
        agent_thread_id: String,
    },
    WebSearch {
        id: String,
        query: String,
        status: ToolStatus,
    },
    ImageView {
        id: String,
        path: String,
    },
    ImageGeneration {
        id: String,
        status: ToolStatus,
    },
    ContextCompaction {
        id: String,
        complete: bool,
    },
    HookPrompt {
        id: String,
        text: String,
    },
    FunctionCallOutput {
        id: String,
        name: String,
    },
    Sleep {
        id: String,
        duration_ms: u64,
    },
    ReviewMode {
        id: String,
        entered: bool,
        review: String,
    },
}
impl Item {
    pub fn id(&self) -> &str {
        match self {
            Self::UserInput { id, .. }
            | Self::Assistant { id, .. }
            | Self::Plan { id, .. }
            | Self::Command { id, .. }
            | Self::FileChange { id, .. }
            | Self::Reasoning { id, .. }
            | Self::McpToolCall { id, .. }
            | Self::DynamicToolCall { id, .. }
            | Self::CollabAgentToolCall { id, .. }
            | Self::SubAgentActivity { id, .. }
            | Self::WebSearch { id, .. }
            | Self::ImageView { id, .. }
            | Self::ImageGeneration { id, .. }
            | Self::ContextCompaction { id, .. }
            | Self::HookPrompt { id, .. }
            | Self::FunctionCallOutput { id, .. }
            | Self::Sleep { id, .. }
            | Self::ReviewMode { id, .. } => id,
        }
    }
}
fn items_with_legacy<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Vec<Item>, D::Error> {
    #[derive(Deserialize)]
    struct Legacy {
        id: String,
        label: String,
        #[serde(default)]
        text: String,
    }
    let mut items = Vec::new();
    for value in Vec::<serde_json::Value>::deserialize(d)? {
        if value.get("kind").and_then(serde_json::Value::as_str) != Some("other") {
            items.push(serde_json::from_value(value).map_err(serde::de::Error::custom)?);
            continue;
        }
        let Legacy { id, label, text } =
            serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        match label.as_str() {
            "Reasoning" => items.push(Item::Reasoning {
                id,
                text,
                complete: true,
            }),
            "contextCompaction" => items.push(Item::ContextCompaction { id, complete: true }),
            _ => {}
        }
    }
    Ok(items)
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionModeOption {
    pub value: PermissionMode,
    pub label: String,
    pub description: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalKind {
    Command,
    FileChange,
    Permission,
    McpElicitation,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub provider: String,
    pub permission_modes: Vec<PermissionModeOption>,
    pub default_permission_mode: PermissionMode,
    pub supported_approval_kinds: Vec<ApprovalKind>,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionMode {
    #[default]
    Default,
    Plan,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSettings {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: PermissionMode,
    #[serde(default)]
    pub interaction_mode: InteractionMode,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<MessageContext>,
    pub native_turn_id: Option<String>,
    pub delivery: Delivery,
    pub execution: Execution,
    #[serde(deserialize_with = "items_with_legacy")]
    pub items: Vec<Item>,
    #[serde(default)]
    pub settings: Option<SessionSettings>,
    #[serde(default)]
    pub started_at_ms: Option<u64>,
    #[serde(default)]
    pub completed_at_ms: Option<u64>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub checkpoint: TurnCheckpoint,
    #[serde(default)]
    pub tasks: Option<crate::TaskProgress>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImageMime {
    #[serde(rename = "image/png")]
    Png,
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/gif")]
    Gif,
    #[serde(rename = "image/webp")]
    Webp,
}
impl ImageMime {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }
}
/// The SHA-256 of an attachment's bytes as 64 lowercase hex digits. Parsing rejects anything
/// else, so an id can never name a path outside the attachments directory.
#[derive(Debug, Clone, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AttachmentId(String);
impl AttachmentId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl std::str::FromStr for AttachmentId {
    type Err = AppError;
    fn from_str(s: &str) -> Result<Self> {
        if s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            Ok(Self(s.into()))
        } else {
            Err(AppError::new(
                "invalid_attachment",
                "Invalid attachment id.",
            ))
        }
    }
}
impl TryFrom<String> for AttachmentId {
    type Error = AppError;
    fn try_from(s: String) -> Result<Self> {
        s.parse()
    }
}
impl From<AttachmentId> for String {
    fn from(id: AttachmentId) -> Self {
        id.0
    }
}
impl std::fmt::Display for AttachmentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageAttachment {
    pub id: AttachmentId,
    pub mime_type: ImageMime,
    pub name: String,
    pub size_bytes: u64,
}
// Ported from T3 Code v0.0.45 packages/contracts/src/orchestration.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AttachmentExtension(String);
impl AttachmentExtension {
    pub fn from_name(name: &str) -> Self {
        name.rsplit_once('.')
            .and_then(|(_, extension)| extension.to_ascii_lowercase().parse().ok())
            .unwrap_or_else(|| Self("bin".into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl std::str::FromStr for AttachmentExtension {
    type Err = AppError;
    fn from_str(value: &str) -> Result<Self> {
        if (1..=10).contains(&value.len())
            && value != "part"
            && value
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        {
            Ok(Self(value.into()))
        } else {
            Err(AppError::new(
                "invalid_attachment",
                "Invalid attachment extension.",
            ))
        }
    }
}
impl TryFrom<String> for AttachmentExtension {
    type Error = AppError;
    fn try_from(value: String) -> Result<Self> {
        value.parse()
    }
}
impl From<AttachmentExtension> for String {
    fn from(value: AttachmentExtension) -> Self {
        value.0
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum AttachmentSource {
    #[serde(rename = "pasted-text")]
    PastedText,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileAttachment {
    pub id: AttachmentId,
    pub mime_type: String,
    pub name: String,
    pub size_bytes: u64,
    pub extension: AttachmentExtension,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<AttachmentSource>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attachment {
    Image(ImageAttachment),
    File(FileAttachment),
}
impl Serialize for Attachment {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match self {
            // Receipts fingerprint this exact legacy image field order.
            Self::Image(image) => image.serialize(serializer),
            Self::File(file) => {
                #[derive(Serialize)]
                #[serde(tag = "kind")]
                enum Tagged<'a> {
                    #[serde(rename = "file")]
                    File(&'a FileAttachment),
                }
                Tagged::File(file).serialize(serializer)
            }
        }
    }
}
impl<'de> Deserialize<'de> for Attachment {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "lowercase")]
        enum Tagged {
            Image(ImageAttachment),
            File(FileAttachment),
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Tagged(Tagged),
            Legacy(ImageAttachment),
        }
        Ok(match Wire::deserialize(deserializer)? {
            Wire::Tagged(Tagged::Image(image)) | Wire::Legacy(image) => Self::Image(image),
            Wire::Tagged(Tagged::File(file)) => Self::File(file),
        })
    }
}
impl From<ImageAttachment> for Attachment {
    fn from(image: ImageAttachment) -> Self {
        Self::Image(image)
    }
}
impl Attachment {
    pub fn id(&self) -> &AttachmentId {
        match self {
            Self::Image(a) => &a.id,
            Self::File(a) => &a.id,
        }
    }
    pub fn name(&self) -> &str {
        match self {
            Self::Image(a) => &a.name,
            Self::File(a) => &a.name,
        }
    }
    pub fn size_bytes(&self) -> u64 {
        match self {
            Self::Image(a) => a.size_bytes,
            Self::File(a) => a.size_bytes,
        }
    }
    pub fn mime_type(&self) -> &str {
        match self {
            Self::Image(a) => a.mime_type.as_str(),
            Self::File(a) => &a.mime_type,
        }
    }
    pub fn extension(&self) -> &str {
        match self {
            Self::Image(a) => a.mime_type.extension(),
            Self::File(a) => a.extension.as_str(),
        }
    }
}
#[derive(Debug, Clone)]
pub enum AttachmentKind {
    Image,
    File {
        mime_type: String,
        source: Option<AttachmentSource>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub reference: String,
    pub commit: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnDiffFile {
    pub path: String,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnCheckpoint {
    Pending,
    Before {
        before: Checkpoint,
    },
    Complete {
        before: Checkpoint,
        after: Checkpoint,
        files: Vec<TurnDiffFile>,
    },
    Unavailable {
        before: Option<Checkpoint>,
        reason: String,
    },
}
impl Default for TurnCheckpoint {
    fn default() -> Self {
        Self::Unavailable {
            before: None,
            reason: "This turn predates checkpoints.".into(),
        }
    }
}
impl TurnCheckpoint {
    pub fn before(&self) -> Option<&Checkpoint> {
        match self {
            Self::Before { before } | Self::Complete { before, .. } => Some(before),
            Self::Unavailable { before, .. } => before.as_ref(),
            Self::Pending => None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileText {
    pub name: String,
    pub contents: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnDiffView {
    Text {
        old: Option<FileText>,
        new: Option<FileText>,
    },
    Unavailable {
        reason: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertIntent {
    pub request_id: String,
    pub turn_id: TurnId,
    pub files: bool,
    pub source_native_thread_id: Option<String>,
    pub before_native_turn_id: Option<String>,
    pub before: Option<Checkpoint>,
    pub checkout_root: PathBuf,
    pub phase: RevertPhase,
    #[serde(default)]
    pub retained_native_turn_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RevertPhase {
    Preparing,
    ConversationReady { native_thread_id: Option<String> },
    RestoringFiles { native_thread_id: Option<String> },
    FilesRestored { native_thread_id: Option<String> },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    pub request_id: String,
    pub turn_id: TurnId,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<MessageContext>,
    pub turn_count: usize,
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
impl ApprovalState {
    pub fn open(&self) -> bool {
        matches!(self, Self::Pending | Self::Answering)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
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
    Permission {
        detail: String,
        reason: String,
    },
    McpElicitation {
        detail: String,
        reason: String,
        app_name: String,
    },
}
impl ApprovalAction {
    pub fn reviewable(&self) -> bool {
        match self {
            Self::Command { command, .. } => !command.trim().is_empty(),
            Self::FileChange { text, .. } => !text.trim().is_empty(),
            Self::Permission { detail, .. } | Self::McpElicitation { detail, .. } => {
                !detail.trim().is_empty()
            }
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalOption {
    pub decision: ApprovalDecision,
    pub label: String,
    pub warning: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: ApprovalId,
    pub turn_id: TurnId,
    pub action: ApprovalAction,
    #[serde(default)]
    pub options: Vec<ApprovalOption>,
    pub state: ApprovalState,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Accept,
    AcceptForSession,
    AcceptAlways,
    Decline,
    Cancel,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserQuestionState {
    Pending,
    Answering,
    Answered,
    Expired,
    Uncertain,
}
impl UserQuestionState {
    pub fn open(self) -> bool {
        matches!(self, Self::Pending | Self::Answering)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestionOption {
    pub label: String,
    pub description: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub is_other: bool,
    pub is_secret: bool,
    pub options: Option<Vec<UserQuestionOption>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestionRequest {
    pub id: UserQuestionRequestId,
    pub turn_id: TurnId,
    pub item_id: String,
    pub questions: Vec<UserQuestion>,
    pub state: UserQuestionState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserQuestionAnswer {
    pub answers: Vec<String>,
}
pub type UserQuestionAnswers = std::collections::BTreeMap<String, UserQuestionAnswer>;

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
    Existing { thread_id: ThreadId },
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
    Archived {
        at_ms: u64,
        restore: LivePlacement,
    },
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LivePlacement {
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
impl From<LivePlacement> for Placement {
    fn from(value: LivePlacement) -> Self {
        match value {
            LivePlacement::Auto => Self::Auto,
            LivePlacement::Kept => Self::Kept,
            LivePlacement::Pinned { at_ms, kept } => Self::Pinned { at_ms, kept },
            LivePlacement::Settled { at_ms } => Self::Settled { at_ms },
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeletedWorktree {
    NotRequested,
    Removed,
    Retained { reason: String },
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
    Archive,
    Unarchive,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    #[serde(default)]
    pub worktree_setup: Option<crate::project::WorktreeSetup>,
    #[serde(default)]
    pub created_at_ms: Option<u64>,
    #[serde(default)]
    pub latest_user_activity_at_ms: Option<u64>,
    #[serde(default)]
    pub unsettled_at_ms: Option<u64>,
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
    #[serde(default)]
    pub user_questions: Vec<UserQuestionRequest>,
    pub diagnostic: Option<String>,
    #[serde(default, alias = "settlement")]
    pub placement: Placement,
    #[serde(default)]
    pub snooze: Option<Snooze>,
    #[serde(default)]
    pub context: Option<ContextUsage>,
    #[serde(default)]
    pub pending_revert: Option<RevertIntent>,
    #[serde(default)]
    pub last_revert: Option<RevertResult>,
}
impl ThreadSnapshot {
    pub fn archived(&self) -> bool {
        matches!(self.placement, Placement::Archived { .. })
    }
    pub fn rename(&mut self, title: &str) -> Result<()> {
        let title = title.trim();
        if title.is_empty() {
            return Err(AppError::new(
                "invalid_title",
                "Thread name cannot be empty.",
            ));
        }
        self.title = title.into();
        Ok(())
    }
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
    pub fn input_open(&self) -> bool {
        self.approval_open()
            || self
                .user_questions
                .iter()
                .any(|request| request.state.open())
    }
    pub fn approval_open(&self) -> bool {
        self.approvals.iter().any(|approval| approval.state.open())
    }
    /// Expires every request whose provider callback died with its session.
    pub fn expire_open_requests(&mut self) -> bool {
        let mut changed = false;
        for approval in &mut self.approvals {
            if approval.state.open() {
                approval.state = ApprovalState::Expired;
                changed = true;
            }
        }
        for request in &mut self.user_questions {
            if request.state.open() {
                request.state = UserQuestionState::Expired;
                changed = true;
            }
        }
        changed
    }
    // Ports threadRaisedHandWhileSnoozed (client-runtime state/threadSettled.ts).
    fn raised_hand(&self, snooze: &Snooze) -> bool {
        self.input_open()
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
    // Stores a due auto-settle as T3's thread.auto-settle command would: settled at the last
    // activity, with the pin and the snooze cleared.
    pub fn materialize_settlement(&mut self, settled_at: Option<u64>) {
        if let (Placement::Auto | Placement::Pinned { .. }, Some(at_ms)) =
            (self.placement, settled_at)
        {
            self.placement = Placement::Settled { at_ms };
            self.unsettled_at_ms = None;
            self.snooze = None;
        }
    }
    // Ports the activity reset of decider.ts: it wakes a settled thread and clears a keep.
    pub fn record_activity(&mut self, settled_at: Option<u64>) {
        if self.archived() {
            return;
        }
        self.materialize_settlement(settled_at);
        self.placement = match self.placement {
            Placement::Settled { .. } | Placement::Kept => Placement::Auto,
            Placement::Pinned { at_ms, .. } => Placement::Pinned { at_ms, kept: false },
            Placement::Auto => Placement::Auto,
            Placement::Archived { .. } => self.placement,
        };
    }
    // Ports the pin, settle and snooze rules of orchestration/decider.ts.
    pub fn arrange(&mut self, action: Arrange, now: u64, settled_at: Option<u64>) -> Result<()> {
        if matches!(action, Arrange::Unarchive) {
            if let Placement::Archived { restore, .. } = self.placement {
                self.placement = restore.into();
            }
            return Ok(());
        }
        if self.archived() {
            return Err(AppError::new(
                "thread_archived",
                "Unarchive this thread first.",
            ));
        }
        if matches!(action, Arrange::Archive) {
            if self.input_open()
                || matches!(
                    self.session,
                    SessionState::Connecting | SessionState::Running | SessionState::Interrupting
                )
            {
                return Err(AppError::new(
                    "busy",
                    "Stop this thread before archiving it.",
                ));
            }
            let restore = match self.placement {
                Placement::Auto => LivePlacement::Auto,
                Placement::Kept => LivePlacement::Kept,
                Placement::Pinned { at_ms, kept } => LivePlacement::Pinned { at_ms, kept },
                Placement::Settled { at_ms } => LivePlacement::Settled { at_ms },
                Placement::Archived { .. } => unreachable!(),
            };
            self.placement = Placement::Archived {
                at_ms: now,
                restore,
            };
            self.snooze = None;
            return Ok(());
        }
        self.materialize_settlement(settled_at);
        match action {
            Arrange::Pin => {
                self.placement = match self.placement {
                    Placement::Archived { .. } | Placement::Pinned { .. } => self.placement,
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
                    if self.input_open() {
                        return Err(AppError::new(
                            "settle_blocked",
                            "Answer the pending approval before settling this thread.",
                        ));
                    }
                    self.placement = Placement::Settled { at_ms: now };
                }
                self.unsettled_at_ms = None;
                self.snooze = None;
            }
            Arrange::Unsettle => {
                if matches!(self.placement, Placement::Settled { .. }) {
                    self.placement = Placement::Kept;
                    self.unsettled_at_ms = Some(now);
                }
            }
            Arrange::Snooze { until_ms } => {
                if until_ms <= now {
                    return Err(AppError::new(
                        "snooze_in_past",
                        "Choose a wake time in the future.",
                    ));
                }
                if self.input_open() {
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
            Arrange::Archive | Arrange::Unarchive => unreachable!(),
        }
        Ok(())
    }
    pub fn summary(&self, settled_at_ms: Option<u64>) -> ThreadSummary {
        ThreadSummary {
            id: self.id.clone(),
            revision: self.revision,
            latest_turn: self.turns.last().map(|turn| LatestTurnSummary {
                id: turn.id.clone(),
                execution: turn.execution.clone(),
                completed_at_ms: turn.completed_at_ms,
                started_at_ms: turn.started_at_ms,
            }),
            pending_approval_ids: self
                .approvals
                .iter()
                .filter(|approval| approval.state == ApprovalState::Pending)
                .map(|approval| approval.id.clone())
                .collect(),
            pending_user_question_ids: self
                .user_questions
                .iter()
                .filter(|request| request.state == UserQuestionState::Pending)
                .map(|request| request.id.clone())
                .collect(),
            title: self.title.clone(),
            session: self.session.clone(),
            checkout: self.checkout.clone(),
            archived_at_ms: match self.placement {
                Placement::Archived { at_ms, .. } => Some(at_ms),
                _ => None,
            },
            created_at_ms: self.created_at_ms,
            unsettled_at_ms: self.unsettled_at_ms,
            updated_at_ms: self.turns.iter().rev().find_map(|turn| turn.started_at_ms),
            awaiting_approval: self
                .approvals
                .iter()
                .any(|approval| approval.state == ApprovalState::Pending)
                || self
                    .user_questions
                    .iter()
                    .any(|request| request.state == UserQuestionState::Pending),
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
pub struct LatestTurnSummary {
    pub started_at_ms: Option<u64>,
    pub id: TurnId,
    pub execution: Execution,
    pub completed_at_ms: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    #[serde(default)]
    pub unsettled_at_ms: Option<u64>,
    pub revision: u64,
    pub latest_turn: Option<LatestTurnSummary>,
    pub pending_approval_ids: Vec<ApprovalId>,
    #[serde(default)]
    pub pending_user_question_ids: Vec<UserQuestionRequestId>,
    #[serde(default)]
    pub pull_requests: crate::ThreadPrSummary,
    pub id: ThreadId,
    pub title: String,
    pub session: SessionState,
    pub checkout: Checkout,
    pub created_at_ms: Option<u64>,
    pub archived_at_ms: Option<u64>,
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
    pub fn new(thread: &ThreadSnapshot, summary: ThreadSummary) -> Self {
        Self {
            thread_id: thread.id.clone(),
            workspace_id: thread.workspace_id.clone(),
            revision: thread.revision,
            summary,
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
    #[serde(default)]
    pub file_coverage: crate::SearchCoverage,
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
    Commit { request: CommitRequest },
    CommitPush { request: CommitRequest },
    CommitPushPr { request: CommitRequest },
    Push,
    CreatePr,
    Pull,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRequest {
    pub message: Option<CommitMessage>,
    pub selection: CommitSelection,
    pub destination: CommitDestination,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CommitSelection {
    #[default]
    All,
    Paths {
        paths: SelectedPaths,
    },
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CommitDestination {
    #[default]
    Current,
    NewBranch,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RepoPath(String);
impl TryFrom<String> for RepoPath {
    type Error = AppError;
    fn try_from(value: String) -> Result<Self> {
        if value.is_empty()
            || value.contains('\0')
            || value.starts_with('/')
            || value.split('/').any(|part| {
                part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
            })
        {
            return Err(AppError::new(
                "invalid_commit_selection",
                "Select repository-relative file paths.",
            ));
        }
        Ok(Self(value))
    }
}
impl From<RepoPath> for String {
    fn from(value: RepoPath) -> Self {
        value.0
    }
}
impl RepoPath {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<RepoPath>", into = "Vec<RepoPath>")]
pub struct SelectedPaths(Vec<RepoPath>);
impl TryFrom<Vec<RepoPath>> for SelectedPaths {
    type Error = AppError;
    fn try_from(paths: Vec<RepoPath>) -> Result<Self> {
        if paths.is_empty() {
            return Err(AppError::new(
                "invalid_commit_selection",
                "Select at least one file to commit.",
            ));
        }
        Ok(Self(paths))
    }
}
impl From<SelectedPaths> for Vec<RepoPath> {
    fn from(value: SelectedPaths) -> Self {
        value.0
    }
}
impl SelectedPaths {
    pub fn iter(&self) -> impl Iterator<Item = &RepoPath> {
        self.0.iter()
    }
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitProgress {
    Phase {
        phase: GitPhase,
    },
    HookStarted {
        name: String,
    },
    HookFinished {
        name: String,
        code: Option<i32>,
    },
    Output {
        stream: GitOutputStream,
        line: String,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitOutputStream {
    Stdout,
    Stderr,
}
/// What a started Git action did. Steps before a failure stay reported.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOutcome {
    pub branch: Option<String>,
    pub commit: Option<Committed>,
    pub push: Option<Pushed>,
    pub pr: Option<PrOpened>,
    pub pull: Option<Pulled>,
    pub failure: Option<GitFailure>,
    #[serde(default)]
    pub warnings: Vec<String>,
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
pub struct SetReviewDisposition {
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
