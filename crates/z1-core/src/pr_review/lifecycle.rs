use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}
impl MergeMethod {
    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::Merge => "MERGE",
            Self::Squash => "SQUASH",
            Self::Rebase => "REBASE",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchUpdateMethod {
    Merge,
    Rebase,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrProgress {
    Queued,
    AutoMergeEnabled,
    AwaitingConfirmation,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrConfirmedState {
    Merged,
    AutoMergeDisabled,
    Draft,
    Ready,
    Closed,
    Reopened,
    BranchUpdated,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrPrimary {
    ResolveConflicts,
    Ready,
    Queued,
    AutoMergeArmed,
    Merge,
    EnableAutoMerge,
    Closed,
    Merged,
    Unavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCapabilities {
    pub primary: PrPrimary,
    pub actions: Vec<PrReviewAction>,
    pub explanation: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrOperation {
    pub input: PrReviewChange,
    pub result: PrChangeResult,
}
impl PrReviewAction {
    pub fn is_lifecycle(&self) -> bool {
        !matches!(
            self,
            Self::SubmitReview { .. } | Self::Reply { .. } | Self::SetResolved { .. }
        )
    }
    pub(crate) fn holds_checkout(&self) -> bool {
        matches!(
            self,
            Self::Merge { .. }
                | Self::Enqueue
                | Self::EnableAutoMerge { .. }
                | Self::UpdateBranch { .. }
        )
    }
}
impl PrChangeResult {
    pub(crate) fn pending(&self) -> bool {
        matches!(self, Self::Accepted { .. } | Self::Uncertain { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrSupersession {
    PullRequestMerged {
        key: PullRequestKey,
        node_id: String,
        observed_head_oid: String,
    },
    ContinuedFromObservedHead {
        observation: PrObservation,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeUncertainUpdate {
    pub key: PullRequestKey,
    pub request_id: String,
    pub inspected: PrObservation,
}
impl PrOperation {
    pub(crate) fn merged_result(
        &self,
        key: &PullRequestKey,
        snapshot: &PrSnapshot,
    ) -> Option<PrChangeResult> {
        if !self.input.action.is_lifecycle()
            || !self.result.pending()
            || &self.input.target.key != key
            || self.input.target.node_id != snapshot.node_id
            || !matches!(snapshot.lifecycle, crate::PrLifecycle::Merged { .. })
        {
            return None;
        }
        if matches!(self.result, PrChangeResult::Accepted { .. })
            && matches!(
                self.input.action,
                PrReviewAction::Merge { .. }
                    | PrReviewAction::Enqueue
                    | PrReviewAction::EnableAutoMerge { .. }
            )
        {
            return Some(PrChangeResult::Confirmed {
                state: PrConfirmedState::Merged,
            });
        }
        Some(PrChangeResult::Superseded {
            evidence: PrSupersession::PullRequestMerged {
                key: key.clone(),
                node_id: snapshot.node_id.clone(),
                observed_head_oid: snapshot.head_oid.clone(),
            },
            message: self.unconfirmed_message(),
        })
    }
    pub(crate) fn unconfirmed_message(&self) -> String {
        match &self.result {
            PrChangeResult::Uncertain { message } => message.clone(),
            _ => "The earlier operation was awaiting confirmation.".into(),
        }
    }
    pub(crate) fn can_continue_update(&self, inspected: &PrObservation) -> bool {
        matches!(self.result, PrChangeResult::Uncertain { .. })
            && matches!(self.input.action, PrReviewAction::UpdateBranch { .. })
            && self.input.target.key == inspected.key
            && self.input.target.node_id == inspected.node_id
            && self.input.target.head_oid != inspected.head_oid
    }
}
