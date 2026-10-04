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
                .args(["init", "-q", "-b", "main"])
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
    fn commit(&self) {
        std::fs::write(self.repository.join("README.md"), "fixture\n").unwrap();
        for args in [
            &["add", "README.md"][..],
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-qm",
                "initial",
            ],
        ] {
            git_output(&self.repository, args);
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
// Under parallel tests, a reopen right after shutdown can still see the lock for a few milliseconds.
async fn reopen(config: &RuntimeConfig) -> App {
    for _ in 0..100 {
        match App::open(config.clone()).await {
            Err(e) if e.code == "already_running" => {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            other => return other.unwrap(),
        }
    }
    panic!("The previous runtime never released its data directory")
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
    app.create_thread(workspace.id, NewCheckout::Local)
        .await
        .unwrap()
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
    let app = reopen(&f.config).await;
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
        .workspace_view(snapshot.workspace_id.clone(), None)
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
        .workspace_view(snapshot.workspace_id.clone(), None)
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
    let app = reopen(&f.config).await;
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
    let a = app
        .create_thread(first.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let b = app
        .create_thread(first.id, NewCheckout::Local)
        .await
        .unwrap();
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
    let reopened = reopen(&f.config).await;
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
    let app = reopen(&f.config).await;
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
        checkout: Checkout::Worktree {
            path: "/legacy".into(),
            branch: "z1/legacy".into(),
        },
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
        settlement: Settlement::Kept,
    };
    let mut value = serde_json::to_value(thread).unwrap();
    value.as_object_mut().unwrap().remove("settlement");
    value.as_object_mut().unwrap().remove("settings");
    value.as_object_mut().unwrap().remove("checkout");
    value["turns"][0]
        .as_object_mut()
        .unwrap()
        .remove("settings");
    let restored: ThreadSnapshot = serde_json::from_value(value).unwrap();
    assert_eq!(restored.settings, SessionSettings::default());
    assert_eq!(restored.checkout, Checkout::Local);
    assert!(restored.turns[0].settings.is_none());
    assert_eq!(restored.settlement, Settlement::Auto);
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
fn worktree(checkout: &Checkout) -> (std::path::PathBuf, String) {
    match checkout {
        Checkout::Worktree { path, branch } => (path.clone(), branch.clone()),
        other => panic!("expected a worktree checkout, got {other:?}"),
    }
}
fn main_worktree() -> NewCheckout {
    NewCheckout::Worktree {
        base: "main".into(),
        from_origin: false,
    }
}
fn git_output(root: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success());
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}
#[tokio::test]
async fn worktree_threads_start_codex_in_their_own_checkout() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let local = app
        .create_thread(workspace.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    assert_eq!(local.checkout, Checkout::Local);
    let isolated = app
        .create_thread(workspace.id.clone(), main_worktree())
        .await
        .unwrap();
    let (path, branch) = worktree(&isolated.checkout);
    let id = branch.strip_prefix("z1code/").unwrap();
    assert_eq!(id.len(), 8);
    assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(
        path,
        f.config
            .data_dir
            .join("worktrees/repository")
            .canonicalize()
            .unwrap()
            .join(format!("z1code-{id}"))
    );
    assert_eq!(git_output(&path, &["branch", "--show-current"]), branch);
    for thread in [&local, &isolated] {
        app.submit(thread.id.clone(), thread.id.to_string(), "hello".into())
            .await
            .unwrap();
        wait(&app, &thread.id, |t| {
            matches!(t.turns[0].execution, Execution::Completed)
        })
        .await;
    }
    let cwds: Vec<_> = f
        .calls()
        .into_iter()
        .filter(|v| v["method"] == "thread/start")
        .map(|v| v["params"]["cwd"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        cwds,
        vec![
            workspace.root.to_string_lossy().into_owned(),
            path.to_string_lossy().into_owned()
        ]
    );
    let summary = app
        .workspace_view(workspace.id, None)
        .await
        .unwrap()
        .threads
        .into_iter()
        .find(|t| t.id == isolated.id)
        .unwrap();
    assert_eq!(summary.checkout, isolated.checkout);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn worktree_threads_run_beside_a_busy_local_checkout() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let held = app
        .create_thread(workspace.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let blocked = app
        .create_thread(workspace.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let isolated = app
        .create_thread(workspace.id, main_worktree())
        .await
        .unwrap();
    app.submit(held.id.clone(), "hold".into(), "hold".into())
        .await
        .unwrap();
    wait(&app, &held.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    assert_eq!(
        app.submit(blocked.id.clone(), "blocked".into(), "hello".into())
            .await
            .unwrap_err()
            .code,
        "checkout_busy"
    );
    app.submit(isolated.id.clone(), "isolated".into(), "hello".into())
        .await
        .unwrap();
    wait(&app, &isolated.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn worktree_requires_a_commit() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    assert_eq!(
        app.create_thread(workspace.id.clone(), main_worktree())
            .await
            .unwrap_err()
            .code,
        "worktree_unavailable"
    );
    let view = app.workspace_view(workspace.id, None).await.unwrap();
    assert!(view.threads.is_empty());
    assert!(!f.config.data_dir.join("worktrees").exists());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn worktree_views_inspect_the_thread_checkout() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let isolated = app
        .create_thread(workspace.id.clone(), main_worktree())
        .await
        .unwrap();
    let (path, branch) = worktree(&isolated.checkout);
    std::fs::write(path.join("only-here.txt"), "worktree\n").unwrap();
    let view = app
        .workspace_view(workspace.id.clone(), Some(isolated.id.clone()))
        .await
        .unwrap();
    assert_eq!(view.branch, branch);
    assert_eq!(view.workspace.root, path);
    assert_eq!(view.workspace.id, workspace.id);
    assert_eq!(view.files, vec!["README.md", "only-here.txt"]);
    let local = app
        .workspace_view(workspace.id.clone(), None)
        .await
        .unwrap();
    assert_eq!(local.workspace.root, workspace.root);
    assert_eq!(local.files, vec!["README.md"]);
    assert!(matches!(
        app.read_file(workspace.id.clone(), Some(isolated.id.clone()), "only-here.txt".into())
            .await
            .unwrap(),
        FileView::Text { contents, .. } if contents == "worktree\n"
    ));
    assert!(
        app.read_file(workspace.id, None, "only-here.txt".into())
            .await
            .is_err()
    );
    let other = f.repository.with_file_name("other");
    std::fs::create_dir(&other).unwrap();
    git_output(&other, &["init", "-q"]);
    let other = app.open_workspace(other).await.unwrap();
    assert_eq!(
        app.workspace_view(other.id, Some(isolated.id))
            .await
            .unwrap_err()
            .code,
        "missing_thread"
    );
    app.shutdown().await.unwrap();
}
fn add_origin(f: &Fixture) -> std::path::PathBuf {
    let origin = f.repository.with_file_name("origin.git");
    git_output(
        f.repository.parent().unwrap(),
        &["clone", "-q", "--bare", "repository", "origin.git"],
    );
    git_output(
        &f.repository,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git_output(&f.repository, &["fetch", "-q", "origin"]);
    git_output(&f.repository, &["remote", "set-head", "origin", "main"]);
    origin
}
fn branch(name: &str, worktree: Option<&std::path::Path>) -> Branch {
    Branch {
        name: name.into(),
        remote: false,
        current: false,
        default: false,
        worktree: worktree.map(|p| p.canonicalize().unwrap()),
    }
}
#[tokio::test]
async fn branches_list_local_and_origin_refs_for_each_checkout() {
    let f = Fixture::new();
    f.commit();
    add_origin(&f);
    git_output(&f.repository, &["push", "-q", "origin", "main:feature"]);
    git_output(&f.repository, &["fetch", "-q", "origin"]);
    git_output(&f.repository, &["branch", "idle"]);
    let topic = f.repository.with_file_name("topic");
    git_output(
        &f.repository,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "topic",
            topic.to_str().unwrap(),
        ],
    );
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let main = Branch {
        current: true,
        default: true,
        ..branch("main", Some(&f.repository))
    };
    let feature = Branch {
        remote: true,
        ..branch("origin/feature", None)
    };
    assert_eq!(
        app.list_branches(workspace.id.clone(), None).await.unwrap(),
        Branches {
            branches: vec![
                main.clone(),
                branch("idle", None),
                branch("topic", Some(&topic)),
                feature.clone(),
            ],
            origin: true,
        }
    );
    let isolated = app
        .create_thread(workspace.id.clone(), main_worktree())
        .await
        .unwrap();
    let (path, name) = worktree(&isolated.checkout);
    let listed = app
        .list_branches(workspace.id, Some(isolated.id))
        .await
        .unwrap()
        .branches;
    assert_eq!(
        listed,
        vec![
            Branch {
                current: true,
                ..branch(&name, Some(&path))
            },
            Branch {
                current: false,
                ..main
            },
            branch("idle", None),
            branch("topic", Some(&topic)),
            feature,
        ]
    );
    app.shutdown().await.unwrap();
}
fn commit_in(root: &std::path::Path, file: &str) {
    std::fs::write(root.join(file), file).unwrap();
    git_output(root, &["add", file]);
    git_output(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            file,
        ],
    );
}
#[tokio::test]
async fn worktrees_start_from_origin_when_asked() {
    let f = Fixture::new();
    f.commit();
    let origin = add_origin(&f);
    let upstream = f.repository.with_file_name("upstream");
    git_output(
        f.repository.parent().unwrap(),
        &["clone", "-q", "origin.git", "upstream"],
    );
    commit_in(&upstream, "ahead.txt");
    git_output(&upstream, &["push", "-q", "origin", "main"]);
    git_output(&f.repository, &["branch", "idle"]);
    let local_main = git_output(&f.repository, &["rev-parse", "main"]);
    let origin_main = git_output(&origin, &["rev-parse", "main"]);
    assert_ne!(local_main, origin_main);
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let head = |base: &str, from_origin: bool| {
        let (app, id) = (&app, workspace.id.clone());
        let base = base.to_owned();
        async move {
            let thread = app
                .create_thread(id, NewCheckout::Worktree { base, from_origin })
                .await
                .unwrap();
            git_output(&worktree(&thread.checkout).0, &["rev-parse", "HEAD"])
        }
    };
    assert_eq!(head("main", true).await, origin_main);
    assert_eq!(head("main", false).await, local_main);
    assert_eq!(head("idle", true).await, local_main);
    git_output(
        &f.repository,
        &["remote", "set-url", "origin", "/missing.git"],
    );
    assert_eq!(
        app.create_thread(
            workspace.id,
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: true
            }
        )
        .await
        .unwrap_err()
        .code,
        "git"
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn switch_branch_changes_the_checkout_unless_its_lease_is_held() {
    let f = Fixture::new();
    f.commit();
    add_origin(&f);
    git_output(&f.repository, &["push", "-q", "origin", "main:feature"]);
    git_output(&f.repository, &["fetch", "-q", "origin"]);
    git_output(&f.repository, &["branch", "idle"]);
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let current = |root: &std::path::Path| git_output(root, &["branch", "--show-current"]);
    let switch = |thread: Option<&ThreadId>, branch: &str, create: bool| {
        app.switch_branch(workspace.id.clone(), thread.cloned(), branch.into(), create)
    };
    switch(None, "idle", false).await.unwrap();
    assert_eq!(current(&f.repository), "idle");
    switch(None, "fresh", true).await.unwrap();
    assert_eq!(current(&f.repository), "fresh");
    switch(None, "origin/feature", false).await.unwrap();
    assert_eq!(current(&f.repository), "feature");
    for name in ["bad name", "-x", "HEAD"] {
        assert_eq!(
            switch(None, name, true).await.unwrap_err().code,
            "invalid_branch"
        );
    }
    assert_eq!(current(&f.repository), "feature");
    let isolated = app
        .create_thread(workspace.id.clone(), main_worktree())
        .await
        .unwrap();
    let (path, _) = worktree(&isolated.checkout);
    assert_eq!(
        switch(Some(&isolated.id), "feature", false)
            .await
            .unwrap_err()
            .code,
        "git"
    );
    switch(Some(&isolated.id), "renamed", true).await.unwrap();
    assert_eq!(current(&path), "renamed");
    let expected = Checkout::Worktree {
        path: path.clone(),
        branch: "renamed".into(),
    };
    assert_eq!(
        app.thread(isolated.id.clone()).await.unwrap().checkout,
        expected
    );
    let summary = app
        .workspace_view(workspace.id.clone(), None)
        .await
        .unwrap()
        .threads
        .into_iter()
        .find(|t| t.id == isolated.id)
        .unwrap();
    assert_eq!(summary.checkout, expected);
    let held = app
        .create_thread(workspace.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    app.submit(held.id.clone(), "hold".into(), "hold".into())
        .await
        .unwrap();
    wait(&app, &held.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    assert_eq!(
        switch(None, "idle", false).await.unwrap_err().code,
        "checkout_busy"
    );
    assert_eq!(
        switch(Some(&held.id), "idle", false)
            .await
            .unwrap_err()
            .code,
        "checkout_busy"
    );
    assert_eq!(current(&f.repository), "feature");
    switch(Some(&isolated.id), "idle", false).await.unwrap();
    assert_eq!(current(&path), "idle");
    app.interrupt(held.id.clone()).await.unwrap();
    wait(&app, &held.id, |t| {
        matches!(t.turns[0].execution, Execution::Interrupted)
    })
    .await;
    switch(None, "main", false).await.unwrap();
    assert_eq!(current(&f.repository), "main");
    app.shutdown().await.unwrap();
}
async fn scratch(app: &App) -> Vec<WorkspaceId> {
    app.list_workspaces()
        .await
        .unwrap()
        .into_iter()
        .filter(|w| w.kind == WorkspaceKind::Scratch)
        .map(|w| w.id)
        .collect()
}
fn folder(checkout: &Checkout) -> std::path::PathBuf {
    match checkout {
        Checkout::Folder { path } => path.clone(),
        other => panic!("expected a folder checkout, got {other:?}"),
    }
}
#[tokio::test]
async fn no_project_is_created_once_on_first_use() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    assert!(app.scratch_available());
    assert!(scratch(&app).await.is_empty());
    let (first, second) = tokio::join!(app.ensure_scratch(), app.ensure_scratch());
    let first = first.unwrap();
    assert_eq!(second.unwrap().id, first.id);
    assert_eq!(first.label, "No project");
    assert_eq!(first.kind, WorkspaceKind::Scratch);
    assert_eq!(
        first.root,
        f.config.data_dir.canonicalize().unwrap().join("scratch")
    );
    assert_eq!(app.ensure_scratch().await.unwrap().id, first.id);
    assert_eq!(scratch(&app).await, vec![first.id.clone()]);
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    assert_eq!(scratch(&app).await, vec![first.id.clone()]);
    assert_eq!(app.ensure_scratch().await.unwrap().id, first.id);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn scratch_is_unavailable_inside_a_git_work_tree() {
    let f = Fixture::new();
    let inside = RuntimeConfig {
        data_dir: f.repository.join("state"),
        ..f.config.clone()
    };
    let app = App::open(inside).await.unwrap();
    assert!(!app.scratch_available());
    assert_eq!(
        app.ensure_scratch().await.unwrap_err().code,
        "scratch_unavailable"
    );
    assert!(scratch(&app).await.is_empty());
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let stored = app.ensure_scratch().await.unwrap();
    let thread = app
        .create_thread(
            stored.id.clone(),
            NewCheckout::Folder {
                prompt: "before".into(),
            },
        )
        .await
        .unwrap();
    app.shutdown().await.unwrap();
    git_output(f._dir.path(), &["init", "-q"]);
    let app = reopen(&f.config).await;
    assert!(!app.scratch_available());
    assert_eq!(scratch(&app).await, vec![stored.id.clone()]);
    let view = app
        .workspace_view(stored.id.clone(), Some(thread.id.clone()))
        .await
        .unwrap();
    assert_eq!(view.workspace.root, folder(&thread.checkout));
    assert_eq!(
        app.create_thread(
            stored.id,
            NewCheckout::Folder {
                prompt: "hello".into()
            }
        )
        .await
        .unwrap_err()
        .code,
        "scratch_unavailable"
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn folder_threads_get_a_dated_folder_named_from_the_prompt() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let home = app.ensure_scratch().await.unwrap();
    let thread = app
        .create_thread(
            home.id.clone(),
            NewCheckout::Folder {
                prompt: "Convert these PNGs to WebP please now ok".into(),
            },
        )
        .await
        .unwrap();
    let path = folder(&thread.checkout);
    assert!(path.is_dir());
    assert_eq!(path.parent().unwrap(), home.root);
    let today = Command::new("date")
        .args(["-u", "+%Y-%m-%d"])
        .output()
        .unwrap()
        .stdout;
    let prefix = format!(
        "{}-convert-these-pngs-to-webp-",
        String::from_utf8(today).unwrap().trim()
    );
    let name = path.file_name().unwrap().to_str().unwrap();
    let id = name.strip_prefix(&prefix).unwrap();
    assert_eq!(id.len(), 8);
    assert!(id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
    let unnamed = app
        .create_thread(
            home.id.clone(),
            NewCheckout::Folder {
                prompt: "!!!".into(),
            },
        )
        .await
        .unwrap();
    let unnamed = folder(&unnamed.checkout);
    let unnamed = unnamed.file_name().unwrap().to_str().unwrap();
    assert_eq!(unnamed.len(), "YYYY-MM-DD-".len() + 8);
    assert!(unnamed.starts_with(&prefix[..11]));
    let repository = app.open_workspace(f.repository.clone()).await.unwrap();
    for (workspace, checkout) in [
        (home.id.clone(), NewCheckout::Local),
        (home.id.clone(), main_worktree()),
        (
            repository.id,
            NewCheckout::Folder {
                prompt: "hello".into(),
            },
        ),
    ] {
        assert_eq!(
            app.create_thread(workspace, checkout)
                .await
                .unwrap_err()
                .code,
            "invalid_checkout"
        );
    }
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn folder_threads_browse_files_without_git() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let home = app.ensure_scratch().await.unwrap();
    let empty = app.workspace_view(home.id.clone(), None).await.unwrap();
    assert!(empty.threads.is_empty());
    let thread = app
        .create_thread(
            home.id.clone(),
            NewCheckout::Folder {
                prompt: "make notes".into(),
            },
        )
        .await
        .unwrap();
    let path = folder(&thread.checkout);
    std::fs::create_dir_all(path.join("nested")).unwrap();
    std::fs::create_dir_all(path.join(".git")).unwrap();
    std::fs::write(path.join("notes.txt"), "scratch\n").unwrap();
    std::fs::write(path.join("nested/b.txt"), "b\n").unwrap();
    std::fs::write(path.join(".git/HEAD"), "ignored\n").unwrap();
    let view = app
        .workspace_view(home.id.clone(), Some(thread.id.clone()))
        .await
        .unwrap();
    assert_eq!(view.workspace.root, path);
    assert_eq!(view.files, vec!["nested/b.txt", "notes.txt"]);
    assert!(view.changes.is_empty());
    assert_eq!(view.branch, "");
    assert!(matches!(
        app.read_file(home.id.clone(), Some(thread.id.clone()), "notes.txt".into())
            .await
            .unwrap(),
        FileView::Text { contents, .. } if contents == "scratch\n"
    ));
    assert!(matches!(
        app.read_diff(
            home.id.clone(),
            Some(thread.id.clone()),
            "notes.txt".into(),
            DiffBasis::Unstaged
        )
        .await
        .unwrap(),
        DiffView::Unavailable { .. }
    ));
    assert_eq!(
        app.list_branches(home.id.clone(), Some(thread.id.clone()))
            .await
            .unwrap_err()
            .code,
        "not_repository"
    );
    assert_eq!(
        app.switch_branch(
            home.id.clone(),
            Some(thread.id.clone()),
            "main".into(),
            true
        )
        .await
        .unwrap_err()
        .code,
        "not_repository"
    );
    let unassigned = app.workspace_view(home.id.clone(), None).await.unwrap();
    assert_eq!(
        unassigned
            .threads
            .iter()
            .map(|t| (&t.id, &t.checkout))
            .collect::<Vec<_>>(),
        vec![(&thread.id, &thread.checkout)]
    );
    assert!(unassigned.files.is_empty());
    assert_eq!(unassigned.workspace.root, home.root);
    assert!(
        app.read_file(home.id.clone(), None, "notes.txt".into())
            .await
            .is_err()
    );
    app.submit(thread.id.clone(), "scratch".into(), "hello".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    let cwds: Vec<_> = f
        .calls()
        .into_iter()
        .filter(|v| v["method"] == "thread/start")
        .map(|v| v["params"]["cwd"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(cwds, vec![path.to_string_lossy().into_owned()]);
    app.shutdown().await.unwrap();
}
fn second_repository(f: &Fixture) -> std::path::PathBuf {
    let root = f.repository.parent().unwrap().join("other");
    std::fs::create_dir(&root).unwrap();
    git_output(&root, &["init", "-q", "-b", "main"]);
    root
}
#[tokio::test]
async fn renamed_projects_keep_their_name_after_restart() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    assert_eq!(workspace.label, "repository");
    let renamed = app
        .rename_workspace(workspace.id.clone(), "  Website  ".into())
        .await
        .unwrap();
    assert_eq!(renamed.label, "Website");
    assert_eq!(renamed.root, workspace.root);
    let error = |result: Result<Workspace>| result.unwrap_err().code;
    assert_eq!(
        error(
            app.rename_workspace(workspace.id.clone(), "   ".into())
                .await
        ),
        "invalid_label"
    );
    let scratch = app.ensure_scratch().await.unwrap();
    assert_eq!(
        error(
            app.rename_workspace(scratch.id.clone(), "Notes".into())
                .await
        ),
        "invalid_workspace"
    );
    assert_eq!(
        error(
            app.rename_workspace(WorkspaceId::default(), "Ghost".into())
                .await
        ),
        "missing_workspace"
    );
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    let labels: Vec<_> = app
        .list_workspaces()
        .await
        .unwrap()
        .into_iter()
        .map(|w| (w.id, w.label))
        .collect();
    assert_eq!(
        labels,
        vec![
            (scratch.id, "No project".to_string()),
            (workspace.id, "Website".to_string())
        ]
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn removing_a_project_deletes_its_threads_and_leaves_files() {
    let f = Fixture::new();
    let other_root = second_repository(&f);
    let app = App::open(f.config.clone()).await.unwrap();
    let removed = app.open_workspace(f.repository.clone()).await.unwrap();
    let kept = app.open_workspace(other_root.clone()).await.unwrap();
    let doomed = app
        .create_thread(removed.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let survivor = app
        .create_thread(kept.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    app.remove_workspace(removed.id.clone()).await.unwrap();
    let ids = |rows: Vec<Workspace>| rows.into_iter().map(|w| w.id).collect::<Vec<_>>();
    assert_eq!(
        ids(app.list_workspaces().await.unwrap()),
        vec![kept.id.clone()]
    );
    assert_eq!(
        app.thread(doomed.id.clone()).await.unwrap_err().code,
        "missing_thread"
    );
    assert_eq!(
        app.workspace_view(removed.id.clone(), None)
            .await
            .unwrap_err()
            .code,
        "missing_workspace"
    );
    assert_eq!(
        app.remove_workspace(removed.id.clone())
            .await
            .unwrap_err()
            .code,
        "missing_workspace"
    );
    assert!(f.repository.join(".git").is_dir());
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    assert_eq!(
        ids(app.list_workspaces().await.unwrap()),
        vec![kept.id.clone()]
    );
    assert_eq!(
        app.thread(doomed.id.clone()).await.unwrap_err().code,
        "missing_thread"
    );
    let view = app.workspace_view(kept.id.clone(), None).await.unwrap();
    let threads: Vec<_> = view.threads.into_iter().map(|t| t.id).collect();
    assert_eq!(threads, vec![survivor.id]);
    let readded = app.open_workspace(f.repository.clone()).await.unwrap();
    assert_ne!(readded.id, removed.id);
    assert_eq!(readded.label, "repository");
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn running_projects_cannot_be_removed_until_their_turn_ends() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "hold".into(), "hold".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    let error = app
        .remove_workspace(thread.workspace_id.clone())
        .await
        .unwrap_err();
    assert_eq!(error.code, "busy");
    assert_eq!(
        error.message,
        "Stop this project's running conversations before removing it."
    );
    app.interrupt(thread.id.clone()).await.unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.session, SessionState::Ready)
    })
    .await;
    app.remove_workspace(thread.workspace_id.clone())
        .await
        .unwrap();
    assert!(app.list_workspaces().await.unwrap().is_empty());
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap_err().code,
        "missing_thread"
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn ui_state_survives_restart_with_overwrites_and_removals() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let set = |key: &str, value: Option<&str>| app.set_ui_state(key.into(), value.map(Into::into));
    set("z1:sidebar-width", Some("260")).await.unwrap();
    set("z1.wordWrap", Some("true")).await.unwrap();
    set("z1:right-panel-width", Some("400")).await.unwrap();
    set("z1:right-panel-width", None).await.unwrap();
    set("z1:sidebar-width", Some("312")).await.unwrap();
    set("z1:missing", None).await.unwrap();
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    assert_eq!(
        app.ui_state().await.unwrap(),
        std::collections::BTreeMap::from([
            ("z1.wordWrap".to_string(), "true".to_string()),
            ("z1:sidebar-width".to_string(), "312".to_string()),
        ])
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn settings_round_trip_through_the_settings_file() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    assert_eq!(app.settings().unwrap(), None);
    app.save_settings("{\n  \"appearance\": \"dark\"\n}\n")
        .unwrap();
    assert_eq!(
        app.settings().unwrap().as_deref(),
        Some("{\n  \"appearance\": \"dark\"\n}\n")
    );
    assert_eq!(
        std::fs::read_to_string(f.config.data_dir.join("settings.json")).unwrap(),
        "{\n  \"appearance\": \"dark\"\n}\n"
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn saving_settings_keeps_a_symlinked_file_linked() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let link = f.config.data_dir.join("settings.json");
    let synced = f.config.data_dir.with_file_name("synced-settings.json");
    std::fs::write(&synced, "{}").unwrap();
    std::os::unix::fs::symlink(&synced, &link).unwrap();
    app.save_settings("{\"appearance\":\"light\"}").unwrap();
    assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
    assert_eq!(
        std::fs::read_to_string(&synced).unwrap(),
        "{\"appearance\":\"light\"}"
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn saving_over_unparseable_settings_keeps_a_backup() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    std::fs::write(f.config.data_dir.join("settings.json"), "{not json").unwrap();
    app.save_settings("{}").unwrap();
    assert_eq!(
        std::fs::read_to_string(f.config.data_dir.join("settings.json.bak")).unwrap(),
        "{not json"
    );
    assert_eq!(
        std::fs::read_to_string(f.config.data_dir.join("settings.json")).unwrap(),
        "{}"
    );
    app.shutdown().await.unwrap();
}
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
fn idle_thread(started_at_ms: Option<u64>, completed_at_ms: Option<u64>) -> ThreadSnapshot {
    ThreadSnapshot {
        id: ThreadId::default(),
        workspace_id: WorkspaceId::default(),
        title: "Idle".into(),
        native_thread_id: Some("native".into()),
        revision: 1,
        session: SessionState::Dormant,
        settings: SessionSettings::default(),
        checkout: Checkout::Local,
        turns: vec![Turn {
            id: TurnId::default(),
            prompt: "hello".into(),
            native_turn_id: None,
            delivery: Delivery::Accepted,
            execution: Execution::Completed,
            items: vec![],
            settings: None,
            started_at_ms,
            completed_at_ms,
        }],
        approvals: vec![],
        diagnostic: None,
        settlement: Settlement::Auto,
    }
}
#[test]
fn idle_threads_auto_settle_after_three_days_of_their_latest_activity() {
    assert_eq!(AUTO_SETTLE_AFTER_MS, 3 * DAY_MS);
    let thread = idle_thread(Some(1_000), Some(2_000));
    assert_eq!(thread.settled_at(2_000 + 3 * DAY_MS - 1), None);
    assert_eq!(
        thread.settled_at(2_000 + 3 * DAY_MS),
        Some(2_000 + 3 * DAY_MS)
    );
    assert_eq!(
        idle_thread(Some(1_000), None).settled_at(1_000 + 3 * DAY_MS),
        Some(1_000 + 3 * DAY_MS)
    );
    assert_eq!(idle_thread(None, None).settled_at(u64::MAX), None);
}
#[test]
fn auto_settle_waits_for_running_sessions_and_open_approvals_and_respects_overrides() {
    let later = 2_000 + 4 * DAY_MS;
    for session in [
        SessionState::Connecting,
        SessionState::Running,
        SessionState::Interrupting,
    ] {
        let mut thread = idle_thread(Some(1_000), Some(2_000));
        thread.session = session;
        assert_eq!(thread.settled_at(later), None);
    }
    for (state, settled) in [
        (ApprovalState::Pending, None),
        (ApprovalState::Answering, None),
        (ApprovalState::Expired, Some(2_000 + 3 * DAY_MS)),
    ] {
        let mut thread = idle_thread(Some(1_000), Some(2_000));
        thread.approvals.push(Approval {
            id: ApprovalId::default(),
            turn_id: thread.turns[0].id.clone(),
            action: ApprovalAction::Command {
                command: "ls".into(),
                cwd: "/".into(),
                reason: String::new(),
            },
            state,
        });
        assert_eq!(thread.settled_at(later), settled);
    }
    let mut kept = idle_thread(Some(1_000), Some(2_000));
    kept.settlement = Settlement::Kept;
    assert_eq!(kept.settled_at(later), None);
    let mut settled = idle_thread(Some(1_000), None);
    settled.settlement = Settlement::Settled { at_ms: 1_500 };
    settled.session = SessionState::Running;
    assert_eq!(settled.settled_at(1_600), Some(1_500));
}
fn settled_at_ms(view: &WorkspaceView, id: &ThreadId) -> Option<u64> {
    view.threads
        .iter()
        .find(|summary| &summary.id == id)
        .unwrap()
        .settled_at_ms
}
#[tokio::test]
async fn manual_settlement_persists_across_reopen_and_unsettling_keeps_threads_active() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let other = app
        .create_thread(thread.workspace_id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    app.set_settled(other.id.clone(), false).await.unwrap();
    assert_eq!(
        app.thread(other.id.clone()).await.unwrap().settlement,
        Settlement::Auto
    );
    let before = now_ms();
    app.set_settled(thread.id.clone(), true).await.unwrap();
    let Settlement::Settled { at_ms } = app.thread(thread.id.clone()).await.unwrap().settlement
    else {
        panic!("settling stores the settled override")
    };
    assert!(at_ms >= before && at_ms <= now_ms());
    app.set_settled(thread.id.clone(), true).await.unwrap();
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().settlement,
        Settlement::Settled { at_ms }
    );
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    let view = app
        .workspace_view(thread.workspace_id.clone(), None)
        .await
        .unwrap();
    assert_eq!(settled_at_ms(&view, &thread.id), Some(at_ms));
    assert_eq!(settled_at_ms(&view, &other.id), None);
    app.set_settled(thread.id.clone(), false).await.unwrap();
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().settlement,
        Settlement::Kept
    );
    let view = app
        .workspace_view(thread.workspace_id.clone(), None)
        .await
        .unwrap();
    assert_eq!(settled_at_ms(&view, &thread.id), None);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn sending_a_prompt_returns_settled_and_kept_threads_to_auto() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.set_settled(thread.id.clone(), true).await.unwrap();
    app.submit(thread.id.clone(), "first".into(), "hello".into())
        .await
        .unwrap();
    let done = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert_eq!(done.settlement, Settlement::Auto);
    app.set_settled(thread.id.clone(), true).await.unwrap();
    app.set_settled(thread.id.clone(), false).await.unwrap();
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().settlement,
        Settlement::Kept
    );
    app.submit(thread.id.clone(), "second".into(), "hello".into())
        .await
        .unwrap();
    let done = wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Completed)
    })
    .await;
    assert_eq!(done.settlement, Settlement::Auto);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn settling_is_refused_while_an_approval_waits_but_allowed_while_running() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "approvals".into(), "approval".into())
        .await
        .unwrap();
    let waiting = wait(&app, &thread.id, |t| t.approvals.len() == 2).await;
    let refused = app.set_settled(thread.id.clone(), true).await.unwrap_err();
    assert_eq!(refused.code, "settle_blocked");
    assert_eq!(
        refused.message,
        "Answer the pending approval before settling this thread."
    );
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().settlement,
        Settlement::Auto
    );
    for approval in waiting.approvals {
        app.answer_approval(approval.id, ApprovalDecision::Decline)
            .await
            .unwrap();
    }
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.submit(thread.id.clone(), "hold".into(), "hold".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Running)
    })
    .await;
    app.set_settled(thread.id.clone(), true).await.unwrap();
    let view = app
        .workspace_view(thread.workspace_id.clone(), None)
        .await
        .unwrap();
    assert!(settled_at_ms(&view, &thread.id).is_some());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn a_new_approval_returns_a_settled_thread_to_auto() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "late".into(), "late-approval".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    app.set_settled(thread.id.clone(), true).await.unwrap();
    assert!(matches!(
        app.thread(thread.id.clone()).await.unwrap().settlement,
        Settlement::Settled { .. }
    ));
    let waiting = wait(&app, &thread.id, |t| t.approvals.len() == 1).await;
    assert_eq!(waiting.settlement, Settlement::Auto);
    let view = app
        .workspace_view(thread.workspace_id.clone(), None)
        .await
        .unwrap();
    assert_eq!(settled_at_ms(&view, &thread.id), None);
    app.shutdown().await.unwrap();
}
fn age_turns(f: &Fixture, id: &ThreadId, by_ms: u64) {
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    let data: String = db
        .query_row(
            "SELECT data FROM threads WHERE id=?1",
            [id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    let mut thread: ThreadSnapshot = serde_json::from_str(&data).unwrap();
    for turn in &mut thread.turns {
        turn.started_at_ms = turn.started_at_ms.map(|at| at - by_ms);
        turn.completed_at_ms = turn.completed_at_ms.map(|at| at - by_ms);
    }
    db.execute(
        "UPDATE threads SET data=?2 WHERE id=?1",
        [id.to_string(), serde_json::to_string(&thread).unwrap()],
    )
    .unwrap();
}
#[tokio::test]
async fn stale_threads_read_as_settled_after_reopen_unless_kept() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let stale = conversation(&app, &f).await;
    let kept = app
        .create_thread(stale.workspace_id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let fresh = app
        .create_thread(stale.workspace_id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    for (n, thread) in [&stale, &kept, &fresh].into_iter().enumerate() {
        app.submit(thread.id.clone(), format!("op-{n}"), "hello".into())
            .await
            .unwrap();
        wait(&app, &thread.id, |t| {
            matches!(t.turns[0].execution, Execution::Completed)
        })
        .await;
    }
    app.set_settled(kept.id.clone(), true).await.unwrap();
    app.set_settled(kept.id.clone(), false).await.unwrap();
    app.shutdown().await.unwrap();
    age_turns(&f, &stale.id, 4 * DAY_MS);
    age_turns(&f, &kept.id, 4 * DAY_MS);
    let app = reopen(&f.config).await;
    let aged = app.thread(stale.id.clone()).await.unwrap();
    let completed = aged.turns[0].completed_at_ms.unwrap();
    let view = app
        .workspace_view(stale.workspace_id.clone(), None)
        .await
        .unwrap();
    assert_eq!(
        settled_at_ms(&view, &stale.id),
        Some(completed + AUTO_SETTLE_AFTER_MS)
    );
    assert_eq!(settled_at_ms(&view, &kept.id), None);
    assert_eq!(settled_at_ms(&view, &fresh.id), None);
    assert_eq!(aged.settlement, Settlement::Auto);
    app.shutdown().await.unwrap();
}
