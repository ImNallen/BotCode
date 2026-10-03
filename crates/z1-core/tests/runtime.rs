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
    assert_eq!(app.thread(thread.id).await.unwrap().turns.len(), 1);
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
    app.submit(thread.id.clone(), "approvals".into(), "approval".into())
        .await
        .unwrap();
    let snapshot = wait(&app, &thread.id, |t| t.approvals.len() == 2).await;
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
    wait(&app, &a.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    assert_eq!(
        app.submit(b.id.clone(), "blocked".into(), "hello".into())
            .await
            .unwrap_err()
            .code,
        "checkout_busy"
    );
    app.interrupt(a.id.clone()).await.unwrap();
    wait(&app, &a.id, |t| {
        matches!(t.turns[0].execution, Execution::Interrupted)
    })
    .await;
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
