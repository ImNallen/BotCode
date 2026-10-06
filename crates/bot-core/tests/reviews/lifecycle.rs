use super::*;

fn lifecycle(detail: &PrReviewDetail, action: PrReviewAction) -> PrReviewChange {
    PrReviewChange {
        request_id: uuid::Uuid::new_v4().to_string(),
        target: detail.observation.clone(),
        action,
    }
}
async fn summary(app: &App, thread: &ThreadId) -> ThreadSummary {
    let snapshot = app.thread(thread.clone()).await.unwrap();
    app.workspace_view(snapshot.workspace_id, None)
        .await
        .unwrap()
        .threads
        .into_iter()
        .find(|t| &t.id == thread)
        .unwrap()
}
#[tokio::test]
async fn lifecycle_merge_is_atomic_confirmed_deduplicated_and_settles_at_conversation_age() {
    let f = Fixture::new();
    f.state(json!({"mergeCommitAllowed":false,"rebaseMergeAllowed":false}));
    let (app, thread) = f.open().await;
    app.save_settings(r#"{"sidebarAutoSettleAfterDays":null}"#)
        .await
        .unwrap();
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(
        detail
            .capabilities
            .actions
            .contains(&PrReviewAction::Merge {
                method: MergeMethod::Squash
            })
    );
    let unsupported = lifecycle(
        &detail,
        PrReviewAction::Merge {
            method: MergeMethod::Rebase,
        },
    );
    assert!(matches!(
        app.change_pull_request(thread.clone(), unsupported)
            .await
            .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert!(f.mutations().is_empty());
    let input = lifecycle(
        &detail,
        PrReviewAction::Merge {
            method: MergeMethod::Squash,
        },
    );
    let result = app
        .change_pull_request(thread.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(
        result,
        PrChangeResult::Confirmed {
            state: PrConfirmedState::Merged
        }
    );
    assert_eq!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        result
    );
    assert_eq!(f.mutations().len(), 1);
    let mutation = &f.mutations()[0];
    assert_eq!(
        mutation["payload"]["variables"]["input"]["expectedHeadOid"],
        "a".repeat(40)
    );
    assert_eq!(
        mutation["payload"]["variables"]["input"]["pullRequestId"],
        "PR_fixture_41"
    );
    assert_eq!(
        mutation["payload"]["variables"]["input"]["mergeMethod"],
        "SQUASH"
    );
    assert_eq!(mutation["inputMode"], "0o600");
    assert_eq!(
        summary(&app, &thread).await.settled_at_ms,
        app.thread(thread.clone()).await.unwrap().created_at_ms
    );
    assert!(
        app.pull_request_operations(thread.clone(), f.key())
            .await
            .unwrap()
            .is_empty()
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn lifecycle_head_move_and_capability_loss_refuse_without_false_merge() {
    let f = Fixture::new();
    f.state(json!({"atomicHead":"b".repeat(40)}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let input = lifecycle(
        &detail,
        PrReviewAction::Merge {
            method: MergeMethod::Squash,
        },
    );
    assert!(matches!(
        app.change_pull_request(thread.clone(), input)
            .await
            .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    f.state(json!({"viewerPermission":"READ"}));
    assert!(matches!(
        app.change_pull_request(
            thread.clone(),
            lifecycle(
                &detail,
                PrReviewAction::Merge {
                    method: MergeMethod::Squash
                }
            )
        )
        .await
        .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn lifecycle_pending_failure_survives_restart_and_reconciles_without_replay() {
    let f = Fixture::new();
    f.state(json!({"failConfirmation":true}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let input = lifecycle(
        &detail,
        PrReviewAction::Merge {
            method: MergeMethod::Squash,
        },
    );
    assert_eq!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        PrChangeResult::Accepted {
            progress: PrProgress::AwaitingConfirmation
        }
    );
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    assert!(matches!(
        app.list_thread_pull_requests(thread.clone(), false)
            .await
            .unwrap()
            .links[0]
            .pr
            .freshness,
        PrFreshness::Stale { .. }
    ));
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let pending = app
        .pull_request_operations(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].input, input);
    assert_eq!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        pending[0].result
    );
    assert_eq!(f.mutations().len(), 1);
    f.state(json!({"lifecycle":"MERGED","mergedAt":"2099-10-05T13:00:00Z"}));
    assert_eq!(
        app.reconcile_pull_request(thread.clone(), f.key(), input.request_id)
            .await
            .unwrap(),
        PrChangeResult::Confirmed {
            state: PrConfirmedState::Merged
        }
    );
    assert_eq!(f.mutations().len(), 1);
    assert!(summary(&app, &thread).await.settled_at_ms.is_some());
    assert!(
        app.pull_request_operations(thread.clone(), f.key())
            .await
            .unwrap()
            .is_empty()
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn lifecycle_queue_and_auto_merge_stay_pending_and_disable_remains_available_during_agent_work()
 {
    let mut f = Fixture::new();
    let peer = f.dir.path().join("codex.py");
    std::fs::write(&peer, include_str!("../support/codex_peer.py")).unwrap();
    std::fs::set_permissions(&peer, std::fs::Permissions::from_mode(0o755)).unwrap();
    f.config.codex_binary = peer;
    f.state(json!({"queueRequired":true}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(
        detail
            .capabilities
            .actions
            .contains(&PrReviewAction::Enqueue)
    );
    assert!(!detail.capabilities.actions.iter().any(|a| matches!(
        a,
        PrReviewAction::Merge { .. } | PrReviewAction::EnableAutoMerge { .. }
    )));
    let queued = lifecycle(&detail, PrReviewAction::Enqueue);
    assert_eq!(
        app.change_pull_request(thread.clone(), queued.clone())
            .await
            .unwrap(),
        PrChangeResult::Accepted {
            progress: PrProgress::Queued
        }
    );
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    assert!(
        f.mutations()[0]["payload"]["variables"]["input"]
            .get("jump")
            .is_none()
    );
    f.state(json!({"lifecycle":"MERGED","mergedAt":"2099-10-05T13:00:00Z"}));
    app.reconcile_pull_request(thread.clone(), f.key(), queued.request_id)
        .await
        .unwrap();
    f.state(json!({"mergeStateStatus":"BLOCKED"}));
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(detail.capabilities.primary, PrPrimary::EnableAutoMerge);
    let armed = lifecycle(
        &detail,
        PrReviewAction::EnableAutoMerge {
            method: MergeMethod::Squash,
        },
    );
    assert_eq!(
        app.change_pull_request(thread.clone(), armed)
            .await
            .unwrap(),
        PrChangeResult::Accepted {
            progress: PrProgress::AutoMergeEnabled
        }
    );
    app.submit(
        thread.clone(),
        uuid::Uuid::new_v4().to_string(),
        "hold".into(),
    )
    .await
    .unwrap();
    for _ in 0..100 {
        if app.thread(thread.clone()).await.unwrap().session == SessionState::Running {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        app.thread(thread.clone()).await.unwrap().session,
        SessionState::Running
    );
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let before = f.mutations().len();
    assert_eq!(
        app.change_pull_request(
            thread.clone(),
            lifecycle(&detail, PrReviewAction::DisableAutoMerge)
        )
        .await
        .unwrap(),
        PrChangeResult::Confirmed {
            state: PrConfirmedState::AutoMergeDisabled
        }
    );
    assert_eq!(f.mutations().len(), before + 1);
    assert!(
        app.pull_request_operations(thread.clone(), f.key())
            .await
            .unwrap()
            .is_empty()
    );
    let rejected = app
        .change_pull_request(
            thread.clone(),
            lifecycle(
                &detail,
                PrReviewAction::UpdateBranch {
                    method: BranchUpdateMethod::Merge,
                },
            ),
        )
        .await
        .unwrap();
    assert!(matches!(rejected, PrChangeResult::Refused { .. }));
    assert_eq!(f.mutations().len(), before + 1);
    app.interrupt(thread).await.unwrap();
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn lifecycle_metadata_and_branch_update_confirm_only_observed_states() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    for (action, state) in [
        (
            PrReviewAction::SetDraft { draft: true },
            PrConfirmedState::Draft,
        ),
        (
            PrReviewAction::SetDraft { draft: false },
            PrConfirmedState::Ready,
        ),
        (
            PrReviewAction::SetClosed { closed: true },
            PrConfirmedState::Closed,
        ),
        (
            PrReviewAction::SetClosed { closed: false },
            PrConfirmedState::Reopened,
        ),
        (
            PrReviewAction::UpdateBranch {
                method: BranchUpdateMethod::Rebase,
            },
            PrConfirmedState::BranchUpdated,
        ),
    ] {
        let detail = app
            .read_pull_request(thread.clone(), f.key())
            .await
            .unwrap();
        assert_eq!(
            app.change_pull_request(thread.clone(), lifecycle(&detail, action))
                .await
                .unwrap(),
            PrChangeResult::Confirmed { state }
        );
    }
    assert_eq!(f.mutations().len(), 5);
    assert_eq!(
        f.mutations()[4]["payload"]["variables"]["input"]["updateMethod"],
        "REBASE"
    );
    assert_eq!(
        f.mutations()[4]["payload"]["variables"]["input"]["expectedHeadOid"],
        "a".repeat(40)
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn lifecycle_hold_excludes_new_turns_and_old_status_cannot_restore_freshness() {
    let f = Fixture::new();
    let status_release = f.dir.path().join("release-status");
    let mutation_release = f.dir.path().join("release-merge");
    f.state(json!({"waitFor":{"BotPullRequest":status_release,"BotMerge":mutation_release},"failConfirmation":true}));
    let (app, thread) = f.open().await;
    f.wait_for("BotPullRequest").await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let input = lifecycle(
        &detail,
        PrReviewAction::Merge {
            method: MergeMethod::Squash,
        },
    );
    let worker = app.clone();
    let id = thread.clone();
    let changing = tokio::spawn(async move { worker.change_pull_request(id, input).await });
    f.wait_for("mutation BotMerge").await;
    let error = app
        .submit(
            thread.clone(),
            uuid::Uuid::new_v4().to_string(),
            "Must not start".into(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "checkout_busy");
    std::fs::write(&mutation_release, "").unwrap();
    assert_eq!(
        changing.await.unwrap().unwrap(),
        PrChangeResult::Accepted {
            progress: PrProgress::AwaitingConfirmation
        }
    );
    std::fs::write(&status_release, "").unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let projection = app
        .list_thread_pull_requests(thread.clone(), false)
        .await
        .unwrap();
    assert!(matches!(
        projection.links[0].pr.freshness,
        PrFreshness::Stale { .. }
    ));
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn fractional_newer_host_revision_accepts_terminal_and_rejects_older_instants() {
    let f = Fixture::new();
    f.state(json!({"updatedAt":"2026-10-05T13:00:00Z"}));
    let (app, thread) = f.open().await;
    app.read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    f.state(json!({"updatedAt":"2026-10-05T13:00:00.001Z","lifecycle":"CLOSED","closedAt":"2099-10-05T13:00:00Z"}));
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(matches!(
        detail.snapshot.lifecycle,
        PrLifecycle::Closed { .. }
    ));
    f.state(json!({"updatedAt":"2026-10-05T13:00:00Z"}));
    assert_eq!(
        app.read_pull_request(thread.clone(), f.key())
            .await
            .unwrap_err()
            .code,
        "pr_review_stale"
    );
    let links = app
        .list_thread_pull_requests(thread.clone(), false)
        .await
        .unwrap();
    assert!(matches!(
        links.links[0].pr.snapshot.as_ref().unwrap().lifecycle,
        PrLifecycle::Closed { .. }
    ));
    f.state(json!({"updatedAt":"invalid"}));
    assert!(
        app.read_pull_request(thread.clone(), f.key())
            .await
            .is_err()
    );
    assert!(matches!(
        app.list_thread_pull_requests(thread.clone(), false)
            .await
            .unwrap()
            .links[0]
            .pr
            .freshness,
        PrFreshness::Stale { .. }
    ));
    assert!(f.mutations().is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn settlement_public_all_links_settings_inheritance_and_recent_activity() {
    let mut f = Fixture::new();
    let peer = f.dir.path().join("codex.py");
    std::fs::write(&peer, include_str!("../support/codex_peer.py")).unwrap();
    std::fs::set_permissions(&peer, std::fs::Permissions::from_mode(0o755)).unwrap();
    f.config.codex_binary = peer;
    f.state(json!({"matchNumber":true,"perNumber":{"41":{"lifecycle":"MERGED","mergedAt":"2099-10-05T13:00:00Z"},"42":{"lifecycle":"OPEN"}}}));
    let (app, thread) = f.open().await;
    let project = app.thread(thread.clone()).await.unwrap().workspace_id;
    app.save_settings(r#"{"sidebarAutoSettleAfterDays":null,"autoSettleOnMerge":true}"#)
        .await
        .unwrap();
    app.read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(summary(&app, &thread).await.settled_at_ms.is_some());
    let other = PullRequestKey::new("fixture", "project", 42).unwrap();
    app.link_pull_request(thread.clone(), other.url())
        .await
        .unwrap();
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    app.read_pull_request(thread.clone(), other.clone())
        .await
        .unwrap();
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    f.state(json!({"matchNumber":true,"perNumber":{"41":{"lifecycle":"MERGED","mergedAt":"2099-10-05T13:00:00Z"},"42":{"lifecycle":"CLOSED","closedAt":"2099-10-05T12:00:00Z"}}}));
    app.read_pull_request(thread.clone(), other).await.unwrap();
    assert!(summary(&app, &thread).await.settled_at_ms.is_some());
    app.save_settings(&json!({"sidebarAutoSettleAfterDays":null,"autoSettleOnMerge":true,"projectOverrides":{project.to_string():{"autoSettleOnMerge":false}}}).to_string()).await.unwrap();
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    app.save_settings(r#"{"sidebarAutoSettleAfterDays":null,"autoSettleOnMerge":true}"#)
        .await
        .unwrap();
    assert!(summary(&app, &thread).await.settled_at_ms.is_some());
    app.arrange(thread.clone(), Arrange::Unsettle)
        .await
        .unwrap();
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    app.submit(
        thread.clone(),
        uuid::Uuid::new_v4().to_string(),
        "new work".into(),
    )
    .await
    .unwrap();
    for _ in 0..100 {
        if app
            .thread(thread.clone())
            .await
            .unwrap()
            .turns
            .last()
            .is_some_and(|turn| matches!(turn.execution, Execution::Completed))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    f.state(json!({"matchNumber":true,"perNumber":{"41":{"lifecycle":"MERGED","mergedAt":"2020-10-05T13:00:00Z"},"42":{"lifecycle":"CLOSED","closedAt":"2020-10-05T12:00:00Z"}}}));
    app.read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    app.read_pull_request(
        thread.clone(),
        PullRequestKey::new("fixture", "project", 42).unwrap(),
    )
    .await
    .unwrap();
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn ordinary_uncached_refresh_confirms_pending_merge_receipts_without_replay() {
    for queue in [false, true] {
        let f = Fixture::new();
        f.state(json!({"queueRequired":queue,"mergeStateStatus":"BLOCKED"}));
        let (app, thread) = f.open().await;
        let detail = app
            .read_pull_request(thread.clone(), f.key())
            .await
            .unwrap();
        let action = if queue {
            PrReviewAction::Enqueue
        } else {
            PrReviewAction::EnableAutoMerge {
                method: MergeMethod::Squash,
            }
        };
        let input = lifecycle(&detail, action);
        assert!(matches!(
            app.change_pull_request(thread.clone(), input.clone())
                .await
                .unwrap(),
            PrChangeResult::Accepted { .. }
        ));
        f.state(json!({"lifecycle":"MERGED","mergedAt":"2099-10-05T13:00:00Z"}));
        if queue {
            app.list_thread_pull_requests(thread.clone(), true)
                .await
                .unwrap();
            for _ in 0..100 {
                if app
                    .pull_request_operations(thread.clone(), f.key())
                    .await
                    .unwrap()
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        } else {
            app.read_pull_request(thread.clone(), f.key())
                .await
                .unwrap();
        }
        assert!(
            app.pull_request_operations(thread.clone(), f.key())
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            app.change_pull_request(thread.clone(), input)
                .await
                .unwrap(),
            PrChangeResult::Confirmed {
                state: PrConfirmedState::Merged
            }
        );
        assert!(summary(&app, &thread).await.settled_at_ms.is_some());
        assert_eq!(f.mutations().len(), 1);
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn linked_pending_start_refuses_lifecycle_and_removed_checkout_adds_no_hold() {
    let mut f = Fixture::new();
    let peer = f.dir.path().join("codex.py");
    std::fs::write(&peer, include_str!("../support/codex_peer.py")).unwrap();
    std::fs::set_permissions(&peer, std::fs::Permissions::from_mode(0o755)).unwrap();
    f.config.codex_binary = peer;
    let (app, thread) = f.open().await;
    let project = app.thread(thread.clone()).await.unwrap().workspace_id;
    let other = app
        .create_thread(project.clone(), NewCheckout::Local)
        .await
        .unwrap();
    app.link_pull_request(other.id.clone(), f.key().url())
        .await
        .unwrap();
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    app.submit(
        other.id.clone(),
        uuid::Uuid::new_v4().to_string(),
        "hold".into(),
    )
    .await
    .unwrap();
    for action in [
        PrReviewAction::Merge {
            method: MergeMethod::Squash,
        },
        PrReviewAction::EnableAutoMerge {
            method: MergeMethod::Squash,
        },
        PrReviewAction::UpdateBranch {
            method: BranchUpdateMethod::Merge,
        },
        PrReviewAction::Enqueue,
    ] {
        assert!(matches!(
            app.change_pull_request(thread.clone(), lifecycle(&detail, action))
                .await
                .unwrap(),
            PrChangeResult::Refused { .. }
        ));
    }
    assert!(f.mutations().is_empty());
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    app.unlink_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    app.unlink_pull_request(other.id, f.key()).await.unwrap();
    let removed = app
        .create_thread(
            project,
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: false,
            },
        )
        .await
        .unwrap();
    let path = match &removed.checkout {
        Checkout::Worktree { path, .. } => path,
        _ => panic!("Expected a disposable worktree"),
    };
    std::fs::remove_dir_all(path).unwrap();
    app.link_pull_request(removed.id.clone(), f.key().url())
        .await
        .unwrap();
    let detail = app
        .read_pull_request(removed.id.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(
        app.change_pull_request(
            removed.id,
            lifecycle(
                &detail,
                PrReviewAction::Merge {
                    method: MergeMethod::Squash
                }
            )
        )
        .await
        .unwrap(),
        PrChangeResult::Confirmed {
            state: PrConfirmedState::Merged
        }
    );
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn started_lifecycle_receipt_recovers_uncertain_and_only_reads_until_host_confirms() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let input = lifecycle(
        &detail,
        PrReviewAction::Merge {
            method: MergeMethod::Squash,
        },
    );
    app.shutdown().await.unwrap();
    let result = PrChangeResult::Uncertain {
        message: "Started without a confirmed result".into(),
    };
    let data = serde_json::to_string(&PrOperation {
        input: input.clone(),
        result: result.clone(),
    })
    .unwrap();
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&input).unwrap()));
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    db.execute("INSERT INTO pull_request_operations(request_id,pr_key,action_digest,state,data) VALUES(?1,?2,?3,'started',?4)",rusqlite::params![input.request_id,input.target.key.as_str(),digest,data]).unwrap();
    drop(db);
    let app = App::open(f.config.clone()).await.unwrap();
    assert_eq!(
        app.pull_request_operations(thread.clone(), f.key())
            .await
            .unwrap()[0]
            .result,
        result
    );
    assert_eq!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        result
    );
    assert_eq!(
        app.reconcile_pull_request(thread.clone(), f.key(), input.request_id.clone())
            .await
            .unwrap(),
        result
    );
    assert!(f.mutations().is_empty());
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    f.state(json!({"lifecycle":"MERGED","mergedAt":"2099-10-05T13:00:00Z"}));
    app.read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(
        app.pull_request_operations(thread.clone(), f.key())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(f.mutations().is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn conflicting_pull_request_keeps_host_permitted_auto_merge_and_conflict_primary() {
    let f = Fixture::new();
    f.state(
        json!({"mergeable":"CONFLICTING","mergeCommitAllowed":false,"rebaseMergeAllowed":false}),
    );
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let action = PrReviewAction::EnableAutoMerge {
        method: MergeMethod::Squash,
    };
    let result = app
        .change_pull_request(thread.clone(), lifecycle(&detail, action.clone()))
        .await
        .unwrap();
    let pending = app
        .pull_request_operations(thread.clone(), f.key())
        .await
        .unwrap();
    let settled = summary(&app, &thread).await.settled_at_ms;
    app.shutdown().await.unwrap();
    assert_eq!(detail.capabilities.primary, PrPrimary::ResolveConflicts);
    assert_eq!(
        detail
            .capabilities
            .actions
            .iter()
            .filter(|a| matches!(a, PrReviewAction::EnableAutoMerge { .. }))
            .cloned()
            .collect::<Vec<_>>(),
        vec![action]
    );
    assert_eq!(
        result,
        PrChangeResult::Accepted {
            progress: PrProgress::AutoMergeEnabled
        }
    );
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].result, result);
    assert_eq!(settled, None);
    let mutations = f.mutations();
    assert_eq!(mutations.len(), 1);
    assert_eq!(
        mutations[0]["payload"]["variables"]["input"]["pullRequestId"],
        "PR_fixture_41"
    );
    assert_eq!(
        mutations[0]["payload"]["variables"]["input"]["expectedHeadOid"],
        "a".repeat(40)
    );
    assert_eq!(
        mutations[0]["payload"]["variables"]["input"]["mergeMethod"],
        "SQUASH"
    );
}

#[tokio::test]
async fn recovered_uncertain_update_converges_on_merged_without_redispatch() {
    let f = Fixture::new();
    f.state(json!({"failConfirmation":true}));
    let (app, thread) = f.open().await;
    app.save_settings(r#"{"sidebarAutoSettleAfterDays":null}"#)
        .await
        .unwrap();
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let input = lifecycle(
        &detail,
        PrReviewAction::UpdateBranch {
            method: BranchUpdateMethod::Merge,
        },
    );
    assert!(matches!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        PrChangeResult::Accepted { .. }
    ));
    app.shutdown().await.unwrap();
    let uncertain = PrChangeResult::Uncertain {
        message: "Started without a confirmed result".into(),
    };
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    db.execute(
        "UPDATE pull_request_operations SET state='started',data=?2 WHERE request_id=?1",
        rusqlite::params![
            input.request_id,
            serde_json::to_string(&PrOperation {
                input: input.clone(),
                result: uncertain.clone()
            })
            .unwrap()
        ],
    )
    .unwrap();
    drop(db);
    f.state(json!({"head":"d".repeat(40)}));
    let app = App::open(f.config.clone()).await.unwrap();
    assert_eq!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        uncertain
    );
    assert_eq!(
        app.reconcile_pull_request(thread.clone(), f.key(), input.request_id.clone())
            .await
            .unwrap(),
        uncertain
    );
    f.state(json!({"head":"d".repeat(40),"lifecycle":"MERGED","mergedAt":"2099-10-05T13:00:00Z"}));
    app.read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let pending = app
        .pull_request_operations(thread.clone(), f.key())
        .await
        .unwrap();
    let settled = summary(&app, &thread).await.settled_at_ms;
    let result = app
        .reconcile_pull_request(thread.clone(), f.key(), input.request_id.clone())
        .await;
    let replay = app
        .change_pull_request(thread.clone(), input.clone())
        .await
        .unwrap();
    app.shutdown().await.unwrap();
    assert!(
        pending.is_empty(),
        "merged PR still has pending receipts: {pending:?}"
    );
    assert!(settled.is_some());
    assert_eq!(
        serde_json::to_value(result.unwrap()).unwrap()["kind"],
        "superseded"
    );
    assert_eq!(serde_json::to_value(replay).unwrap()["kind"], "superseded");
    assert_eq!(f.mutations().len(), 1);
}

async fn recovered_update(f: &Fixture) -> (App, ThreadId, PrReviewChange, PrChangeResult) {
    f.state(json!({"failConfirmation":true}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let input = lifecycle(
        &detail,
        PrReviewAction::UpdateBranch {
            method: BranchUpdateMethod::Rebase,
        },
    );
    assert!(matches!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        PrChangeResult::Accepted { .. }
    ));
    app.shutdown().await.unwrap();
    let uncertain = PrChangeResult::Uncertain {
        message: "Started without a confirmed result".into(),
    };
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    db.execute(
        "UPDATE pull_request_operations SET state='started',data=?2 WHERE request_id=?1",
        rusqlite::params![
            input.request_id,
            serde_json::to_string(&PrOperation {
                input: input.clone(),
                result: uncertain.clone()
            })
            .unwrap()
        ],
    )
    .unwrap();
    drop(db);
    f.state(json!({"head":"d".repeat(40)}));
    (
        App::open(f.config.clone()).await.unwrap(),
        thread,
        input,
        uncertain,
    )
}
fn acknowledgment(input: &PrReviewChange, detail: &PrReviewDetail) -> AcknowledgeUncertainUpdate {
    AcknowledgeUncertainUpdate {
        key: input.target.key.clone(),
        request_id: input.request_id.clone(),
        inspected: detail.observation.clone(),
    }
}
#[tokio::test]
async fn uncertain_update_continuation_is_explicit_durable_and_never_redispatches() {
    let f = Fixture::new();
    let (app, thread, input, uncertain) = recovered_update(&f).await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(detail.operations[0].result, uncertain);
    assert_eq!(
        app.reconcile_pull_request(thread.clone(), f.key(), input.request_id.clone())
            .await
            .unwrap(),
        uncertain
    );
    let ack = acknowledgment(&input, &detail);
    let result = app
        .acknowledge_uncertain_update(thread.clone(), ack.clone())
        .await
        .unwrap();
    assert_eq!(
        result,
        PrChangeResult::Superseded {
            evidence: PrSupersession::ContinuedFromObservedHead {
                observation: detail.observation.clone()
            },
            message: "Started without a confirmed result".into()
        }
    );
    assert_eq!(
        app.acknowledge_uncertain_update(thread.clone(), ack.clone())
            .await
            .unwrap(),
        result
    );
    assert_eq!(
        app.reconcile_pull_request(thread.clone(), f.key(), input.request_id.clone())
            .await
            .unwrap(),
        result
    );
    assert_eq!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        result
    );
    let mut conflicting = input.clone();
    conflicting.action = PrReviewAction::UpdateBranch {
        method: BranchUpdateMethod::Merge,
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), conflicting)
            .await
            .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert!(
        app.pull_request_operations(thread.clone(), f.key())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    let (digest, data): (String, String) = db
        .query_row(
            "SELECT action_digest,data FROM pull_request_operations WHERE request_id=?1",
            [&input.request_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        digest,
        format!("{:x}", Sha256::digest(serde_json::to_vec(&input).unwrap()))
    );
    assert_eq!(
        serde_json::from_str::<PrOperation>(&data).unwrap().input,
        input
    );
    drop(db);
    let app = App::open(f.config.clone()).await.unwrap();
    assert_eq!(
        app.acknowledge_uncertain_update(thread.clone(), ack)
            .await
            .unwrap(),
        result
    );
    assert_eq!(
        app.change_pull_request(thread.clone(), input)
            .await
            .unwrap(),
        result
    );
    let fresh = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(
        app.change_pull_request(
            thread.clone(),
            lifecycle(
                &fresh,
                PrReviewAction::Merge {
                    method: MergeMethod::Squash
                }
            )
        )
        .await
        .unwrap(),
        PrChangeResult::Confirmed {
            state: PrConfirmedState::Merged
        }
    );
    assert_eq!(f.mutations().len(), 2);
    assert_eq!(
        f.mutations()[1]["payload"]["variables"]["input"]["expectedHeadOid"],
        "d".repeat(40)
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn uncertain_update_continuation_refuses_changed_or_failed_inspection() {
    let f = Fixture::new();
    let (app, thread, input, uncertain) = recovered_update(&f).await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    for state in [
        json!({"head":"e".repeat(40)}),
        json!({"head":"d".repeat(40),"viewer":"changed-viewer"}),
        json!({"head":"d".repeat(40),"wrongIdentitySections":["BotReviewMeta"]}),
        json!({"head":"d".repeat(40),"lifecycle":"CLOSED"}),
        json!({"head":"d".repeat(40),"failCore":true}),
        json!({"head":"d".repeat(40),"updatedAt":"2026-10-04T12:00:00Z"}),
        json!({"head":"d".repeat(40),"updatedAt":"malformed"}),
    ] {
        f.state(state.clone());
        assert!(
            app.acknowledge_uncertain_update(thread.clone(), acknowledgment(&input, &detail))
                .await
                .is_err(),
            "accepted stale inspection: {state}"
        );
        assert_eq!(
            app.change_pull_request(thread.clone(), input.clone())
                .await
                .unwrap(),
            uncertain
        );
        assert_eq!(
            app.pull_request_operations(thread.clone(), f.key())
                .await
                .unwrap()
                .len(),
            1
        );
    }
    f.state(json!({}));
    let original_head = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(
        app.acknowledge_uncertain_update(thread.clone(), acknowledgment(&input, &original_head))
            .await
            .is_err()
    );
    app.unlink_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(
        app.acknowledge_uncertain_update(thread.clone(), acknowledgment(&input, &detail))
            .await
            .unwrap_err()
            .code,
        "pr_not_linked"
    );
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn uncertain_update_acknowledgment_rechecks_membership_and_excludes_other_work() {
    let f = Fixture::new();
    let (app, thread, input, uncertain) = recovered_update(&f).await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let release = f.dir.path().join("ack-release");
    f.state(json!({"head":"d".repeat(40),"waitFor":{"BotReviewMeta":release}}));
    let calls = f.calls("BotReviewMeta", 41);
    let pending = app.acknowledge_uncertain_update(thread.clone(), acknowledgment(&input, &detail));
    let changed = async {
        tokio::time::timeout(Duration::from_secs(3), async {
            while f.calls("BotReviewMeta", 41) == calls {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            app.read_pull_request(thread.clone(), f.key())
                .await
                .unwrap_err()
                .code,
            "pr_busy"
        );
        assert!(matches!(
            app.change_pull_request(
                thread.clone(),
                lifecycle(
                    &detail,
                    PrReviewAction::Merge {
                        method: MergeMethod::Squash
                    }
                )
            )
            .await
            .unwrap(),
            PrChangeResult::Refused { .. }
        ));
        app.unlink_pull_request(thread.clone(), f.key())
            .await
            .unwrap();
        std::fs::write(&release, "release").unwrap();
    };
    let (result, ()) = tokio::join!(pending, changed);
    assert_eq!(result.unwrap_err().code, "pr_not_linked");
    f.state(json!({"head":"d".repeat(40)}));
    app.link_pull_request(thread.clone(), f.key().url())
        .await
        .unwrap();
    assert_eq!(
        app.change_pull_request(thread.clone(), input)
            .await
            .unwrap(),
        uncertain
    );
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn uncertain_lifecycle_merge_recovery_excludes_reviews_and_rejected_observations() {
    let f = Fixture::new();
    let (app, thread, update, uncertain) = recovered_update(&f).await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    app.shutdown().await.unwrap();
    let mut inputs = vec![submission(&detail)];
    for action in [
        PrReviewAction::SetDraft { draft: true },
        PrReviewAction::SetClosed { closed: false },
        PrReviewAction::DisableAutoMerge,
        PrReviewAction::Merge {
            method: MergeMethod::Squash,
        },
        PrReviewAction::EnableAutoMerge {
            method: MergeMethod::Squash,
        },
        PrReviewAction::Enqueue,
    ] {
        inputs.push(lifecycle(&detail, action));
    }
    use sha2::{Digest, Sha256};
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    for input in &inputs {
        db.execute("INSERT INTO pull_request_operations(request_id,pr_key,action_digest,state,data) VALUES(?1,?2,?3,'started',?4)", rusqlite::params![input.request_id,input.target.key.as_str(),format!("{:x}",Sha256::digest(serde_json::to_vec(input).unwrap())),serde_json::to_string(&PrOperation { input:input.clone(), result:uncertain.clone() }).unwrap()]).unwrap();
    }
    drop(db);
    let app = App::open(f.config.clone()).await.unwrap();
    f.state(json!({"head":"d".repeat(40),"queued":true,"autoMerge":true}));
    for input in &inputs[5..] {
        assert_eq!(
            app.reconcile_pull_request(thread.clone(), f.key(), input.request_id.clone())
                .await
                .unwrap(),
            uncertain
        );
    }
    for state in [
        json!({"nodeId":"PR_other"}),
        json!({"updatedAt":"2026-10-04T12:00:00Z"}),
        json!({"updatedAt":"invalid"}),
        json!({"mode":"error"}),
    ] {
        let mut state = state;
        state["head"] = json!("d".repeat(40));
        state["lifecycle"] = json!("MERGED");
        state["mergedAt"] = json!("2099-10-05T13:00:00Z");
        f.state(state);
        let _ = app.read_pull_request(thread.clone(), f.key()).await;
        assert_eq!(
            app.change_pull_request(thread.clone(), update.clone())
                .await
                .unwrap(),
            uncertain
        );
        assert_eq!(
            app.pull_request_operations(thread.clone(), f.key())
                .await
                .unwrap()
                .len(),
            7
        );
    }
    f.state(json!({"head":"d".repeat(40),"lifecycle":"MERGED","mergedAt":"2099-10-05T13:00:00Z"}));
    app.read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(
        app.pull_request_operations(thread.clone(), f.key())
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        app.change_pull_request(thread.clone(), inputs[0].clone())
            .await
            .unwrap(),
        uncertain
    );
    assert_eq!(
        app.reconcile_pull_request(thread.clone(), f.key(), inputs[0].request_id.clone())
            .await
            .unwrap_err()
            .code,
        "pr_recovery_unavailable"
    );
    assert!(
        app.pull_request_operations(thread.clone(), f.key())
            .await
            .unwrap()
            .is_empty()
    );
    for input in &inputs[1..] {
        assert!(matches!(
            app.change_pull_request(thread.clone(), input.clone())
                .await
                .unwrap(),
            PrChangeResult::Superseded {
                evidence: PrSupersession::PullRequestMerged { .. },
                ..
            }
        ));
    }
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn uncertain_update_storage_failure_preserves_pending_receipt() {
    let f = Fixture::new();
    let (app, thread, input, uncertain) = recovered_update(&f).await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    app.shutdown().await.unwrap();
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER deny_recovery BEFORE UPDATE ON pull_request_operations WHEN NEW.state='applied' BEGIN SELECT RAISE(FAIL, 'fixture recovery storage failure'); END;").unwrap();
    drop(db);
    let app = App::open(f.config.clone()).await.unwrap();
    assert_eq!(
        app.acknowledge_uncertain_update(thread.clone(), acknowledgment(&input, &detail))
            .await
            .unwrap_err()
            .code,
        "storage"
    );
    assert_eq!(
        app.pull_request_operations(thread.clone(), f.key())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        uncertain
    );
    f.state(json!({"head":"d".repeat(40),"lifecycle":"MERGED","mergedAt":"2099-10-05T13:00:00Z"}));
    assert!(
        app.read_pull_request(thread.clone(), f.key())
            .await
            .is_err()
    );
    assert_eq!(
        app.pull_request_operations(thread.clone(), f.key())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        uncertain
    );
    assert!(summary(&app, &thread).await.settled_at_ms.is_none());
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn old_epoch_merged_status_cannot_supersede_uncertain_update() {
    let f = Fixture::new();
    let (app, thread, input, uncertain) = recovered_update(&f).await;
    app.read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let release = f.dir.path().join("old-merged-status");
    f.state(json!({"head":"d".repeat(40),"lifecycle":"MERGED","mergedAt":"2099-10-05T13:00:00Z","waitFor":{"BotPullRequest":release}}));
    let calls = f.calls("BotPullRequest", 41);
    app.list_thread_pull_requests(thread.clone(), true)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.calls("BotPullRequest", 41) == calls {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    f.state(json!({"head":"d".repeat(40)}));
    assert_eq!(
        app.reconcile_pull_request(thread.clone(), f.key(), input.request_id.clone())
            .await
            .unwrap(),
        uncertain
    );
    std::fs::write(release, "release").unwrap();
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    assert_eq!(
        app.pull_request_operations(thread.clone(), f.key())
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        app.change_pull_request(thread.clone(), input)
            .await
            .unwrap(),
        uncertain
    );
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}
