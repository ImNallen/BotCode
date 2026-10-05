mod host;
use crate::{
    domain::*,
    pull_requests::{PrSnapshot, PullRequestKey},
};
pub(crate) use host::{change, read};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrObservation {
    pub key: PullRequestKey,
    pub node_id: String,
    pub head_oid: String,
    pub viewer: String,
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
    pub review_decision: Option<String>,
    pub verdicts: Vec<ReviewVerdict>,
    pub findings: Vec<PrFinding>,
    pub checks: Vec<PrCheck>,
    pub files: Vec<PrFile>,
    pub problems: Vec<PrSectionProblem>,
    pub timeline: Vec<PrTimelineEntry>,
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
pub struct PrFinding {
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
pub struct PrFile {
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
    pub body: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrReviewAction {
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
    Applied { host_id: String },
    Refused { message: String },
    Uncertain { message: String },
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
