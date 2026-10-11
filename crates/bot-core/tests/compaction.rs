#![cfg(unix)]
#![allow(clippy::disallowed_methods)]
use bot_core::*;
use std::{os::unix::fs::PermissionsExt, path::PathBuf, process::Command, time::Duration};

const LIMIT: Duration = Duration::from_secs(30);
const RUNNING: &str = "Context compaction is unavailable while a provider turn is running.";

struct Fixture {
    _dir: tempfile::TempDir,
    config: RuntimeConfig,
    repository: PathBuf,
    peer_root: PathBuf,
}
impl Fixture {
    fn new(compaction_timeout: Duration) -> Self {
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
                codex_binary: peer,
                gh_binary: dir.path().join("no-gh"),
                network_timeout: Duration::from_secs(180),
                compaction_timeout,
                shell: None,
            },
            peer_root: dir.path().to_path_buf(),
            _dir: dir,
            repository,
        }
    }
    fn flag(&self, name: &str, text: &str) {
        std::fs::write(self.peer_root.join(name), text).unwrap();
    }
    fn calls(&self, method: &str) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.peer_root.join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .filter(|call| call["method"] == method)
            .collect()
    }
    async fn conversation(&self, app: &App) -> ThreadSnapshot {
        let workspace = app.open_workspace(self.repository.clone()).await.unwrap();
        let thread = app
            .create_thread(workspace.id, NewCheckout::Local)
            .await
            .unwrap();
        app.submit(thread.id.clone(), "first".into(), "hello".into(), vec![])
            .await
            .unwrap();
        wait(app, &thread.id, |t| {
            t.turns[0].execution == Execution::Completed && t.session == SessionState::Ready
        })
        .await
    }
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
        let settling = snapshot.turns.last().is_some_and(|turn| {
            !turn.execution.active()
                && matches!(
                    turn.checkpoint,
                    TurnCheckpoint::Pending | TurnCheckpoint::Before { .. }
                )
        });
        if predicate(&snapshot) && !settling {
            return snapshot;
        }
        last = Some(snapshot);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("Timed out awaiting thread state; last snapshot: {last:#?}")
}
fn compaction_item(turn: &Turn) -> Option<bool> {
    turn.items.iter().find_map(|item| match item {
        Item::ContextCompaction { complete, .. } => Some(*complete),
        _ => None,
    })
}

#[tokio::test]
async fn compaction_runs_as_a_turn_and_survives_restart() {
    let f = Fixture::new(Duration::from_secs(600));
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = f.conversation(&app).await;
    let native = thread.native_thread_id.clone().unwrap();
    f.flag("compact_hold", "");
    let receipt = app
        .submit(
            thread.id.clone(),
            "compact".into(),
            " /COMPACT ".into(),
            vec![],
        )
        .await
        .unwrap();

    let running = wait(&app, &thread.id, |t| {
        t.session == SessionState::Running
            && t.turns.last().and_then(compaction_item) == Some(false)
    })
    .await;
    let turn = running.turns.last().unwrap();
    assert_eq!(turn.id, receipt.turn_id);
    assert_eq!(turn.kind, TurnKind::Compaction);
    assert_eq!(turn.prompt, "/compact");
    assert_eq!(turn.execution, Execution::Running);
    let compactions = f.calls("thread/compact/start");
    assert_eq!(compactions.len(), 1);
    assert_eq!(
        compactions[0]["params"],
        serde_json::json!({"threadId": native})
    );
    assert!(
        !f.calls("turn/start")
            .iter()
            .any(|call| call["params"]["input"][0]["text"] == "/compact"),
        "the command never reaches Codex as a prompt"
    );

    let prompt = app
        .submit(thread.id.clone(), "during".into(), "more".into(), vec![])
        .await
        .unwrap_err();
    assert_eq!(prompt.code, "busy");
    let steer = app
        .submit_to(
            thread.id.clone(),
            "steer".into(),
            "more".into(),
            vec![],
            Some(receipt.turn_id.clone()),
        )
        .await
        .unwrap_err();
    assert_eq!(
        steer.message,
        "Wait for context compaction to finish before sending."
    );
    assert!(f.calls("turn/steer").is_empty());
    let mut settings = running.settings.clone();
    settings.permission_mode = PermissionMode::ApprovalRequired;
    let change = app
        .update_settings(thread.id.clone(), settings)
        .await
        .unwrap_err();
    assert_eq!(change.code, "busy");

    f.flag("compact_release", "");
    let done = wait(&app, &thread.id, |t| {
        t.session == SessionState::Ready
            && t.turns.last().unwrap().execution == Execution::Completed
    })
    .await;
    let turn = done.turns.last().unwrap();
    assert_eq!(compaction_item(turn), Some(true));
    assert_eq!(turn.delivery, Delivery::Accepted);
    assert!(
        turn.native_turn_id
            .as_ref()
            .unwrap()
            .starts_with("compact-")
    );
    assert_eq!(
        done.context,
        Some(ContextUsage {
            used_tokens: 13067,
            max_tokens: Some(258400),
            total_processed_tokens: Some(20659),
        })
    );
    let injected = f.calls("thread/inject_items");
    assert_eq!(injected.len(), 1);
    assert_eq!(injected[0]["params"]["threadId"], native.as_str());
    let restored = injected[0]["params"]["items"][0]["content"][0]["text"]
        .as_str()
        .unwrap();
    let sent = f.calls("turn/start")[0]["params"]["additionalContext"]["botcode_tools"]["value"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(restored, format!("<botcode_tools>{sent}</botcode_tools>"));

    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let reopened = app.thread(thread.id.clone()).await.unwrap();
    let turn = reopened.turns.last().unwrap();
    assert_eq!(reopened.turns.len(), 2);
    assert_eq!(turn.kind, TurnKind::Compaction);
    assert_eq!(turn.prompt, "/compact");
    assert_eq!(turn.execution, Execution::Completed);
    assert_eq!(compaction_item(turn), Some(true));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn compaction_refuses_without_a_conversation_or_while_a_turn_runs() {
    let f = Fixture::new(Duration::from_secs(600));
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let empty = app
        .create_thread(workspace.id, NewCheckout::Local)
        .await
        .unwrap();
    let refused = app
        .submit(empty.id.clone(), "empty".into(), "/compact".into(), vec![])
        .await
        .unwrap_err();
    assert_eq!(
        refused.message,
        "Context compaction requires an existing conversation."
    );
    assert!(app.thread(empty.id.clone()).await.unwrap().turns.is_empty());

    let thread = f.conversation(&app).await;
    let held = app
        .submit(thread.id.clone(), "hold".into(), "hold".into(), vec![])
        .await
        .unwrap();
    wait(&app, &thread.id, |t| t.session == SessionState::Running).await;
    let refused = app
        .submit(thread.id.clone(), "busy".into(), "/compact".into(), vec![])
        .await
        .unwrap_err();
    assert_eq!(refused.message, RUNNING);
    let refused = app
        .submit_to(
            thread.id.clone(),
            "steer".into(),
            "/compact".into(),
            vec![],
            Some(held.turn_id),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.message, RUNNING);
    assert!(f.calls("thread/compact/start").is_empty());
    assert!(f.calls("turn/steer").is_empty());
    app.interrupt(thread.id.clone()).await.unwrap();
    wait(&app, &thread.id, |t| t.session == SessionState::Ready).await;

    app.submit(
        thread.id.clone(),
        "words".into(),
        "/compact now".into(),
        vec![],
    )
    .await
    .unwrap();
    let prompt = wait(&app, &thread.id, |t| {
        t.turns.last().unwrap().execution == Execution::Completed
    })
    .await;
    assert_eq!(prompt.turns.last().unwrap().kind, TurnKind::Prompt);
    assert!(f.calls("thread/compact/start").is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn compaction_that_never_completes_is_lost_at_the_ceiling() {
    let f = Fixture::new(Duration::from_secs(2));
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = f.conversation(&app).await;
    f.flag("compact_stall", "");
    app.submit(
        thread.id.clone(),
        "compact".into(),
        "/compact".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |t| t.session == SessionState::Running).await;
    let lost = wait(&app, &thread.id, |t| {
        !t.turns.last().unwrap().execution.active()
    })
    .await;
    let reason = "Provider did not report completed context compaction within 10 minutes.";
    let turn = lost.turns.last().unwrap();
    assert_eq!(
        turn.execution,
        Execution::Lost {
            reason: reason.into()
        }
    );
    assert_eq!(lost.session, SessionState::Ready);
    assert_eq!(lost.diagnostic.as_deref(), Some(reason));
    let interrupts = f.calls("turn/interrupt");
    assert_eq!(interrupts.len(), 1);
    assert_eq!(
        interrupts[0]["params"]["turnId"],
        turn.native_turn_id.as_deref().unwrap()
    );

    std::fs::remove_file(f.peer_root.join("compact_stall")).unwrap();
    app.submit(thread.id.clone(), "after".into(), "hello".into(), vec![])
        .await
        .unwrap();
    let after = wait(&app, &thread.id, |t| {
        t.turns.len() == 3 && t.turns[2].execution == Execution::Completed
    })
    .await;
    assert_eq!(
        after.turns[1].execution,
        Execution::Lost {
            reason: reason.into()
        }
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn compaction_stops_on_interrupt_and_fails_on_refusal() {
    let f = Fixture::new(Duration::from_secs(600));
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = f.conversation(&app).await;
    f.flag("compact_stall", "");
    app.submit(
        thread.id.clone(),
        "compact".into(),
        "/compact".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &thread.id, |t| {
        t.session == SessionState::Running && t.turns.last().unwrap().native_turn_id.is_some()
    })
    .await;
    app.interrupt(thread.id.clone()).await.unwrap();
    let stopped = wait(&app, &thread.id, |t| t.session == SessionState::Ready).await;
    assert_eq!(stopped.turns[1].execution, Execution::Interrupted);
    assert_eq!(compaction_item(&stopped.turns[1]), Some(false));

    f.flag("compact_error", "Compaction refused by fixture");
    app.submit(thread.id.clone(), "again".into(), "/compact".into(), vec![])
        .await
        .unwrap();
    let failed = wait(&app, &thread.id, |t| {
        t.turns.len() == 3 && !t.turns[2].execution.active()
    })
    .await;
    let turn = &failed.turns[2];
    assert_eq!(
        turn.execution,
        Execution::Failed {
            reason: "Compaction refused by fixture".into()
        }
    );
    assert_eq!(
        turn.delivery,
        Delivery::NotSent {
            reason: "Compaction refused by fixture".into()
        }
    );
    assert_eq!(failed.session, SessionState::Ready);
    app.shutdown().await.unwrap();
}
