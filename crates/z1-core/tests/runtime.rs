use std::{os::unix::fs::PermissionsExt, process::Command, time::Duration};
use z1_core::*;
struct Fixture {
    _dir: tempfile::TempDir,
    config: RuntimeConfig,
    repository: std::path::PathBuf,
    peer: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repository = dir.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(["init", "-q"])
                .status()
                .unwrap()
                .success()
        );
        let peer = dir.path().join("peer.py");
        std::fs::write(&peer, include_str!("support/codex_peer.py")).unwrap();
        std::fs::set_permissions(&peer, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            config: RuntimeConfig {
                data_dir: dir.path().join("state"),
                codex_binary: peer.clone(),
            },
            _dir: dir,
            repository,
            peer,
        }
    }
    fn calls(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.peer.parent().unwrap().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
}
async fn wait(
    app: &App,
    id: &ThreadId,
    predicate: impl Fn(&ThreadSnapshot) -> bool,
) -> ThreadSnapshot {
    for _ in 0..500 {
        let snapshot = app.thread(id.clone()).await.unwrap();
        if predicate(&snapshot) {
            return snapshot;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("Timed out awaiting public snapshot state")
}
async fn conversation(app: &App, f: &Fixture) -> ThreadSnapshot {
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    app.create_thread(workspace.id).await.unwrap()
}
#[tokio::test]
async fn receipts_prevent_duplicate_prompts_and_reject_different_input() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let mut changes = app.subscribe();
    let first = app
        .submit(thread.id.clone(), "operation".into(), "hello".into())
        .await
        .unwrap();
    let same = app
        .submit(thread.id.clone(), "operation".into(), "hello".into())
        .await
        .unwrap();
    assert_eq!(first.turn_id, same.turn_id);
    assert_eq!(
        app.submit(thread.id.clone(), "operation".into(), "different".into())
            .await
            .unwrap_err()
            .code,
        "request_conflict"
    );
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    let mut refresh = false;
    while let Ok(hint) = changes.try_recv() {
        refresh |= hint.thread_id == thread.id
            && hint.workspace_id == thread.workspace_id
            && hint.refresh_workspace;
    }
    assert!(
        refresh,
        "Completion must refresh its workspace even without a visible conversation"
    );
    assert_eq!(
        f.calls()
            .iter()
            .filter(|v| v["method"] == "turn/start")
            .count(),
        1
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn lost_acceptance_stays_uncertain_after_restart_and_never_replays() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "lost".into(), "lose".into())
        .await
        .unwrap();
    let snapshot = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].delivery, Delivery::Uncertain { .. })
    })
    .await;
    assert!(matches!(
        snapshot.turns[0].execution,
        Execution::Lost { .. }
    ));
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    app.submit(thread.id.clone(), "lost".into(), "lose".into())
        .await
        .unwrap();
    let restored = app.thread(thread.id).await.unwrap();
    assert_eq!(restored.turns.len(), 1);
    assert_eq!(restored.turns[0].completed_at_ms, None);
    assert_eq!(
        f.calls()
            .iter()
            .filter(|v| v["method"] == "turn/start")
            .count(),
        1
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn routes_multiple_approvals_by_callback_and_expires_old_clicks() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let mut hints = app.subscribe();
    app.submit(thread.id.clone(), "approvals".into(), "approval".into())
        .await
        .unwrap();
    let snapshot = wait(&app, &thread.id, |t| t.approvals.len() == 2).await;
    let mut hinted_approval = false;
    while let Ok(hint) = hints.try_recv() {
        hinted_approval |= hint.thread_id == thread.id && hint.summary.awaiting_approval;
    }
    assert!(hinted_approval);
    let summary = |view: WorkspaceView| {
        view.threads
            .into_iter()
            .find(|summary| summary.id == thread.id)
            .unwrap()
    };
    let view = app
        .workspace_view(snapshot.workspace_id.clone())
        .await
        .unwrap();
    assert!(summary(view).awaiting_approval);
    for approval in &snapshot.approvals {
        app.answer_approval(approval.id.clone(), ApprovalDecision::Decline)
            .await
            .unwrap();
        assert_eq!(
            app.answer_approval(approval.id.clone(), ApprovalDecision::Accept)
                .await
                .unwrap_err()
                .code,
            "approval_expired"
        );
    }
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    let view = app
        .workspace_view(snapshot.workspace_id.clone())
        .await
        .unwrap();
    assert!(!summary(view).awaiting_approval);
    let responses: Vec<_> = f
        .calls()
        .into_iter()
        .filter(|v| v.get("method").is_none() && v.get("result").is_some())
        .collect();
    assert_eq!(responses.len(), 2);
    assert_ne!(responses[0]["id"], responses[1]["id"]);
    assert!(
        responses
            .iter()
            .all(|v| v["result"]["decision"] == "decline")
    );
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    assert!(
        app.answer_approval(snapshot.approvals[0].id.clone(), ApprovalDecision::Accept)
            .await
            .is_err()
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn missing_command_cannot_be_approved_and_late_file_details_become_reviewable() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(
        thread.id.clone(),
        "missing".into(),
        "missing-command".into(),
    )
    .await
    .unwrap();
    let snapshot = wait(&app, &thread.id, |t| t.approvals.len() == 2).await;
    assert_eq!(
        app.answer_approval(snapshot.approvals[0].id.clone(), ApprovalDecision::Accept)
            .await
            .unwrap_err()
            .code,
        "approval_details_missing"
    );
    for a in snapshot.approvals {
        app.answer_approval(a.id, ApprovalDecision::Decline)
            .await
            .unwrap();
    }
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.submit(thread.id.clone(), "file".into(), "late-file".into())
        .await
        .unwrap();
    let snapshot=wait(&app,&thread.id,|t|t.approvals.iter().any(|a|matches!(&a.action,ApprovalAction::FileChange{text,..} if text.contains("fixture change")))).await;
    let paths: Vec<&Vec<String>> = snapshot.turns[1]
        .items
        .iter()
        .filter_map(|item| match item {
            Item::FileChange { paths, .. } => Some(paths),
            _ => None,
        })
        .collect();
    assert_eq!(paths, vec![&vec!["test.txt".to_string()]]);
    let a = snapshot.approvals.last().unwrap();
    app.answer_approval(a.id.clone(), ApprovalDecision::Accept)
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[1].execution, Execution::Completed)
    })
    .await;
    assert!(
        f.calls()
            .iter()
            .any(|v| v["id"] == "file-route" && v["result"]["decision"] == "accept")
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn canonical_checkout_lease_and_confirmed_interrupt() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let first = app.open_workspace(f.repository.clone()).await.unwrap();
    let second = app.open_workspace(f.repository.join(".")).await.unwrap();
    assert_eq!(first.id, second.id);
    let a = app.create_thread(first.id.clone()).await.unwrap();
    let b = app.create_thread(first.id).await.unwrap();
    app.submit(a.id.clone(), "hold".into(), "hold".into())
        .await
        .unwrap();
    let running = wait(&app, &a.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    let started = running.turns[0].started_at_ms.expect("started_at recorded");
    assert_eq!(running.turns[0].completed_at_ms, None);
    assert_eq!(
        app.submit(b.id.clone(), "blocked".into(), "hello".into())
            .await
            .unwrap_err()
            .code,
        "checkout_busy"
    );
    app.interrupt(a.id.clone()).await.unwrap();
    let interrupted = wait(&app, &a.id, |t| {
        matches!(t.turns[0].execution, Execution::Interrupted)
    })
    .await;
    let completed = interrupted.turns[0]
        .completed_at_ms
        .expect("completed_at recorded");
    assert!(completed >= started);
    app.submit(b.id.clone(), "free".into(), "hello".into())
        .await
        .unwrap();
    wait(&app, &b.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn exclusive_data_owner_and_dropping_app_terminates_child() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    assert!(matches!(App::open(f.config.clone()).await,Err(e) if e.code=="already_running"));
    let t = conversation(&app, &f).await;
    app.submit(t.id.clone(), "hold".into(), "hold".into())
        .await
        .unwrap();
    wait(&app, &t.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    let pid = std::fs::read_to_string(f.peer.parent().unwrap().join("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    drop(app);
    for _ in 0..300 {
        if unsafe { libc::kill(pid, 0) } != 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_ne!(
        unsafe { libc::kill(pid, 0) },
        0,
        "Dropping all App handles must reap Codex"
    );
    let reopened = App::open(f.config).await.unwrap();
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn stalled_provider_pipe_becomes_uncertain_without_blocking_runtime() {
    let f = Fixture::new();
    std::fs::write(f.peer.parent().unwrap().join("stall"), "").unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "stall".into(), "x".repeat(95_000))
        .await
        .unwrap();
    let snapshot = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].delivery, Delivery::Uncertain { .. })
    })
    .await;
    assert!(matches!(
        snapshot.turns[0].execution,
        Execution::Lost { .. }
    ));
    assert!(app.list_workspaces().await.is_ok());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn late_missing_start_response_preserves_confirmed_completion_and_new_turn() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "late".into(), "late-response".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.submit(thread.id.clone(), "newer".into(), "hold".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Running)
    })
    .await;
    tokio::time::sleep(Duration::from_secs(21)).await;
    let snapshot = app.thread(thread.id.clone()).await.unwrap();
    assert!(matches!(snapshot.turns[0].execution, Execution::Completed));
    assert!(matches!(snapshot.turns[1].execution, Execution::Running));
    assert!(matches!(snapshot.session, SessionState::Running));
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn save_failures_preserve_retryable_approval_and_interrupt_state() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "approval".into(), "approval".into())
        .await
        .unwrap();
    let snapshot = wait(&app, &thread.id, |t| t.approvals.len() == 2).await;
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_save BEFORE UPDATE ON threads BEGIN SELECT RAISE(FAIL,'fixture save failure'); END;").unwrap();
    assert!(
        app.answer_approval(snapshot.approvals[0].id.clone(), ApprovalDecision::Accept)
            .await
            .is_err()
    );
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().approvals[0].state,
        ApprovalState::Pending
    );
    assert!(
        !f.calls()
            .iter()
            .any(|v| v["id"] == "route-one" && v.get("result").is_some())
    );
    assert!(app.interrupt(thread.id.clone()).await.is_err());
    assert!(matches!(
        app.thread(thread.id.clone()).await.unwrap().session,
        SessionState::Running
    ));
    assert!(!f.calls().iter().any(|v| v["method"] == "turn/interrupt"));
    db.execute_batch("DROP TRIGGER reject_save;").unwrap();
    for approval in snapshot.approvals {
        app.answer_approval(approval.id, ApprovalDecision::Decline)
            .await
            .unwrap();
    }
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn shutdown_terminates_same_group_tool_after_leader_exits() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "descendant".into(), "descendant".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    let pid_path = f.peer.parent().unwrap().join("descendant.pid");
    for _ in 0..100 {
        if pid_path.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let pid = std::fs::read_to_string(pid_path)
        .unwrap()
        .parse::<i32>()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    app.shutdown().await.unwrap();
    for _ in 0..100 {
        if unsafe { libc::kill(pid, 0) } != 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_ne!(
        unsafe { libc::kill(pid, 0) },
        0,
        "Same-group tool must not outlive runtime shutdown"
    );
}

#[tokio::test]
async fn model_catalog_settings_and_protocol_modes() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let models = app.models().await.unwrap();
    assert_eq!(
        models
            .iter()
            .map(|model| model.model.as_str())
            .collect::<Vec<_>>(),
        vec!["model-one", "model-two"]
    );
    assert_eq!(
        f.calls()
            .iter()
            .filter(|call| call["method"] == "model/list")
            .count(),
        2
    );
    let modes = [
        (
            PermissionMode::ApprovalRequired,
            "untrusted",
            "user",
            "read-only",
            "readOnly",
        ),
        (
            PermissionMode::AutoAcceptEdits,
            "on-request",
            "user",
            "workspace-write",
            "workspaceWrite",
        ),
        (
            PermissionMode::Auto,
            "on-request",
            "auto_review",
            "workspace-write",
            "workspaceWrite",
        ),
        (
            PermissionMode::FullAccess,
            "never",
            "user",
            "danger-full-access",
            "dangerFullAccess",
        ),
    ];
    for (index, (mode, policy, reviewer, sandbox, turn_sandbox)) in modes.into_iter().enumerate() {
        let thread = conversation(&app, &f).await;
        let settings = SessionSettings {
            model: Some("model-one".into()),
            effort: Some("ultra".into()),
            permission_mode: mode,
        };
        let saved = app
            .update_settings(thread.id.clone(), settings.clone())
            .await
            .unwrap();
        assert_eq!(saved.settings, settings);
        assert!(saved.revision > thread.revision);
        app.submit(thread.id.clone(), format!("mode-{index}"), "hello".into())
            .await
            .unwrap();
        let done = wait(&app, &thread.id, |t| {
            matches!(t.turns[0].execution, Execution::Completed)
        })
        .await;
        assert_eq!(done.turns[0].settings, Some(settings));
        let calls = f.calls();
        let start = calls
            .iter()
            .rev()
            .find(|call| call["method"] == "thread/start")
            .unwrap();
        let turn = calls
            .iter()
            .rev()
            .find(|call| call["method"] == "turn/start")
            .unwrap();
        assert_eq!(start["params"]["model"], "model-one");
        assert_eq!(start["params"]["approvalPolicy"], policy);
        assert_eq!(start["params"]["approvalsReviewer"], reviewer);
        assert_eq!(start["params"]["sandbox"], sandbox);
        assert_eq!(turn["params"]["model"], "model-one");
        assert_eq!(turn["params"]["effort"], "ultra");
        assert_eq!(turn["params"]["approvalPolicy"], policy);
        assert_eq!(turn["params"]["approvalsReviewer"], reviewer);
        assert_eq!(turn["params"]["sandboxPolicy"]["type"], turn_sandbox);
    }
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn settings_persist_reset_defaults_and_reject_busy_or_invalid_choices() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    app.models().await.unwrap();
    let thread = conversation(&app, &f).await;
    let id = thread.id.clone();
    let selected = SessionSettings {
        model: Some("model-one".into()),
        effort: Some("ultra".into()),
        permission_mode: PermissionMode::Auto,
    };
    app.update_settings(id.clone(), selected).await.unwrap();
    assert_eq!(
        app.update_settings(
            id.clone(),
            SessionSettings {
                model: Some("missing".into()),
                ..Default::default()
            }
        )
        .await
        .unwrap_err()
        .code,
        "invalid_model"
    );
    assert_eq!(
        app.update_settings(
            id.clone(),
            SessionSettings {
                model: Some("model-two".into()),
                effort: Some("ultra".into()),
                ..Default::default()
            }
        )
        .await
        .unwrap_err()
        .code,
        "invalid_effort"
    );
    app.submit(id.clone(), "hold-one".into(), "hold".into())
        .await
        .unwrap();
    wait(&app, &id, |t| matches!(t.session, SessionState::Running)).await;
    assert_eq!(
        app.update_settings(id.clone(), SessionSettings::default())
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    app.interrupt(id.clone()).await.unwrap();
    wait(&app, &id, |t| {
        matches!(t.turns[0].execution, Execution::Interrupted)
    })
    .await;
    app.update_settings(id.clone(), SessionSettings::default())
        .await
        .unwrap();
    app.submit(id.clone(), "reset".into(), "hello".into())
        .await
        .unwrap();
    wait(&app, &id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Completed)
    })
    .await;
    let turn = f
        .calls()
        .into_iter()
        .rev()
        .find(|call| call["method"] == "turn/start")
        .unwrap();
    assert_eq!(turn["params"]["model"], "model-one");
    assert_eq!(turn["params"]["effort"], "low");
    assert_eq!(turn["params"]["approvalsReviewer"], "user");
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let restored = app.thread(id.clone()).await.unwrap();
    assert_eq!(restored.settings, SessionSettings::default());
    assert_eq!(
        restored.turns[0]
            .settings
            .as_ref()
            .unwrap()
            .effort
            .as_deref(),
        Some("ultra")
    );
    assert_eq!(restored.turns[1].settings, Some(SessionSettings::default()));
    app.models().await.unwrap();
    app.open_thread(id.clone()).await.unwrap();
    wait(&app, &id, |t| matches!(t.session, SessionState::Ready)).await;
    let resume = f
        .calls()
        .into_iter()
        .rev()
        .find(|call| call["method"] == "thread/resume")
        .unwrap();
    assert_eq!(resume["params"]["model"], "model-one");
    assert_eq!(resume["params"]["sandbox"], "read-only");
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn model_catalog_failure_can_retry_and_default_drafts_still_send() {
    let f = Fixture::new();
    std::fs::write(f.peer.parent().unwrap().join("models_error"), "").unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    assert_eq!(app.models().await.unwrap_err().code, "provider");
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "default".into(), "hello".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.submit(thread.id.clone(), "default-followup".into(), "hello".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Completed)
    })
    .await;
    std::fs::remove_file(f.peer.parent().unwrap().join("models_error")).unwrap();
    assert_eq!(app.models().await.unwrap().len(), 2);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn catalog_refresh_failure_preserves_effort_reset() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    app.models().await.unwrap();
    let thread = conversation(&app, &f).await;
    app.update_settings(
        thread.id.clone(),
        SessionSettings {
            model: Some("model-one".into()),
            effort: Some("ultra".into()),
            permission_mode: PermissionMode::ApprovalRequired,
        },
    )
    .await
    .unwrap();
    app.submit(thread.id.clone(), "ultra".into(), "hello".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.update_settings(thread.id.clone(), SessionSettings::default())
        .await
        .unwrap();
    std::fs::write(f.peer.parent().unwrap().join("models_error"), "").unwrap();
    assert_eq!(app.models().await.unwrap_err().code, "provider");
    app.submit(thread.id.clone(), "reset".into(), "hello".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Completed)
    })
    .await;
    let calls = f.calls();
    let turn = calls
        .iter()
        .rev()
        .find(|call| call["method"] == "turn/start")
        .unwrap();
    assert_eq!(turn["params"]["model"], "model-one");
    assert_eq!(turn["params"]["effort"], "low");
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn refreshed_catalog_rejects_removed_saved_model_before_acceptance() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    app.models().await.unwrap();
    let thread = conversation(&app, &f).await;
    app.update_settings(
        thread.id.clone(),
        SessionSettings {
            model: Some("model-one".into()),
            effort: Some("ultra".into()),
            permission_mode: PermissionMode::ApprovalRequired,
        },
    )
    .await
    .unwrap();
    std::fs::write(f.peer.parent().unwrap().join("models_removed"), "").unwrap();
    assert!(app.models().await.unwrap().is_empty());
    let error = app
        .submit(thread.id.clone(), "removed".into(), "hello".into())
        .await
        .unwrap_err();
    assert_eq!(error.code, "invalid_model");
    assert!(app.thread(thread.id).await.unwrap().turns.is_empty());
    assert!(!f.calls().iter().any(|call| call["method"] == "turn/start"));
    app.shutdown().await.unwrap();
}
#[test]
fn legacy_snapshots_default_settings() {
    let thread = ThreadSnapshot {
        id: ThreadId::default(),
        workspace_id: WorkspaceId::default(),
        title: "Legacy".into(),
        native_thread_id: None,
        revision: 1,
        session: SessionState::Draft,
        settings: SessionSettings::default(),
        turns: vec![Turn {
            id: TurnId::default(),
            prompt: "hello".into(),
            native_turn_id: None,
            delivery: Delivery::Accepted,
            execution: Execution::Completed,
            items: vec![],
            settings: None,
            started_at_ms: None,
            completed_at_ms: None,
        }],
        approvals: vec![],
        diagnostic: None,
    };
    let mut value = serde_json::to_value(thread).unwrap();
    value.as_object_mut().unwrap().remove("settings");
    value["turns"][0]
        .as_object_mut()
        .unwrap()
        .remove("settings");
    let restored: ThreadSnapshot = serde_json::from_value(value).unwrap();
    assert_eq!(restored.settings, SessionSettings::default());
    assert!(restored.turns[0].settings.is_none());
}
#[tokio::test]
async fn provider_loss_invalidates_catalog_and_reloads_on_request() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    app.models().await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "loss".into(), "lose".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.session, SessionState::Unavailable { .. })
    })
    .await;
    assert_eq!(app.models().await.unwrap().len(), 2);
    assert_eq!(
        f.calls()
            .iter()
            .filter(|call| call["method"] == "model/list")
            .count(),
        4
    );
    app.shutdown().await.unwrap();
}
