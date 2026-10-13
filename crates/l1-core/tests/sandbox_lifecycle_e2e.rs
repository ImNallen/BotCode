#![allow(clippy::disallowed_methods)]
use l1_core::*;
use std::{
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn docker(args: &[&str]) -> std::process::Output {
    Command::new(sandbox::docker_binary())
        .args(args)
        .output()
        .unwrap()
}
fn status(container: &str) -> String {
    let output = docker(&["inspect", "-f", "{{.State.Status}}", container]);
    if output.status.success() {
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    } else {
        "absent".into()
    }
}
async fn until_status(container: &str, expected: &str, limit: Duration) -> Duration {
    let started = Instant::now();
    while status(container) != expected {
        assert!(
            started.elapsed() < limit,
            "{container} is {} instead of {expected} after {limit:?}",
            status(container)
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    started.elapsed()
}
async fn until_state(
    app: &App,
    workspace: &WorkspaceId,
    thread: &ThreadId,
    expected: SandboxState,
) {
    let started = Instant::now();
    loop {
        let state = app
            .sandbox_state(workspace.clone(), thread.clone())
            .await
            .unwrap();
        if state == expected {
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "sandbox state stayed {state:?} instead of {expected:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
struct Removal(String);
impl Drop for Removal {
    fn drop(&mut self) {
        let _ = docker(&["rm", "--force", &self.0]);
    }
}
async fn wait(app: &App, id: &ThreadId, receipt: &Receipt, limit: Duration) -> ThreadSnapshot {
    let started = Instant::now();
    loop {
        let snapshot = app.thread(id.clone()).await.unwrap();
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| turn.id == receipt.turn_id)
            .expect("turn disappeared");
        let settled = !turn.execution.active()
            && !matches!(
                turn.checkpoint,
                TurnCheckpoint::Pending | TurnCheckpoint::Before { .. }
            );
        if settled {
            assert!(
                matches!(turn.execution, Execution::Completed),
                "turn did not complete: {}",
                serde_json::to_string_pretty(turn).unwrap()
            );
            return snapshot;
        }
        assert!(
            started.elapsed() < limit,
            "timed out: {}",
            serde_json::to_string_pretty(&snapshot).unwrap()
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test]
#[ignore = "needs Docker and a signed-in Codex"]
async fn an_idle_sandbox_pauses_a_message_wakes_it_and_delete_removes_it() {
    unsafe {
        std::env::set_var("L1_CODE_SANDBOX_PAUSE_AFTER_SECS", "8");
        std::env::set_var("L1_CODE_SANDBOX_STOP_AFTER_SECS", "30");
        std::env::set_var("L1_CODE_SANDBOX_DESKTOP_IDLE_SECS", "5");
    }
    let root = tempfile::Builder::new()
        .prefix("l1code lifecycle e2e-")
        .tempdir()
        .unwrap();
    let repository = root.path().join("repository");
    std::fs::create_dir_all(&repository).unwrap();
    git(&repository, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "Lifecycle E2E"),
        ("user.email", "lifecycle-e2e@example.invalid"),
        ("commit.gpgsign", "false"),
    ] {
        git(&repository, &["config", key, value]);
    }
    std::fs::write(repository.join("README.md"), "# lifecycle e2e\n").unwrap();
    git(&repository, &["add", "README.md"]);
    git(&repository, &["commit", "-qm", "initial"]);
    let data = root.path().join("state");
    std::fs::create_dir_all(&data).unwrap();
    let mut config = RuntimeConfig::from_environment().unwrap();
    config.data_dir = dunce::canonicalize(&data).unwrap();
    let app = App::open(config.clone()).await.unwrap();
    let workspace = app.open_workspace(repository.clone()).await.unwrap();
    let thread = app
        .create_thread(
            workspace.id.clone(),
            NewCheckout::Sandbox {
                base: "main".into(),
                from_origin: false,
            },
        )
        .await
        .unwrap();
    let Checkout::Worktree {
        path: mirror,
        sandbox: Some(Sandbox::Docker { id }),
        ..
    } = thread.checkout.clone()
    else {
        panic!("not a sandbox checkout: {:?}", thread.checkout);
    };
    let container = format!(
        "l1code-{}-{id}",
        sandbox::Instance::of(&config.data_dir).as_str()
    );
    let _removal = Removal(container.clone());
    let codex_home = config.data_dir.join("sandboxes").join(id.as_str());
    app.update_settings(
        thread.id.clone(),
        SessionSettings {
            permission_mode: PermissionMode::FullAccess,
            ..SessionSettings::default()
        },
    )
    .await
    .unwrap();

    let receipt = app
        .submit(
            thread.id.clone(),
            "lifecycle-1".into(),
            "Create a file named awake.txt whose content is the single line FIRST, with a shell command, then reply DONE.".into(),
            vec![],
        )
        .await
        .unwrap();
    let first = wait(&app, &thread.id, &receipt, Duration::from_secs(900)).await;
    assert_eq!(status(&container), "running");
    let paused_after = until_status(&container, "paused", Duration::from_secs(120)).await;
    eprintln!("LIFECYCLE paused {paused_after:?} after the first turn");
    assert_eq!(
        std::fs::read_to_string(mirror.join("awake.txt")).unwrap(),
        "FIRST\n",
        "the mirror is exact while paused"
    );
    until_state(&app, &workspace.id, &thread.id, SandboxState::Paused).await;

    let started = Instant::now();
    let receipt = app
        .submit(
            thread.id.clone(),
            "lifecycle-2".into(),
            "Append the line SECOND to awake.txt with a shell command, then reply DONE.".into(),
            vec![],
        )
        .await
        .unwrap();
    let woke_after = until_status(&container, "running", Duration::from_secs(30)).await;
    eprintln!("LIFECYCLE the second message unpaused it after {woke_after:?}");
    let second = wait(&app, &thread.id, &receipt, Duration::from_secs(600)).await;
    eprintln!(
        "LIFECYCLE second turn done {:?} after submit",
        started.elapsed()
    );
    assert_eq!(
        second.native_thread_id, first.native_thread_id,
        "the same native thread served the turn"
    );
    assert_eq!(
        std::fs::read_to_string(mirror.join("awake.txt")).unwrap(),
        "FIRST\nSECOND\n"
    );

    let stopped_after = until_status(&container, "exited", Duration::from_secs(120)).await;
    eprintln!("LIFECYCLE stopped {stopped_after:?} after the second turn");
    until_state(&app, &workspace.id, &thread.id, SandboxState::Stopped).await;
    let snapshot = app.thread(thread.id.clone()).await.unwrap();
    assert_eq!(
        snapshot.session,
        SessionState::Unavailable {
            reason: "Sandbox stopped while idle. Your next message restarts it.".into()
        }
    );
    assert_eq!(snapshot.diagnostic, None, "a planned stop is not a loss");
    let receipt = app
        .submit(
            thread.id.clone(),
            "lifecycle-3".into(),
            "Reply with the exact contents of awake.txt.".into(),
            vec![],
        )
        .await
        .unwrap();
    let third = wait(&app, &thread.id, &receipt, Duration::from_secs(600)).await;
    let text: String = third
        .turns
        .iter()
        .find(|turn| turn.id == receipt.turn_id)
        .unwrap()
        .items
        .iter()
        .filter_map(|item| match item {
            Item::Assistant { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert!(text.contains("FIRST") && text.contains("SECOND"), "{text}");
    assert_eq!(status(&container), "running");

    let stopped_after = until_status(&container, "exited", Duration::from_secs(120)).await;
    eprintln!("LIFECYCLE stopped again {stopped_after:?} after the third turn");
    until_state(&app, &workspace.id, &thread.id, SandboxState::Stopped).await;
    assert!(codex_home.exists());
    let started = Instant::now();
    app.delete_thread(thread.id.clone()).await.unwrap();
    eprintln!(
        "LIFECYCLE delete of a stopped sandbox took {:?}",
        started.elapsed()
    );
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "delete took {:?}",
        started.elapsed()
    );
    assert_eq!(status(&container), "absent");
    assert!(
        !codex_home.exists(),
        "the Codex home went with the container"
    );
    app.shutdown().await.unwrap();
}
