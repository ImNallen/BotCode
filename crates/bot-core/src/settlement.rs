use crate::{domain::*, pull_requests::*};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SettlementRules {
    pub after_ms: Option<u64>,
    pub on_merge: bool,
}
pub struct SettlementInput<'a> {
    pub thread: &'a ThreadSnapshot,
    pub links: &'a [LinkedPrSummary],
    pub rules: SettlementRules,
    pub blocked: bool,
    pub now: u64,
}
pub fn settlement_at(input: SettlementInput<'_>) -> Option<u64> {
    let thread = input.thread;
    match thread.placement {
        Placement::Settled { at_ms } => return Some(at_ms),
        Placement::Archived { .. } | Placement::Kept | Placement::Pinned { kept: true, .. } => {
            return None;
        }
        _ => {}
    }
    if input.blocked
        || thread.approval_open()
        || matches!(
            thread.session,
            SessionState::Connecting | SessionState::Running | SessionState::Interrupting
        )
        || thread
            .snoozed_until()
            .is_some_and(|until| until > input.now)
    {
        return None;
    }
    if input.links.iter().any(|link| {
        !matches!(link.pr.freshness, PrFreshness::Current { .. })
            || link
                .pr
                .snapshot
                .as_ref()
                .is_none_or(|s| matches!(s.lifecycle, PrLifecycle::Open { .. }))
    }) {
        return None;
    }
    let activity = thread
        .turns
        .iter()
        .flat_map(|turn| [turn.started_at_ms, turn.completed_at_ms])
        .flatten()
        .chain(thread.latest_user_activity_at_ms)
        .max();
    let anchor = thread
        .turns
        .iter()
        .filter_map(|turn| turn.started_at_ms)
        .chain(thread.created_at_ms)
        .chain(thread.latest_user_activity_at_ms)
        .max();
    let latest = input
        .links
        .iter()
        .filter_map(|link| {
            let (at, eligible) = match &link.pr.snapshot.as_ref()?.lifecycle {
                PrLifecycle::Closed { closed_at } => (closed_at.as_deref()?, true),
                PrLifecycle::Merged { merged_at } => (merged_at.as_deref()?, input.rules.on_merge),
                PrLifecycle::Open { .. } => return None,
            };
            let at = u64::try_from(
                chrono::DateTime::parse_from_rfc3339(at)
                    .ok()?
                    .timestamp_millis(),
            )
            .ok()?;
            Some((at, eligible))
        })
        .max_by_key(|(at, _)| *at);
    if let (Some(anchor), Some((terminal, true))) = (anchor, latest)
        && terminal >= anchor
    {
        return activity.or(thread.created_at_ms);
    }
    let activity = activity?;
    (input.now.saturating_sub(activity) >= input.rules.after_ms?).then_some(activity)
}
