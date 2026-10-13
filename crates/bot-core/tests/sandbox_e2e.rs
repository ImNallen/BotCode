//! A sandbox thread end to end against real Docker and the Mac's signed-in Codex. Ignored by
//! default. Run it with
//! `cargo test -p bot-core --test sandbox_e2e -- --include-ignored --nocapture`.
#![allow(clippy::disallowed_methods)]
use bot_core::*;
use std::{
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

fn git(root: &Path, args: &[&str]) -> String {
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
    String::from_utf8(output.stdout).unwrap()
}
fn docker(args: &[&str]) -> String {
    let output = Command::new(sandbox::docker_binary())
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "docker {args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap()
}
/// Removes the container on drop, also after a failed assertion.
struct Removal(String);
impl Drop for Removal {
    fn drop(&mut self) {
        let _ = Command::new(sandbox::docker_binary())
            .args(["rm", "--force", &self.0])
            .output();
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
fn assistant_text(thread: &ThreadSnapshot, turn: &TurnId) -> String {
    thread
        .turns
        .iter()
        .find(|row| row.id == *turn)
        .unwrap()
        .items
        .iter()
        .filter_map(|item| match item {
            Item::Assistant { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
#[ignore = "needs Docker and a signed-in Codex"]
async fn a_sandbox_thread_runs_codex_in_the_container_and_mirrors_to_the_mac() {
    let root = tempfile::Builder::new()
        .prefix("botcode sandbox e2e-")
        .tempdir()
        .unwrap();
    let origin = root.path().join("origin.git");
    let repository = root.path().join("repository");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "--bare", "-q", "--initial-branch=main"]);
    git(
        root.path(),
        &["clone", "-q", origin.to_str().unwrap(), "repository"],
    );
    for (key, value) in [
        ("user.name", "Sandbox E2E"),
        ("user.email", "sandbox-e2e@example.invalid"),
        ("commit.gpgsign", "false"),
    ] {
        git(&repository, &["config", key, value]);
    }
    std::fs::write(repository.join("README.md"), "# sandbox e2e\n").unwrap();
    std::fs::write(
        repository.join("t3.json"),
        r#"{"scripts":[{"name":"Env","command":"printf '%s %s\\n' \"$T3CODE_PROJECT_ROOT\" \"$T3CODE_WORKTREE_PATH\" > script-env.txt"}]}"#,
    )
    .unwrap();
    git(&repository, &["add", "README.md", "t3.json"]);
    git(&repository, &["commit", "-qm", "initial"]);
    git(&repository, &["push", "-q", "-u", "origin", "main"]);

    let data = root.path().join("state");
    std::fs::create_dir_all(&data).unwrap();
    let mut config = RuntimeConfig::from_environment().unwrap();
    config.data_dir = dunce::canonicalize(&data).unwrap();
    let app = App::open(config.clone()).await.unwrap();
    let availability = app.sandbox_availability().await;
    assert!(
        matches!(availability, SandboxAvailability::Ready { .. }),
        "{availability:?}"
    );
    let workspace = app.open_workspace(repository.clone()).await.unwrap();
    let thread = app
        .create_thread(
            workspace.id.clone(),
            NewCheckout::Sandbox {
                base: "main".into(),
                from_origin: true,
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
        "botcode-{}-{id}",
        sandbox::Instance::of(&config.data_dir).as_str()
    );
    let _removal = Removal(container.clone());
    let output = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let term = TerminalId::try_from("term-1".to_string()).unwrap();
    app.terminal_attach(
        workspace.id.clone(),
        Some(thread.id.clone()),
        term.clone(),
        80,
        24,
        {
            let output = output.clone();
            move |event| {
                if let TerminalEvent::Output { data } = event {
                    output.lock().unwrap().push_str(&data);
                }
            }
        },
    )
    .await
    .unwrap();
    let mut hints = app.subscribe();
    app.terminal_write(
        workspace.id.clone(),
        Some(thread.id.clone()),
        term.clone(),
        "whoami; pwd; uname -s; echo terminal > term.txt\r".into(),
    )
    .await
    .unwrap();
    let started = Instant::now();
    while !output
        .lock()
        .unwrap()
        .contains("botcode\r\n/workspace\r\nLinux\r\n")
    {
        assert!(
            started.elapsed() < Duration::from_secs(600),
            "{:?}",
            output.lock().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // Nothing else reads the checkout here, so only the pull after the prompt brings term.txt.
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let hint = hints.recv().await.unwrap();
            if hint.thread_id == thread.id
                && hint.refresh_workspace
                && mirror.join("term.txt").exists()
            {
                break;
            }
        }
    })
    .await
    .expect("the finished command pulls the mirror and refreshes the checkout");
    assert_eq!(
        std::fs::read_to_string(mirror.join("term.txt")).unwrap(),
        "terminal\n"
    );
    // Saved actions come from settings; import the file's actions as the UI's Import does.
    let script = app
        .project_file_config(workspace.id.clone())
        .await
        .unwrap()
        .scripts
        .remove(0);
    app.save_settings(
        &serde_json::json!({
            "projectSettingsOverrides": {
                workspace.id.to_string(): {"defaultProjectScripts": [&script]}
            }
        })
        .to_string(),
    )
    .await
    .unwrap();
    app.run_project_script(
        workspace.id.clone(),
        Some(thread.id.clone()),
        script.id,
        TerminalId::try_from("term-2".to_string()).unwrap(),
    )
    .await
    .unwrap();
    let started = Instant::now();
    while !mirror.join("script-env.txt").exists() {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "the script never ran"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        std::fs::read_to_string(mirror.join("script-env.txt")).unwrap(),
        "/workspace /workspace\n",
        "scripts see container paths"
    );
    let editor = app
        .open_target_path(OpenTarget::Workspace {
            workspace_id: workspace.id.clone(),
            thread_id: Some(thread.id.clone()),
            path: "README.md".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(editor.code, "sandbox_mirror");
    // The container is the boundary, so the agent may run its shell commands unasked.
    app.update_settings(
        thread.id.clone(),
        SessionSettings {
            permission_mode: PermissionMode::FullAccess,
            ..SessionSettings::default()
        },
    )
    .await
    .unwrap();
    let in_container =
        |script: &str| docker(&["exec", "-w", "/workspace", &container, "sh", "-ec", script]);

    let started = Instant::now();
    let receipt = app
        .submit(
            thread.id.clone(),
            "sandbox-e2e-1".into(),
            "Create a file named hello.txt in the current directory whose content is exactly the line SANDBOX_OK. Use a shell command. Then reply with the single word DONE.".into(),
            vec![],
        )
        .await
        .unwrap();
    let first = wait(&app, &thread.id, &receipt, Duration::from_secs(900)).await;
    eprintln!("first turn: {:?}", started.elapsed());
    assert_eq!(
        in_container("cat hello.txt"),
        "SANDBOX_OK\n",
        "the agent wrote inside the container"
    );
    assert_eq!(
        std::fs::read_to_string(mirror.join("hello.txt")).unwrap(),
        "SANDBOX_OK\n",
        "the Mac mirror received it"
    );
    let TurnCheckpoint::Complete { files, .. } = &first.turns[0].checkpoint else {
        panic!("{:?}", first.turns[0].checkpoint);
    };
    assert!(
        files.iter().any(|file| file.path == "hello.txt"),
        "{files:?}"
    );
    // The npm wrapper is `node`; the agent itself is one native `codex` process.
    assert_eq!(
        in_container("pgrep -cx codex || true").trim(),
        "1",
        "one agent runs in the container"
    );

    app.write_file(
        workspace.id.clone(),
        Some(thread.id.clone()),
        "from-mac.txt".into(),
        "MAC_WRITE\n".into(),
    )
    .await
    .unwrap();
    assert_eq!(in_container("cat from-mac.txt"), "MAC_WRITE\n");

    // Branch naming holds the checkout for a moment after the first turn; the UI retries too.
    let started = Instant::now();
    let outcome = loop {
        let action = GitAction::CommitPush {
            request: CommitRequest {
                message: Some("sandbox commit".to_string().try_into().unwrap()),
                selection: CommitSelection::All,
                destination: CommitDestination::Current,
            },
        };
        match app
            .run_git_action(
                workspace.id.clone(),
                Some(thread.id.clone()),
                action,
                |_| {},
            )
            .await
        {
            Err(error) if error.code == "checkout_busy" => {
                assert!(started.elapsed() < Duration::from_secs(180), "{error:?}");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            other => break other.unwrap(),
        }
    };
    assert!(outcome.failure.is_none(), "{:?}", outcome.failure);
    let committed = outcome.commit.expect("a commit").sha;
    assert!(outcome.push.is_some(), "pushed");
    assert_eq!(in_container("git rev-parse HEAD").trim(), committed);
    assert_eq!(git(&mirror, &["rev-parse", "HEAD"]).trim(), committed);
    let branch = match app.thread(thread.id.clone()).await.unwrap().checkout {
        Checkout::Worktree { branch, .. } => branch,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        git(&origin, &["rev-parse", &branch]).trim(),
        committed,
        "the bare origin has the commit on {branch}"
    );
    assert_eq!(
        in_container("git log -1 --format=%s").trim(),
        "sandbox commit"
    );
    assert_eq!(in_container("git remote").trim(), "", "no remote inside");

    app.shutdown().await.unwrap();
    assert_eq!(
        docker(&["inspect", "-f", "{{.State.Status}}", &container]).trim(),
        "exited",
        "shutdown stopped the container"
    );

    let app = App::open(config).await.unwrap();
    let receipt = app
        .submit(
            thread.id.clone(),
            "sandbox-e2e-2".into(),
            "Reply with the word RESUMED followed by the exact contents of hello.txt.".into(),
            vec![],
        )
        .await
        .unwrap();
    let second = wait(&app, &thread.id, &receipt, Duration::from_secs(600)).await;
    let text = assistant_text(&second, &receipt.turn_id);
    assert!(
        text.contains("RESUMED") && text.contains("SANDBOX_OK"),
        "{text}"
    );
    assert_eq!(
        second.native_thread_id, first.native_thread_id,
        "the same native thread resumed in the container"
    );
    app.shutdown().await.unwrap();
    let _ = PathBuf::new();
}
