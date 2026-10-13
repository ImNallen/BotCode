#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum PrAccess {
    Thread(crate::ThreadId),
    Workspace {
        #[serde(rename = "workspaceId")]
        workspace_id: crate::WorkspaceId,
    },
}
impl From<crate::ThreadId> for PrAccess {
    fn from(id: crate::ThreadId) -> Self {
        Self::Thread(id)
    }
}
mod host;
mod lifecycle;
use crate::{
    domain::*,
    pull_requests::{PrSnapshot, PullRequestKey},
};
pub(crate) use host::checkout_snapshot;
pub(crate) use host::{
    Confirmation, acknowledge_update, change, confirm, read, read_candidates, read_commit_files,
    read_file_contents, read_files_viewed, set_files_viewed,
};
pub use lifecycle::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrObservation {
    pub key: PullRequestKey,
    pub node_id: String,
    pub head_oid: String,
    pub viewer: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommitFilesRequest {
    pub target: PrObservation,
    pub commit_oid: String,
}
impl PrCommitFilesRequest {
    pub(crate) fn validate(&self) -> Result<()> {
        self.target.validate()?;
        if self.commit_oid.len() != 40 || !self.commit_oid.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::new(
                "invalid_review",
                "Invalid commit or review identity.",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommitFiles {
    pub target: PrObservation,
    pub commit_oid: String,
    pub files: Vec<PrFile>,
    pub problems: Vec<PrSectionProblem>,
}
// Viewed state follows pingdotgg/t3code v0.0.45 GitHubPullRequestCli.ts (MIT).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrFileViewedState {
    Viewed,
    Unviewed,
    Dismissed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFileViewed {
    pub path: String,
    pub state: PrFileViewedState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFilesViewed {
    pub target: PrObservation,
    pub files: Vec<PrFileViewed>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFileViewedUpdate {
    pub path: String,
    pub viewed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSetFilesViewed {
    pub target: PrObservation,
    pub files: Vec<PrFileViewedUpdate>,
}
impl PrObservation {
    pub(crate) fn validate(&self) -> Result<()> {
        if self.head_oid.len() != 40
            || !self.head_oid.bytes().all(|c| c.is_ascii_hexdigit())
            || self.node_id.is_empty()
            || self.node_id.len() > 256
            || self.viewer.is_empty()
            || self.viewer.len() > 256
        {
            return Err(AppError::new(
                "invalid_review",
                "Invalid commit or review identity.",
            ));
        }
        Ok(())
    }
}
impl PrSetFilesViewed {
    pub(crate) fn validate(&self) -> Result<()> {
        self.target.validate()?;
        if self.files.len() > 100
            || self.files.iter().any(|file| {
                file.path.is_empty() || file.path.len() > 4096 || file.path.contains('\0')
            })
        {
            return Err(AppError::new(
                "invalid_review",
                "Viewed updates require at most 100 nonempty file paths.",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewVerdict {
    Comment,
    Approve,
    RequestChanges,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewDetail {
    pub observation: PrObservation,
    pub snapshot: PrSnapshot,
    pub body: String,
    pub reactions: Vec<PrReaction>,
    pub author: Option<PrActor>,
    pub labels: Vec<PrLabel>,
    pub reviewers: Vec<PrReviewer>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub auto_merge_method: Option<MergeMethod>,
    pub review_decision: Option<String>,
    pub verdicts: Vec<ReviewVerdict>,
    pub findings: Vec<PrFinding>,
    pub checks: Vec<PrCheck>,
    pub files: Vec<PrFile>,
    pub problems: Vec<PrSectionProblem>,
    pub timeline: Vec<PrTimelineEntry>,
    pub capabilities: PrCapabilities,
    pub operations: Vec<PrOperation>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrActor {
    pub login: String,
    pub avatar_url: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLabel {
    pub name: String,
    pub color: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewer {
    pub login: String,
    pub avatar_url: Option<String>,
    pub outcome: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrSection {
    Threads,
    ConversationComments,
    Reviews,
    Checks,
    Files,
    Commits,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrSectionProblem {
    Failed { section: PrSection, message: String },
    Limited { section: PrSection, message: String },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrTimelineEntry {
    pub at: Option<String>,
    pub event: PrTimelineEvent,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrTimelineEvent {
    Opened {
        author: Option<String>,
    },
    Commit {
        oid: String,
        headline: String,
        author: Option<String>,
    },
    Comment {
        finding_id: String,
    },
    Review {
        finding_id: String,
    },
    Merged,
    Closed,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrThreadLocation {
    pub path: String,
    pub side: PrSide,
    pub line: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFinding {
    #[serde(default)]
    pub thread_location: Option<PrThreadLocation>,
    pub reaction_subjects: Vec<PrReactionSubject>,
    pub finding: ReviewFinding,
    pub outcome: Option<String>,
    pub can_reply: bool,
    pub can_resolve: bool,
    pub can_unresolve: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    pub state: String,
    pub url: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFileContentsSource {
    pub id: String,
    pub old_oid: Option<String>,
    pub new_oid: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFileContentsRequest {
    pub target: PrObservation,
    pub source_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFileContents {
    pub old_contents: String,
    pub new_contents: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    #[serde(default)]
    pub previous_path: Option<String>,
    #[serde(default)]
    pub contents_source: Option<PrFileContentsSource>,
    pub path: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub patch: Option<String>,
    pub anchors: Vec<PrLine>,
    pub unavailable: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum PrSide {
    Left,
    Right,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLine {
    pub side: PrSide,
    pub line: u64,
    pub text: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftReviewComment {
    pub id: String,
    pub revision: u64,
    pub path: String,
    pub side: PrSide,
    pub line: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
    pub body: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrReviewAction {
    Merge {
        method: MergeMethod,
    },
    Enqueue,
    EnableAutoMerge {
        method: MergeMethod,
    },
    DisableAutoMerge,
    SetDraft {
        draft: bool,
    },
    SetClosed {
        closed: bool,
    },
    UpdateBranch {
        method: BranchUpdateMethod,
    },
    SubmitReview {
        verdict: ReviewVerdict,
        body: String,
        comments: Vec<DraftReviewComment>,
    },
    Reply {
        thread_id: String,
        body: String,
    },
    SetResolved {
        thread_id: String,
        resolved: bool,
    },
    EditTitle {
        title: String,
    },
    EditBody {
        body: String,
    },
    AddComment {
        body: String,
    },
    SetReaction {
        subject_id: Option<String>,
        content: PrReactionContent,
        reacted: bool,
    },
    SetLabel {
        name: String,
        applied: bool,
    },
    RequestReviewer {
        id: String,
        reviewer_kind: PrReviewerKind,
        requested: bool,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewChange {
    pub request_id: String,
    pub target: PrObservation,
    pub action: PrReviewAction,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrChangeResult {
    Applied {
        host_id: String,
    },
    Confirmed {
        state: PrConfirmedState,
    },
    Accepted {
        progress: PrProgress,
    },
    Refused {
        message: String,
    },
    Uncertain {
        message: String,
    },
    Superseded {
        evidence: PrSupersession,
        message: String,
    },
}
impl PrReviewChange {
    pub(crate) fn validate(&self) -> Result<()> {
        let valid_id = |id: &str| {
            !id.is_empty()
                && id.len() <= 256
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-=:".contains(&c))
        };
        let body = |s: &str| s.len() <= 64000;
        if !valid_id(&self.request_id)
            || !valid_id(&self.target.node_id)
            || self.target.viewer.is_empty()
            || self.target.viewer.len() > 256
            || self.target.head_oid.len() != 40
            || !self.target.head_oid.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(AppError::new("invalid_review", "Invalid review identity."));
        }
        let valid = match &self.action {
            PrReviewAction::SubmitReview {
                verdict,
                body: text,
                comments,
            } => {
                body(text)
                    && comments.len() <= 100
                    && (matches!(verdict, ReviewVerdict::Approve)
                        || !text.trim().is_empty()
                        || !comments.is_empty())
                    && comments.iter().all(|c| {
                        valid_id(&c.id)
                            && c.line > 0
                            && !c.path.is_empty()
                            && c.path.len() <= 4096
                            && body(&c.body)
                            && !c.body.trim().is_empty()
                    })
            }
            PrReviewAction::Reply {
                thread_id,
                body: text,
            } => valid_id(thread_id) && body(text) && !text.trim().is_empty(),
            PrReviewAction::SetResolved { thread_id, .. } => valid_id(thread_id),
            PrReviewAction::EditTitle { title } => {
                !title.trim().is_empty() && title.chars().count() <= 256
            }
            PrReviewAction::EditBody { body: text } => body(text),
            PrReviewAction::AddComment { body: text } => body(text) && !text.trim().is_empty(),
            PrReviewAction::SetReaction { subject_id, .. } => {
                subject_id.as_ref().is_none_or(|id| valid_id(id))
            }
            PrReviewAction::SetLabel { name, .. } => {
                !name.trim().is_empty() && name.len() <= 256 && !name.contains('\0')
            }
            PrReviewAction::RequestReviewer {
                id, reviewer_kind, ..
            } => {
                let login = if *reviewer_kind == PrReviewerKind::User {
                    id.strip_suffix("[bot]").unwrap_or(id)
                } else {
                    id
                };
                !login.is_empty()
                    && id.len() <= 256
                    && login
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            }
            PrReviewAction::Merge { .. }
            | PrReviewAction::Enqueue
            | PrReviewAction::EnableAutoMerge { .. }
            | PrReviewAction::DisableAutoMerge
            | PrReviewAction::SetDraft { .. }
            | PrReviewAction::SetClosed { .. }
            | PrReviewAction::UpdateBranch { .. } => true,
        };
        if !valid || serde_json::to_vec(self)?.len() > 1024 * 1024 {
            return Err(AppError::new(
                "invalid_review",
                "Review text or line comments are invalid or too large.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrCandidateKind {
    Labels,
    Reviewers,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrReviewerKind {
    User,
    Team,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLabelCandidate {
    pub name: String,
    pub color: Option<String>,
    pub description: Option<String>,
    pub is_applied: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewerCandidate {
    pub id: String,
    pub kind: PrReviewerKind,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub is_requested: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCandidates {
    pub labels: Vec<PrLabelCandidate>,
    pub reviewers: Vec<PrReviewerCandidate>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrReactionContent {
    ThumbsUp,
    ThumbsDown,
    Laugh,
    Hooray,
    Confused,
    Heart,
    Rocket,
    Eyes,
}
impl PrReactionContent {
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::ThumbsUp => "THUMBS_UP",
            Self::ThumbsDown => "THUMBS_DOWN",
            Self::Laugh => "LAUGH",
            Self::Hooray => "HOORAY",
            Self::Confused => "CONFUSED",
            Self::Heart => "HEART",
            Self::Rocket => "ROCKET",
            Self::Eyes => "EYES",
        }
    }
    pub(crate) fn from_wire(wire: &str) -> Option<Self> {
        [
            Self::ThumbsUp,
            Self::ThumbsDown,
            Self::Laugh,
            Self::Hooray,
            Self::Confused,
            Self::Heart,
            Self::Rocket,
            Self::Eyes,
        ]
        .into_iter()
        .find(|content| content.wire() == wire)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReaction {
    pub content: PrReactionContent,
    pub count: u64,
    pub actors: Vec<String>,
    pub viewer_has_reacted: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReactionSubject {
    pub subject_id: String,
    pub reactions: Vec<PrReaction>,
}
