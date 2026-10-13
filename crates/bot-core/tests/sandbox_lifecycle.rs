//! The sandbox lifecycle through the App, against a stand-in docker CLI and the fake Codex
//! peer as the sandbox agent: idle pause and stop, wakes, settle, delete, the storage sweep,
//! terminal input and the desktop. The windows are overridden to a few seconds.
#![cfg(unix)]
#![allow(clippy::disallowed_methods)]
use bot_core::*;
use serde_json::Value;
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const PATIENCE: Duration = Duration::from_secs(20);

/// The fake docker and the environment every App in this process shares.
struct Harness {
    peer: PathBuf,
    state: PathBuf,
}
fn harness() -> &'static Harness {
    static HARNESS: OnceLock<Harness> = OnceLock::new();
    HARNESS.get_or_init(|| {
        let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        let root = dunce::canonicalize(dir.path()).unwrap();
        let state = root.join("docker-state");
        std::fs::create_dir_all(&state).unwrap();
        let docker = root.join("docker");
        std::fs::write(&docker, include_str!("support/docker_fake.py")).unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(root.join("state_dir"), state.to_string_lossy().as_bytes()).unwrap();
        let peer = root.join("codex_peer.py");
        std::fs::write(&peer, include_str!("support/codex_peer.py")).unwrap();
        std::fs::set_permissions(&peer, std::fs::Permissions::from_mode(0o755)).unwrap();
        let codex_home = root.join("codex-home");
        std::fs::create_dir_all(&codex_home).unwrap();
        std::fs::write(
            codex_home.join("auth.json"),
            r#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"access_token":"at-fixture","account_id":"acct-fixture","id_token":null}}"#,
        )
        .unwrap();
        // Read once per App::open; every test in this process opens its App after this.
        unsafe {
            std::env::set_var("BOT_CODE_DOCKER_BIN", &docker);
            std::env::set_var("CODEX_HOME", &codex_home);
            std::env::set_var("BOT_CODE_SANDBOX_PAUSE_AFTER_SECS", "4");
            std::env::set_var("BOT_CODE_SANDBOX_STOP_AFTER_SECS", "8");
            std::env::set_var("BOT_CODE_SANDBOX_DESKTOP_IDLE_SECS", "3");
        }
        Harness { peer, state }
    })
}

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

/// One App with one sandbox thread whose container the fake docker "started".
struct Fixture {
    _dir: tempfile::TempDir,
    config: RuntimeConfig,
    app: App,
    workspace: Workspace,
    thread: ThreadSnapshot,
    id: SandboxId,
    container: String,
    mirror: PathBuf,
}
impl Fixture {
    async fn new() -> Self {
        let h = harness();
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let repository = root.join("repository");
        std::fs::create_dir_all(&repository).unwrap();
        git(&repository, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Fixture"),
            ("user.email", "fixture@example.invalid"),
            ("commit.gpgsign", "false"),
        ] {
            git(&repository, &["config", key, value]);
        }
        std::fs::write(repository.join("README.md"), "fixture\n").unwrap();
        git(&repository, &["add", "README.md"]);
        git(&repository, &["commit", "-qm", "initial"]);
        let data = root.join("state");
        std::fs::create_dir_all(&data).unwrap();
        // The peer keeps its state next to itself, so this App's Mac agent gets its own copy.
        let peer = root.join("mac-peer").join("codex_peer.py");
        std::fs::create_dir_all(peer.parent().unwrap()).unwrap();
        std::fs::copy(&h.peer, &peer).unwrap();
        let config = RuntimeConfig {
            data_dir: data,
            codex_binary: peer,
            gh_binary: root.join("no-gh"),
            network_timeout: Duration::from_secs(5),
            compaction_timeout: Duration::from_secs(600),
            shell: None,
        };
        let app = App::open(config.clone()).await.unwrap();
        let workspace = app.open_workspace(repository).await.unwrap();
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
        // The fake's capture echoes the base it is given, so with both refs at HEAD every
        // pull is the no-op of an unchanged container.
        let head = git(&mirror, &["rev-parse", "HEAD"]);
        for name in ["base", "outgoing"] {
            git(
                &mirror,
                &[
                    "update-ref",
                    &format!("refs/botcode/sandbox/{id}/{name}"),
                    head.trim(),
                ],
            );
        }
        let container = format!(
            "botcode-{}-{id}",
            sandbox::Instance::of(&config.data_dir).as_str()
        );
        let f = Self {
            _dir: dir,
            config,
            app,
            workspace,
            thread,
            id,
            container,
            mirror,
        };
        f.until("the warm-up started the container", |f| {
            f.verbs().contains(&"start".to_string())
        })
        .await;
        f
    }
    /// What the fake docker was asked to do with this container, in order: a verb such as
    /// `start`, or `exec <program> <subcommand>`.
    fn verbs(&self) -> Vec<String> {
        let calls =
            std::fs::read_to_string(harness().state.join("calls.jsonl")).unwrap_or_default();
        calls
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|call| {
                call["argv"]
                    .as_array()
                    .is_some_and(|argv| argv.iter().any(|arg| arg == self.container.as_str()))
            })
            .filter_map(|call| {
                if let Some(exec) = call.get("exec") {
                    let words: Vec<&str> = exec
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_str)
                        .take(2)
                        .map(|word| word.rsplit('/').next().unwrap_or(word))
                        .collect();
                    return Some(format!("exec {}", words.join(" ")));
                }
                let verb = call["argv"][0].as_str()?;
                if verb == "exec" || verb == "container" || verb == "inspect" {
                    return None;
                }
                Some(verb.to_owned())
            })
            .collect()
    }
    fn container_status(&self) -> Option<String> {
        let path = harness()
            .state
            .join(format!("container-{}.json", self.container));
        let record: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
        Some(record["status"].as_str()?.to_owned())
    }
    fn steer(&self, flag: &str, value: &str) {
        std::fs::write(
            harness().state.join(format!("{flag}-{}", self.container)),
            value,
        )
        .unwrap();
    }
    fn codex_home_dir(&self) -> PathBuf {
        self.config
            .data_dir
            .join("sandboxes")
            .join(self.id.as_str())
    }
    async fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let started = Instant::now();
        while !done(self) {
            assert!(
                started.elapsed() < PATIENCE,
                "{what}: timed out; docker saw {:?}",
                self.verbs()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    async fn state(&self) -> SandboxState {
        self.app
            .sandbox_state(self.workspace.id.clone(), self.thread.id.clone())
            .await
            .unwrap()
    }
    /// The docker log shows a step as it starts; the state follows when the step is done.
    async fn until_state(&self, expected: SandboxState) {
        let started = Instant::now();
        while self.state().await != expected {
            assert!(
                started.elapsed() < PATIENCE,
                "never {expected:?}; docker saw {:?}",
                self.verbs()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    async fn send(&self, request: &str, text: &str) -> Turn {
        let receipt = self
            .app
            .submit(self.thread.id.clone(), request.into(), text.into(), vec![])
            .await
            .unwrap();
        let started = Instant::now();
        loop {
            let snapshot = self.app.thread(self.thread.id.clone()).await.unwrap();
            let turn = snapshot
                .turns
                .iter()
                .find(|turn| turn.id == receipt.turn_id)
                .unwrap()
                .clone();
            if !turn.execution.active()
                && !matches!(
                    turn.checkpoint,
                    TurnCheckpoint::Pending | TurnCheckpoint::Before { .. }
                )
            {
                return turn;
            }
            assert!(
                started.elapsed() < PATIENCE,
                "turn did not settle: {}",
                serde_json::to_string_pretty(&snapshot).unwrap()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    /// The index of the first `verb` after position `from`.
    fn position(&self, verb: &str, from: usize) -> Option<usize> {
        self.verbs()
            .iter()
            .enumerate()
            .skip(from)
            .find(|(_, v)| v.as_str() == verb)
            .map(|(i, _)| i)
    }
}

#[tokio::test]
async fn an_idle_sandbox_pauses_then_stops_and_the_strip_state_follows() {
    let f = Fixture::new().await;
    assert!(matches!(
        f.state().await,
        SandboxState::Running | SandboxState::Starting
    ));
    f.until("the idle rule paused it", |f| {
        f.position("pause", 0).is_some()
    })
    .await;
    f.until_state(SandboxState::Paused).await;
    assert_eq!(f.container_status().as_deref(), Some("paused"));
    let paused = f.position("pause", 0).unwrap();
    assert!(
        f.verbs()[..paused].contains(&"exec sync capture".to_string()),
        "the mirror is pulled before the pause: {:?}",
        f.verbs()
    );
    f.until("the idle rule stopped it", |f| {
        f.position("stop", paused).is_some()
    })
    .await;
    f.until_state(SandboxState::Stopped).await;
    assert_eq!(f.container_status().as_deref(), Some("exited"));
    let verbs = f.verbs();
    let unpaused = f.position("unpause", paused).unwrap();
    let stopped = f.position("stop", paused).unwrap();
    assert!(
        unpaused < stopped && verbs[unpaused..stopped].contains(&"exec sync capture".to_string()),
        "a paused container is unpaused and pulled before it stops: {verbs:?}"
    );
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_message_wakes_a_paused_sandbox_through_both_launch_paths() {
    let f = Fixture::new().await;
    f.until("paused before the first message", |f| {
        f.position("pause", 0).is_some()
    })
    .await;
    let paused = f.position("pause", 0).unwrap();
    // No agent runs yet, so the launcher readies the container.
    let turn = f.send("req-1", "hello").await;
    assert_eq!(turn.execution, Execution::Completed, "{turn:?}");
    let woken = f
        .position("unpause", paused)
        .expect("the launch unpaused it");
    assert!(
        f.position("exec agent", woken).is_some(),
        "the agent started after the unpause: {:?}",
        f.verbs()
    );
    assert_eq!(f.state().await, SandboxState::Running);
    // The agent is live across the next pause; the turn path wakes the container itself.
    f.until("paused again with the agent live", |f| {
        f.position("pause", woken).is_some()
    })
    .await;
    let paused = f.position("pause", woken).unwrap();
    let before = f
        .verbs()
        .iter()
        .filter(|v| v.as_str() == "exec agent")
        .count();
    let turn = f.send("req-2", "hello again").await;
    assert_eq!(turn.execution, Execution::Completed, "{turn:?}");
    assert!(f.position("unpause", paused).is_some(), "{:?}", f.verbs());
    let after = f
        .verbs()
        .iter()
        .filter(|v| v.as_str() == "exec agent")
        .count();
    assert_eq!(
        after, before,
        "the live agent served the turn without a relaunch"
    );
    assert_eq!(f.state().await, SandboxState::Running);
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn settle_stops_the_container_and_its_agent_on_purpose() {
    let f = Fixture::new().await;
    f.send("req-1", "hello").await;
    let before = f.verbs().len();
    f.app
        .arrange(f.thread.id.clone(), Arrange::Settle)
        .await
        .unwrap();
    f.until("settle stopped it", |f| {
        f.position("stop", before).is_some()
    })
    .await;
    f.until_state(SandboxState::Stopped).await;
    let thread = f.app.thread(f.thread.id.clone()).await.unwrap();
    assert_eq!(
        thread.session,
        SessionState::Unavailable {
            reason: "Sandbox stopped. Your next message restarts it.".into()
        }
    );
    assert_eq!(thread.diagnostic, None, "a planned stop is not a loss");
    assert_eq!(f.container_status().as_deref(), Some("exited"));
    // Unsettle does nothing to the container; the next message starts it.
    f.app
        .arrange(f.thread.id.clone(), Arrange::Unsettle)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(f.container_status().as_deref(), Some("exited"));
    let turn = f.send("req-2", "hello again").await;
    assert_eq!(turn.execution, Execution::Completed, "{turn:?}");
    assert_eq!(f.container_status().as_deref(), Some("running"));
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn opening_a_stopped_sandbox_thread_is_a_read_and_starts_nothing() {
    let f = Fixture::new().await;
    f.send("req-1", "hello").await;
    f.until("stopped while idle", |f| f.position("stop", 0).is_some())
        .await;
    f.until_state(SandboxState::Stopped).await;
    let before = f.verbs().len();
    let thread = f.app.open_thread(f.thread.id.clone()).await.unwrap();
    assert!(
        matches!(thread.session, SessionState::Unavailable { .. }),
        "{:?}",
        thread.session
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    let verbs = f.verbs();
    assert!(
        !verbs[before..]
            .iter()
            .any(|v| v == "start" || v == "unpause" || v == "exec agent"),
        "opening the thread started nothing: {:?}",
        &verbs[before..]
    );
    assert_eq!(f.state().await, SandboxState::Stopped);
    let turn = f.send("req-2", "hello again").await;
    assert_eq!(turn.execution, Execution::Completed, "{turn:?}");
    assert_eq!(f.state().await, SandboxState::Running);
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn deleting_the_last_thread_removes_the_container_and_its_codex_home() {
    let f = Fixture::new().await;
    f.send("req-1", "hello").await;
    assert!(f.codex_home_dir().exists());
    let before = f.verbs().len();
    f.app.delete_thread(f.thread.id.clone()).await.unwrap();
    let verbs = f.verbs();
    let pulled = verbs[before..]
        .iter()
        .position(|v| v == "exec sync capture")
        .expect("a final pull");
    let removed = verbs[before..]
        .iter()
        .position(|v| v == "rm")
        .expect("the container was removed");
    assert!(pulled < removed, "{verbs:?}");
    assert_eq!(f.container_status(), None);
    assert!(!f.codex_home_dir().exists(), "the Codex home went with it");
    assert_eq!(
        f.app.thread(f.thread.id.clone()).await.unwrap_err().code,
        "missing_thread"
    );
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_failed_final_pull_keeps_the_container_the_codex_home_and_the_thread() {
    let f = Fixture::new().await;
    f.send("req-1", "hello").await;
    f.steer("fail-capture", "1");
    let error = f.app.delete_thread(f.thread.id.clone()).await.unwrap_err();
    assert_eq!(error.code, "sandbox_kept");
    assert!(
        error.message.contains("could not be synced") && error.message.contains("capture failed"),
        "{}",
        error.message
    );
    assert!(f.container_status().is_some(), "the container stays");
    assert!(f.codex_home_dir().exists());
    assert!(f.mirror.exists(), "the worktree stays");
    assert!(
        f.app.thread(f.thread.id.clone()).await.is_ok(),
        "the thread stays"
    );
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_storage_sweep_retires_the_container_before_removing_the_worktree() {
    let f = Fixture::new().await;
    std::fs::write(
        f.config.data_dir.join("settings.json"),
        r#"{"storageCleanup":{"worktreeAfterDays":null,"worktreeUnchanged":true}}"#,
    )
    .unwrap();
    f.steer("fail-capture", "1");
    f.app.sweep_worktrees_at(u64::MAX / 2).await;
    assert!(f.mirror.exists(), "a failed final pull keeps the worktree");
    assert!(f.container_status().is_some());
    std::fs::remove_file(
        harness()
            .state
            .join(format!("fail-capture-{}", f.container)),
    )
    .unwrap();
    let before = f.verbs().len();
    f.app.sweep_worktrees_at(u64::MAX / 2).await;
    assert!(!f.mirror.exists(), "the worktree was removed");
    assert_eq!(f.container_status(), None, "the container was removed");
    assert!(
        f.codex_home_dir().exists(),
        "the Codex home stays for the next message"
    );
    let verbs = f.verbs();
    assert!(
        verbs[before..].contains(&"exec sync capture".to_string()),
        "pulled before removal: {verbs:?}"
    );
    assert!(
        f.app.thread(f.thread.id.clone()).await.is_ok(),
        "the thread stays"
    );
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn terminal_input_wakes_a_paused_sandbox_first() {
    let f = Fixture::new().await;
    let output = Arc::new(Mutex::new(String::new()));
    let term = TerminalId::try_from("term-1".to_string()).unwrap();
    f.app
        .terminal_attach(
            f.workspace.id.clone(),
            Some(f.thread.id.clone()),
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
    f.until("paused with an idle shell attached", |f| {
        f.position("pause", 0).is_some()
    })
    .await;
    let paused = f.position("pause", 0).unwrap();
    f.app
        .terminal_write(
            f.workspace.id.clone(),
            Some(f.thread.id.clone()),
            term.clone(),
            "echo wo''ke\n".into(),
        )
        .await
        .unwrap();
    assert!(
        f.position("unpause", paused).is_some(),
        "the write woke the sandbox first: {:?}",
        f.verbs()
    );
    assert_eq!(f.state().await, SandboxState::Running);
    let started = Instant::now();
    while !output.lock().unwrap().contains("woke") {
        assert!(started.elapsed() < PATIENCE, "{:?}", output.lock().unwrap());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    f.app
        .terminal_close(f.workspace.id.clone(), Some(f.thread.id.clone()), term)
        .await
        .unwrap();
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn terminal_input_to_a_paused_sandbox_sends_the_strip_a_change_hint() {
    let f = Fixture::new().await;
    let term = TerminalId::try_from("term-hint".to_string()).unwrap();
    f.app
        .terminal_attach(
            f.workspace.id.clone(),
            Some(f.thread.id.clone()),
            term.clone(),
            80,
            24,
            |_| {},
        )
        .await
        .unwrap();
    f.until("paused with an idle shell attached", |f| {
        f.position("pause", 0).is_some()
    })
    .await;
    f.until_state(SandboxState::Paused).await;
    // The pause's own hint is on its way; let it pass before listening.
    let mut hints = f.app.subscribe();
    tokio::time::sleep(Duration::from_millis(500)).await;
    while hints.try_recv().is_ok() {}
    // No newline: the shell shows no new prompt, so no pull after a command sends a hint.
    f.app
        .terminal_write(
            f.workspace.id.clone(),
            Some(f.thread.id.clone()),
            term.clone(),
            "ls".into(),
        )
        .await
        .unwrap();
    assert_eq!(f.state().await, SandboxState::Running);
    // Well inside the pause window, so the next idle pause cannot stand in for the wake.
    let hint = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let hint = hints.recv().await.expect("the change channel stays open");
            if hint.thread_id == f.thread.id {
                break hint;
            }
        }
    })
    .await
    .expect("the wake sent the renderer a change hint for the thread");
    assert_eq!(hint.workspace_id, f.workspace.id);
    assert_eq!(
        f.state().await,
        SandboxState::Running,
        "the hint arrived while the container runs, so the strip reads Running"
    );
    f.app
        .terminal_close(f.workspace.id.clone(), Some(f.thread.id.clone()), term)
        .await
        .unwrap();
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_desktop_stops_after_the_window_without_a_tab_and_a_connected_tab_keeps_everything() {
    let f = Fixture::new().await;
    f.app
        .sandbox_desktop(f.workspace.id.clone(), f.thread.id.clone())
        .await
        .unwrap();
    f.until("the idle desktop was stopped", |f| {
        f.position("exec desktop stop", 0).is_some()
    })
    .await;
    let stopped = f.position("exec desktop stop", 0).unwrap();
    assert!(
        f.position("pause", 0).is_none_or(|paused| paused > stopped),
        "the desktop stops before the container pauses: {:?}",
        f.verbs()
    );
    f.until("then the sandbox paused", |f| {
        f.position("pause", stopped).is_some()
    })
    .await;

    // A connected tab keeps the desktop and the container.
    f.steer("probe-clients", "1");
    f.send("req-1", "hello").await;
    f.app
        .sandbox_desktop(f.workspace.id.clone(), f.thread.id.clone())
        .await
        .unwrap();
    let before = f.verbs().len();
    tokio::time::sleep(Duration::from_secs(7)).await;
    let verbs = f.verbs();
    assert!(
        !verbs[before..]
            .iter()
            .any(|v| v == "pause" || v == "exec desktop stop"),
        "a connected tab keeps the desktop and the container running: {:?}",
        &verbs[before..]
    );
    assert_eq!(f.state().await, SandboxState::Running);
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn cpu_in_the_container_keeps_a_sandbox_running() {
    let f = Fixture::new().await;
    f.steer("probe-cpu-usec", "0");
    f.send("req-1", "hello").await;
    // Half a second of CPU per second, until the file stops moving.
    let busy = {
        let (state, container) = (harness().state.clone(), f.container.clone());
        tokio::spawn(async move {
            let mut used = 0u64;
            loop {
                used += 500_000;
                std::fs::write(
                    state.join(format!("probe-cpu-usec-{container}")),
                    used.to_string(),
                )
                .unwrap();
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        })
    };
    tokio::time::sleep(Duration::from_secs(8)).await;
    assert!(
        f.position("pause", 0).is_none(),
        "a busy container never paused: {:?}",
        f.verbs()
    );
    assert_eq!(f.state().await, SandboxState::Running);
    busy.abort();
    f.until("quiet, it pauses", |f| f.position("pause", 0).is_some())
        .await;
    f.app.shutdown().await.unwrap();
}

#[tokio::test]
async fn quitting_pulls_and_stops_a_paused_sandbox() {
    let f = Fixture::new().await;
    f.until("paused", |f| f.position("pause", 0).is_some())
        .await;
    let paused = f.position("pause", 0).unwrap();
    f.app.shutdown().await.unwrap();
    let verbs = f.verbs();
    let unpaused = f.position("unpause", paused).expect("unpaused to pull");
    let stopped = f.position("stop", unpaused).expect("stopped at quit");
    assert!(
        verbs[unpaused..stopped].contains(&"exec sync capture".to_string()),
        "{verbs:?}"
    );
    assert_eq!(f.container_status().as_deref(), Some("exited"));
}
