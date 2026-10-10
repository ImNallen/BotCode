#![cfg(unix)]
#![allow(clippy::disallowed_methods)]
#[path = "support/polling.rs"]
mod polling;
use bot_core::*;
use std::{os::unix::fs::PermissionsExt, process::Command, time::Duration};
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
                gh_binary: dir.path().join("no-gh"),
                network_timeout: Duration::from_secs(180),
                shell: None,
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
const LIMIT: Duration = Duration::from_secs(30);
// Under parallel tests, a reopen right after shutdown can still see the lock for a few milliseconds.
async fn reopen(config: &RuntimeConfig) -> App {
    let started = std::time::Instant::now();
    while started.elapsed() < LIMIT {
        match App::open(config.clone()).await {
            Err(e) if e.code == "already_running" => {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            other => return other.unwrap(),
        }
    }
    panic!("The previous runtime never released its data directory")
}
async fn eventually(mut condition: impl FnMut() -> bool) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < LIMIT {
        if condition() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}
async fn wait(
    app: &App,
    id: &ThreadId,
    predicate: impl Fn(&ThreadSnapshot) -> bool,
) -> ThreadSnapshot {
    let started = std::time::Instant::now();
    let mut last = None;
    while started.elapsed() < LIMIT {
        let snapshot = app.thread(id.clone()).await.unwrap();
        if predicate(&snapshot)
            && !snapshot.turns.last().is_some_and(|turn| {
                !turn.execution.active()
                    && matches!(
                        turn.checkpoint,
                        TurnCheckpoint::Pending | TurnCheckpoint::Before { .. }
                    )
            })
        {
            return snapshot;
        }
        last = Some(snapshot);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "Timed out awaiting public snapshot state after {:?}; last snapshot: {last:#?}",
        started.elapsed()
    )
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
        .submit(
            thread.id.clone(),
            "operation".into(),
            "hello".into(),
            vec![],
        )
        .await
        .unwrap();
    let same = app
        .submit(
            thread.id.clone(),
            "operation".into(),
            "hello".into(),
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(first.turn_id, same.turn_id);
    assert_eq!(
        app.submit(
            thread.id.clone(),
            "operation".into(),
            "different".into(),
            vec![]
        )
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
    app.submit(thread.id.clone(), "lost".into(), "lose".into(), vec![])
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
    app.submit(thread.id.clone(), "lost".into(), "lose".into(), vec![])
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
    app.submit(
        thread.id.clone(),
        "approvals".into(),
        "approval".into(),
        vec![],
    )
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
        vec![],
    )
    .await
    .unwrap();
    let snapshot = wait(&app, &thread.id, |t| t.approvals.len() == 2).await;
    for decision in [ApprovalDecision::Accept, ApprovalDecision::AcceptForSession] {
        assert_eq!(
            app.answer_approval(snapshot.approvals[0].id.clone(), decision)
                .await
                .unwrap_err()
                .code,
            "approval_details_missing"
        );
    }
    for a in snapshot.approvals {
        app.answer_approval(a.id, ApprovalDecision::Decline)
            .await
            .unwrap();
    }
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.submit(thread.id.clone(), "file".into(), "late-file".into(), vec![])
        .await
        .unwrap();
    let snapshot = wait(&app, &thread.id, |t| {
        t.approvals.iter().any(|approval| {
            matches!(&approval.action, ApprovalAction::FileChange { text, .. } if text == "test.txt\n+fixture change")
        })
    })
    .await;
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
    app.submit(a.id.clone(), "hold".into(), "hold".into(), vec![])
        .await
        .unwrap();
    let running = wait(&app, &a.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    let started = running.turns[0].started_at_ms.expect("started_at recorded");
    assert_eq!(running.turns[0].completed_at_ms, None);
    assert_eq!(
        app.submit(b.id.clone(), "blocked".into(), "hello".into(), vec![])
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
    app.submit(b.id.clone(), "free".into(), "hello".into(), vec![])
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
    let mut f = Fixture::new();
    f.config.shell = Some("/bin/sh".into());
    let app = App::open(f.config.clone()).await.unwrap();
    assert!(matches!(App::open(f.config.clone()).await,Err(e) if e.code=="already_running"));
    let t = conversation(&app, &f).await;
    app.submit(t.id.clone(), "hold".into(), "hold".into(), vec![])
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
    let output = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let sink = output.clone();
    let terminal: TerminalId = "term-1".parse().unwrap();
    app.terminal_attach(
        t.workspace_id.clone(),
        None,
        terminal.clone(),
        80,
        24,
        move |event| {
            if let TerminalEvent::Output { data } = event {
                sink.lock().unwrap().push_str(&data);
            }
        },
    )
    .await
    .unwrap();
    app.terminal_write(
        t.workspace_id.clone(),
        None,
        terminal,
        "echo shell=$$.\n".into(),
    )
    .await
    .unwrap();
    let mut shell = None;
    eventually(|| {
        let text = output.lock().unwrap().clone();
        shell = text
            .rsplit_once("shell=")
            .and_then(|(_, rest)| rest.split_once('.'))
            .and_then(|(digits, _)| digits.parse::<i32>().ok());
        shell.is_some()
    })
    .await;
    let shell = shell.expect("the shell printed its pid");
    drop(app);
    for (pid, what) in [(pid, "Codex"), (shell, "the terminal shell")] {
        assert!(
            wait_until_dead(pid).await,
            "Dropping all App handles must reap {what}"
        );
    }
    let reopened = reopen(&f.config).await;
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn stalled_provider_pipe_becomes_uncertain_without_blocking_runtime() {
    let f = Fixture::new();
    std::fs::write(f.peer.parent().unwrap().join("stall"), "").unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(
        thread.id.clone(),
        "stall".into(),
        "x".repeat(95_000),
        vec![],
    )
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
    app.submit(
        thread.id.clone(),
        "late".into(),
        "late-response".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.submit(thread.id.clone(), "newer".into(), "hold".into(), vec![])
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
    app.submit(
        thread.id.clone(),
        "approval".into(),
        "approval".into(),
        vec![],
    )
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
    app.submit(
        thread.id.clone(),
        "descendant".into(),
        "descendant".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    let pid_path = f.peer.parent().unwrap().join("descendant.pid");
    eventually(|| pid_path.exists()).await;
    let pid = std::fs::read_to_string(pid_path)
        .unwrap()
        .parse::<i32>()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    app.shutdown().await.unwrap();
    assert!(
        wait_until_dead(pid).await,
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
            interaction_mode: InteractionMode::Default,
        };
        let saved = app
            .update_settings(thread.id.clone(), settings.clone())
            .await
            .unwrap();
        assert_eq!(saved.settings, settings);
        assert!(saved.revision > thread.revision);
        app.submit(
            thread.id.clone(),
            format!("mode-{index}"),
            "hello".into(),
            vec![],
        )
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
        interaction_mode: InteractionMode::Default,
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
    app.submit(id.clone(), "hold-one".into(), "hold".into(), vec![])
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
    app.submit(id.clone(), "reset".into(), "hello".into(), vec![])
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
    app.submit(thread.id.clone(), "default".into(), "hello".into(), vec![])
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.submit(
        thread.id.clone(),
        "default-followup".into(),
        "hello".into(),
        vec![],
    )
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
            interaction_mode: InteractionMode::Default,
        },
    )
    .await
    .unwrap();
    app.submit(thread.id.clone(), "ultra".into(), "hello".into(), vec![])
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
    app.submit(thread.id.clone(), "reset".into(), "hello".into(), vec![])
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
            interaction_mode: InteractionMode::Default,
        },
    )
    .await
    .unwrap();
    std::fs::write(f.peer.parent().unwrap().join("models_removed"), "").unwrap();
    assert!(app.models().await.unwrap().is_empty());
    let error = app
        .submit(thread.id.clone(), "removed".into(), "hello".into(), vec![])
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
        worktree_setup: None,
        created_at_ms: None,
        latest_user_activity_at_ms: None,
        unsettled_at_ms: None,
        id: ThreadId::default(),
        workspace_id: WorkspaceId::default(),
        title: "Legacy".into(),
        native_thread_id: None,
        revision: 1,
        session: SessionState::Draft,
        settings: SessionSettings::default(),
        checkout: Checkout::Worktree {
            path: "/legacy".into(),
            branch: "bot-code/legacy".into(),
        },
        turns: vec![Turn {
            tasks: None,
            id: TurnId::default(),
            prompt: "hello".into(),
            context: None,
            native_turn_id: None,
            delivery: Delivery::Accepted,
            execution: Execution::Completed,
            items: vec![],
            settings: None,
            started_at_ms: None,
            completed_at_ms: None,
            attachments: vec![],
            checkpoint: TurnCheckpoint::default(),
        }],
        approvals: vec![],
        user_questions: vec![],
        diagnostic: None,
        placement: Placement::Kept,
        snooze: None,
        context: None,
        pending_revert: None,
        last_revert: None,
    };
    let mut value = serde_json::to_value(thread).unwrap();
    value.as_object_mut().unwrap().remove("placement");
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
    assert_eq!(restored.placement, Placement::Auto);
}
#[tokio::test]
async fn provider_loss_invalidates_catalog_and_reloads_on_request() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    app.models().await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "loss".into(), "lose".into(), vec![])
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
fn limits_json(limits: UsageLimits) -> serde_json::Value {
    serde_json::to_value(limits).unwrap()
}
fn weekly_44() -> serde_json::Value {
    serde_json::json!({"kind":"reported","plan":"ChatGPT Pro 20x Subscription","windows":[{"slot":"primary","kind":"weekly","usedPercent":44,"durationMins":10080,"resetsAtMs":1791580401000u64}]})
}
fn method_count(f: &Fixture, method: &str) -> usize {
    f.calls()
        .iter()
        .filter(|call| call["method"] == method)
        .count()
}
#[tokio::test]
async fn first_usage_limits_read_launches_codex_and_reads_the_codex_bucket() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    assert_eq!(
        limits_json(app.usage_limits(false).await.unwrap()),
        weekly_44()
    );
    assert_eq!(
        limits_json(app.usage_limits(false).await.unwrap()),
        weekly_44()
    );
    let methods: Vec<_> = f
        .calls()
        .into_iter()
        .map(|call| call["method"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        methods,
        vec![
            "initialize",
            "initialized",
            "collaborationMode/list",
            "account/read",
            "account/rateLimits/read"
        ]
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn usage_turn_records_context_and_merges_limits() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    app.usage_limits(false).await.unwrap();
    let mut watch = app.watch_usage_limits();
    watch.borrow_and_update();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "usage".into(), "usage".into(), vec![])
        .await
        .unwrap();
    let done = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    let context = Some(ContextUsage {
        used_tokens: 20575,
        max_tokens: Some(258400),
        total_processed_tokens: Some(41150),
    });
    assert_eq!(done.context, context);
    let merged = serde_json::json!({"kind":"reported","plan":"ChatGPT Pro 20x Subscription","windows":[
        {"slot":"secondary","kind":"session","usedPercent":3,"durationMins":300,"resetsAtMs":1791470000000u64},
        {"slot":"primary","kind":"weekly","usedPercent":47,"durationMins":10080,"resetsAtMs":1791580401000u64}]});
    assert!(watch.has_changed().unwrap());
    assert_eq!(
        limits_json(watch.borrow_and_update().clone().unwrap()),
        merged
    );
    app.submit(
        thread.id.clone(),
        "usage-again".into(),
        "usage".into(),
        vec![],
    )
    .await
    .unwrap();
    let again = wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Completed)
    })
    .await;
    assert_eq!(again.context, context);
    assert!(
        !watch.has_changed().unwrap(),
        "Repeated, foreign and empty limit updates must not notify"
    );
    assert_eq!(limits_json(app.usage_limits(false).await.unwrap()), merged);
    assert_eq!(method_count(&f, "account/rateLimits/read"), 1);
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    assert_eq!(app.thread(thread.id).await.unwrap().context, context);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn usage_limits_failure_keeps_the_last_report() {
    let f = Fixture::new();
    let marker = f.peer.parent().unwrap().join("limits_error");
    std::fs::write(&marker, "").unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    assert_eq!(
        app.usage_limits(false).await.unwrap(),
        UsageLimits::Failed {
            message: "Usage service unavailable".into()
        }
    );
    std::fs::remove_file(&marker).unwrap();
    assert_eq!(
        limits_json(app.usage_limits(true).await.unwrap()),
        weekly_44()
    );
    std::fs::write(&marker, "").unwrap();
    assert_eq!(
        limits_json(app.usage_limits(true).await.unwrap()),
        weekly_44()
    );
    assert_eq!(method_count(&f, "account/rateLimits/read"), 3);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn usage_limits_classify_api_key_and_signed_out_accounts() {
    let f = Fixture::new();
    let apikey = f.peer.parent().unwrap().join("account_apikey");
    std::fs::write(&apikey, "").unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    assert_eq!(
        app.usage_limits(false).await.unwrap(),
        UsageLimits::Unsupported
    );
    assert_eq!(method_count(&f, "account/rateLimits/read"), 0);
    std::fs::remove_file(&apikey).unwrap();
    std::fs::write(f.peer.parent().unwrap().join("account_none"), "").unwrap();
    assert_eq!(
        app.usage_limits(true).await.unwrap(),
        UsageLimits::Failed {
            message: "Codex is not signed in.".into()
        }
    );
    assert_eq!(method_count(&f, "account/rateLimits/read"), 0);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn usage_limits_answer_when_codex_cannot_launch() {
    let mut f = Fixture::new();
    f.config.codex_binary = f.peer.with_file_name("missing-codex");
    let app = App::open(f.config.clone()).await.unwrap();
    assert!(matches!(
        app.usage_limits(false).await.unwrap(),
        UsageLimits::Failed { .. }
    ));
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn provider_loss_keeps_usage_limits_and_relaunch_reads_again() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    app.usage_limits(false).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "loss".into(), "lose".into(), vec![])
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.session, SessionState::Unavailable { .. })
    })
    .await;
    assert_eq!(
        limits_json(app.usage_limits(false).await.unwrap()),
        weekly_44()
    );
    assert_eq!(method_count(&f, "initialize"), 1);
    app.submit(thread.id.clone(), "relaunch".into(), "hello".into(), vec![])
        .await
        .unwrap();
    eventually(|| method_count(&f, "account/rateLimits/read") == 2).await;
    assert_eq!(method_count(&f, "account/rateLimits/read"), 2);
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
    let id = branch.strip_prefix("botcode/").unwrap();
    assert_eq!(id.len(), 8);
    assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(
        path,
        f.config
            .data_dir
            .join("worktrees/repository")
            .canonicalize()
            .unwrap()
            .join(format!("botcode-{id}"))
    );
    assert_eq!(git_output(&path, &["branch", "--show-current"]), branch);
    for thread in [&local, &isolated] {
        app.submit(
            thread.id.clone(),
            thread.id.to_string(),
            "hello".into(),
            vec![],
        )
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
    app.submit(held.id.clone(), "hold".into(), "hold".into(), vec![])
        .await
        .unwrap();
    wait(&app, &held.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    assert_eq!(
        app.submit(blocked.id.clone(), "blocked".into(), "hello".into(), vec![])
            .await
            .unwrap_err()
            .code,
        "checkout_busy"
    );
    app.submit(
        isolated.id.clone(),
        "isolated".into(),
        "hello".into(),
        vec![],
    )
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
async fn writes_land_in_the_thread_checkout() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let isolated = app
        .create_thread(workspace.id.clone(), main_worktree())
        .await
        .unwrap();
    let (path, _) = worktree(&isolated.checkout);
    app.write_file(
        workspace.id.clone(),
        Some(isolated.id.clone()),
        "README.md".into(),
        "edited\n".into(),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        "edited\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.join("README.md")).unwrap(),
        "fixture\n"
    );
    std::fs::remove_dir_all(&path).unwrap();
    let removed = app
        .write_file(
            workspace.id.clone(),
            Some(isolated.id.clone()),
            "README.md".into(),
            "again\n".into(),
        )
        .await
        .unwrap_err();
    assert_eq!(removed.code, "worktree_removed");
    assert!(!path.exists());
    let home = app.ensure_scratch().await.unwrap();
    let unassigned = app
        .write_file(home.id, None, "notes.txt".into(), "x".into())
        .await
        .unwrap_err();
    assert_eq!(
        (unassigned.code.as_str(), unassigned.message.as_str()),
        ("missing_folder", "Start a thread to see its files.")
    );
    assert!(!home.root.join("notes.txt").exists());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn saved_files_and_ignore_edits_refresh_project_search() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let input = PathSearchInput {
        query: "search-target".into(),
        limit: 50,
        refresh: false,
    };
    let before = app
        .search_paths(
            workspace.id.clone(),
            None,
            "autosave".into(),
            1,
            input.clone(),
        )
        .await
        .unwrap();
    assert!(before.paths.is_empty());
    app.write_file(
        workspace.id.clone(),
        None,
        "nested/search-target.txt".into(),
        "autosave_search_sentinel\n".into(),
    )
    .await
    .unwrap();
    let saved = app
        .search_paths(
            workspace.id.clone(),
            None,
            "autosave".into(),
            2,
            input.clone(),
        )
        .await
        .unwrap();
    assert_eq!(saved.paths, ["nested/search-target.txt"]);
    app.write_file(
        workspace.id.clone(),
        None,
        ".gitignore".into(),
        "nested/search-target.txt\n".into(),
    )
    .await
    .unwrap();
    let ignored = app
        .search_paths(workspace.id.clone(), None, "autosave".into(), 3, input)
        .await
        .unwrap();
    assert!(ignored.paths.is_empty());
    let contents = app
        .search_contents(
            workspace.id.clone(),
            None,
            "autosave".into(),
            4,
            ContentSearchInput {
                query: "autosave_search_sentinel".into(),
                case_sensitive: false,
                whole_word: false,
                use_regex: false,
                refresh: false,
            },
        )
        .await
        .unwrap();
    assert!(contents.matches.is_empty());
    assert_eq!(
        app.workspace_view(workspace.id, None).await.unwrap().files,
        [".gitignore", "README.md"]
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn serves_checkout_files_to_the_workspace_scheme() {
    let f = Fixture::new();
    f.commit();
    std::fs::write(f.repository.join("logo.png"), b"png").unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let served = app
        .serve_workspace_file(&format!("/{}/-/logo.png", workspace.id), None, false)
        .await;
    assert_eq!((served.status, served.body.as_slice()), (200, &b"png"[..]));
    let unknown = app
        .serve_workspace_file(
            &format!("/{}/-/logo.png", WorkspaceId::default()),
            None,
            false,
        )
        .await;
    assert_eq!((unknown.status, unknown.body.len()), (404, 0));
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
    app.submit(held.id.clone(), "hold".into(), "hold".into(), vec![])
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
    app.submit(thread.id.clone(), "scratch".into(), "hello".into(), vec![])
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
    app.submit(thread.id.clone(), "hold".into(), "hold".into(), vec![])
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
    set("bot:missing", None).await.unwrap();
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
        .await
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
    app.save_settings("{\"appearance\":\"light\"}")
        .await
        .unwrap();
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
    app.save_settings("{}").await.unwrap();
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
const HOUR_MS: u64 = 60 * 60 * 1000;
const DAY_MS: u64 = 24 * HOUR_MS;
const DEFAULT_LIMIT: Option<u64> = Some(AUTO_SETTLE_AFTER_MS);
trait SettlementFixture {
    fn settlement_for_test(&self, now: u64, after_ms: Option<u64>) -> Option<u64>;
    fn summary_for_test(&self, after_ms: Option<u64>) -> ThreadSummary;
    fn arrange_for_test(&mut self, action: Arrange, now: u64, after_ms: Option<u64>) -> Result<()>;
    fn activity_for_test(&mut self, now: u64, after_ms: Option<u64>);
}
impl SettlementFixture for ThreadSnapshot {
    fn settlement_for_test(&self, now: u64, after_ms: Option<u64>) -> Option<u64> {
        settlement_at(SettlementInput {
            thread: self,
            links: &[],
            rules: SettlementRules {
                after_ms,
                on_merge: true,
            },
            blocked: false,
            now,
        })
    }
    fn summary_for_test(&self, after_ms: Option<u64>) -> ThreadSummary {
        self.summary(self.settlement_for_test(now_ms(), after_ms))
    }
    fn arrange_for_test(&mut self, action: Arrange, now: u64, after_ms: Option<u64>) -> Result<()> {
        self.arrange(action, now, self.settlement_for_test(now, after_ms))
    }
    fn activity_for_test(&mut self, now: u64, after_ms: Option<u64>) {
        self.record_activity(self.settlement_for_test(now, after_ms));
    }
}
fn idle_thread(started_at_ms: Option<u64>, completed_at_ms: Option<u64>) -> ThreadSnapshot {
    ThreadSnapshot {
        worktree_setup: None,
        created_at_ms: None,
        latest_user_activity_at_ms: None,
        unsettled_at_ms: None,
        id: ThreadId::default(),
        workspace_id: WorkspaceId::default(),
        title: "Idle".into(),
        native_thread_id: Some("native".into()),
        revision: 1,
        session: SessionState::Dormant,
        settings: SessionSettings::default(),
        checkout: Checkout::Local,
        turns: vec![Turn {
            tasks: None,
            id: TurnId::default(),
            prompt: "hello".into(),
            context: None,
            native_turn_id: None,
            delivery: Delivery::Accepted,
            execution: Execution::Completed,
            items: vec![],
            settings: None,
            started_at_ms,
            completed_at_ms,
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
#[test]
fn idle_threads_auto_settle_after_three_days_of_their_latest_activity() {
    assert_eq!(AUTO_SETTLE_AFTER_MS, 3 * DAY_MS);
    let thread = idle_thread(Some(1_000), Some(2_000));
    assert_eq!(
        thread.settlement_for_test(2_000 + 3 * DAY_MS - 1, DEFAULT_LIMIT),
        None
    );
    assert_eq!(
        thread.settlement_for_test(2_000 + 3 * DAY_MS, DEFAULT_LIMIT),
        Some(2_000)
    );
    assert_eq!(
        thread.settlement_for_test(2_000 + DAY_MS, Some(DAY_MS)),
        Some(2_000)
    );
    assert_eq!(thread.settlement_for_test(u64::MAX, None), None);
    assert_eq!(
        idle_thread(Some(1_000), None).settlement_for_test(1_000 + 3 * DAY_MS, DEFAULT_LIMIT),
        Some(1_000)
    );
    assert_eq!(
        idle_thread(None, None).settlement_for_test(u64::MAX, DEFAULT_LIMIT),
        None
    );
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
        assert_eq!(thread.settlement_for_test(later, DEFAULT_LIMIT), None);
    }
    for (state, settled) in [
        (ApprovalState::Pending, None),
        (ApprovalState::Answering, None),
        (ApprovalState::Expired, Some(2_000)),
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
            options: vec![],
            state,
        });
        assert_eq!(thread.settlement_for_test(later, DEFAULT_LIMIT), settled);
    }
    let mut kept = idle_thread(Some(1_000), Some(2_000));
    kept.placement = Placement::Kept;
    assert_eq!(kept.settlement_for_test(later, DEFAULT_LIMIT), None);
    let mut settled = idle_thread(Some(1_000), None);
    settled.placement = Placement::Settled { at_ms: 1_500 };
    settled.session = SessionState::Running;
    assert_eq!(
        settled.settlement_for_test(1_600, DEFAULT_LIMIT),
        Some(1_500)
    );
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
    app.arrange(other.id.clone(), Arrange::Unsettle)
        .await
        .unwrap();
    assert_eq!(
        app.thread(other.id.clone()).await.unwrap().placement,
        Placement::Auto
    );
    let before = now_ms();
    app.arrange(thread.id.clone(), Arrange::Settle)
        .await
        .unwrap();
    let Placement::Settled { at_ms } = app.thread(thread.id.clone()).await.unwrap().placement
    else {
        panic!("settling stores the settled override")
    };
    assert!(at_ms >= before && at_ms <= now_ms());
    app.arrange(thread.id.clone(), Arrange::Settle)
        .await
        .unwrap();
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().placement,
        Placement::Settled { at_ms }
    );
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    let view = app
        .workspace_view(thread.workspace_id.clone(), None)
        .await
        .unwrap();
    assert_eq!(settled_at_ms(&view, &thread.id), Some(at_ms));
    assert_eq!(settled_at_ms(&view, &other.id), None);
    app.arrange(thread.id.clone(), Arrange::Unsettle)
        .await
        .unwrap();
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().placement,
        Placement::Kept
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
    app.arrange(thread.id.clone(), Arrange::Settle)
        .await
        .unwrap();
    app.submit(thread.id.clone(), "first".into(), "hello".into(), vec![])
        .await
        .unwrap();
    let done = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert_eq!(done.placement, Placement::Auto);
    app.arrange(thread.id.clone(), Arrange::Settle)
        .await
        .unwrap();
    app.arrange(thread.id.clone(), Arrange::Unsettle)
        .await
        .unwrap();
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().placement,
        Placement::Kept
    );
    app.submit(thread.id.clone(), "second".into(), "hello".into(), vec![])
        .await
        .unwrap();
    let done = wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Completed)
    })
    .await;
    assert_eq!(done.placement, Placement::Auto);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn settling_is_refused_while_an_approval_waits_but_allowed_while_running() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(
        thread.id.clone(),
        "approvals".into(),
        "approval".into(),
        vec![],
    )
    .await
    .unwrap();
    let waiting = wait(&app, &thread.id, |t| t.approvals.len() == 2).await;
    let refused = app
        .arrange(thread.id.clone(), Arrange::Settle)
        .await
        .unwrap_err();
    assert_eq!(refused.code, "settle_blocked");
    assert_eq!(
        refused.message,
        "Answer the pending approval before settling this thread."
    );
    let refused = app
        .arrange(
            thread.id.clone(),
            Arrange::Snooze {
                until_ms: now_ms() + HOUR_MS,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, "snooze_blocked");
    assert_eq!(
        refused.message,
        "Answer the pending approval before snoozing this thread."
    );
    let unchanged = app.thread(thread.id.clone()).await.unwrap();
    assert_eq!(unchanged.placement, Placement::Auto);
    assert_eq!(unchanged.snooze, None);
    for approval in waiting.approvals {
        app.answer_approval(approval.id, ApprovalDecision::Decline)
            .await
            .unwrap();
    }
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.submit(thread.id.clone(), "hold".into(), "hold".into(), vec![])
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Running)
    })
    .await;
    app.arrange(thread.id.clone(), Arrange::Settle)
        .await
        .unwrap();
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
    app.submit(
        thread.id.clone(),
        "late".into(),
        "late-approval".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    app.arrange(thread.id.clone(), Arrange::Settle)
        .await
        .unwrap();
    assert!(matches!(
        app.thread(thread.id.clone()).await.unwrap().placement,
        Placement::Settled { .. }
    ));
    let waiting = wait(&app, &thread.id, |t| t.approvals.len() == 1).await;
    assert_eq!(waiting.placement, Placement::Auto);
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
    thread.created_at_ms = thread.created_at_ms.map(|at| at - by_ms);
    thread.latest_user_activity_at_ms = thread.latest_user_activity_at_ms.map(|at| at - by_ms);
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
        app.submit(thread.id.clone(), format!("op-{n}"), "hello".into(), vec![])
            .await
            .unwrap();
        wait(&app, &thread.id, |t| {
            matches!(t.turns[0].execution, Execution::Completed)
        })
        .await;
    }
    app.arrange(kept.id.clone(), Arrange::Settle).await.unwrap();
    app.arrange(kept.id.clone(), Arrange::Unsettle)
        .await
        .unwrap();
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
    assert_eq!(settled_at_ms(&view, &stale.id), Some(completed));
    assert_eq!(settled_at_ms(&view, &kept.id), None);
    assert_eq!(settled_at_ms(&view, &fresh.id), None);
    assert_eq!(aged.placement, Placement::Auto);
    app.shutdown().await.unwrap();
}
#[test]
fn snapshots_saved_with_settlement_load_it_as_placement() {
    for (settlement, placement) in [
        (serde_json::json!({"kind": "auto"}), Placement::Auto),
        (serde_json::json!({"kind": "kept"}), Placement::Kept),
        (
            serde_json::json!({"kind": "settled", "atMs": 1_500}),
            Placement::Settled { at_ms: 1_500 },
        ),
    ] {
        let mut value = serde_json::to_value(idle_thread(Some(1_000), Some(2_000))).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("placement");
        object.insert("settlement".into(), settlement.clone());
        let restored: ThreadSnapshot = serde_json::from_value(value).unwrap();
        assert_eq!(restored.placement, placement);
        let saved = serde_json::to_value(&restored).unwrap();
        assert_eq!(saved["placement"], settlement);
        assert!(saved.get("settlement").is_none());
    }
}
fn pending_approval(thread: &ThreadSnapshot) -> Approval {
    Approval {
        id: ApprovalId::default(),
        turn_id: thread.turns[0].id.clone(),
        action: ApprovalAction::Command {
            command: "ls".into(),
            cwd: "/".into(),
            reason: String::new(),
        },
        options: vec![],
        state: ApprovalState::Pending,
    }
}
const SNOOZE: Snooze = Snooze {
    until_ms: 10_000,
    at_ms: 3_000,
};
#[test]
fn pinning_clears_settle_and_snooze_and_keeps_the_first_pin_time() {
    for (placement, kept) in [
        (Placement::Auto, false),
        (Placement::Kept, true),
        (Placement::Settled { at_ms: 1_500 }, true),
    ] {
        let mut thread = idle_thread(Some(1_000), Some(2_000));
        thread.placement = placement;
        thread.snooze = Some(SNOOZE);
        thread
            .arrange_for_test(Arrange::Pin, 5_000, DEFAULT_LIMIT)
            .unwrap();
        assert_eq!(thread.placement, Placement::Pinned { at_ms: 5_000, kept });
        assert_eq!(thread.snooze, None);
        thread
            .arrange_for_test(Arrange::Pin, 6_000, DEFAULT_LIMIT)
            .unwrap();
        assert_eq!(thread.placement, Placement::Pinned { at_ms: 5_000, kept });
    }
}
#[test]
fn unpinning_returns_a_pinned_thread_to_its_keep_and_leaves_others_alone() {
    for (kept, unpinned) in [(false, Placement::Auto), (true, Placement::Kept)] {
        let mut thread = idle_thread(Some(1_000), Some(2_000));
        thread.placement = Placement::Pinned { at_ms: 5_000, kept };
        thread.snooze = Some(SNOOZE);
        thread
            .arrange_for_test(Arrange::Unpin, 6_000, DEFAULT_LIMIT)
            .unwrap();
        assert_eq!(thread.placement, unpinned);
        assert_eq!(thread.snooze, Some(SNOOZE));
    }
    let mut thread = idle_thread(Some(1_000), Some(2_000));
    thread.placement = Placement::Kept;
    thread
        .arrange_for_test(Arrange::Unpin, 6_000, DEFAULT_LIMIT)
        .unwrap();
    assert_eq!(thread.placement, Placement::Kept);
}
#[test]
fn settling_clears_pin_and_snooze_and_is_refused_while_an_approval_waits() {
    let mut thread = idle_thread(Some(1_000), Some(2_000));
    thread.placement = Placement::Pinned {
        at_ms: 5_000,
        kept: false,
    };
    thread.snooze = Some(SNOOZE);
    thread
        .arrange_for_test(Arrange::Settle, 7_000, DEFAULT_LIMIT)
        .unwrap();
    assert_eq!(thread.placement, Placement::Settled { at_ms: 7_000 });
    assert_eq!(thread.snooze, None);
    thread.snooze = Some(SNOOZE);
    thread
        .arrange_for_test(Arrange::Settle, 8_000, DEFAULT_LIMIT)
        .unwrap();
    assert_eq!(thread.placement, Placement::Settled { at_ms: 7_000 });
    assert_eq!(thread.snooze, None);
    let mut waiting = idle_thread(Some(1_000), Some(2_000));
    waiting.placement = Placement::Pinned {
        at_ms: 5_000,
        kept: false,
    };
    waiting.approvals.push(pending_approval(&waiting));
    let refused = waiting
        .arrange_for_test(Arrange::Settle, 7_000, DEFAULT_LIMIT)
        .unwrap_err();
    assert_eq!(refused.code, "settle_blocked");
    assert_eq!(
        waiting.placement,
        Placement::Pinned {
            at_ms: 5_000,
            kept: false,
        }
    );
}
#[test]
fn unsettling_keeps_settled_threads_active_and_leaves_pins_alone() {
    let mut settled = idle_thread(Some(1_000), Some(2_000));
    settled.placement = Placement::Settled { at_ms: 7_000 };
    settled
        .arrange_for_test(Arrange::Unsettle, 8_000, DEFAULT_LIMIT)
        .unwrap();
    assert_eq!(settled.placement, Placement::Kept);
    let mut auto_settled = idle_thread(Some(1_000), Some(2_000));
    auto_settled
        .arrange_for_test(Arrange::Unsettle, 2_000 + 4 * DAY_MS, DEFAULT_LIMIT)
        .unwrap();
    assert_eq!(auto_settled.placement, Placement::Kept);
    let mut pinned = idle_thread(Some(1_000), Some(2_000));
    pinned.placement = Placement::Pinned {
        at_ms: 5_000,
        kept: false,
    };
    pinned
        .arrange_for_test(Arrange::Unsettle, 8_000, DEFAULT_LIMIT)
        .unwrap();
    assert_eq!(
        pinned.placement,
        Placement::Pinned {
            at_ms: 5_000,
            kept: false,
        }
    );
}
#[test]
fn snoozing_keeps_the_placement_and_the_first_snooze_time_for_the_same_wake() {
    for placement in [
        Placement::Auto,
        Placement::Pinned {
            at_ms: 5_000,
            kept: false,
        },
        Placement::Settled { at_ms: 5_000 },
    ] {
        let mut thread = idle_thread(Some(1_000), Some(2_000));
        thread.placement = placement;
        thread
            .arrange_for_test(Arrange::Snooze { until_ms: 10_000 }, 6_000, DEFAULT_LIMIT)
            .unwrap();
        assert_eq!(thread.placement, placement);
        assert_eq!(
            thread.snooze,
            Some(Snooze {
                until_ms: 10_000,
                at_ms: 6_000
            })
        );
        thread
            .arrange_for_test(Arrange::Snooze { until_ms: 10_000 }, 7_000, DEFAULT_LIMIT)
            .unwrap();
        assert_eq!(
            thread.snooze,
            Some(Snooze {
                until_ms: 10_000,
                at_ms: 6_000
            })
        );
        thread
            .arrange_for_test(Arrange::Snooze { until_ms: 12_000 }, 7_000, DEFAULT_LIMIT)
            .unwrap();
        assert_eq!(
            thread.snooze,
            Some(Snooze {
                until_ms: 12_000,
                at_ms: 7_000
            })
        );
    }
}
#[test]
fn snoozing_is_refused_for_a_wake_time_not_in_the_future_or_while_an_approval_waits() {
    let mut thread = idle_thread(Some(1_000), Some(2_000));
    for until_ms in [6_000, 5_999] {
        let refused = thread
            .arrange_for_test(Arrange::Snooze { until_ms }, 6_000, DEFAULT_LIMIT)
            .unwrap_err();
        assert_eq!(refused.code, "snooze_in_past");
        assert_eq!(refused.message, "Choose a wake time in the future.");
    }
    thread.approvals.push(pending_approval(&thread));
    let refused = thread
        .arrange_for_test(Arrange::Snooze { until_ms: 10_000 }, 6_000, DEFAULT_LIMIT)
        .unwrap_err();
    assert_eq!(refused.code, "snooze_blocked");
    assert_eq!(
        refused.message,
        "Answer the pending approval before snoozing this thread."
    );
    assert_eq!(thread.snooze, None);
}
#[test]
fn waking_clears_only_the_snooze() {
    let mut thread = idle_thread(Some(1_000), Some(2_000));
    thread.placement = Placement::Pinned {
        at_ms: 5_000,
        kept: false,
    };
    thread.snooze = Some(SNOOZE);
    thread
        .arrange_for_test(Arrange::Wake, 6_000, DEFAULT_LIMIT)
        .unwrap();
    assert_eq!(thread.snooze, None);
    assert_eq!(
        thread.placement,
        Placement::Pinned {
            at_ms: 5_000,
            kept: false,
        }
    );
}
#[test]
fn a_snoozed_pinned_thread_keeps_its_pin_and_reports_its_wake_time() {
    let mut thread = idle_thread(Some(1_000), Some(2_000));
    thread.placement = Placement::Pinned {
        at_ms: 2_500,
        kept: false,
    };
    let until_ms = now_ms() + HOUR_MS;
    thread.snooze = Some(Snooze {
        until_ms,
        at_ms: 3_000,
    });
    let summary = thread.summary_for_test(DEFAULT_LIMIT);
    assert_eq!(summary.pinned_at_ms, Some(2_500));
    assert_eq!(summary.snoozed_until_ms, Some(until_ms));
    assert_eq!(summary.settled_at_ms, None);
}
#[test]
fn a_snoozed_thread_raises_its_hand_for_a_newer_result_or_an_approval() {
    let snoozed = |execution: Execution, completed_at_ms: u64| {
        let mut thread = idle_thread(Some(1_000), Some(completed_at_ms));
        thread.turns[0].execution = execution;
        thread.snooze = Some(SNOOZE);
        thread.snoozed_until()
    };
    assert_eq!(snoozed(Execution::Completed, 2_000), Some(10_000));
    assert_eq!(snoozed(Execution::Completed, 3_000), Some(10_000));
    assert_eq!(snoozed(Execution::Completed, 3_001), None);
    assert_eq!(
        snoozed(
            Execution::Failed {
                reason: "boom".into()
            },
            3_001
        ),
        None
    );
    assert_eq!(snoozed(Execution::Interrupted, 3_001), Some(10_000));
    let mut waiting = idle_thread(Some(1_000), Some(2_000));
    waiting.snooze = Some(SNOOZE);
    waiting.approvals.push(pending_approval(&waiting));
    assert_eq!(waiting.snoozed_until(), None);
    assert_eq!(
        waiting.summary_for_test(DEFAULT_LIMIT).snoozed_until_ms,
        None
    );
}
#[test]
fn an_idle_pinned_thread_reads_as_settled_and_not_pinned() {
    let mut thread = idle_thread(Some(1_000), Some(2_000));
    thread.placement = Placement::Pinned {
        at_ms: 2_500,
        kept: false,
    };
    assert_eq!(
        thread.settlement_for_test(2_000 + 3 * DAY_MS - 1, DEFAULT_LIMIT),
        None
    );
    assert_eq!(
        thread.settlement_for_test(2_000 + 3 * DAY_MS, DEFAULT_LIMIT),
        Some(2_000)
    );
    let summary = thread.summary_for_test(DEFAULT_LIMIT);
    assert_eq!(summary.settled_at_ms, Some(2_000));
    assert_eq!(summary.pinned_at_ms, None);
}
#[test]
fn unsettling_an_auto_settled_pinned_thread_stores_kept_without_the_pin() {
    let mut thread = idle_thread(Some(1_000), Some(2_000));
    thread.placement = Placement::Pinned {
        at_ms: 2_500,
        kept: false,
    };
    thread.snooze = Some(SNOOZE);
    thread
        .arrange_for_test(Arrange::Unsettle, 2_000 + 4 * DAY_MS, DEFAULT_LIMIT)
        .unwrap();
    assert_eq!(thread.placement, Placement::Kept);
    assert_eq!(thread.snooze, None);
    assert_eq!(thread.summary_for_test(DEFAULT_LIMIT).pinned_at_ms, None);
}
#[test]
fn pinning_a_settled_thread_keeps_it_from_auto_settling() {
    let mut thread = idle_thread(Some(1_000), Some(2_000));
    let now = 2_000 + 4 * DAY_MS;
    assert_eq!(thread.settlement_for_test(now, DEFAULT_LIMIT), Some(2_000));
    thread
        .arrange_for_test(Arrange::Pin, now, DEFAULT_LIMIT)
        .unwrap();
    assert_eq!(
        thread.placement,
        Placement::Pinned {
            at_ms: now,
            kept: true
        }
    );
    assert_eq!(thread.settlement_for_test(u64::MAX, DEFAULT_LIMIT), None);
    let summary = thread.summary_for_test(DEFAULT_LIMIT);
    assert_eq!(summary.pinned_at_ms, Some(now));
    assert_eq!(summary.settled_at_ms, None);
}
#[test]
fn activity_drops_the_keep_from_a_pinned_thread() {
    let mut thread = idle_thread(Some(1_000), Some(2_000));
    thread.placement = Placement::Pinned {
        at_ms: 2_500,
        kept: true,
    };
    thread.activity_for_test(2_000 + 4 * DAY_MS, DEFAULT_LIMIT);
    assert_eq!(
        thread.placement,
        Placement::Pinned {
            at_ms: 2_500,
            kept: false
        }
    );
}
#[test]
fn pins_saved_without_kept_load_as_pins_that_can_auto_settle() {
    let mut value = serde_json::to_value(idle_thread(Some(1_000), Some(2_000))).unwrap();
    value["placement"] = serde_json::json!({"kind": "pinned", "atMs": 2_500});
    let restored: ThreadSnapshot = serde_json::from_value(value).unwrap();
    assert_eq!(
        restored.placement,
        Placement::Pinned {
            at_ms: 2_500,
            kept: false
        }
    );
    assert_eq!(
        serde_json::to_value(restored.placement).unwrap(),
        serde_json::json!({"kind": "pinned", "atMs": 2_500, "kept": false})
    );
}
#[test]
fn snoozed_threads_auto_settle_only_after_they_wake() {
    let mut thread = idle_thread(Some(1_000), Some(2_000));
    thread.snooze = Some(Snooze {
        until_ms: 2_000 + 5 * DAY_MS,
        at_ms: 2_500,
    });
    assert_eq!(
        thread.settlement_for_test(2_000 + 4 * DAY_MS, DEFAULT_LIMIT),
        None
    );
    assert_eq!(
        thread.settlement_for_test(2_000 + 5 * DAY_MS, DEFAULT_LIMIT),
        Some(2_000)
    );
}
#[tokio::test]
async fn pins_and_snoozes_persist_across_reopen_and_reach_the_summary() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let before = now_ms();
    app.arrange(thread.id.clone(), Arrange::Pin).await.unwrap();
    let until_ms = now_ms() + HOUR_MS;
    app.arrange(thread.id.clone(), Arrange::Snooze { until_ms })
        .await
        .unwrap();
    let stored = app.thread(thread.id.clone()).await.unwrap();
    let Placement::Pinned { at_ms, kept: false } = stored.placement else {
        panic!("pinning stores the pinned placement")
    };
    assert!(at_ms >= before && at_ms <= now_ms());
    let snoozed_at = stored.snooze.unwrap().at_ms;
    assert_eq!(stored.snooze.unwrap().until_ms, until_ms);
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    let reopened = app.thread(thread.id.clone()).await.unwrap();
    assert_eq!(reopened.placement, Placement::Pinned { at_ms, kept: false });
    assert_eq!(
        reopened.snooze,
        Some(Snooze {
            until_ms,
            at_ms: snoozed_at
        })
    );
    let view = app
        .workspace_view(thread.workspace_id.clone(), None)
        .await
        .unwrap();
    let summary = view.threads.iter().find(|s| s.id == thread.id).unwrap();
    assert_eq!(summary.pinned_at_ms, Some(at_ms));
    assert_eq!(summary.snoozed_until_ms, Some(until_ms));
    app.arrange(thread.id.clone(), Arrange::Wake).await.unwrap();
    app.arrange(thread.id.clone(), Arrange::Unpin)
        .await
        .unwrap();
    let cleared = app.thread(thread.id.clone()).await.unwrap();
    assert_eq!(cleared.placement, Placement::Auto);
    assert_eq!(cleared.snooze, None);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn sending_a_prompt_clears_the_snooze_and_keeps_the_pin() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.arrange(thread.id.clone(), Arrange::Pin).await.unwrap();
    app.arrange(
        thread.id.clone(),
        Arrange::Snooze {
            until_ms: now_ms() + HOUR_MS,
        },
    )
    .await
    .unwrap();
    let pinned = app.thread(thread.id.clone()).await.unwrap().placement;
    app.submit(thread.id.clone(), "first".into(), "hello".into(), vec![])
        .await
        .unwrap();
    let done = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert!(matches!(pinned, Placement::Pinned { .. }));
    assert_eq!(done.placement, pinned);
    assert_eq!(done.snooze, None);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn a_new_prompt_returns_an_auto_settled_pinned_thread_to_active_without_its_pin() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "first".into(), "hello".into(), vec![])
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.arrange(thread.id.clone(), Arrange::Pin).await.unwrap();
    app.shutdown().await.unwrap();
    age_turns(&f, &thread.id, 4 * DAY_MS);
    let app = reopen(&f.config).await;
    let view = app
        .workspace_view(thread.workspace_id.clone(), None)
        .await
        .unwrap();
    let summary = view.threads.iter().find(|s| s.id == thread.id).unwrap();
    assert!(summary.settled_at_ms.is_some());
    assert_eq!(summary.pinned_at_ms, None);
    app.submit(thread.id.clone(), "second".into(), "hello".into(), vec![])
        .await
        .unwrap();
    let done = wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Completed)
    })
    .await;
    assert_eq!(done.placement, Placement::Auto);
    let summary = done.summary_for_test(DEFAULT_LIMIT);
    assert_eq!(summary.settled_at_ms, None);
    assert_eq!(summary.pinned_at_ms, None);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn pinning_a_settled_thread_persists_the_keep_until_the_next_prompt() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.arrange(thread.id.clone(), Arrange::Settle)
        .await
        .unwrap();
    app.arrange(thread.id.clone(), Arrange::Pin).await.unwrap();
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    let Placement::Pinned { at_ms, kept: true } =
        app.thread(thread.id.clone()).await.unwrap().placement
    else {
        panic!("pinning a settled thread keeps it")
    };
    app.submit(thread.id.clone(), "first".into(), "hello".into(), vec![])
        .await
        .unwrap();
    let done = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert_eq!(done.placement, Placement::Pinned { at_ms, kept: false });
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn a_new_approval_returns_kept_threads_to_auto_keeps_pins_and_raises_a_snoozed_hand() {
    for pinned in [false, true] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        app.submit(
            thread.id.clone(),
            "late".into(),
            "late-approval".into(),
            vec![],
        )
        .await
        .unwrap();
        wait(&app, &thread.id, |t| {
            matches!(t.turns[0].execution, Execution::Running)
        })
        .await;
        if pinned {
            app.arrange(thread.id.clone(), Arrange::Pin).await.unwrap();
        } else {
            app.arrange(thread.id.clone(), Arrange::Settle)
                .await
                .unwrap();
            app.arrange(thread.id.clone(), Arrange::Unsettle)
                .await
                .unwrap();
        }
        let until_ms = now_ms() + HOUR_MS;
        app.arrange(thread.id.clone(), Arrange::Snooze { until_ms })
            .await
            .unwrap();
        let before = app.thread(thread.id.clone()).await.unwrap();
        let waiting = wait(&app, &thread.id, |t| t.approvals.len() == 1).await;
        if pinned {
            assert_eq!(waiting.placement, before.placement);
        } else {
            assert_eq!(before.placement, Placement::Kept);
            assert_eq!(waiting.placement, Placement::Auto);
        }
        assert_eq!(waiting.snooze, before.snooze);
        assert_eq!(waiting.snooze.unwrap().until_ms, until_ms);
        assert_eq!(
            waiting.summary_for_test(DEFAULT_LIMIT).snoozed_until_ms,
            None
        );
        app.shutdown().await.unwrap();
    }
}
#[test]
fn snoozing_again_after_a_raised_hand_takes_a_fresh_snooze_time() {
    let mut thread = idle_thread(Some(1_000), Some(4_000));
    thread.snooze = Some(SNOOZE);
    assert_eq!(thread.snoozed_until(), None);
    thread
        .arrange_for_test(Arrange::Snooze { until_ms: 10_000 }, 6_000, DEFAULT_LIMIT)
        .unwrap();
    assert_eq!(
        thread.snooze,
        Some(Snooze {
            until_ms: 10_000,
            at_ms: 6_000
        })
    );
    assert_eq!(thread.snoozed_until(), Some(10_000));
}
struct Projects {
    alpha: WorkspaceId,
    beta: WorkspaceId,
    scratch: WorkspaceId,
    threads: [ThreadId; 3],
}
async fn finished_thread(app: &App, workspace: &WorkspaceId, checkout: NewCheckout) -> ThreadId {
    let thread = app
        .create_thread(workspace.clone(), checkout)
        .await
        .unwrap();
    app.submit(
        thread.id.clone(),
        thread.id.to_string(),
        "hello".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    thread.id
}
// One finished thread in each of two repositories and No project, all idle for 2 days.
async fn two_day_old_projects(f: &Fixture) -> Projects {
    let app = App::open(f.config.clone()).await.unwrap();
    let second = f.repository.with_file_name("second");
    std::fs::create_dir(&second).unwrap();
    git_output(&second, &["init", "-q", "-b", "main"]);
    let alpha = app.open_workspace(f.repository.clone()).await.unwrap().id;
    let beta = app.open_workspace(second).await.unwrap().id;
    let scratch = app.ensure_scratch().await.unwrap().id;
    let threads = [
        finished_thread(&app, &alpha, NewCheckout::Local).await,
        finished_thread(&app, &beta, NewCheckout::Local).await,
        finished_thread(
            &app,
            &scratch,
            NewCheckout::Folder {
                prompt: "hello".into(),
            },
        )
        .await,
    ];
    app.shutdown().await.unwrap();
    for id in &threads {
        age_turns(f, id, 2 * DAY_MS);
    }
    Projects {
        alpha,
        beta,
        scratch,
        threads,
    }
}
async fn settled_by_project(app: &App, projects: &Projects) -> [bool; 3] {
    let mut settled = [false; 3];
    for (n, workspace) in [&projects.alpha, &projects.beta, &projects.scratch]
        .into_iter()
        .enumerate()
    {
        let view = app.workspace_view(workspace.clone(), None).await.unwrap();
        settled[n] = settled_at_ms(&view, &projects.threads[n]).is_some();
    }
    settled
}
fn write_settings(f: &Fixture, settings: &serde_json::Value) {
    std::fs::write(
        f.config.data_dir.join("settings.json"),
        settings.to_string(),
    )
    .unwrap();
}
#[tokio::test]
async fn a_project_override_beats_the_auto_settle_default() {
    let f = Fixture::new();
    let projects = two_day_old_projects(&f).await;
    write_settings(
        &f,
        &serde_json::json!({
            "sidebarAutoSettleAfterDays": 3,
            "projectOverrides": {
                projects.alpha.to_string(): {"sidebarAutoSettleAfterDays": 1},
            },
        }),
    );
    let app = reopen(&f.config).await;
    assert_eq!(
        settled_by_project(&app, &projects).await,
        [true, false, false]
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn a_null_project_override_turns_auto_settle_off_for_that_project_only() {
    let f = Fixture::new();
    let projects = two_day_old_projects(&f).await;
    write_settings(
        &f,
        &serde_json::json!({
            "sidebarAutoSettleAfterDays": 1,
            "projectOverrides": {
                projects.alpha.to_string(): {"sidebarAutoSettleAfterDays": null},
            },
        }),
    );
    let app = reopen(&f.config).await;
    assert_eq!(
        settled_by_project(&app, &projects).await,
        [false, true, true]
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn no_project_uses_its_own_override_and_a_null_default_turns_others_off() {
    let f = Fixture::new();
    let projects = two_day_old_projects(&f).await;
    for id in &projects.threads {
        age_turns(&f, id, 2 * DAY_MS);
    }
    write_settings(
        &f,
        &serde_json::json!({
            "sidebarAutoSettleAfterDays": null,
            "projectOverrides": {
                projects.scratch.to_string(): {"sidebarAutoSettleAfterDays": 1},
            },
        }),
    );
    let app = reopen(&f.config).await;
    assert_eq!(
        settled_by_project(&app, &projects).await,
        [false, false, true]
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn a_missing_or_invalid_auto_settle_limit_falls_back_to_three_days() {
    let f = Fixture::new();
    let projects = two_day_old_projects(&f).await;
    let variants = [
        None,
        Some("{not json".to_string()),
        Some(
            serde_json::json!({
                "sidebarAutoSettleAfterDays": 0,
                "projectOverrides": {
                    projects.alpha.to_string(): {"sidebarAutoSettleAfterDays": 91},
                    projects.beta.to_string(): {"sidebarAutoSettleAfterDays": "1"},
                },
            })
            .to_string(),
        ),
        Some(serde_json::json!({"sidebarAutoSettleAfterDays": "off"}).to_string()),
    ];
    for settled in [[false; 3], [true; 3]] {
        for settings in &variants {
            let path = f.config.data_dir.join("settings.json");
            match settings {
                Some(text) => std::fs::write(&path, text).unwrap(),
                None => drop(std::fs::remove_file(&path)),
            }
            let app = reopen(&f.config).await;
            assert_eq!(
                settled_by_project(&app, &projects).await,
                settled,
                "{settings:?}"
            );
            app.shutdown().await.unwrap();
        }
        for id in &projects.threads {
            age_turns(&f, id, DAY_MS + HOUR_MS);
        }
    }
}
#[tokio::test]
async fn saving_settings_reclassifies_threads_without_a_restart() {
    let f = Fixture::new();
    let projects = two_day_old_projects(&f).await;
    let app = reopen(&f.config).await;
    assert_eq!(
        settled_by_project(&app, &projects).await,
        [false, false, false]
    );
    for id in &projects.threads {
        let started = std::time::Instant::now();
        while app
            .list_thread_pull_requests(id.clone(), false)
            .await
            .unwrap()
            .discovering
        {
            assert!(
                started.elapsed() < LIMIT,
                "startup PR discovery never finished"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    let mut changes = app.subscribe();
    let settings = serde_json::json!({
        "projectOverrides": {
            projects.alpha.to_string(): {"sidebarAutoSettleAfterDays": 1},
        },
    });
    app.save_settings(&settings.to_string()).await.unwrap();
    let hint = changes.try_recv().unwrap();
    assert_eq!(hint.thread_id, projects.threads[0]);
    assert!(hint.summary.settled_at_ms.is_some());
    assert!(changes.try_recv().is_err());
    assert_eq!(
        settled_by_project(&app, &projects).await,
        [true, false, false]
    );
    app.save_settings("{}").await.unwrap();
    let hint = changes.try_recv().unwrap();
    assert_eq!(hint.thread_id, projects.threads[0]);
    assert_eq!(hint.summary.settled_at_ms, None);
    assert_eq!(
        settled_by_project(&app, &projects).await,
        [false, false, false]
    );
    app.shutdown().await.unwrap();
}
const SHOT: &[u8] = b"\x89PNG\r\n\x1a\nshot";
const SHOT_ID: &str = "0c25346db1c2a63fcc299515e33ca8fb44d8d4cdb6ad376e04aa20a8928293cb";
const CLIP: &[u8] = b"GIF89aclip";
const CLIP_ID: &str = "f791cfdafdc956edbeb3f12bfa69771c4a594ba3fe46f3873c39fe1aa85d407f";
fn attachment_path(f: &Fixture, file: &str) -> std::path::PathBuf {
    f.config
        .data_dir
        .canonicalize()
        .unwrap()
        .join("attachments")
        .join(file)
}
fn turn_inputs(f: &Fixture) -> Vec<serde_json::Value> {
    f.calls()
        .into_iter()
        .filter(|call| call["method"] == "turn/start")
        .map(|call| call["params"]["input"].clone())
        .collect()
}
fn age(path: &std::path::Path, by: Duration) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - by)
        .unwrap();
}
#[tokio::test]
async fn turn_start_sends_the_text_then_each_image_by_its_stored_path() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let shot = app
        .stage_attachment("shot.png".into(), SHOT.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    let clip = app
        .stage_attachment("clip.gif".into(), CLIP.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&shot).unwrap(),
        serde_json::json!({"id": SHOT_ID, "mimeType": "image/png", "name": "shot.png", "sizeBytes": 12})
    );
    assert_eq!(clip.id().as_str(), CLIP_ID);
    app.submit(
        thread.id.clone(),
        "images".into(),
        "  What changed?  ".into(),
        vec![shot.clone(), clip.clone()],
    )
    .await
    .unwrap();
    let done = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert_eq!(done.turns[0].prompt, "What changed?");
    assert_eq!(done.turns[0].attachments, [shot, clip]);
    assert_eq!(
        turn_inputs(&f),
        [serde_json::json!([
            {"type": "text", "text": format!("What changed?\n\n[Attached image \"shot.png\" is saved at: {}]\n\n[Attached image \"clip.gif\" is saved at: {}]", attachment_path(&f, &format!("{SHOT_ID}.png")).display(), attachment_path(&f, &format!("{CLIP_ID}.gif")).display()), "text_elements": []},
            {"type": "localImage", "path": attachment_path(&f, &format!("{SHOT_ID}.png"))},
            {"type": "localImage", "path": attachment_path(&f, &format!("{CLIP_ID}.gif"))},
        ])]
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn a_retried_submit_returns_its_turn_and_different_images_conflict() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let shot = app
        .stage_attachment("shot.png".into(), SHOT.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    let clip = app
        .stage_attachment("clip.gif".into(), CLIP.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    let submit = |attachments: Vec<Attachment>| {
        app.submit(
            thread.id.clone(),
            "retry".into(),
            "Look".into(),
            attachments,
        )
    };
    let first = submit(vec![shot.clone()]).await.unwrap();
    let retry = submit(vec![shot.clone()]).await.unwrap();
    assert_eq!(retry.turn_id, first.turn_id);
    let conflict = submit(vec![shot.clone(), clip]).await.unwrap_err();
    assert_eq!(conflict.code, "request_conflict");
    let mut renamed = shot.clone();
    if let Attachment::Image(image) = &mut renamed {
        image.name = "other.png".into();
    }
    assert_eq!(
        submit(vec![renamed]).await.unwrap_err().code,
        "request_conflict"
    );
    assert_eq!(submit(vec![]).await.unwrap_err().code, "request_conflict");
    let done = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert_eq!(done.turns.len(), 1);
    assert_eq!(turn_inputs(&f).len(), 1);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn an_image_without_text_starts_a_turn_titled_by_the_image() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    assert_eq!(
        app.submit(thread.id.clone(), "empty".into(), "  ".into(), vec![])
            .await
            .unwrap_err()
            .code,
        "invalid_prompt"
    );
    let shot = app
        .stage_attachment("shot.png".into(), SHOT.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    app.submit(thread.id.clone(), "image".into(), " ".into(), vec![shot])
        .await
        .unwrap();
    let done = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert_eq!(done.title, "Image: shot.png");
    assert_eq!(done.turns[0].prompt, "");
    assert_eq!(
        turn_inputs(&f),
        [serde_json::json!([
            {"type": "text", "text": format!("[Attached image \"shot.png\" is saved at: {}]", attachment_path(&f, &format!("{SHOT_ID}.png")).display()), "text_elements": []},
            {"type": "localImage", "path": attachment_path(&f, &format!("{SHOT_ID}.png"))},
        ])]
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn a_submit_refuses_images_that_are_not_staged() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let shot = app
        .stage_attachment("shot.png".into(), SHOT.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    let mut wrong_size = shot.clone();
    if let Attachment::Image(image) = &mut wrong_size {
        image.size_bytes = 13;
    }
    let refused = app
        .submit(
            thread.id.clone(),
            "forged".into(),
            "Look".into(),
            vec![wrong_size],
        )
        .await
        .unwrap_err();
    assert_eq!(
        refused,
        AppError::new(
            "missing_attachment",
            "'shot.png' is no longer available. Attach the file again."
        )
    );
    std::fs::remove_file(attachment_path(&f, &format!("{SHOT_ID}.png"))).unwrap();
    let refused = app
        .submit(
            thread.id.clone(),
            "missing".into(),
            "Look".into(),
            vec![shot],
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, "missing_attachment");
    assert!(app.thread(thread.id).await.unwrap().turns.is_empty());
    assert!(turn_inputs(&f).is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn turn_images_survive_reopen_and_the_sweep_keeps_only_referenced_old_files() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let shot = app
        .stage_attachment("shot.png".into(), SHOT.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    app.stage_attachment("clip.gif".into(), CLIP.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    app.submit(
        thread.id.clone(),
        "keep".into(),
        "Look".into(),
        vec![shot.clone()],
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.shutdown().await.unwrap();
    let day = Duration::from_secs(25 * 60 * 60);
    age(&attachment_path(&f, &format!("{SHOT_ID}.png")), day);
    age(&attachment_path(&f, &format!("{CLIP_ID}.gif")), day);
    let app = reopen(&f.config).await;
    let restored = app.thread(thread.id).await.unwrap();
    assert_eq!(restored.turns[0].attachments, [shot]);
    let mut files: Vec<_> = std::fs::read_dir(attachment_path(&f, ""))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    assert_eq!(files, [format!("{SHOT_ID}.png")]);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn image_threads_keep_renames_and_archives_until_the_last_reference_is_deleted() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let first = conversation(&app, &f).await;
    let second = app
        .create_thread(first.workspace_id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let image = app
        .stage_attachment("shot.png".into(), SHOT.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    app.rename_thread(first.id.clone(), "Saved image".into())
        .await
        .unwrap();
    for thread in [&first, &second] {
        app.submit(
            thread.id.clone(),
            format!("image-{}", thread.id),
            String::new(),
            vec![image.clone()],
        )
        .await
        .unwrap();
        wait(&app, &thread.id, |t| {
            matches!(t.turns[0].execution, Execution::Completed)
        })
        .await;
    }
    assert_eq!(
        app.thread(first.id.clone()).await.unwrap().title,
        "Saved image"
    );
    assert_eq!(
        app.thread(second.id.clone()).await.unwrap().title,
        "Image: shot.png"
    );
    app.arrange(first.id.clone(), Arrange::Archive)
        .await
        .unwrap();
    app.delete_thread(second.id.clone()).await.unwrap();
    app.shutdown().await.unwrap();
    let path = attachment_path(&f, &format!("{SHOT_ID}.png"));
    age(&path, Duration::from_secs(25 * 60 * 60));
    let app = reopen(&f.config).await;
    let archived = app.thread(first.id.clone()).await.unwrap();
    assert!(archived.archived());
    assert_eq!(archived.title, "Saved image");
    assert_eq!(archived.turns[0].attachments, [image]);
    assert!(path.exists());
    assert_eq!(
        app.thread(second.id).await.unwrap_err().code,
        "missing_thread"
    );
    app.arrange(first.id.clone(), Arrange::Unarchive)
        .await
        .unwrap();
    assert_eq!(
        app.thread(first.id.clone()).await.unwrap().title,
        "Saved image"
    );
    app.delete_thread(first.id.clone()).await.unwrap();
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    assert_eq!(
        app.thread(first.id).await.unwrap_err().code,
        "missing_thread"
    );
    assert!(!path.exists());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn archived_placements_and_rename_survive_restart_and_reject_live_actions() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let first = conversation(&app, &f).await;
    let workspace = first.workspace_id.clone();
    let mut expected = vec![];
    for actions in [
        vec![],
        vec![Arrange::Pin],
        vec![Arrange::Settle],
        vec![Arrange::Settle, Arrange::Unsettle],
    ] {
        let thread = app
            .create_thread(workspace.clone(), NewCheckout::Local)
            .await
            .unwrap();
        for action in actions {
            app.arrange(thread.id.clone(), action).await.unwrap();
        }
        let before = app.thread(thread.id.clone()).await.unwrap().placement;
        app.arrange(
            thread.id.clone(),
            Arrange::Snooze {
                until_ms: now_ms() + 60_000,
            },
        )
        .await
        .unwrap();
        app.rename_thread(thread.id.clone(), "  My saved title  ".into())
            .await
            .unwrap();
        app.arrange(thread.id.clone(), Arrange::Archive)
            .await
            .unwrap();
        let archived = app.thread(thread.id.clone()).await.unwrap();
        assert!(archived.archived());
        assert!(archived.snooze.is_none());
        assert_eq!(archived.title, "My saved title");
        assert_eq!(
            app.arrange(thread.id.clone(), Arrange::Pin)
                .await
                .unwrap_err()
                .code,
            "thread_archived"
        );
        assert_eq!(
            app.submit(thread.id.clone(), "hidden".into(), "hello".into(), vec![])
                .await
                .unwrap_err()
                .code,
            "thread_archived"
        );
        assert_eq!(
            app.open_thread(thread.id.clone()).await.unwrap_err().code,
            "thread_archived"
        );
        expected.push((thread.id, before));
    }
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    let view = app.workspace_view(workspace, None).await.unwrap();
    for (id, before) in expected {
        let summary = view.threads.iter().find(|thread| thread.id == id).unwrap();
        assert!(summary.archived_at_ms.is_some());
        assert!(summary.created_at_ms.is_some());
        assert!(
            summary.pinned_at_ms.is_none()
                && summary.settled_at_ms.is_none()
                && summary.snoozed_until_ms.is_none()
        );
        app.arrange(id.clone(), Arrange::Unarchive).await.unwrap();
        assert_eq!(app.thread(id.clone()).await.unwrap().placement, before);
        assert_eq!(app.thread(id).await.unwrap().title, "My saved title");
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn manual_draft_rename_survives_first_prompt_and_empty_name_refuses() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.rename_thread(thread.id.clone(), "Custom title".into())
        .await
        .unwrap();
    assert_eq!(
        app.rename_thread(thread.id.clone(), "  ".into())
            .await
            .unwrap_err()
            .code,
        "invalid_title"
    );
    app.submit(
        thread.id.clone(),
        "rename-first".into(),
        "hello".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().title,
        "Custom title"
    );
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    assert_eq!(app.thread(thread.id).await.unwrap().title, "Custom title");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn delete_refuses_running_and_same_checkout_then_removes_receipts_durably() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let other = app
        .create_thread(thread.workspace_id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    app.submit(
        thread.id.clone(),
        "deleted-receipt".into(),
        "hold".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    assert_eq!(
        app.delete_thread(thread.id.clone()).await.unwrap_err().code,
        "busy"
    );
    assert_eq!(
        app.delete_thread(other.id.clone()).await.unwrap_err().code,
        "busy"
    );
    app.interrupt(thread.id.clone()).await.unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Interrupted)
    })
    .await;
    app.delete_thread(thread.id.clone()).await.unwrap();
    assert!(f.repository.exists());
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap_err().code,
        "missing_thread"
    );
    app.delete_thread(thread.id.clone()).await.unwrap();
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    let receipts: i64 = db
        .query_row(
            "SELECT count(*) FROM receipts WHERE request_id='deleted-receipt'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(receipts, 0);
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    assert_eq!(
        app.thread(thread.id).await.unwrap_err().code,
        "missing_thread"
    );
    assert!(app.thread(other.id).await.is_ok());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn delete_worktree_setting_retains_dirty_locked_and_default_off_but_removes_clean() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let local = conversation(&app, &f).await;
    let disabled = app
        .create_thread(local.workspace_id.clone(), main_worktree())
        .await
        .unwrap();
    let (path, _) = worktree(&disabled.checkout);
    assert!(matches!(
        app.delete_thread(disabled.id).await.unwrap(),
        DeletedWorktree::NotRequested
    ));
    assert!(path.exists());
    app.save_settings(r#"{"storageCleanup":{"worktreeOnDelete":true}}"#)
        .await
        .unwrap();
    for dirty in ["dirty", "ignored", "locked", "clean"] {
        let thread = app
            .create_thread(local.workspace_id.clone(), main_worktree())
            .await
            .unwrap();
        let (path, branch) = worktree(&thread.checkout);
        match dirty {
            "dirty" => std::fs::write(path.join("notes.txt"), "keep me").unwrap(),
            "ignored" => {
                std::fs::write(path.join(".gitignore"), "secret\n").unwrap();
                git_output(&path, &["add", ".gitignore"]);
                git_output(
                    &path,
                    &[
                        "-c",
                        "user.name=T",
                        "-c",
                        "user.email=t@e.invalid",
                        "commit",
                        "-qm",
                        "ignore",
                    ],
                );
                std::fs::write(path.join("secret"), "keep me").unwrap();
            }
            "locked" => {
                git_output(
                    &f.repository,
                    &["worktree", "lock", &path.to_string_lossy()],
                );
            }
            _ => {}
        }
        let outcome = app.delete_thread(thread.id.clone()).await.unwrap();
        if dirty == "clean" {
            assert!(matches!(outcome, DeletedWorktree::Removed));
            assert!(!path.exists());
        } else {
            assert!(
                matches!(outcome, DeletedWorktree::Retained { .. }),
                "{outcome:?}"
            );
            assert!(path.exists());
        }
        assert_eq!(
            app.thread(thread.id).await.unwrap_err().code,
            "missing_thread"
        );
        git_output(
            &f.repository,
            &["show-ref", "--verify", &format!("refs/heads/{branch}")],
        );
    }
    app.delete_thread(local.id).await.unwrap();
    assert!(f.repository.exists());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn delete_database_failure_keeps_thread_and_releases_checkout_and_terminal_gate() {
    let mut f = Fixture::new();
    f.config.shell = Some("/bin/sh".into());
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER refuse_thread_delete BEFORE DELETE ON threads BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;").unwrap();
    assert!(app.delete_thread(thread.id.clone()).await.is_err());
    assert!(app.thread(thread.id.clone()).await.is_ok());
    app.terminal_attach(
        thread.workspace_id.clone(),
        Some(thread.id.clone()),
        "term-1".parse().unwrap(),
        80,
        24,
        |_| {},
    )
    .await
    .unwrap();
    app.rename_thread(thread.id.clone(), "Still here".into())
        .await
        .unwrap();
    db.execute_batch("DROP TRIGGER refuse_thread_delete;")
        .unwrap();
    app.delete_thread(thread.id.clone()).await.unwrap();
    assert_eq!(
        app.thread(thread.id).await.unwrap_err().code,
        "missing_thread"
    );
    app.shutdown().await.unwrap();
}

#[test]
fn legacy_placement_json_remains_live_and_archive_cannot_nest() {
    for json in [
        r#"{"kind":"auto"}"#,
        r#"{"kind":"kept"}"#,
        r#"{"kind":"pinned","atMs":17}"#,
        r#"{"kind":"settled","atMs":29}"#,
    ] {
        let placement: Placement = serde_json::from_str(json).unwrap();
        let mut thread = idle_thread(None, None);
        thread.placement = placement;
        thread.arrange(Arrange::Archive, 30, None).unwrap();
        let serialized = serde_json::to_string(&thread.placement).unwrap();
        thread.placement = serde_json::from_str(&serialized).unwrap();
        assert!(thread.arrange(Arrange::Archive, 40, None).is_err());
        thread.arrange(Arrange::Unarchive, 50, None).unwrap();
        assert_eq!(thread.placement, placement);
    }
    assert!(
        serde_json::from_str::<Placement>(
            r#"{"kind":"archived","atMs":1,"restore":{"kind":"archived","atMs":2}}"#
        )
        .is_err()
    );
}

#[tokio::test]
async fn metadata_archive_listing_restore_and_delete_work_when_repository_is_unavailable() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.arrange(thread.id.clone(), Arrange::Archive)
        .await
        .unwrap();
    let moved = f.repository.with_file_name("repository-away");
    std::fs::rename(&f.repository, &moved).unwrap();
    assert!(
        app.workspace_view(thread.workspace_id.clone(), None)
            .await
            .is_err()
    );
    let summary = app
        .list_thread_summaries(thread.workspace_id.clone())
        .await
        .unwrap();
    assert!(
        summary
            .iter()
            .any(|item| item.id == thread.id && item.archived_at_ms.is_some())
    );
    app.arrange(thread.id.clone(), Arrange::Unarchive)
        .await
        .unwrap();
    assert!(!app.thread(thread.id.clone()).await.unwrap().archived());
    app.arrange(thread.id.clone(), Arrange::Archive)
        .await
        .unwrap();
    app.delete_thread(thread.id).await.unwrap();
    assert!(
        app.list_thread_summaries(thread.workspace_id)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(moved.exists());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn deleting_shared_worktree_retains_checkout_and_surviving_history() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let local = conversation(&app, &f).await;
    let first = app
        .create_thread(local.workspace_id.clone(), main_worktree())
        .await
        .unwrap();
    let mut second = app
        .create_thread(local.workspace_id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    app.save_settings(r#"{"storageCleanup":{"worktreeOnDelete":true}}"#)
        .await
        .unwrap();
    app.shutdown().await.unwrap();
    second.checkout = first.checkout.clone();
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    db.execute(
        "UPDATE threads SET data=?1 WHERE id=?2",
        rusqlite::params![
            serde_json::to_string(&second).unwrap(),
            second.id.to_string()
        ],
    )
    .unwrap();
    let app = reopen(&f.config).await;
    let (path, branch) = worktree(&first.checkout);
    assert!(matches!(
        app.delete_thread(first.id).await.unwrap(),
        DeletedWorktree::Retained { .. }
    ));
    assert!(path.exists());
    assert!(app.thread(second.id).await.is_ok());
    git_output(
        &f.repository,
        &["show-ref", "--verify", &format!("refs/heads/{branch}")],
    );
    let scratch = app.ensure_scratch().await.unwrap();
    let folder = app
        .create_thread(
            scratch.id,
            NewCheckout::Folder {
                prompt: "scratch".into(),
            },
        )
        .await
        .unwrap();
    let Checkout::Folder { path } = folder.checkout else {
        panic!("folder expected")
    };
    assert!(matches!(
        app.delete_thread(folder.id).await.unwrap(),
        DeletedWorktree::NotRequested
    ));
    assert!(path.exists());
    app.shutdown().await.unwrap();
}

fn steering_delivery<'a>(thread: &'a ThreadSnapshot, operation: &str) -> Option<&'a Delivery> {
    thread
        .turns
        .iter()
        .flat_map(|turn| &turn.items)
        .find_map(|item| match item {
            Item::UserInput { id, delivery, .. } if id == operation => Some(delivery),
            _ => None,
        })
}
#[tokio::test]
async fn steering_receipts_keep_one_turn_and_checkout_lease_and_reconcile_every_message() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let first = app
        .submit(thread.id.clone(), "original".into(), "hold".into(), vec![])
        .await
        .unwrap();
    let running = wait(&app, &thread.id, |t| {
        matches!(t.session, SessionState::Running)
    })
    .await;
    let checkpoint = serde_json::to_value(&running.turns[0].checkpoint).unwrap();
    for (operation, text) in [
        ("steer-one", "event-before-error"),
        ("steer-two", "second follow-up"),
    ] {
        let receipt = app
            .submit_to(
                thread.id.clone(),
                operation.into(),
                text.into(),
                vec![],
                Some(first.turn_id.clone()),
            )
            .await
            .unwrap();
        assert_eq!(receipt.turn_id, first.turn_id);
        let accepted = wait(&app, &thread.id, |t| {
            matches!(steering_delivery(t, operation), Some(Delivery::Accepted))
        })
        .await;
        assert_eq!(accepted.turns.len(), 1);
        assert!(matches!(accepted.turns[0].execution, Execution::Running));
        assert_eq!(
            serde_json::to_value(&accepted.turns[0].checkpoint).unwrap(),
            checkpoint
        );
        assert_eq!(accepted.turns[0].settings, running.turns[0].settings);
        let same = app
            .submit_to(
                thread.id.clone(),
                operation.into(),
                text.into(),
                vec![],
                Some(first.turn_id.clone()),
            )
            .await
            .unwrap();
        assert_eq!(same.turn_id, first.turn_id);
        let conflict = app
            .submit_to(
                thread.id.clone(),
                operation.into(),
                "different".into(),
                vec![],
                Some(first.turn_id.clone()),
            )
            .await
            .unwrap_err();
        assert_eq!(conflict.code, "request_conflict");
    }
    let other = conversation(&app, &f).await;
    assert_eq!(
        app.submit(other.id, "other".into(), "hello".into(), vec![])
            .await
            .unwrap_err()
            .code,
        "checkout_busy"
    );
    let calls = f.calls();
    let steers: Vec<_> = calls
        .iter()
        .filter(|v| v["method"] == "turn/steer")
        .collect();
    assert_eq!(steers.len(), 2);
    assert_eq!(
        steers[0]["params"]["expectedTurnId"],
        running.turns[0].native_turn_id.clone().unwrap()
    );
    assert_eq!(steers[0]["params"]["clientUserMessageId"], "steer-one");
    assert_eq!(
        calls.iter().filter(|v| v["method"] == "turn/start").count(),
        1
    );
    app.interrupt(thread.id.clone()).await.unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Interrupted)
    })
    .await;
    app.shutdown().await.unwrap();
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    let mut local = app_snapshot_after_close(&db, &thread.id);
    for item in &mut local.turns[0].items {
        if let Item::UserInput { delivery, .. } = item {
            *delivery = Delivery::Uncertain {
                reason: "Simulated lost saved outcome".into(),
            };
        }
    }
    db.execute(
        "UPDATE threads SET data=?1 WHERE id=?2",
        rusqlite::params![
            serde_json::to_string(&local).unwrap(),
            thread.id.to_string()
        ],
    )
    .unwrap();
    let restarted = reopen(&f.config).await;
    restarted.open_thread(thread.id.clone()).await.unwrap();
    let resumed = wait(&restarted, &thread.id, |t| {
        matches!(t.session, SessionState::Ready)
            && matches!(steering_delivery(t, "steer-one"), Some(Delivery::Accepted))
            && matches!(steering_delivery(t, "steer-two"), Some(Delivery::Accepted))
    })
    .await;
    assert_eq!(resumed.turns.len(), 1);
    assert_eq!(
        resumed.turns[0]
            .items
            .iter()
            .filter(|item| matches!(item, Item::UserInput { .. }))
            .count(),
        2
    );
    assert!(matches!(
        steering_delivery(&resumed, "steer-one"),
        Some(Delivery::Accepted)
    ));
    assert!(matches!(
        steering_delivery(&resumed, "steer-two"),
        Some(Delivery::Accepted)
    ));
    restarted
        .submit_to(
            thread.id.clone(),
            "steer-two".into(),
            "second follow-up".into(),
            vec![],
            Some(first.turn_id),
        )
        .await
        .unwrap();
    assert_eq!(
        f.calls()
            .iter()
            .filter(|v| v["method"] == "turn/steer")
            .count(),
        2
    );
    restarted.shutdown().await.unwrap();
}
#[tokio::test]
async fn steering_refuses_stale_targets_and_approvals_without_native_dispatch() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let original = app
        .submit(
            thread.id.clone(),
            "original".into(),
            "approval".into(),
            vec![],
        )
        .await
        .unwrap();
    wait(&app, &thread.id, |t| t.approval_open()).await;
    let error = app
        .submit_to(
            thread.id.clone(),
            "follow".into(),
            "hello".into(),
            vec![],
            Some(original.turn_id.clone()),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "busy");
    let error = app
        .submit_to(
            thread.id.clone(),
            "stale".into(),
            "hello".into(),
            vec![],
            Some(TurnId::default()),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "stale_turn");
    assert_eq!(
        f.calls()
            .iter()
            .filter(|v| v["method"] == "turn/steer")
            .count(),
        0
    );
    assert_eq!(app.thread(thread.id).await.unwrap().turns.len(), 1);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn steering_completion_does_not_confirm_input_and_malformed_ack_is_uncertain() {
    for (prompt, uncertain) in [
        ("completion-without-user", false),
        ("wrong-target-ack", true),
        ("wrong-target-event", true),
        ("lose-steer", true),
    ] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        let original = app
            .submit(thread.id.clone(), "original".into(), "hold".into(), vec![])
            .await
            .unwrap();
        wait(&app, &thread.id, |t| {
            matches!(t.session, SessionState::Running)
        })
        .await;
        app.submit_to(
            thread.id.clone(),
            "follow".into(),
            prompt.into(),
            vec![],
            Some(original.turn_id.clone()),
        )
        .await
        .unwrap();
        let snapshot = wait(&app, &thread.id, |t| {
            matches!(
                steering_delivery(t, "follow"),
                Some(Delivery::Uncertain { .. } | Delivery::NotSent { .. })
            )
        })
        .await;
        if uncertain {
            assert!(matches!(
                steering_delivery(&snapshot, "follow"),
                Some(Delivery::Uncertain { .. })
            ));
        } else {
            assert!(matches!(
                steering_delivery(&snapshot, "follow"),
                Some(Delivery::NotSent { .. })
            ));
            assert!(matches!(snapshot.turns[0].execution, Execution::Completed));
        }
        app.submit_to(
            thread.id.clone(),
            "follow".into(),
            prompt.into(),
            vec![],
            Some(original.turn_id),
        )
        .await
        .unwrap();
        assert_eq!(
            f.calls()
                .iter()
                .filter(|v| v["method"] == "turn/steer")
                .count(),
            1
        );
        app.shutdown().await.unwrap();
        let restarted = reopen(&f.config).await;
        let snapshot = restarted.thread(thread.id).await.unwrap();
        assert_eq!(snapshot.turns.len(), 1);
        assert!(!matches!(
            steering_delivery(&snapshot, "follow"),
            Some(Delivery::Accepted)
        ));
        restarted.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn steering_never_reaches_provider_when_acceptance_or_sending_save_fails() {
    for phase in ["preparing", "sending"] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        let original = app
            .submit(thread.id.clone(), "original".into(), "hold".into(), vec![])
            .await
            .unwrap();
        wait(&app, &thread.id, |t| {
            matches!(t.session, SessionState::Running)
        })
        .await;
        let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
        db.execute_batch(&format!("CREATE TRIGGER reject_steer BEFORE UPDATE ON threads WHEN EXISTS (SELECT 1 FROM json_each(json_extract(NEW.data,'$.turns[0].items')) WHERE json_extract(value,'$.kind')='user_input' AND json_extract(value,'$.delivery.kind')='{phase}') BEGIN SELECT RAISE(FAIL,'injected steer save failure'); END;")).unwrap();
        let result = app
            .submit_to(
                thread.id.clone(),
                "follow".into(),
                "hello".into(),
                vec![],
                Some(original.turn_id.clone()),
            )
            .await;
        if phase == "preparing" {
            assert_eq!(result.unwrap_err().code, "storage");
        } else {
            assert_eq!(result.unwrap().turn_id, original.turn_id);
            wait(&app, &thread.id, |t| {
                matches!(
                    steering_delivery(t, "follow"),
                    Some(Delivery::NotSent { .. })
                )
            })
            .await;
            app.submit_to(
                thread.id.clone(),
                "follow".into(),
                "hello".into(),
                vec![],
                Some(original.turn_id),
            )
            .await
            .unwrap();
        }
        assert_eq!(
            f.calls()
                .iter()
                .filter(|v| v["method"] == "turn/steer")
                .count(),
            0
        );
        db.execute_batch("DROP TRIGGER reject_steer").unwrap();
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn archived_steering_images_survive_startup_sweep_and_rewind_removes_the_whole_turn() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let original = app
        .submit(thread.id.clone(), "original".into(), "hold".into(), vec![])
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.session, SessionState::Running)
    })
    .await;
    let image = app
        .stage_attachment("steer.png".into(), SHOT.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    app.submit_to(
        thread.id.clone(),
        "image-steer".into(),
        "Look here".into(),
        vec![image.clone()],
        Some(original.turn_id.clone()),
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(
            steering_delivery(t, "image-steer"),
            Some(Delivery::Accepted)
        )
    })
    .await;
    app.interrupt(thread.id.clone()).await.unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Interrupted)
    })
    .await;
    app.arrange(thread.id.clone(), Arrange::Archive)
        .await
        .unwrap();
    app.shutdown().await.unwrap();
    age(
        &attachment_path(&f, &format!("{SHOT_ID}.png")),
        Duration::from_secs(25 * 60 * 60),
    );
    let app = reopen(&f.config).await;
    assert!(attachment_path(&f, &format!("{SHOT_ID}.png")).exists());
    app.arrange(thread.id.clone(), Arrange::Unarchive)
        .await
        .unwrap();
    let reverted = app
        .revert_thread(
            thread.id.clone(),
            "revert-steered-turn".into(),
            original.turn_id.clone(),
            false,
        )
        .await
        .unwrap();
    assert!(reverted.turns.is_empty());
    assert_eq!(reverted.last_revert.as_ref().unwrap().prompt, "hold");
    assert!(
        reverted
            .last_revert
            .as_ref()
            .unwrap()
            .attachments
            .is_empty()
    );
    let prior_receipt = app
        .submit_to(
            thread.id.clone(),
            "image-steer".into(),
            "Look here".into(),
            vec![image],
            Some(original.turn_id),
        )
        .await
        .unwrap();
    assert_eq!(prior_receipt.turn_id, reverted.last_revert.unwrap().turn_id);
    assert_eq!(
        f.calls()
            .iter()
            .filter(|v| v["method"] == "turn/steer")
            .count(),
        1
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn restart_classifies_preparing_and_sending_steers_without_replay_even_on_completed_parent() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "original".into(), "hello".into(), vec![])
        .await
        .unwrap();
    let mut snapshot = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.shutdown().await.unwrap();
    snapshot.turns[0].items.extend([
        Item::UserInput {
            id: "preparing".into(),
            text: "Not sent".into(),
            attachments: vec![],
            context: None,
            delivery: Delivery::Preparing,
        },
        Item::UserInput {
            id: "sending".into(),
            text: "May have sent".into(),
            attachments: vec![],
            context: None,
            delivery: Delivery::Sending,
        },
    ]);
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    db.execute(
        "UPDATE threads SET data=?1 WHERE id=?2",
        rusqlite::params![
            serde_json::to_string(&snapshot).unwrap(),
            thread.id.to_string()
        ],
    )
    .unwrap();
    let app = reopen(&f.config).await;
    let restored = app.thread(thread.id).await.unwrap();
    assert!(matches!(
        steering_delivery(&restored, "preparing"),
        Some(Delivery::NotSent { .. })
    ));
    assert!(matches!(
        steering_delivery(&restored, "sending"),
        Some(Delivery::Uncertain { .. })
    ));
    assert_eq!(
        f.calls()
            .iter()
            .filter(|v| v["method"] == "turn/steer")
            .count(),
        0
    );
    app.shutdown().await.unwrap();
}

fn app_snapshot_after_close(db: &rusqlite::Connection, id: &ThreadId) -> ThreadSnapshot {
    let text: String = db
        .query_row(
            "SELECT data FROM threads WHERE id=?1",
            [id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&text).unwrap()
}

#[test]
fn old_session_settings_restore_build_and_empty_questions() {
    let settings: SessionSettings = serde_json::from_value(serde_json::json!({
        "model": null, "effort": null, "permissionMode": "approval-required"
    }))
    .unwrap();
    assert_eq!(settings.interaction_mode, InteractionMode::Default);
    let mut saved = serde_json::to_value(idle_thread(Some(1000), Some(2000))).unwrap();
    saved.as_object_mut().unwrap().remove("userQuestions");
    saved["settings"]
        .as_object_mut()
        .unwrap()
        .remove("interactionMode");
    let restored: ThreadSnapshot = serde_json::from_value(saved).unwrap();
    assert!(restored.user_questions.is_empty());
    assert_eq!(restored.settings.interaction_mode, InteractionMode::Default);
}

#[tokio::test]
async fn collaboration_modes_require_real_supported_catalog() {
    for malformed in [false, true] {
        let f = Fixture::new();
        if malformed {
            std::fs::write(f.peer.parent().unwrap().join("collaboration_malformed"), "").unwrap();
        }
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        assert!(app.collaboration_modes().await.unwrap().is_empty());
        assert_eq!(
            app.update_settings(
                thread.id.clone(),
                SessionSettings {
                    interaction_mode: InteractionMode::Plan,
                    ..Default::default()
                }
            )
            .await
            .unwrap_err()
            .code,
            "plan_unavailable"
        );
        app.submit(
            thread.id.clone(),
            "legacy-build".into(),
            "hello".into(),
            vec![],
        )
        .await
        .unwrap();
        wait(&app, &thread.id, |t| {
            matches!(t.turns[0].execution, Execution::Completed)
        })
        .await;
        let calls = f.calls();
        let params = &calls
            .iter()
            .find(|call| call["method"] == "turn/start")
            .unwrap()["params"];
        assert!(params.get("collaborationMode").is_none());
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn collaboration_plan_and_build_send_captured_settings_and_clear_sticky_mode() {
    let f = Fixture::new();
    std::fs::write(f.peer.parent().unwrap().join("collaboration"), "").unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    assert_eq!(
        app.collaboration_modes().await.unwrap(),
        vec![InteractionMode::Plan, InteractionMode::Default]
    );
    let plan = SessionSettings {
        interaction_mode: InteractionMode::Plan,
        permission_mode: PermissionMode::FullAccess,
        ..Default::default()
    };
    app.update_settings(thread.id.clone(), plan.clone())
        .await
        .unwrap();
    app.submit(
        thread.id.clone(),
        "plan-mode".into(),
        "hello".into(),
        vec![],
    )
    .await
    .unwrap();
    let snapshot = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert_eq!(snapshot.turns[0].settings.as_ref(), Some(&plan));
    let build = SessionSettings {
        model: Some("model-one".into()),
        effort: Some("ultra".into()),
        interaction_mode: InteractionMode::Default,
        ..Default::default()
    };
    app.update_settings(thread.id.clone(), build.clone())
        .await
        .unwrap();
    app.submit(
        thread.id.clone(),
        "build-mode".into(),
        "hello".into(),
        vec![],
    )
    .await
    .unwrap();
    let snapshot = wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Completed)
    })
    .await;
    assert_eq!(snapshot.turns[0].settings.as_ref(), Some(&plan));
    assert_eq!(snapshot.turns[1].settings.as_ref(), Some(&build));
    let calls = f.calls();
    let turns: Vec<_> = calls
        .iter()
        .filter(|call| call["method"] == "turn/start")
        .collect();
    assert_eq!(
        turns[0]["params"]["collaborationMode"],
        serde_json::json!({"mode":"plan","settings":{"model":"model-one","reasoning_effort":"low","developer_instructions":null}})
    );
    assert_eq!(turns[0]["params"]["effort"], "low");
    assert_eq!(
        turns[1]["params"]["collaborationMode"],
        serde_json::json!({"mode":"default","settings":{"model":"model-one","reasoning_effort":"ultra","developer_instructions":null}})
    );
    assert!(calls.iter().any(|call| call["method"] == "initialize"
        && call["params"]["capabilities"]["experimentalApi"] == true));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn plan_items_stream_complete_persist_and_resume_from_native_history() {
    let f = Fixture::new();
    std::fs::write(f.peer.parent().unwrap().join("collaboration"), "").unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.collaboration_modes().await.unwrap();
    app.update_settings(
        thread.id.clone(),
        SessionSettings {
            interaction_mode: InteractionMode::Plan,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    app.submit(
        thread.id.clone(),
        "stream-plan".into(),
        "propose-plan".into(),
        vec![],
    )
    .await
    .unwrap();
    let streaming = wait(&app, &thread.id, |t| t.turns[0].items.iter().any(|item| matches!(item, Item::Plan { text, complete: false, .. } if text.contains("composer workflow")))).await;
    assert!(matches!(streaming.turns[0].execution, Execution::Running));
    let finished = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert!(finished.turns[0].items.iter().any(|item| matches!(item, Item::Plan { text, complete: true, .. } if text == "# Fixture plan\n\nImplement the requested composer workflow.")));
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    let restored = app.thread(thread.id.clone()).await.unwrap();
    assert!(
        restored.turns[0]
            .items
            .iter()
            .any(|item| matches!(item, Item::Plan { complete: true, .. }))
    );
    let mut history: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(f.peer.parent().unwrap().join("history.json")).unwrap(),
    )
    .unwrap();
    history[0]["items"][0]["text"] = "# Restored native plan".into();
    std::fs::write(
        f.peer.parent().unwrap().join("history.json"),
        history.to_string(),
    )
    .unwrap();
    app.open_thread(thread.id.clone()).await.unwrap();
    wait(&app, &thread.id, |t| t.turns[0].items.iter().any(|item| matches!(item, Item::Plan { text, complete: true, .. } if text == "# Restored native plan"))).await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn plan_questions_are_distinct_answerable_requests_and_block_steering() {
    for prompt in ["ask-plan", "ask-plan-empty-options"] {
        let f = Fixture::new();
        std::fs::write(f.peer.parent().unwrap().join("collaboration"), "").unwrap();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        app.collaboration_modes().await.unwrap();
        app.update_settings(
            thread.id.clone(),
            SessionSettings {
                interaction_mode: InteractionMode::Plan,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let turn = app
            .submit(thread.id.clone(), prompt.into(), prompt.into(), vec![])
            .await
            .unwrap();
        let pending = wait(&app, &thread.id, |t| !t.user_questions.is_empty()).await;
        assert!(pending.approvals.is_empty());
        assert!(pending.input_open());
        let request = &pending.user_questions[0];
        assert_eq!(request.state, UserQuestionState::Pending);
        assert_eq!(
            request.questions[1].options.as_ref().map(Vec::len),
            (prompt == "ask-plan-empty-options").then_some(0)
        );
        let rows = app
            .list_thread_summaries(thread.workspace_id.clone())
            .await
            .unwrap();
        let summary = rows.iter().find(|row| row.id == thread.id).unwrap();
        assert!(summary.awaiting_approval);
        assert_eq!(summary.pending_user_question_ids, vec![request.id.clone()]);
        assert_eq!(
            app.submit_to(
                thread.id.clone(),
                "question-steer".into(),
                "followup".into(),
                vec![],
                Some(turn.turn_id)
            )
            .await
            .unwrap_err()
            .code,
            "busy"
        );
        assert_eq!(
            app.arrange(
                thread.id.clone(),
                Arrange::Snooze {
                    until_ms: now_ms() + 60_000
                }
            )
            .await
            .unwrap_err()
            .code,
            "snooze_blocked"
        );
        assert_eq!(
            app.answer_user_questions(request.id.clone(), Default::default())
                .await
                .unwrap_err()
                .code,
            "invalid_answers"
        );
        let answers = [
            (
                "scope".into(),
                UserQuestionAnswer {
                    answers: vec!["Composer".into()],
                },
            ),
            (
                "notes".into(),
                UserQuestionAnswer {
                    answers: vec!["Preserve T3 styles".into()],
                },
            ),
        ]
        .into_iter()
        .collect();
        app.answer_user_questions(request.id.clone(), answers)
            .await
            .unwrap();
        let answered = wait(&app, &thread.id, |t| {
            t.user_questions[0].state == UserQuestionState::Answered
                && matches!(t.turns[0].execution, Execution::Completed)
        })
        .await;
        assert!(!answered.input_open());
        let calls = f.calls();
        let response = calls
            .iter()
            .find(|call| call["id"] == "question-route" && call.get("method").is_none())
            .unwrap();
        assert_eq!(
            response["result"]["answers"]["notes"]["answers"],
            serde_json::json!(["Preserve T3 styles"])
        );
        assert_eq!(
            app.answer_user_questions(request.id.clone(), Default::default())
                .await
                .unwrap_err()
                .code,
            "question_expired"
        );
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn pending_plan_questions_expire_after_interrupt_and_restart() {
    for interrupt in [false, true] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        app.submit(
            thread.id.clone(),
            "question-expiry".into(),
            "ask-plan".into(),
            vec![],
        )
        .await
        .unwrap();
        let pending = wait(&app, &thread.id, |t| !t.user_questions.is_empty()).await;
        let request = pending.user_questions[0].id.clone();
        if interrupt {
            app.interrupt(thread.id.clone()).await.unwrap();
            wait(&app, &thread.id, |t| {
                t.user_questions[0].state == UserQuestionState::Expired
            })
            .await;
        }
        app.shutdown().await.unwrap();
        let app = reopen(&f.config).await;
        let restored = app.thread(thread.id).await.unwrap();
        assert_eq!(restored.user_questions[0].state, UserQuestionState::Expired);
        assert_eq!(
            app.answer_user_questions(request, Default::default())
                .await
                .unwrap_err()
                .code,
            "question_expired"
        );
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn implement_plan_in_new_thread_reuses_checkout_settings_and_operation_guards() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let scratch = app.ensure_scratch().await.unwrap();
    app.models().await.unwrap();
    for (workspace_id, checkout) in [
        (workspace.id.clone(), NewCheckout::Local),
        (
            workspace.id.clone(),
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: false,
            },
        ),
        (
            scratch.id.clone(),
            NewCheckout::Folder {
                prompt: "Implement shared scratch plan".into(),
            },
        ),
    ] {
        let source = app
            .create_thread(workspace_id.clone(), checkout)
            .await
            .unwrap();
        let settings = SessionSettings {
            model: Some("model-one".into()),
            effort: Some("ultra".into()),
            permission_mode: PermissionMode::FullAccess,
            ..Default::default()
        };
        app.update_settings(source.id.clone(), settings.clone())
            .await
            .unwrap();
        let target = app
            .create_thread(
                workspace_id.clone(),
                NewCheckout::Existing {
                    thread_id: source.id.clone(),
                },
            )
            .await
            .unwrap();
        assert_ne!(target.id, source.id);
        assert_eq!(target.checkout, source.checkout);
        assert_eq!(target.settings, settings);
        assert!(target.turns.is_empty());
        assert!(target.native_thread_id.is_none());
        let wrong_workspace = if workspace_id == workspace.id {
            scratch.id.clone()
        } else {
            workspace.id.clone()
        };
        assert_eq!(
            app.create_thread(
                wrong_workspace,
                NewCheckout::Existing {
                    thread_id: source.id.clone()
                }
            )
            .await
            .unwrap_err()
            .code,
            "invalid_checkout"
        );
        app.submit(
            source.id.clone(),
            format!("hold-{}", source.id),
            "hold".into(),
            vec![],
        )
        .await
        .unwrap();
        wait(&app, &source.id, |t| {
            matches!(t.session, SessionState::Running)
        })
        .await;
        assert_eq!(
            app.create_thread(
                workspace_id.clone(),
                NewCheckout::Existing {
                    thread_id: source.id.clone()
                }
            )
            .await
            .unwrap_err()
            .code,
            "busy"
        );
        assert_eq!(
            app.submit(
                target.id.clone(),
                format!("shared-{}", target.id),
                "hello".into(),
                vec![]
            )
            .await
            .unwrap_err()
            .code,
            "checkout_busy"
        );
        app.interrupt(source.id.clone()).await.unwrap();
        wait(&app, &source.id, |t| {
            matches!(t.turns[0].execution, Execution::Interrupted)
        })
        .await;
        if let Checkout::Worktree { path, .. } = &source.checkout {
            app.switch_branch(
                workspace_id.clone(),
                Some(target.id.clone()),
                "shared-manual".into(),
                true,
            )
            .await
            .unwrap();
            for id in [&source.id, &target.id] {
                assert!(
                    matches!(app.thread(id.clone()).await.unwrap().checkout, Checkout::Worktree { branch, .. } if branch == "shared-manual")
                );
            }
            std::fs::remove_dir_all(path).unwrap();
            assert_eq!(
                app.create_thread(
                    workspace_id,
                    NewCheckout::Existing {
                        thread_id: source.id
                    }
                )
                .await
                .unwrap_err()
                .code,
                "missing_checkout"
            );
        }
    }
    app.shutdown().await.unwrap();
}

fn legacy_items() -> serde_json::Value {
    serde_json::json!([
        {"kind": "other", "id": "r1", "label": "Reasoning", "text": "Plan the change"},
        {"kind": "assistant", "id": "a1", "text": "Done", "complete": true},
        {"kind": "other", "id": "w1", "label": "webSearch", "text": ""},
        {"kind": "other", "id": "c1", "label": "contextCompaction", "text": ""}
    ])
}
fn typed_legacy_items() -> Vec<Item> {
    vec![
        Item::Reasoning {
            id: "r1".into(),
            text: "Plan the change".into(),
            complete: true,
        },
        Item::Assistant {
            id: "a1".into(),
            text: "Done".into(),
            complete: true,
        },
        Item::ContextCompaction {
            id: "c1".into(),
            complete: true,
        },
    ]
}
#[test]
fn snapshots_saved_with_other_items_load_them_as_typed_items() {
    let mut value = serde_json::to_value(idle_thread(Some(1_000), Some(2_000))).unwrap();
    value["turns"][0]["items"] = legacy_items();
    let restored: ThreadSnapshot = serde_json::from_value(value).unwrap();
    assert_eq!(restored.turns[0].items, typed_legacy_items());
    let saved = serde_json::to_value(&restored).unwrap();
    assert_eq!(
        saved["turns"][0]["items"],
        serde_json::json!([
            {"kind": "reasoning", "id": "r1", "text": "Plan the change", "complete": true},
            {"kind": "assistant", "id": "a1", "text": "Done", "complete": true},
            {"kind": "context_compaction", "id": "c1", "complete": true}
        ])
    );
    assert!(!saved.to_string().contains("\"other\""));
}
#[tokio::test]
async fn stored_threads_with_other_items_reopen_with_typed_items() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "legacy".into(), "hello".into(), vec![])
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.shutdown().await.unwrap();
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    let data: String = db
        .query_row(
            "SELECT data FROM threads WHERE id=?1",
            [thread.id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    let mut stored: serde_json::Value = serde_json::from_str(&data).unwrap();
    stored["turns"][0]["items"] = legacy_items();
    db.execute(
        "UPDATE threads SET data=?2 WHERE id=?1",
        [thread.id.to_string(), stored.to_string()],
    )
    .unwrap();
    drop(db);
    let app = reopen(&f.config).await;
    let restored = app.thread(thread.id.clone()).await.unwrap();
    assert_eq!(restored.turns[0].items, typed_legacy_items());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn resumed_native_history_places_items_the_turn_lacks_at_their_native_positions() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "legacy".into(), "hello".into(), vec![])
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    app.shutdown().await.unwrap();
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    let data: String = db
        .query_row(
            "SELECT data FROM threads WHERE id=?1",
            [thread.id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    let mut stored: serde_json::Value = serde_json::from_str(&data).unwrap();
    let native_turn = stored["turns"][0]["nativeTurnId"].clone();
    let turn_id = stored["turns"][0]["id"].clone();
    stored["turns"][0]["items"] = serde_json::to_value([
        Item::Assistant {
            id: "a".into(),
            text: "Searching".into(),
            complete: true,
        },
        Item::Command {
            id: "c".into(),
            command: "ls".into(),
            output: String::new(),
            status: "completed".into(),
        },
        Item::Assistant {
            id: "b".into(),
            text: "Done".into(),
            complete: true,
        },
    ])
    .unwrap();
    db.execute(
        "UPDATE threads SET data=?2 WHERE id=?1",
        [thread.id.to_string(), stored.to_string()],
    )
    .unwrap();
    drop(db);
    std::fs::write(
        f.peer.parent().unwrap().join("history.json"),
        serde_json::json!([{"id": native_turn, "status": "completed", "items": [
            {"type": "userMessage", "id": "u", "clientId": turn_id},
            {"type": "agentMessage", "id": "a", "text": "Searching"},
            {"type": "webSearch", "id": "w", "query": "latest Rust release"},
            {"type": "commandExecution", "id": "c", "command": "ls", "status": "completed"},
            {"type": "mcpToolCall", "id": "m", "server": "node_repl", "tool": "js", "status": "completed"},
            {"type": "agentMessage", "id": "b", "text": "Done"}
        ]}])
        .to_string(),
    )
    .unwrap();
    let app = reopen(&f.config).await;
    app.open_thread(thread.id.clone()).await.unwrap();
    let resumed = wait(&app, &thread.id, |t| t.turns[0].items.len() == 5).await;
    assert_eq!(
        resumed.turns[0]
            .items
            .iter()
            .map(Item::id)
            .collect::<Vec<_>>(),
        ["a", "w", "c", "m", "b"]
    );
    app.shutdown().await.unwrap();
}
fn work_items(turn: &Turn) -> Vec<Item> {
    turn.items
        .iter()
        .filter(|item| !matches!(item, Item::UserInput { .. }))
        .cloned()
        .collect()
}
#[tokio::test]
async fn native_codex_items_stream_into_typed_timeline_items() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(
        thread.id.clone(),
        "native".into(),
        "native-items".into(),
        vec![],
    )
    .await
    .unwrap();
    let streaming = wait(&app, &thread.id, |t| {
        t.turns[0].items.iter().any(
            |item| matches!(item, Item::Reasoning { text, .. } if text.ends_with("Then add 333.")),
        )
    })
    .await;
    assert_eq!(
        work_items(&streaming.turns[0]),
        vec![
            Item::WebSearch {
                id: "exec-af1cec6b-7b06-458e-8d44-f38131318601".into(),
                query: "latest Rust release site:blog.rust-lang.org".into(),
                status: ToolStatus::Completed,
            },
            Item::McpToolCall {
                id: "exec-0e668882-3b63-455d-8185-6ddafa10e7cd".into(),
                server: "node_repl".into(),
                tool: "js".into(),
                title: "Evaluate 6 × 7".into(),
                status: ToolStatus::InProgress,
                arguments: serde_json::json!({"code": "nodeRepl.write(6*7)", "title": "Evaluate 6 × 7"}),
                result: None,
                error: None,
                duration_ms: None,
            },
            Item::Reasoning {
                id: "rs_0612991cf91e8829016ac65f87221c87d2beaa39e7ea874690".into(),
                text: "**Calculating a math expression**\n\nI need to compute floor(999/3).\n\nThen add 333."
                    .into(),
                complete: false,
            },
        ]
    );
    std::fs::write(f.peer.parent().unwrap().join("native_items_release"), "").unwrap();
    let finished = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert_eq!(
        serde_json::to_value(work_items(&finished.turns[0])).unwrap(),
        serde_json::json!([
            {"kind": "web_search", "id": "exec-af1cec6b-7b06-458e-8d44-f38131318601",
             "query": "latest Rust release site:blog.rust-lang.org", "status": "completed"},
            {"kind": "mcp_tool_call", "id": "exec-0e668882-3b63-455d-8185-6ddafa10e7cd",
             "server": "node_repl", "tool": "js", "title": "Evaluate 6 × 7", "status": "completed",
             "arguments": {"code": "nodeRepl.write(6*7)", "title": "Evaluate 6 × 7"},
             "result": "42", "error": null, "durationMs": 56},
            {"kind": "reasoning", "id": "rs_0612991cf91e8829016ac65f87221c87d2beaa39e7ea874690",
             "text": "**Calculating a math expression**\n\nI need to compute floor(999/3).\n\nThen add 333.",
             "complete": true},
            {"kind": "reasoning", "id": "rs_0054cc89d9ce4db0016ac65f68c6848191881bf3f88b094734",
             "text": "Raw thought", "complete": true},
            {"kind": "context_compaction", "id": "01a116e4-b2c0-7723-a84a-19dc76d47a0e", "complete": true},
            {"kind": "dynamic_tool_call", "id": "dynamic-1", "tool": "lookup", "status": "failed"},
            {"kind": "collab_agent_tool_call", "id": "collab-1", "tool": "spawnAgent",
             "prompt": "Review the diff", "status": "failed"},
            {"kind": "sub_agent_activity", "id": "sub-1", "activity": "started",
             "agentPath": "/root/reviewer", "agentThreadId": "child-thread"},
            {"kind": "image_view", "id": "view-1", "path": "/fixture/screen.png"},
            {"kind": "image_generation", "id": "gen-1", "status": "completed"},
            {"kind": "sleep", "id": "sleep-1", "durationMs": 1500},
            {"kind": "review_mode", "id": "review-1", "entered": true, "review": "current changes"},
            {"kind": "hook_prompt", "id": "hook-1", "text": "Run the linter.\nThen the tests."},
            {"kind": "function_call_output", "id": "output-1", "name": "shell"},
            {"kind": "mcp_tool_call", "id": "computer-1", "server": "computer-use", "tool": "click",
             "title": "Clicked in Safari", "status": "completed", "arguments": {"app": "  Safari "},
             "result": "clicked\ndone", "error": null, "durationMs": 9},
            {"kind": "mcp_tool_call", "id": "github-1", "server": "github", "tool": "search_issues",
             "title": "github · search_issues", "status": "failed", "arguments": {},
             "result": null, "error": "rate limited", "durationMs": null}
        ])
    );
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    let restored = app.thread(thread.id.clone()).await.unwrap();
    assert_eq!(
        work_items(&restored.turns[0]),
        work_items(&finished.turns[0])
    );
    app.shutdown().await.unwrap();
}

async fn setup_thread(f: &Fixture, app: &App, script: serde_json::Value) -> ThreadSnapshot {
    std::fs::write(
        f.repository.join("t3.json"),
        serde_json::json!({"scripts":[script]}).to_string(),
    )
    .unwrap();
    let w = app.open_workspace(f.repository.clone()).await.unwrap();
    app.create_thread(
        w.id,
        NewCheckout::Worktree {
            base: "main".into(),
            from_origin: false,
        },
    )
    .await
    .unwrap()
}
#[tokio::test]
async fn project_setup_runs_after_submodule_failure_without_replaying_success() {
    let f = Fixture::new();
    f.commit();
    std::fs::write(
        f.repository.join(".gitmodules"),
        "[submodule \"missing\"]\npath = dependencies/missing\nurl = /missing-bot-code-submodule.git\n",
    )
    .unwrap();
    let commit = git_output(&f.repository, &["rev-parse", "HEAD"]);
    git_output(&f.repository, &["add", ".gitmodules"]);
    git_output(
        &f.repository,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{commit},dependencies/missing"),
        ],
    );
    git_output(
        &f.repository,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "Add unavailable submodule",
        ],
    );
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = setup_thread(
        &f,
        &app,
        serde_json::json!({
            "name": "Install",
            "command": "echo once >> dependency-marker",
            "runOnWorktreeCreate": true,
            "async": false
        }),
    )
    .await;
    let done = wait(&app, &thread.id, |t| {
        matches!(
            t.worktree_setup.as_ref().unwrap().state,
            SetupState::Succeeded
        )
    })
    .await;
    assert!(
        done.worktree_setup
            .as_ref()
            .unwrap()
            .output
            .iter()
            .any(|line| { line.contains("Submodule checkout failed with code") })
    );
    app.retry_worktree_setup(thread.id.clone()).await.unwrap();
    let Checkout::Worktree { path, .. } = &done.checkout else {
        panic!("expected worktree")
    };
    assert_eq!(
        std::fs::read_to_string(path.join("dependency-marker")).unwrap(),
        "once\n"
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn project_setup_waits_before_checkpoint_then_releases_failed_turn() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = setup_thread(
        &f,
        &app,
        serde_json::json!({
            "name": "Install",
            "command": format!("{}; echo prepared > dependency; echo setup-output; exit 7", polling::wait_for_file("\"$T3CODE_PROJECT_ROOT/release\"")),
            "runOnWorktreeCreate": true,
            "async": false
        }),
    )
    .await;
    app.submit(
        thread.id.clone(),
        "setup-turn".into(),
        "hello".into(),
        vec![],
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    let held = app.thread(thread.id.clone()).await.unwrap();
    assert!(matches!(held.turns[0].checkpoint, TurnCheckpoint::Pending));
    assert!(!f.calls().iter().any(|call| call["method"] == "turn/start"));
    assert!(app.delete_thread(thread.id.clone()).await.is_err());
    assert!(
        app.remove_workspace(thread.workspace_id.clone())
            .await
            .is_err()
    );
    std::fs::write(f.repository.join("release"), "").unwrap();
    let done = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert!(matches!(
        done.worktree_setup.unwrap().state,
        SetupState::Failed {
            exit_code: Some(7),
            ..
        }
    ));
    assert_eq!(
        f.calls()
            .iter()
            .filter(|call| call["method"] == "turn/start")
            .count(),
        1
    );
    let diff = app
        .read_turn_diff(
            thread.id.clone(),
            done.turns[0].id.clone(),
            "dependency".into(),
        )
        .await;
    assert_eq!(diff.unwrap_err().code, "invalid_path");
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn project_setup_receipt_survives_restart_and_completed_retry_is_noop() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = setup_thread(
        &f,
        &app,
        serde_json::json!({
            "name": "Install",
            "command": format!("echo once >> \"$T3CODE_PROJECT_ROOT/count\"; {}; echo done", polling::wait_for_file("\"$T3CODE_PROJECT_ROOT/release\"")),
            "runOnWorktreeCreate": true
        }),
    )
    .await;
    let running = app
        .retry_worktree_setup(thread.id.clone())
        .await
        .unwrap()
        .worktree_setup
        .unwrap();
    assert!(matches!(running.state, SetupState::Running));
    app.shutdown().await.unwrap();
    std::fs::write(f.repository.join("release"), "").unwrap();
    let receipt = f
        .config
        .data_dir
        .join("worktree-setup")
        .join(&running.id)
        .join("receipt");
    assert!(eventually(|| receipt.exists()).await);
    let app = reopen(&f.config).await;
    wait(&app, &thread.id, |t| {
        matches!(
            t.worktree_setup.as_ref().unwrap().state,
            SetupState::Succeeded
        )
    })
    .await;
    app.retry_worktree_setup(thread.id.clone()).await.unwrap();
    let shared = app
        .create_thread(
            thread.workspace_id.clone(),
            NewCheckout::Existing {
                thread_id: thread.id.clone(),
            },
        )
        .await
        .unwrap();
    assert!(shared.worktree_setup.is_none());
    assert_eq!(
        std::fs::read_to_string(f.repository.join("count")).unwrap(),
        "once\n"
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn project_config_accepts_jsonc_and_rejects_invalid_fields() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let w = app.open_workspace(f.repository.clone()).await.unwrap();
    std::fs::write(
        f.repository.join("t3.json"),
        r#"{/* config */ "scripts":[{"name":" Run Tests ","command":" echo '//ok' ",},{"name":"Run Tests","command":"true"},],"worktreeSubmodules":"none",}"#,
    )
    .unwrap();
    let config = app.project_config(w.id.clone()).await.unwrap();
    assert_eq!(config.scripts[0].id, "run-tests");
    assert_eq!(config.scripts[1].id, "run-tests-2");
    assert_eq!(config.scripts[0].command, "echo '//ok'");
    assert!(config.scripts[0].r#async);
    for invalid in [
        r#"{"scripts":[{"name":" ","command":"true"}]}"#,
        r#"{"scripts":[{"name":"x","command":"true","async":null}]}"#,
        r#"{"worktreeSubmodules":"shallow"}"#,
    ] {
        std::fs::write(f.repository.join("t3.json"), invalid).unwrap();
        assert_eq!(
            app.project_config(w.id.clone()).await.unwrap_err().code,
            "project_config"
        );
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn project_setup_failure_retries_and_manual_script_starts_unopened_terminal() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = setup_thread(
        &f,
        &app,
        serde_json::json!({
            "name": "Install",
            "command": "echo attempt >> \"$T3CODE_PROJECT_ROOT/count\"; test -f \"$T3CODE_PROJECT_ROOT/release\"",
            "runOnWorktreeCreate": true
        }),
    )
    .await;
    wait(&app, &thread.id, |t| {
        matches!(
            t.worktree_setup.as_ref().unwrap().state,
            SetupState::Failed { .. }
        )
    })
    .await;
    std::fs::write(f.repository.join("release"), "").unwrap();
    app.retry_worktree_setup(thread.id.clone()).await.unwrap();
    wait(&app, &thread.id, |t| {
        matches!(
            t.worktree_setup.as_ref().unwrap().state,
            SetupState::Succeeded
        )
    })
    .await;
    assert_eq!(
        std::fs::read_to_string(f.repository.join("count")).unwrap(),
        "attempt\nattempt\n"
    );
    std::fs::write(
        f.repository.join("t3.json"),
        serde_json::json!({
            "scripts": [{
                "name": "Manual",
                "command": "printf '%s\\n%s\\n' \"$T3CODE_PROJECT_ROOT\" \"$T3CODE_WORKTREE_PATH\" > manual"
            }]
        })
        .to_string(),
    )
    .unwrap();
    app.run_project_script(
        thread.workspace_id.clone(),
        Some(thread.id.clone()),
        "manual".into(),
        "script-tab".parse().unwrap(),
    )
    .await
    .unwrap();
    let Checkout::Worktree { path, .. } = &thread.checkout else {
        panic!()
    };
    let expected = format!(
        "{}\n{}\n",
        f.repository.canonicalize().unwrap().display(),
        path.display()
    );
    eventually(|| std::fs::read_to_string(path.join("manual")).is_ok_and(|s| s == expected)).await;
    assert_eq!(
        std::fs::read_to_string(path.join("manual")).unwrap(),
        expected
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn project_setup_async_default_and_live_restart_do_not_duplicate_process() {
    let f = Fixture::new();
    f.commit();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread=setup_thread(&f,&app,serde_json::json!({"name":"Install","command":format!("echo once >> \"$T3CODE_PROJECT_ROOT/count\"; {}", polling::wait_for_file("\"$T3CODE_PROJECT_ROOT/release\"")),"runOnWorktreeCreate":true})).await;
    app.submit(
        thread.id.clone(),
        "async-turn".into(),
        "hello".into(),
        vec![],
    )
    .await
    .unwrap();
    let done = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert!(matches!(
        done.worktree_setup.unwrap().state,
        SetupState::Running
    ));
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    tokio::time::sleep(Duration::from_millis(2200)).await;
    assert!(matches!(
        app.retry_worktree_setup(thread.id.clone())
            .await
            .unwrap()
            .worktree_setup
            .unwrap()
            .state,
        SetupState::Running
    ));
    assert_eq!(
        std::fs::read_to_string(f.repository.join("count")).unwrap(),
        "once\n"
    );
    std::fs::write(f.repository.join("release"), "").unwrap();
    wait(&app, &thread.id, |t| {
        matches!(
            t.worktree_setup.as_ref().unwrap().state,
            SetupState::Succeeded
        )
    })
    .await;
    app.shutdown().await.unwrap();
}

const KILLED: &str =
    "Codex stopped unexpectedly (killed by signal 9). Your next message restarts it.";
fn peer_file(f: &Fixture, name: &str) -> std::path::PathBuf {
    f.peer.parent().unwrap().join(name)
}
fn peer_pid(f: &Fixture, name: &str) -> i32 {
    std::fs::read_to_string(peer_file(f, name))
        .unwrap()
        .parse()
        .unwrap()
}
fn lost_reason(turn: &Turn) -> &str {
    match &turn.execution {
        Execution::Lost { reason } => reason,
        other => panic!("expected a lost turn, got {other:?}"),
    }
}
fn not_sent_reason(turn: &Turn) -> &str {
    match &turn.delivery {
        Delivery::NotSent { reason } => reason,
        other => panic!("expected an unsent turn, got {other:?}"),
    }
}
async fn wait_until_dead(pid: i32) -> bool {
    eventually(|| unsafe { libc::kill(pid, 0) } != 0).await
}

#[tokio::test]
async fn crash_mid_turn_reports_stderr_and_resumes_the_native_thread_without_replay() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let idle = conversation(&app, &f).await;
    app.submit(idle.id.clone(), "idle".into(), "hello".into(), vec![])
        .await
        .unwrap();
    wait(&app, &idle.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "crash".into(), "crash".into(), vec![])
        .await
        .unwrap();
    let lost = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Lost { .. })
    })
    .await;
    let reason = lost_reason(&lost.turns[0]);
    assert!(
        reason.starts_with(&format!("{KILLED}\n\nCodex stderr:\n")),
        "{reason}"
    );
    assert!(
        reason.contains("fixture stderr: panic in turn native-"),
        "{reason}"
    );
    assert_eq!(lost.diagnostic.as_deref(), Some(KILLED));
    assert_eq!(
        lost.session,
        SessionState::Unavailable {
            reason: KILLED.into()
        }
    );
    let idle = app.thread(idle.id.clone()).await.unwrap();
    assert_eq!(
        idle.session,
        SessionState::Unavailable {
            reason: KILLED.into()
        }
    );
    assert_eq!(idle.diagnostic, None, "an idle thread lost no work");
    let log = std::fs::read_to_string(f.config.data_dir.join("logs").join("codex.log")).unwrap();
    assert!(
        log.contains("fixture stderr: panic in turn native-"),
        "{log}"
    );
    assert!(log.contains("fixture stderr: started"), "{log}");
    assert!(log.contains("exited: signal: 9"), "{log}");

    let native = lost.native_thread_id.clone().unwrap();
    std::fs::write(
        peer_file(&f, "history.json"),
        serde_json::json!([{"id": lost.turns[0].native_turn_id, "status": "interrupted", "items": []}])
            .to_string(),
    )
    .unwrap();
    app.submit(thread.id.clone(), "after".into(), "hello".into(), vec![])
        .await
        .unwrap();
    let done = wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Completed)
    })
    .await;
    assert_eq!(done.native_thread_id.as_deref(), Some(native.as_str()));
    assert_eq!(
        lost_reason(&done.turns[0]),
        reason,
        "native history reports the crashed turn as interrupted"
    );
    assert_eq!(done.diagnostic, None);
    let calls = f.calls();
    let relaunch = calls
        .iter()
        .enumerate()
        .filter(|(_, call)| call["method"] == "initialize")
        .nth(1)
        .unwrap()
        .0;
    assert!(
        calls[relaunch..]
            .iter()
            .any(|call| call["method"] == "thread/resume" && call["params"]["threadId"] == native)
    );
    assert_eq!(method_count(&f, "turn/start"), 3);
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "turn/start" && call["params"]["threadId"] == native)
            .count(),
        2,
        "the crashed prompt is never replayed"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn crash_expires_pending_approvals_and_user_questions() {
    for prompt in [
        "approval",
        "ask-plan",
        "approval-kind-permission-network",
        "approval-kind-mcp-null-turn",
        "approval-kind-legacy-command",
        "approval-kind-legacy-file",
    ] {
        let f = Fixture::new();
        std::fs::write(peer_file(&f, "collaboration"), "").unwrap();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        if prompt == "ask-plan" {
            app.collaboration_modes().await.unwrap();
            app.update_settings(
                thread.id.clone(),
                SessionSettings {
                    interaction_mode: InteractionMode::Plan,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        app.submit(thread.id.clone(), prompt.into(), prompt.into(), vec![])
            .await
            .unwrap();
        let pending = wait(&app, &thread.id, |t| {
            !t.approvals.is_empty() || !t.user_questions.is_empty()
        })
        .await;
        assert!(pending.input_open());
        unsafe { libc::kill(peer_pid(&f, "pid"), libc::SIGKILL) };
        let lost = wait(&app, &thread.id, |t| {
            matches!(t.turns[0].execution, Execution::Lost { .. })
        })
        .await;
        assert!(lost_reason(&lost.turns[0]).starts_with(KILLED), "{prompt}");
        assert_eq!(lost.diagnostic.as_deref(), Some(KILLED));
        assert!(!lost.input_open());
        for approval in &pending.approvals {
            assert_eq!(
                lost.approvals
                    .iter()
                    .find(|a| a.id == approval.id)
                    .unwrap()
                    .state,
                ApprovalState::Expired
            );
            for decision in [ApprovalDecision::Accept, ApprovalDecision::AcceptForSession] {
                assert_eq!(
                    app.answer_approval(approval.id.clone(), decision)
                        .await
                        .unwrap_err()
                        .code,
                    "approval_expired"
                );
            }
        }
        for request in &pending.user_questions {
            assert_eq!(lost.user_questions[0].id, request.id);
            assert_eq!(lost.user_questions[0].state, UserQuestionState::Expired);
            assert_eq!(
                app.answer_user_questions(request.id.clone(), Default::default())
                    .await
                    .unwrap_err()
                    .code,
                "question_expired"
            );
        }
        app.submit(thread.id.clone(), "after".into(), "hello".into(), vec![])
            .await
            .unwrap();
        wait(&app, &thread.id, |t| {
            t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Completed)
        })
        .await;
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn leader_exit_is_detected_while_a_descendant_holds_stdout() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(
        thread.id.clone(),
        "descendant".into(),
        "descendant".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    eventually(|| peer_file(&f, "descendant.pid").exists()).await;
    let descendant = peer_pid(&f, "descendant.pid");
    let killed = std::time::Instant::now();
    unsafe { libc::kill(peer_pid(&f, "pid"), libc::SIGKILL) };
    let lost = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Lost { .. })
    })
    .await;
    assert!(killed.elapsed() < Duration::from_secs(10));
    assert!(lost_reason(&lost.turns[0]).starts_with(KILLED));
    assert!(
        wait_until_dead(descendant).await,
        "The same-group tool must not outlive its leader's loss"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn repeated_crashes_back_off_and_never_rewrite_settled_turns() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(thread.id.clone(), "crash".into(), "crash".into(), vec![])
        .await
        .unwrap();
    let crashed = wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Lost { .. })
    })
    .await;
    let first = serde_json::to_value(&crashed.turns[0]).unwrap();
    std::fs::write(peer_file(&f, "crash_on_launch"), "2").unwrap();

    app.submit(thread.id.clone(), "retry-1".into(), "hello".into(), vec![])
        .await
        .unwrap();
    let failed = wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].delivery, Delivery::NotSent { .. })
    })
    .await;
    let reason = not_sent_reason(&failed.turns[1]);
    assert!(
        reason.starts_with(
            "Codex stopped unexpectedly (exit code 3). Your next message restarts it.\n\nCodex stderr:\n"
        ),
        "{reason}"
    );
    assert!(
        reason.contains("fixture stderr: refusing to start (2 left)"),
        "{reason}"
    );

    app.submit(thread.id.clone(), "retry-2".into(), "hello".into(), vec![])
        .await
        .unwrap();
    let failed = wait(&app, &thread.id, |t| {
        t.turns.len() == 3 && matches!(t.turns[2].delivery, Delivery::NotSent { .. })
    })
    .await;
    assert!(
        not_sent_reason(&failed.turns[2]).contains("fixture stderr: refusing to start (1 left)")
    );

    app.submit(thread.id.clone(), "retry-3".into(), "hello".into(), vec![])
        .await
        .unwrap();
    let done = wait(&app, &thread.id, |t| {
        t.turns.len() == 4 && matches!(t.turns[3].execution, Execution::Completed)
    })
    .await;

    let launches: Vec<f64> = std::fs::read_to_string(peer_file(&f, "launches.jsonl"))
        .unwrap()
        .lines()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["time"]
                .as_f64()
                .unwrap()
        })
        .collect();
    assert_eq!(launches.len(), 4);
    assert!(launches[2] - launches[1] >= 0.9, "{launches:?}");
    assert!(launches[3] - launches[2] >= 1.9, "{launches:?}");

    assert_eq!(serde_json::to_value(&done.turns[0]).unwrap(), first);
    for turn in &done.turns[1..3] {
        assert!(matches!(turn.delivery, Delivery::NotSent { .. }));
        assert!(matches!(turn.execution, Execution::Lost { .. }));
    }
    let started: Vec<_> = f
        .calls()
        .into_iter()
        .filter(|call| call["method"] == "turn/start")
        .map(|call| {
            call["params"]["clientUserMessageId"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(
        started,
        [done.turns[0].id.to_string(), done.turns[3].id.to_string()]
    );
    assert_eq!(done.session, SessionState::Ready);
    assert!(!done.input_open());
    app.shutdown().await.unwrap();
}

// Each pending reply races the exit signal, so a few rounds make a lost race visible.
#[tokio::test]
async fn crash_before_turn_start_ack_reports_the_crash() {
    for _ in 0..4 {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        app.submit(
            thread.id.clone(),
            "unacknowledged".into(),
            "crash-before-ack".into(),
            vec![],
        )
        .await
        .unwrap();
        let lost = wait(&app, &thread.id, |t| !t.turns[0].execution.active()).await;
        let reason = lost_reason(&lost.turns[0]);
        assert!(reason.starts_with(KILLED), "{reason}");
        assert!(
            reason.contains("fixture stderr: panic before ack"),
            "{reason}"
        );
        assert!(matches!(
            &lost.turns[0].delivery,
            Delivery::Uncertain { reason } if reason.starts_with(KILLED)
        ));
        assert_eq!(lost.diagnostic.as_deref(), Some(KILLED));
        assert_eq!(method_count(&f, "turn/start"), 1);
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn crash_while_steering_is_sending_reports_the_crash() {
    for _ in 0..4 {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        let original = app
            .submit(thread.id.clone(), "original".into(), "hold".into(), vec![])
            .await
            .unwrap();
        wait(&app, &thread.id, |t| {
            matches!(t.session, SessionState::Running)
        })
        .await;
        app.submit_to(
            thread.id.clone(),
            "follow".into(),
            "no-response-steer".into(),
            vec![],
            Some(original.turn_id.clone()),
        )
        .await
        .unwrap();
        wait(&app, &thread.id, |t| {
            matches!(steering_delivery(t, "follow"), Some(Delivery::Sending))
        })
        .await;
        eventually(|| method_count(&f, "turn/steer") == 1).await;
        unsafe { libc::kill(peer_pid(&f, "pid"), libc::SIGKILL) };
        let lost = wait(&app, &thread.id, |t| {
            matches!(t.turns[0].execution, Execution::Lost { .. })
        })
        .await;
        assert!(
            lost_reason(&lost.turns[0]).starts_with(KILLED),
            "{}",
            lost_reason(&lost.turns[0])
        );
        assert_eq!(lost.diagnostic.as_deref(), Some(KILLED));
        assert!(matches!(
            steering_delivery(&lost, "follow"),
            Some(Delivery::Uncertain { .. })
        ));
        assert_eq!(method_count(&f, "turn/steer"), 1);
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn steer_written_to_a_killed_codex_reports_the_crash() {
    for _ in 0..4 {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        let original = app
            .submit(thread.id.clone(), "original".into(), "hold".into(), vec![])
            .await
            .unwrap();
        wait(&app, &thread.id, |t| {
            matches!(t.session, SessionState::Running)
        })
        .await;
        unsafe { libc::kill(peer_pid(&f, "pid"), libc::SIGKILL) };
        // The owner may already have handled the exit and refused the steer.
        let _ = app
            .submit_to(
                thread.id.clone(),
                "follow".into(),
                "late".into(),
                vec![],
                Some(original.turn_id.clone()),
            )
            .await;
        let lost = wait(&app, &thread.id, |t| {
            matches!(t.turns[0].execution, Execution::Lost { .. })
        })
        .await;
        assert!(
            lost_reason(&lost.turns[0]).starts_with(KILLED),
            "{}",
            lost_reason(&lost.turns[0])
        );
        assert_eq!(lost.diagnostic.as_deref(), Some(KILLED));
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn approval_protocol_replies_match_each_typed_request_kind() {
    use serde_json::json;
    let cases = [
        (
            "reason-only",
            ApprovalDecision::Accept,
            ApprovalKind::Command,
        ),
        (
            "managed-network",
            ApprovalDecision::Accept,
            ApprovalKind::Command,
        ),
        (
            "file-change",
            ApprovalDecision::Accept,
            ApprovalKind::FileChange,
        ),
        (
            "permission-network",
            ApprovalDecision::Accept,
            ApprovalKind::Permission,
        ),
        (
            "permission-filesystem",
            ApprovalDecision::Accept,
            ApprovalKind::Permission,
        ),
        (
            "permission-extensions",
            ApprovalDecision::Accept,
            ApprovalKind::Permission,
        ),
        (
            "mcp-null-turn",
            ApprovalDecision::Accept,
            ApprovalKind::McpElicitation,
        ),
        (
            "mcp-session",
            ApprovalDecision::AcceptForSession,
            ApprovalKind::McpElicitation,
        ),
        (
            "mcp-always",
            ApprovalDecision::AcceptAlways,
            ApprovalKind::McpElicitation,
        ),
        (
            "mcp-optional",
            ApprovalDecision::Accept,
            ApprovalKind::McpElicitation,
        ),
        (
            "mcp-camel-form",
            ApprovalDecision::Accept,
            ApprovalKind::McpElicitation,
        ),
        (
            "legacy-command",
            ApprovalDecision::Accept,
            ApprovalKind::Command,
        ),
        (
            "legacy-file",
            ApprovalDecision::Accept,
            ApprovalKind::FileChange,
        ),
        (
            "legacy-file-root",
            ApprovalDecision::Accept,
            ApprovalKind::FileChange,
        ),
        (
            "legacy-file-reason",
            ApprovalDecision::Accept,
            ApprovalKind::FileChange,
        ),
    ];
    for (scenario, decision, kind) in cases {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        app.submit(
            thread.id.clone(),
            scenario.into(),
            format!("approval-kind-{scenario}"),
            vec![],
        )
        .await
        .unwrap();
        let pending = wait(&app, &thread.id, |thread| thread.approvals.len() == 1).await;
        let approval = &pending.approvals[0];
        let actual_kind = match &approval.action {
            ApprovalAction::Command { command, .. } => {
                if scenario == "managed-network" {
                    assert!(command.contains("registry.npmjs.org"));
                }
                ApprovalKind::Command
            }
            ApprovalAction::FileChange { text, .. } => {
                assert!(text.contains(match scenario {
                    "legacy-file-root" => "/fixture/external",
                    "legacy-file-reason" => "Legacy patch needs external access",
                    _ => "+new",
                }));
                ApprovalKind::FileChange
            }
            ApprovalAction::Permission { detail, .. } => {
                assert!(detail.contains(if scenario == "permission-network" {
                    "enabled"
                } else {
                    "fileSystem"
                }));
                ApprovalKind::Permission
            }
            ApprovalAction::McpElicitation { app_name, .. } => {
                assert_eq!(app_name, "Fixture App");
                assert_eq!(
                    serde_json::to_value(&approval.action).unwrap()["appName"],
                    json!("Fixture App")
                );
                ApprovalKind::McpElicitation
            }
        };
        assert_eq!(actual_kind, kind, "{scenario}");
        assert!(
            approval
                .options
                .iter()
                .any(|option| option.decision == decision),
            "{scenario}"
        );
        if decision != ApprovalDecision::AcceptAlways {
            assert_eq!(
                app.answer_approval(approval.id.clone(), ApprovalDecision::AcceptAlways)
                    .await
                    .unwrap_err()
                    .code,
                "approval_choice"
            );
        }
        app.answer_approval(approval.id.clone(), decision)
            .await
            .unwrap();
        let completed = wait(&app, &thread.id, |thread| {
            matches!(
                thread.turns[0].execution,
                Execution::Completed | Execution::Failed { .. }
            )
        })
        .await;
        assert!(
            matches!(completed.turns[0].execution, Execution::Completed),
            "{scenario}: {:?}",
            std::fs::read_to_string(peer_file(&f, "approval_mismatch.json"))
        );
        assert_eq!(completed.approvals[0].state, ApprovalState::Answered);
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn approval_denials_and_session_grants_use_each_protocols_response_shape() {
    use serde_json::json;
    for (scenario, decision, expected) in [
        (
            "file-change",
            ApprovalDecision::AcceptForSession,
            json!({"decision":"acceptForSession"}),
        ),
        (
            "permission-network",
            ApprovalDecision::AcceptForSession,
            json!({"permissions":{"network":{"enabled":true},"fileSystem":null},"scope":"session"}),
        ),
        (
            "permission-filesystem",
            ApprovalDecision::Decline,
            json!({"permissions":{},"scope":"turn"}),
        ),
        (
            "permission-network",
            ApprovalDecision::Cancel,
            json!({"permissions":{},"scope":"turn"}),
        ),
        (
            "mcp-null-turn",
            ApprovalDecision::Decline,
            json!({"action":"decline"}),
        ),
        (
            "mcp-null-turn",
            ApprovalDecision::Cancel,
            json!({"action":"cancel"}),
        ),
        (
            "legacy-command",
            ApprovalDecision::AcceptForSession,
            json!({"decision":"approved_for_session"}),
        ),
        (
            "legacy-file",
            ApprovalDecision::Decline,
            json!({"decision":{"denied":{"rejection":"Declined by the user."}}}),
        ),
        (
            "legacy-command",
            ApprovalDecision::Cancel,
            json!({"decision":"abort"}),
        ),
    ] {
        let f = Fixture::new();
        std::fs::write(
            peer_file(&f, "approval_expected.json"),
            expected.to_string(),
        )
        .unwrap();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        app.submit(
            thread.id.clone(),
            scenario.into(),
            format!("approval-kind-{scenario}"),
            vec![],
        )
        .await
        .unwrap();
        let pending = wait(&app, &thread.id, |thread| thread.approvals.len() == 1).await;
        app.answer_approval(pending.approvals[0].id.clone(), decision)
            .await
            .unwrap();
        let completed = wait(&app, &thread.id, |thread| {
            matches!(
                thread.turns[0].execution,
                Execution::Completed | Execution::Failed { .. }
            )
        })
        .await;
        assert!(
            matches!(completed.turns[0].execution, Execution::Completed),
            "{scenario}: {decision:?} {:?}",
            std::fs::read_to_string(peer_file(&f, "approval_mismatch.json"))
        );
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn unsupported_elicitations_and_refused_methods_finish_without_pending_callbacks() {
    for scenario in [
        "mcp-required",
        "mcp-malformed",
        "mcp-null-schema",
        "mcp-url",
        "token-refresh",
        "tool-call",
        "stale-turn",
        "malformed",
    ] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        app.submit(
            thread.id.clone(),
            scenario.into(),
            format!("approval-kind-{scenario}"),
            vec![],
        )
        .await
        .unwrap();
        let completed = wait(&app, &thread.id, |thread| {
            matches!(
                thread.turns[0].execution,
                Execution::Completed | Execution::Failed { .. }
            )
        })
        .await;
        assert!(
            matches!(completed.turns[0].execution, Execution::Completed),
            "{scenario}: {:?}",
            std::fs::read_to_string(peer_file(&f, "approval_mismatch.json"))
        );
        assert!(completed.approvals.is_empty(), "{scenario}");
        assert!(!completed.input_open(), "{scenario}");
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn session_approval_skips_identical_requests_but_changed_commands_still_prompt() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(
        thread.id.clone(),
        "first".into(),
        "approval-kind-command-session".into(),
        vec![],
    )
    .await
    .unwrap();
    let pending = wait(&app, &thread.id, |thread| thread.approvals.len() == 1).await;
    app.answer_approval(
        pending.approvals[0].id.clone(),
        ApprovalDecision::AcceptForSession,
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |thread| {
        matches!(thread.turns[0].execution, Execution::Completed)
    })
    .await;
    app.submit(
        thread.id.clone(),
        "identical".into(),
        "approval-kind-command-session".into(),
        vec![],
    )
    .await
    .unwrap();
    let identical = wait(&app, &thread.id, |thread| {
        thread.turns.len() == 2 && matches!(thread.turns[1].execution, Execution::Completed)
    })
    .await;
    assert_eq!(identical.approvals.len(), 1);
    app.submit(
        thread.id.clone(),
        "changed".into(),
        "approval-kind-command-changed".into(),
        vec![],
    )
    .await
    .unwrap();
    let changed = wait(&app, &thread.id, |thread| thread.approvals.len() == 2).await;
    assert_eq!(changed.approvals[1].state, ApprovalState::Pending);
    app.answer_approval(changed.approvals[1].id.clone(), ApprovalDecision::Accept)
        .await
        .unwrap();
    wait(&app, &thread.id, |thread| {
        matches!(thread.turns[2].execution, Execution::Completed)
    })
    .await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn provider_capabilities_advertise_semantic_modes_and_supported_approval_kinds() {
    let f = Fixture::new();
    let app = App::open(f.config).await.unwrap();
    let capabilities = app.provider_capabilities();
    assert_eq!(capabilities.provider, "codex");
    assert_eq!(
        capabilities.default_permission_mode,
        PermissionMode::FullAccess
    );
    assert_eq!(
        SessionSettings::default().permission_mode,
        PermissionMode::ApprovalRequired
    );
    assert_eq!(
        capabilities
            .permission_modes
            .iter()
            .map(|mode| mode.label.as_str())
            .collect::<Vec<_>>(),
        vec!["Supervised", "Auto-accept edits", "Auto", "Full access"]
    );
    assert_eq!(
        capabilities.supported_approval_kinds,
        vec![
            ApprovalKind::Command,
            ApprovalKind::FileChange,
            ApprovalKind::Permission,
            ApprovalKind::McpElicitation
        ]
    );
    assert_eq!(
        serde_json::to_value(capabilities).unwrap()["defaultPermissionMode"],
        "full-access"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn file_root_escalation_is_reviewable_and_later_patch_replaces_context() {
    for scenario in ["file-root", "file-root-late", "file-no-details"] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        app.submit(
            thread.id.clone(),
            scenario.into(),
            format!("approval-kind-{scenario}"),
            vec![],
        )
        .await
        .unwrap();
        let pending = wait(&app, &thread.id, |thread| thread.approvals.len() == 1).await;
        let ApprovalAction::FileChange { text, .. } = &pending.approvals[0].action else {
            panic!("Expected file approval");
        };
        let decision = if scenario == "file-no-details" {
            assert!(text.is_empty());
            for decision in [ApprovalDecision::Accept, ApprovalDecision::AcceptForSession] {
                assert_eq!(
                    app.answer_approval(pending.approvals[0].id.clone(), decision)
                        .await
                        .unwrap_err()
                        .code,
                    "approval_details_missing"
                );
            }
            ApprovalDecision::Decline
        } else {
            assert_eq!(text, "Write access under /fixture/external");
            if scenario == "file-root-late" {
                std::fs::write(peer_file(&f, "file_patch_release"), "").unwrap();
                let patched = wait(&app, &thread.id, |thread| matches!(&thread.approvals[0].action, ApprovalAction::FileChange { text, .. } if text.contains("exact later patch"))).await;
                let ApprovalAction::FileChange { text, .. } = &patched.approvals[0].action else {
                    unreachable!()
                };
                assert!(!text.contains("Write access under"));
                assert!(text.contains("/fixture/external/test.txt"));
            }
            ApprovalDecision::Accept
        };
        app.answer_approval(pending.approvals[0].id.clone(), decision)
            .await
            .unwrap();
        let completed = wait(&app, &thread.id, |thread| {
            matches!(
                thread.turns[0].execution,
                Execution::Completed | Execution::Failed { .. }
            )
        })
        .await;
        assert!(
            matches!(completed.turns[0].execution, Execution::Completed),
            "{scenario}"
        );
        app.shutdown().await.unwrap();
    }
}

#[test]
fn historical_approval_without_options_still_deserializes() {
    let approval: Approval = serde_json::from_value(serde_json::json!({
        "id": ApprovalId::default(), "turnId": TurnId::default(),
        "action": {"kind":"command","command":"echo old","cwd":"/fixture","reason":""},
        "state":"answered"
    }))
    .unwrap();
    assert!(approval.options.is_empty());
    assert_eq!(approval.state, ApprovalState::Answered);
}

fn stored_attachment(f: &Fixture, attachment: &Attachment) -> std::path::PathBuf {
    attachment_path(
        f,
        &format!("{}.{}", attachment.id(), attachment.extension()),
    )
}
fn expected_mixed_input(f: &Fixture, text: &str, files: &[Attachment]) -> serde_json::Value {
    serde_json::json!([
        {"type":"text", "text":format!("{text}\n\n[Attached file \"Report.PDF\" is saved at: {}]\n\n[Pasted text \"pasted-text.txt\" is saved at: {}. Inspect it as needed.]\n\n[Attached image \"shot.png\" is saved at: {}]", stored_attachment(f, &files[0]).display(), stored_attachment(f, &files[1]).display(), stored_attachment(f, &files[2]).display()), "text_elements":[]},
        {"type":"localImage", "path":stored_attachment(f, &files[2])}
    ])
}
#[tokio::test]
async fn files_and_folded_text_use_exact_t3_paths_at_both_codex_boundaries() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let pdf = app
        .stage_attachment(
            "Report.PDF".into(),
            b"%PDF-1.4 fixture".to_vec(),
            AttachmentKind::File {
                mime_type: "application/pdf".into(),
                source: None,
            },
        )
        .await
        .unwrap();
    let paste = app
        .stage_attachment(
            "pasted-text.txt".into(),
            "å".repeat(16384).into_bytes(),
            AttachmentKind::File {
                mime_type: "text/plain;charset=utf-8".into(),
                source: Some(AttachmentSource::PastedText),
            },
        )
        .await
        .unwrap();
    let image = app
        .stage_attachment("shot.png".into(), SHOT.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    let files = vec![pdf, paste, image];
    assert_eq!(
        std::fs::read(stored_attachment(&f, &files[0])).unwrap(),
        b"%PDF-1.4 fixture"
    );
    assert_eq!(
        std::fs::read(stored_attachment(&f, &files[1])).unwrap(),
        "å".repeat(16384).into_bytes()
    );
    app.submit(
        thread.id.clone(),
        "files-start".into(),
        "Inspect these".into(),
        files.clone(),
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.session, SessionState::Ready)
    })
    .await;
    assert_eq!(
        turn_inputs(&f)[0],
        expected_mixed_input(&f, "Inspect these", &files)
    );
    let original = app
        .submit(thread.id.clone(), "held".into(), "hold".into(), vec![])
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.session, SessionState::Running)
    })
    .await;
    app.submit_to(
        thread.id.clone(),
        "files-steer".into(),
        "Read now".into(),
        files.clone(),
        Some(original.turn_id),
    )
    .await
    .unwrap();
    let steered = wait(&app, &thread.id, |t| {
        matches!(
            steering_delivery(t, "files-steer"),
            Some(Delivery::Accepted)
        )
    })
    .await;
    assert_eq!(
        f.calls()
            .iter()
            .find(|call| call["method"] == "turn/steer")
            .unwrap()["params"]["input"],
        expected_mixed_input(&f, "Read now", &files)
    );
    assert!(
        steered.turns[1].items.iter().any(
            |item| matches!(item, Item::UserInput { attachments, .. } if attachments == &files)
        )
    );
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    assert_eq!(
        app.thread(thread.id).await.unwrap().turns[0].attachments,
        files
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn native_file_limits_and_immutable_extensions_refuse_invalid_metadata_before_dispatch() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let kind = || AttachmentKind::File {
        mime_type: "application/octet-stream".into(),
        source: None,
    };
    assert_eq!(
        app.stage_attachment("empty.txt".into(), vec![], kind())
            .await
            .unwrap_err()
            .message,
        "'empty.txt' is empty or could not be read."
    );
    assert_eq!(
        app.stage_attachment("huge.pdf".into(), vec![0; 50 * 1024 * 1024 + 1], kind())
            .await
            .unwrap_err()
            .message,
        "'huge.pdf' exceeds the 50 MB attachment limit."
    );
    let largest = app
        .stage_attachment("limit.bin".into(), vec![0; 50 * 1024 * 1024], kind())
        .await
        .unwrap();
    assert_eq!(largest.size_bytes(), 50 * 1024 * 1024);
    assert_eq!(
        std::fs::metadata(stored_attachment(&f, &largest))
            .unwrap()
            .len(),
        50 * 1024 * 1024
    );
    for name in [
        "file.part",
        "file.../../outside",
        "file.é",
        "file.verylongextension",
    ] {
        let file = app
            .stage_attachment(name.into(), b"data".to_vec(), kind())
            .await
            .unwrap();
        assert_eq!(file.extension(), "bin");
        assert_eq!(
            std::fs::read(stored_attachment(&f, &file)).unwrap(),
            b"data"
        );
    }
    let mut file = app
        .stage_attachment("safe.PDF".into(), b"data".to_vec(), kind())
        .await
        .unwrap();
    if let Attachment::File(file) = &mut file {
        file.name = "renamed.txt".into();
    }
    assert_eq!(file.extension(), "pdf");
    let error = app
        .submit(
            thread.id.clone(),
            "too-many".into(),
            "Inspect".into(),
            vec![file.clone(); 101],
        )
        .await
        .unwrap_err();
    assert_eq!(error.message, "You can attach up to 100 files per message.");
    if let Attachment::File(file) = &mut file {
        file.size_bytes = 50 * 1024 * 1024 + 1;
    }
    assert_eq!(
        app.submit(
            thread.id.clone(),
            "forged-size".into(),
            "Inspect".into(),
            vec![file]
        )
        .await
        .unwrap_err()
        .message,
        "'renamed.txt' exceeds the 50 MB attachment limit."
    );
    let invalid = serde_json::json!({"kind":"file", "id":SHOT_ID, "mimeType":"image/png", "name":"shot.png", "sizeBytes":12, "extension":"../outside"});
    assert!(serde_json::from_value::<Attachment>(invalid).is_err());
    let image = app
        .stage_attachment("shot.png".into(), SHOT.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    let large = match image {
        Attachment::Image(mut image) => {
            image.size_bytes = 10 * 1024 * 1024;
            Attachment::Image(image)
        }
        Attachment::File(_) => unreachable!(),
    };
    let error = app
        .submit(
            thread.id.clone(),
            "too-many-image-bytes".into(),
            "Inspect".into(),
            vec![large; 9],
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "Images can total up to 80 MiB per message or question response. Use smaller images or send fewer at once."
    );
    assert!(turn_inputs(&f).is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn startup_sweep_keeps_aged_files_owned_by_drafts_stashes_and_chips_only() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let mut files = vec![];
    for name in [
        "draft.pdf",
        "stash.txt",
        "chip.bin",
        "orphan.csv",
        "legacy.png",
    ] {
        let kind = if name.ends_with("png") {
            AttachmentKind::Image
        } else {
            AttachmentKind::File {
                mime_type: "application/octet-stream".into(),
                source: None,
            }
        };
        let bytes = if name.ends_with("png") {
            SHOT.to_vec()
        } else {
            name.as_bytes().to_vec()
        };
        files.push(
            app.stage_attachment(name.into(), bytes, kind)
                .await
                .unwrap(),
        );
    }
    app.set_ui_state("composer-draft:unsent".into(), Some(serde_json::json!({"version":2,"text":"draft", "records":[], "attachments":[{"key":"d","status":"ready","attachment":files[0]}]}).to_string())).await.unwrap();
    app.set_ui_state("prompt-stash:v1".into(), Some(serde_json::json!({"version":1,"entries":[{"id":"s","createdAt":"2026-10-07T00:00:00Z","payload":{"version":1,"text":"stash", "records":[], "attachments":[files[1]]}}]}).to_string())).await.unwrap();
    app.set_ui_state("composer-draft:chips".into(), Some(serde_json::json!({"version":2,"text":"chip", "records":[{"kind":"file","attachmentId":files[2].id()}], "attachments":[]}).to_string())).await.unwrap();
    app.set_ui_state("composer-draft:old".into(), Some(serde_json::json!({"version":1,"text":"old", "records":[], "images":[{"key":"i","status":"ready","attachment":files[4]}]}).to_string())).await.unwrap();
    app.set_ui_state(
        "unrelated".into(),
        Some(serde_json::json!({"attachments":[files[3]]}).to_string()),
    )
    .await
    .unwrap();
    app.shutdown().await.unwrap();
    for file in &files {
        age(
            &stored_attachment(&f, file),
            Duration::from_secs(25 * 60 * 60),
        );
    }
    let partial = attachment_path(&f, ".stale.part");
    std::fs::write(&partial, "unfinished").unwrap();
    age(&partial, Duration::from_secs(2 * 60 * 60));
    let app = reopen(&f.config).await;
    for index in [0, 1, 2, 4] {
        assert!(stored_attachment(&f, &files[index]).exists());
    }
    assert!(!stored_attachment(&f, &files[3]).exists());
    assert!(!partial.exists());
    assert!(app.ui_state().await.unwrap()["prompt-stash:v1"].contains("stash.txt"));
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn malformed_or_future_composer_state_prevents_destructive_attachment_sweep() {
    for saved in ["{broken", "{\"version\":99,\"text\":\"future\"}"] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let file = app
            .stage_attachment(
                "kept.pdf".into(),
                b"bytes".to_vec(),
                AttachmentKind::File {
                    mime_type: "application/pdf".into(),
                    source: None,
                },
            )
            .await
            .unwrap();
        app.set_ui_state("composer-draft:unreadable".into(), Some(saved.into()))
            .await
            .unwrap();
        app.shutdown().await.unwrap();
        age(
            &stored_attachment(&f, &file),
            Duration::from_secs(25 * 60 * 60),
        );
        let app = reopen(&f.config).await;
        assert_eq!(
            std::fs::read(stored_attachment(&f, &file)).unwrap(),
            b"bytes"
        );
        app.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn a_pre_port_image_receipt_retries_with_unchanged_serialized_fingerprint() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    let image = app
        .stage_attachment("shot.png".into(), SHOT.to_vec(), AttachmentKind::Image)
        .await
        .unwrap();
    let legacy =
        serde_json::json!({"id":SHOT_ID,"mimeType":"image/png","name":"shot.png","sizeBytes":12});
    assert_eq!(
        serde_json::to_string(&image).unwrap(),
        format!(
            "{{\"id\":\"{SHOT_ID}\",\"mimeType\":\"image/png\",\"name\":\"shot.png\",\"sizeBytes\":12}}"
        )
    );
    let first = app
        .submit(
            thread.id.clone(),
            "legacy-retry".into(),
            "Inspect".into(),
            vec![image],
        )
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.session, SessionState::Ready)
    })
    .await;
    app.shutdown().await.unwrap();
    let app = reopen(&f.config).await;
    let decoded: Attachment = serde_json::from_value(legacy).unwrap();
    let retry = app
        .submit(
            thread.id.clone(),
            "legacy-retry".into(),
            "Inspect".into(),
            vec![decoded],
        )
        .await
        .unwrap();
    assert_eq!(retry.turn_id, first.turn_id);
    assert_eq!(app.thread(thread.id).await.unwrap().turns.len(), 1);
    assert_eq!(turn_inputs(&f).len(), 1);
    app.shutdown().await.unwrap();
}

async fn task_control(
    f: &Fixture,
    native: &str,
    revision: u64,
    action: &str,
    fields: serde_json::Value,
) {
    let mut value = fields;
    value["revision"] = revision.into();
    value["action"] = action.into();
    let root = f.peer.parent().unwrap();
    std::fs::write(
        root.join(format!("task-control-{native}.json")),
        value.to_string(),
    )
    .unwrap();
    let seen = root.join(format!("task-control-seen-{native}.json"));
    let consumed = eventually(|| {
        std::fs::read_to_string(&seen)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .is_some_and(|v| v["revision"] == revision)
    })
    .await;
    assert!(consumed, "task fixture did not consume {action}");
    tokio::time::sleep(Duration::from_millis(130)).await;
}

#[tokio::test]
async fn task_progress_routes_exact_turns_and_preserves_last_valid_snapshot() {
    use serde_json::json;
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(
        thread.id.clone(),
        "early-tasks".into(),
        "task-progress-early".into(),
        vec![],
    )
    .await
    .unwrap();
    let first = wait(&app, &thread.id, |t| {
        t.turns[0]
            .tasks
            .as_ref()
            .is_some_and(|tasks| tasks.steps().len() == 3)
    })
    .await;
    let native = first.native_thread_id.clone().unwrap();
    let first_turn = first.turns[0].native_turn_id.clone().unwrap();
    assert_eq!(
        first.turns[0].tasks.as_ref().unwrap().steps()[0].status,
        TaskStatus::InProgress
    );
    task_control(&f, &native, 1, "advance", json!({"stage":1})).await;
    let updated = wait(&app, &thread.id, |t| {
        t.turns[0]
            .tasks
            .as_ref()
            .is_some_and(|tasks| tasks.steps()[0].status == TaskStatus::Completed)
    })
    .await;
    let tasks = updated.turns[0].tasks.clone();
    let revision = updated.revision;
    assert!(tasks.as_ref().unwrap().steps()[0].duration_ms.is_some());
    task_control(&f, &native, 2, "advance", json!({"stage":1})).await;
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().revision,
        revision
    );
    for (index, action) in ["malformed", "missing", "stale", "wrong-thread"]
        .into_iter()
        .enumerate()
    {
        task_control(&f, &native, index as u64 + 3, action, json!({})).await;
        let snapshot = app.thread(thread.id.clone()).await.unwrap();
        assert_eq!(snapshot.turns[0].tasks, tasks);
        assert_eq!(snapshot.revision, revision);
        assert_eq!(snapshot.session, SessionState::Running);
    }
    task_control(&f, &native, 7, "clear", json!({})).await;
    wait(&app, &thread.id, |t| t.turns[0].tasks.is_none()).await;
    task_control(&f, &native, 8, "advance", json!({"stage":0})).await;
    wait(&app, &thread.id, |t| {
        t.turns[0]
            .tasks
            .as_ref()
            .is_some_and(|tasks| tasks.steps()[0].status == TaskStatus::InProgress)
    })
    .await;
    app.interrupt(thread.id.clone()).await.unwrap();
    let stopped = wait(&app, &thread.id, |t| {
        t.turns[0].execution == Execution::Interrupted
    })
    .await;
    assert_eq!(
        stopped.turns[0].tasks.as_ref().unwrap().steps()[0].status,
        TaskStatus::InProgress
    );
    std::fs::remove_file(
        f.peer
            .parent()
            .unwrap()
            .join(format!("task-control-{native}.json")),
    )
    .unwrap();
    app.submit(
        thread.id.clone(),
        "next-tasks".into(),
        "task-progress".into(),
        vec![],
    )
    .await
    .unwrap();
    let next = wait(&app, &thread.id, |t| {
        t.turns.len() == 2 && t.turns[1].tasks.is_some()
    })
    .await;
    assert_eq!(
        next.turns[1].tasks.as_ref().unwrap().steps()[0].status,
        TaskStatus::InProgress
    );
    task_control(&f, &native, 9, "stale", json!({"turnId":first_turn})).await;
    let safe = app.thread(thread.id.clone()).await.unwrap();
    assert_eq!(safe.turns[0].tasks, stopped.turns[0].tasks);
    assert_eq!(safe.turns[1].tasks, next.turns[1].tasks);
    task_control(&f, &native, 10, "advance", json!({"stage":3})).await;
    let completed_tasks = wait(&app, &thread.id, |t| {
        t.turns[1].tasks.as_ref().is_some_and(|tasks| {
            tasks
                .steps()
                .iter()
                .all(|s| s.status == TaskStatus::Completed)
        })
    })
    .await
    .turns[1]
        .tasks
        .clone();
    task_control(&f, &native, 11, "finish", json!({})).await;
    let completed = wait(&app, &thread.id, |t| {
        t.turns[1].execution == Execution::Completed
    })
    .await;
    assert_eq!(completed.turns[1].tasks, completed_tasks);
    app.shutdown().await.unwrap();
    let reopened = reopen(&f.config).await;
    let restored = reopened.thread(thread.id.clone()).await.unwrap();
    assert_eq!(restored.turns[0].tasks, stopped.turns[0].tasks);
    assert_eq!(restored.turns[1].tasks, completed_tasks);
    reopened
        .revert_thread(
            thread.id.clone(),
            "rewind-tasks".into(),
            restored.turns[1].id.clone(),
            false,
        )
        .await
        .unwrap();
    let rewound = reopened.thread(thread.id.clone()).await.unwrap();
    assert_eq!(rewound.turns.len(), 1);
    assert_eq!(rewound.turns[0].tasks, stopped.turns[0].tasks);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn task_progress_survives_active_restart_as_lost_without_replaying_timers() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.submit(
        thread.id.clone(),
        "restart-tasks".into(),
        "task-progress".into(),
        vec![],
    )
    .await
    .unwrap();
    let running = wait(&app, &thread.id, |t| t.turns[0].tasks.is_some()).await;
    app.shutdown().await.unwrap();
    let reopened = reopen(&f.config).await;
    let restored = reopened.thread(thread.id.clone()).await.unwrap();
    assert!(matches!(
        restored.turns[0].execution,
        Execution::Lost { .. }
    ));
    assert_eq!(restored.turns[0].tasks, running.turns[0].tasks);
    assert!(matches!(
        restored.session,
        SessionState::Ready | SessionState::Dormant
    ));
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn task_progress_provider_loss_and_failure_keep_reported_statuses() {
    for fail in [false, true] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let thread = conversation(&app, &f).await;
        app.submit(
            thread.id.clone(),
            "terminal-tasks".into(),
            "task-progress".into(),
            vec![],
        )
        .await
        .unwrap();
        let running = wait(&app, &thread.id, |t| t.turns[0].tasks.is_some()).await;
        if fail {
            task_control(
                &f,
                running.native_thread_id.as_deref().unwrap(),
                1,
                "fail",
                serde_json::json!({}),
            )
            .await;
        } else {
            let pid = std::fs::read_to_string(f.peer.parent().unwrap().join("pid")).unwrap();
            assert!(
                Command::new("kill")
                    .args(["-KILL", pid.trim()])
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let terminal = wait(&app, &thread.id, |t| {
            if fail {
                matches!(t.turns[0].execution, Execution::Failed { .. })
            } else {
                matches!(t.turns[0].execution, Execution::Lost { .. })
            }
        })
        .await;
        assert_eq!(terminal.turns[0].tasks, running.turns[0].tasks);
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn unsettle_return_clock_survives_reopen_without_changing_user_activity() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = conversation(&app, &f).await;
    app.arrange(thread.id.clone(), Arrange::Settle)
        .await
        .unwrap();
    app.arrange(thread.id.clone(), Arrange::Unsettle)
        .await
        .unwrap();
    let un_settled = app.thread(thread.id.clone()).await.unwrap();
    assert!(un_settled.unsettled_at_ms.is_some());
    assert_eq!(
        un_settled.latest_user_activity_at_ms,
        thread.latest_user_activity_at_ms
    );
    app.arrange(thread.id.clone(), Arrange::Unsettle)
        .await
        .unwrap();
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().unsettled_at_ms,
        un_settled.unsettled_at_ms
    );
    app.shutdown().await.unwrap();
    let reopened = reopen(&f.config).await;
    let restored = reopened.thread(thread.id.clone()).await.unwrap();
    assert_eq!(restored.unsettled_at_ms, un_settled.unsettled_at_ms);
    assert_eq!(
        restored.latest_user_activity_at_ms,
        un_settled.latest_user_activity_at_ms
    );
    reopened.shutdown().await.unwrap();
}
