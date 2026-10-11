#![cfg(unix)]
use bot_core::*;
use std::os::unix::fs::PermissionsExt;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

struct Fixture {
    dir: tempfile::TempDir,
    config: RuntimeConfig,
    binary: PathBuf,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("codex peer");
        std::fs::write(dir.path().join("mode"), mode).unwrap();
        std::fs::write(&binary, r#"#!/usr/bin/env python3
import json, pathlib, sys, time
root = pathlib.Path(__file__).parent
mode = (root / 'mode').read_text()
if sys.argv[1] == '--version':
    if mode == 'version_stall': time.sleep(60)
    print('codex-cli 1.2.3')
    sys.exit(0)
if sys.argv[1] == 'login':
    (root / 'login-ran').touch()
    print('LOGIN_DONE', flush=True)
    sys.exit(0)
(root / 'pid').write_text(str(__import__('os').getpid()))
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request: continue
    if request['method'] == 'initialize':
        response = {}
    elif request['method'] == 'account/read':
        if mode == 'stall': time.sleep(60)
        if mode == 'malformed': response = {'account': 'private-token', 'requiresOpenaiAuth': True}
        elif mode == 'unauthenticated': response = {'account': None, 'requiresOpenaiAuth': True}
        elif mode == 'no_auth': response = {'account': None, 'requiresOpenaiAuth': False}
        else: response = {'account': {'type': 'chatgpt', 'email': 'secret@example.invalid', 'token': 'private-token'}, 'requiresOpenaiAuth': True}
    else: response = {}
    print(json.dumps({'id': request['id'], 'result': response}), flush=True)
"#).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = RuntimeConfig {
            data_dir: dir.path().join("state"),
            codex_binary: binary.clone(),
            gh_binary: dir.path().join("no-gh"),
            network_timeout: Duration::from_secs(5),
            shell: Some("/bin/sh".into()),
        };
        Self {
            dir,
            config,
            binary,
        }
    }
}
#[tokio::test]
async fn readiness_uses_the_configured_peer_and_does_not_publish_credentials() {
    for (mode, expected) in [
        ("ready", "ready"),
        ("unauthenticated", "unauthenticated"),
        ("no_auth", "ready"),
        ("malformed", "attention"),
    ] {
        let fixture = Fixture::new(mode);
        let app = App::open(fixture.config.clone()).await.unwrap();
        let result = serde_json::to_value(app.codex_readiness().await).unwrap();
        assert_eq!(result["kind"], expected);
        let serialized = result.to_string();
        assert!(!serialized.contains("secret@example.invalid"));
        assert!(!serialized.contains("private-token"));
        let log = std::fs::read_to_string(fixture.config.data_dir.join("logs/codex.log"))
            .unwrap_or_default();
        assert!(!log.contains("private-token"));
        let pid: i32 = std::fs::read_to_string(fixture.dir.path().join("pid"))
            .unwrap()
            .parse()
            .unwrap();
        for _ in 0..100 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "probe process must stop");
        app.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn missing_configured_binary_remains_missing_even_with_a_default_cli() {
    let fixture = Fixture::new("ready");
    let mut config = fixture.config.clone();
    config.codex_binary = fixture.dir.path().join("does-not-exist");
    let app = App::open(config).await.unwrap();
    assert_eq!(app.codex_readiness().await, CodexReadiness::Missing);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn stalled_version_and_account_reads_are_bounded() {
    for mode in ["version_stall", "stall"] {
        let fixture = Fixture::new(mode);
        let app = App::open(fixture.config.clone()).await.unwrap();
        let result = tokio::time::timeout(Duration::from_secs(8), app.codex_readiness())
            .await
            .unwrap();
        assert!(matches!(result, CodexReadiness::Attention { .. }));
        app.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn setup_terminal_is_isolated_and_pretypes_without_enter() {
    let fixture = Fixture::new("ready");
    let app = App::open(fixture.config.clone()).await.unwrap();
    let terminal: TerminalId = "setup-login".parse().unwrap();
    let command = app
        .setup_terminal_open(terminal.clone(), CodexSetupAction::SignIn)
        .await
        .unwrap();
    assert!(command.contains(&fixture.binary.to_string_lossy().into_owned()));
    assert!(!command.ends_with(['\n', '\r']));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!fixture.dir.path().join("login-ran").exists());
    assert!(app.list_workspaces().await.unwrap().is_empty());
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = events.clone();
    let subscription = app
        .setup_terminal_attach(terminal.clone(), 80, 24, move |event| {
            observed.lock().unwrap().push(event)
        })
        .await
        .unwrap();
    assert!(matches!(
        events.lock().unwrap().first(),
        Some(TerminalEvent::Snapshot { .. })
    ));
    app.setup_terminal_write(terminal.clone(), "\n".into())
        .await
        .unwrap();
    for _ in 0..200 {
        if fixture.dir.path().join("login-ran").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(fixture.dir.path().join("login-ran").exists());
    app.setup_terminal_write(terminal.clone(), "\npwd\n".into())
        .await
        .unwrap();
    for _ in 0..200 {
        let output = format!("{:?}", events.lock().unwrap());
        if output.contains("agent-setup") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(format!("{:?}", events.lock().unwrap()).contains("agent-setup"));
    app.setup_terminal_write(terminal.clone(), "exit\n".into())
        .await
        .unwrap();
    for _ in 0..200 {
        if events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, TerminalEvent::Exited { .. }))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, TerminalEvent::Exited { .. }))
    );
    app.setup_terminal_detach(subscription);
    app.setup_terminal_close(terminal.clone()).await.unwrap();
    assert!(
        app.setup_terminal_attach(terminal, 80, 24, |_| {})
            .await
            .is_err()
    );
    assert!(app.list_workspaces().await.unwrap().is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn setup_installer_is_pretyped_and_closing_forgets_its_history() {
    let fixture = Fixture::new("ready");
    let app = App::open(fixture.config.clone()).await.unwrap();
    let terminal: TerminalId = "setup-install".parse().unwrap();
    let command = app
        .setup_terminal_open(terminal.clone(), CodexSetupAction::Install)
        .await
        .unwrap();
    assert_eq!(
        command,
        "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
    );
    tokio::time::sleep(Duration::from_millis(50)).await;
    app.setup_terminal_close(terminal.clone()).await.unwrap();
    app.setup_terminal_close(terminal.clone()).await.unwrap();
    assert!(
        app.setup_terminal_attach(terminal, 80, 24, |_| {})
            .await
            .is_err()
    );
    app.shutdown().await.unwrap();
}
