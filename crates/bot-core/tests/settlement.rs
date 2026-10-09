use bot_core::*;

fn thread() -> ThreadSnapshot {
    ThreadSnapshot {
        worktree_setup: None,
        created_at_ms: Some(1000),
        latest_user_activity_at_ms: Some(2000),
        unsettled_at_ms: None,
        id: ThreadId::default(),
        workspace_id: WorkspaceId::default(),
        title: "Settlement".into(),
        native_thread_id: None,
        revision: 1,
        session: SessionState::Dormant,
        settings: SessionSettings::default(),
        checkout: Checkout::Local,
        turns: vec![Turn {
            tasks: None,
            id: TurnId::default(),
            prompt: "Accepted work".into(),
            context: None,
            native_turn_id: None,
            delivery: Delivery::Accepted,
            execution: Execution::Completed,
            items: vec![],
            settings: None,
            started_at_ms: Some(2000),
            completed_at_ms: Some(3000),
            attachments: vec![],
            checkpoint: TurnCheckpoint::default(),
        }],
        approvals: vec![],
        user_questions: vec![],
        diagnostic: None,
        placement: Placement::Auto,
        snooze: None,
        context: None,
        pending_revert: None,
        last_revert: None,
    }
}
fn link(lifecycle: PrLifecycle) -> LinkedPrSummary {
    LinkedPrSummary {
        pr: CachedPr {
            key: PullRequestKey::new("fixture", "project", 41).unwrap(),
            revision: 1,
            stack: None,
            freshness: PrFreshness::Current { fetched_at: 9000 },
            snapshot: Some(PrSnapshot {
                node_id: "PR_fixture_41".into(),
                title: "Settlement".into(),
                lifecycle,
                base: "main".into(),
                head: "feature".into(),
                head_oid: "a".repeat(40),
                head_repository: "fixture/project".into(),
                host_updated_at: "2026-10-05T13:00:00Z".into(),
            }),
        },
        source: PrLinkSource::Manual,
        linked_at: 9000,
    }
}
fn merged(at: &str) -> LinkedPrSummary {
    link(PrLifecycle::Merged {
        merged_at: Some(at.into()),
    })
}
fn closed(at: &str) -> LinkedPrSummary {
    link(PrLifecycle::Closed {
        closed_at: Some(at.into()),
    })
}
fn settled(
    thread: &ThreadSnapshot,
    links: &[LinkedPrSummary],
    after_ms: Option<u64>,
    on_merge: bool,
    blocked: bool,
) -> Option<u64> {
    settlement_at(SettlementInput {
        thread,
        links,
        rules: SettlementRules { after_ms, on_merge },
        blocked,
        now: 10000,
    })
}
#[test]
fn terminal_time_selects_eligibility_and_conversation_activity_selects_age() {
    let t = thread();
    let merge = merged("1970-01-01T00:00:04Z");
    assert_eq!(
        settled(&t, std::slice::from_ref(&merge), None, true, false),
        Some(3000)
    );
    assert_eq!(
        settled(&t, std::slice::from_ref(&merge), None, false, false),
        None
    );
    assert_eq!(
        settled(&t, &[closed("1970-01-01T00:00:04Z")], None, false, false),
        Some(3000)
    );
    assert_eq!(
        settled(
            &t,
            &[
                closed("1970-01-01T00:00:04Z"),
                merged("1970-01-01T00:00:05Z")
            ],
            None,
            false,
            false
        ),
        None
    );
    assert_eq!(
        settled(
            &t,
            &[merge, closed("1970-01-01T00:00:05Z")],
            None,
            false,
            false
        ),
        Some(3000)
    );
    assert_eq!(settled(&t, &[merged("invalid")], None, true, false), None);
    assert_eq!(
        settled(
            &t,
            &[merged("invalid"), closed("1970-01-01T00:00:04Z")],
            None,
            true,
            false
        ),
        Some(3000)
    );
    assert_eq!(
        settled(&t, &[merged("1970-01-01T00:00:01Z")], None, true, false),
        None
    );
    assert_eq!(
        settled(
            &t,
            &[merged("1970-01-01T00:00:01Z")],
            Some(6000),
            true,
            false
        ),
        Some(3000)
    );
}
#[test]
fn every_visible_unknown_open_stale_or_unconfirmed_link_blocks_even_inactivity() {
    let t = thread();
    let terminal = merged("1970-01-01T00:00:04Z");
    let mut unknown = terminal.clone();
    unknown.pr.snapshot = None;
    let mut stale = terminal.clone();
    stale.pr.freshness = PrFreshness::Stale {
        last_success: Some(9000),
        message: "May have reopened".into(),
    };
    let mut unloaded = terminal.clone();
    unloaded.pr.freshness = PrFreshness::NeverLoaded;
    for blocker in [
        unknown,
        stale,
        unloaded,
        link(PrLifecycle::Open { draft: false }),
    ] {
        assert_eq!(
            settled(&t, &[terminal.clone(), blocker], Some(1), true, false),
            None
        );
    }
    assert_eq!(settled(&t, &[terminal], Some(1), true, true), None);
}
#[test]
fn accepted_user_anchor_and_legacy_absence_prevent_old_terminal_resettlement() {
    let mut t = thread();
    let links = [merged("1970-01-01T00:00:04Z")];
    t.latest_user_activity_at_ms = Some(5000);
    assert_eq!(settled(&t, &links, None, true, false), None);
    assert_eq!(settled(&t, &links, Some(4000), true, false), Some(5000));
    t.created_at_ms = None;
    t.latest_user_activity_at_ms = None;
    t.turns[0].started_at_ms = None;
    assert_eq!(settled(&t, &links, None, true, false), None);
    t.latest_user_activity_at_ms = Some(2000);
    assert_eq!(settled(&t, &links, None, true, false), Some(3000));
    t.turns.clear();
    t.latest_user_activity_at_ms = None;
    t.created_at_ms = Some(1000);
    assert_eq!(settled(&t, &links, None, true, false), Some(1000));
}
#[test]
fn explicit_placement_snooze_approval_and_runtime_busy_rules_remain_authoritative() {
    let mut t = thread();
    let links = [merged("1970-01-01T00:00:04Z")];
    for placement in [
        Placement::Kept,
        Placement::Pinned {
            at_ms: 4000,
            kept: true,
        },
    ] {
        t.placement = placement;
        assert_eq!(settled(&t, &links, Some(1), true, false), None);
    }
    t.placement = Placement::Pinned {
        at_ms: 4000,
        kept: false,
    };
    assert_eq!(settled(&t, &links, None, true, false), Some(3000));
    t.snooze = Some(Snooze {
        at_ms: 4000,
        until_ms: 11000,
    });
    assert_eq!(settled(&t, &links, Some(1), true, false), None);
    t.snooze = None;
    for session in [
        SessionState::Connecting,
        SessionState::Running,
        SessionState::Interrupting,
    ] {
        t.session = session;
        assert_eq!(settled(&t, &links, Some(1), true, false), None);
    }
    t.session = SessionState::Dormant;
    t.approvals.push(Approval {
        id: ApprovalId::default(),
        turn_id: t.turns[0].id.clone(),
        action: ApprovalAction::FileChange {
            text: "Change".into(),
            reason: String::new(),
        },
        options: vec![],
        state: ApprovalState::Pending,
    });
    assert_eq!(settled(&t, &links, Some(1), true, false), None);
    t.placement = Placement::Settled { at_ms: 6000 };
    assert_eq!(
        settled(
            &t,
            &[link(PrLifecycle::Open { draft: false })],
            Some(1),
            true,
            true
        ),
        Some(6000)
    );
}

#[test]
fn unsettle_return_clock_stamps_only_actual_transitions_and_defaults_for_old_snapshots() {
    let mut manual = thread();
    manual.arrange(Arrange::Settle, 4000, None).unwrap();
    assert_eq!(manual.unsettled_at_ms, None);
    manual.arrange(Arrange::Unsettle, 5000, None).unwrap();
    assert_eq!(manual.unsettled_at_ms, Some(5000));
    assert_eq!(manual.latest_user_activity_at_ms, Some(2000));
    manual.arrange(Arrange::Unsettle, 6000, None).unwrap();
    assert_eq!(manual.unsettled_at_ms, Some(5000));
    assert_eq!(manual.summary(None).unsettled_at_ms, Some(5000));
    let serialized = serde_json::to_value(&manual).unwrap();
    let restored: ThreadSnapshot = serde_json::from_value(serialized.clone()).unwrap();
    assert_eq!(restored.unsettled_at_ms, Some(5000));
    let mut legacy = serialized;
    legacy.as_object_mut().unwrap().remove("unsettledAtMs");
    assert_eq!(
        serde_json::from_value::<ThreadSnapshot>(legacy)
            .unwrap()
            .unsettled_at_ms,
        None
    );
    manual.arrange(Arrange::Settle, 7000, None).unwrap();
    assert_eq!(manual.unsettled_at_ms, None);

    let mut automatic = thread();
    automatic
        .arrange(Arrange::Unsettle, 8000, Some(3000))
        .unwrap();
    assert_eq!(automatic.placement, Placement::Kept);
    assert_eq!(automatic.unsettled_at_ms, Some(8000));
    automatic.placement = Placement::Auto;
    automatic.materialize_settlement(Some(3000));
    assert_eq!(automatic.unsettled_at_ms, None);
    assert_eq!(automatic.latest_user_activity_at_ms, Some(2000));
}
