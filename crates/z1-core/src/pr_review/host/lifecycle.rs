use super::*;
use crate::PrLifecycle;

pub(super) fn capabilities(repo: &Value, pr: &Value, snapshot: &PrSnapshot) -> PrCapabilities {
    let yes = |key: &str| pr[key].as_bool() == Some(true);
    let open = matches!(snapshot.lifecycle, PrLifecycle::Open { .. });
    let draft = matches!(snapshot.lifecycle, PrLifecycle::Open { draft: true });
    let conflict = pr["mergeable"].as_str() == Some("CONFLICTING");
    let queued = pr["mergeQueueEntry"]["id"].as_str().is_some();
    let armed = pr["autoMergeRequest"].is_object();
    let queue = yes("isMergeQueueEnabled");
    let write = matches!(
        repo["viewerPermission"].as_str(),
        Some("WRITE" | "MAINTAIN" | "ADMIN")
    );
    let methods: Vec<_> = [
        ("mergeCommitAllowed", MergeMethod::Merge),
        ("squashMergeAllowed", MergeMethod::Squash),
        ("rebaseMergeAllowed", MergeMethod::Rebase),
    ]
    .into_iter()
    .filter_map(|(key, method)| (repo[key].as_bool() == Some(true)).then_some(method))
    .collect();
    let mut actions = vec![];
    if open {
        if yes("viewerCanClose") {
            actions.push(PrReviewAction::SetClosed { closed: true });
        }
        if yes("viewerCanUpdate") {
            actions.push(PrReviewAction::SetDraft { draft: !draft });
        }
        if yes("viewerCanUpdateBranch") && !queued {
            actions.extend(
                [BranchUpdateMethod::Merge, BranchUpdateMethod::Rebase]
                    .map(|method| PrReviewAction::UpdateBranch { method }),
            );
        }
        if armed && yes("viewerCanDisableAutoMerge") {
            actions.push(PrReviewAction::DisableAutoMerge);
        }
        if !draft && write && !queued {
            if queue {
                if !armed && !conflict {
                    actions.push(PrReviewAction::Enqueue);
                }
            } else {
                if !armed
                    && pr["mergeable"].as_str() == Some("MERGEABLE")
                    && matches!(
                        pr["mergeStateStatus"].as_str(),
                        Some("CLEAN" | "HAS_HOOKS" | "UNSTABLE")
                    )
                {
                    actions.extend(
                        methods
                            .iter()
                            .map(|method| PrReviewAction::Merge { method: *method }),
                    );
                }
                if !armed
                    && yes("viewerCanEnableAutoMerge")
                    && repo["autoMergeAllowed"].as_bool() == Some(true)
                {
                    actions.extend(
                        methods
                            .iter()
                            .map(|method| PrReviewAction::EnableAutoMerge { method: *method }),
                    );
                }
            }
        }
    } else if matches!(snapshot.lifecycle, PrLifecycle::Closed { .. }) && yes("viewerCanReopen") {
        actions.push(PrReviewAction::SetClosed { closed: false });
    }
    let primary = match snapshot.lifecycle {
        PrLifecycle::Merged { .. } => PrPrimary::Merged,
        PrLifecycle::Closed { .. } => PrPrimary::Closed,
        _ if conflict => PrPrimary::ResolveConflicts,
        _ if draft && yes("viewerCanUpdate") => PrPrimary::Ready,
        _ if draft => PrPrimary::Unavailable,
        _ if queued => PrPrimary::Queued,
        _ if armed => PrPrimary::AutoMergeArmed,
        _ if actions
            .iter()
            .any(|a| matches!(a, PrReviewAction::Merge { .. } | PrReviewAction::Enqueue)) =>
        {
            PrPrimary::Merge
        }
        _ if actions
            .iter()
            .any(|a| matches!(a, PrReviewAction::EnableAutoMerge { .. })) =>
        {
            PrPrimary::EnableAutoMerge
        }
        _ => PrPrimary::Unavailable,
    };
    PrCapabilities { primary, actions, explanation: (primary == PrPrimary::Unavailable).then(|| "GitHub does not currently permit merging this pull request. Refresh after requirements change.".into()), edit: yes("viewerCanUpdate") }
}

pub(crate) struct Confirmation {
    pub snapshot: PrSnapshot,
    pub result: PrChangeResult,
}
pub(crate) async fn confirm(
    program: &Path,
    input: &PrReviewChange,
    previous: PrChangeResult,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Confirmation> {
    let mut fetch = Fetch {
        program,
        deadline: Instant::now() + timeout.min(Duration::from_secs(30)),
        bytes: 0,
        calls: 0,
        section_deadline: None,
        cancel,
    };
    let meta = fetch.meta(&input.target.key).await?;
    if meta.observation.node_id != input.target.node_id {
        return Err(unavailable("The canonical pull request identity changed."));
    }
    if let Some(result) = (PrOperation {
        input: input.clone(),
        result: previous.clone(),
    })
    .merged_result(&input.target.key, &meta.snapshot)
    {
        return Ok(Confirmation {
            snapshot: meta.snapshot,
            result,
        });
    }
    let state = match input.action {
        PrReviewAction::DisableAutoMerge if meta.auto_merge.is_none() => {
            Some(PrConfirmedState::AutoMergeDisabled)
        }
        PrReviewAction::SetDraft { draft: true }
            if matches!(meta.snapshot.lifecycle, PrLifecycle::Open { draft: true }) =>
        {
            Some(PrConfirmedState::Draft)
        }
        PrReviewAction::SetDraft { draft: false }
            if matches!(meta.snapshot.lifecycle, PrLifecycle::Open { draft: false }) =>
        {
            Some(PrConfirmedState::Ready)
        }
        PrReviewAction::SetClosed { closed: true }
            if matches!(meta.snapshot.lifecycle, PrLifecycle::Closed { .. }) =>
        {
            Some(PrConfirmedState::Closed)
        }
        PrReviewAction::SetClosed { closed: false }
            if matches!(meta.snapshot.lifecycle, PrLifecycle::Open { .. }) =>
        {
            Some(PrConfirmedState::Reopened)
        }
        PrReviewAction::UpdateBranch { .. }
            if !matches!(previous, PrChangeResult::Uncertain { .. })
                && meta.snapshot.head_oid != input.target.head_oid =>
        {
            Some(PrConfirmedState::BranchUpdated)
        }
        _ => None,
    };
    let result = if let Some(state) = state {
        PrChangeResult::Confirmed { state }
    } else if !matches!(previous, PrChangeResult::Uncertain { .. })
        && matches!(input.action, PrReviewAction::Enqueue)
        && meta.queued
    {
        PrChangeResult::Accepted {
            progress: PrProgress::Queued,
        }
    } else if let PrReviewAction::EnableAutoMerge { method } = input.action
        && !matches!(previous, PrChangeResult::Uncertain { .. })
        && meta.auto_merge.as_deref() == Some(method.wire())
    {
        PrChangeResult::Accepted {
            progress: PrProgress::AutoMergeEnabled,
        }
    } else {
        previous
    };
    Ok(Confirmation {
        snapshot: meta.snapshot,
        result,
    })
}

pub(crate) async fn acknowledge_update(
    program: &Path,
    operation: &PrOperation,
    inspected: &PrObservation,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Confirmation> {
    let mut fetch = Fetch {
        program,
        deadline: Instant::now() + timeout.min(Duration::from_secs(30)),
        bytes: 0,
        calls: 0,
        section_deadline: None,
        cancel,
    };
    let meta = fetch.meta(&operation.input.target.key).await?;
    if !operation.can_continue_update(inspected)
        || meta.observation != *inspected
        || !matches!(meta.snapshot.lifecycle, PrLifecycle::Open { .. })
    {
        return Err(unavailable(
            "The inspected pull request, head or account changed. Refresh before continuing.",
        ));
    }
    Ok(Confirmation {
        snapshot: meta.snapshot,
        result: PrChangeResult::Superseded {
            evidence: PrSupersession::ContinuedFromObservedHead {
                observation: meta.observation,
            },
            message: operation.unconfirmed_message(),
        },
    })
}
