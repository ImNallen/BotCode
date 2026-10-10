#![cfg(unix)]
#![allow(clippy::disallowed_methods)]
use bot_core::*;
use std::{
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};

struct Fixture {
    _dir: tempfile::TempDir,
    config: RuntimeConfig,
    repository: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repository = dir.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        std::fs::write(repository.join("README.md"), "fixture\n").unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["add", "README.md"],
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
            let status = Command::new("git")
                .arg("-C")
                .arg(&repository)
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        }
        Self {
            config: RuntimeConfig {
                data_dir: dir.path().join("state"),
                codex_binary: dir.path().join("no-codex"),
                gh_binary: dir.path().join("no-gh"),
                network_timeout: Duration::from_secs(5),
                shell: Some("/bin/sh".into()),
            },
            _dir: dir,
            repository,
        }
    }
}

#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<TerminalEvent>>>);
impl Events {
    fn sink(&self) -> impl Fn(TerminalEvent) + Send + Sync + 'static {
        let events = self.0.clone();
        move |event| events.lock().unwrap().push(event)
    }
    fn all(&self) -> Vec<TerminalEvent> {
        self.0.lock().unwrap().clone()
    }
    fn output(&self) -> String {
        self.all()
            .into_iter()
            .filter_map(|event| match event {
                TerminalEvent::Output { data } => Some(data),
                _ => None,
            })
            .collect()
    }
    fn snapshot(&self) -> String {
        match self.all().first() {
            Some(TerminalEvent::Snapshot { history }) => history.clone(),
            other => panic!("The first event must be a snapshot, got {other:?}"),
        }
    }
    async fn until(&self, what: &str, done: impl Fn(&[TerminalEvent]) -> bool) {
        for _ in 0..3000 {
            if done(&self.all()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("Timed out awaiting {what}. Events: {:?}", self.all());
    }
    async fn output_containing(&self, needle: &str) -> String {
        self.until(needle, |_| self.output().contains(needle)).await;
        self.output()
    }
    async fn pid(&self) -> i32 {
        self.until("a pid", |_| last_pid(&self.output()).is_some())
            .await;
        last_pid(&self.output()).unwrap()
    }
}
fn last_pid(text: &str) -> Option<i32> {
    text.rmatch_indices("pid=").find_map(|(at, _)| {
        let digits: String = text[at + 4..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        digits.parse().ok()
    })
}
fn term(id: &str) -> TerminalId {
    id.parse().unwrap()
}
fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}
async fn gone(pid: i32, why: &str) {
    for _ in 0..3000 {
        if !alive(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{why}: pid {pid} is still alive");
}
async fn write(app: &App, workspace: &WorkspaceId, thread: Option<&ThreadId>, data: &str) {
    app.terminal_write(
        workspace.clone(),
        thread.cloned(),
        term("term-1"),
        data.into(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn attaching_to_a_thread_starts_the_shell_in_its_checkout() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = app
        .create_thread(
            workspace.id.clone(),
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: false,
            },
        )
        .await
        .unwrap();
    let Checkout::Worktree { path, .. } = &thread.checkout else {
        panic!("expected a worktree checkout")
    };
    let events = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        Some(thread.id.clone()),
        term("term-1"),
        80,
        24,
        events.sink(),
    )
    .await
    .unwrap();
    write(&app, &workspace.id, Some(&thread.id), "pwd\n").await;
    let worktree = path.canonicalize().unwrap();
    events
        .output_containing(&format!("{}\r\n", worktree.display()))
        .await;

    let draft = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        None,
        term("term-1"),
        80,
        24,
        draft.sink(),
    )
    .await
    .unwrap();
    write(&app, &workspace.id, None, "pwd\n").await;
    let root = f.repository.canonicalize().unwrap();
    draft
        .output_containing(&format!("{}\r\n", root.display()))
        .await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn reattaching_replays_history_from_the_same_shell() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let first = Events::default();
    let subscription = app
        .terminal_attach(
            workspace.id.clone(),
            None,
            term("term-1"),
            80,
            24,
            first.sink(),
        )
        .await
        .unwrap();
    assert_eq!(first.snapshot(), "");
    write(
        &app,
        &workspace.id,
        None,
        "echo bot-code-$((40+2)); echo pid=$$\n",
    )
    .await;
    first.output_containing("bot-code-42\r\n").await;
    let pid = first.pid().await;

    app.terminal_detach(subscription);
    let detached = first.all().len();
    write(&app, &workspace.id, None, "echo while-$((1+1))\n").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        first.all().len(),
        detached,
        "A detached subscriber receives nothing"
    );

    let second = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        None,
        term("term-1"),
        80,
        24,
        second.sink(),
    )
    .await
    .unwrap();
    let snapshot = second.snapshot();
    assert!(snapshot.contains("bot-code-42\r\n"), "{snapshot:?}");
    assert!(
        snapshot.contains("while-2\r\n"),
        "Output while detached is kept: {snapshot:?}"
    );
    write(&app, &workspace.id, None, "echo pid=$$\n").await;
    second.output_containing("pid=").await;
    assert_eq!(second.pid().await, pid, "Re-attaching keeps the same shell");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn resize_reaches_the_shell() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let events = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        None,
        term("term-1"),
        80,
        24,
        events.sink(),
    )
    .await
    .unwrap();
    app.terminal_resize(workspace.id.clone(), None, term("term-1"), 101, 37)
        .unwrap();
    write(&app, &workspace.id, None, "stty size\n").await;
    events.output_containing("37 101\r\n").await;

    let again = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        None,
        term("term-1"),
        90,
        13,
        again.sink(),
    )
    .await
    .unwrap();
    write(&app, &workspace.id, None, "stty size\n").await;
    again.output_containing("13 90\r\n").await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn close_kills_the_shell_and_its_foreground_job() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let events = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        None,
        term("term-1"),
        80,
        24,
        events.sink(),
    )
    .await
    .unwrap();
    write(&app, &workspace.id, None, "echo pid=$$; sleep 31\n").await;
    let pid = events.pid().await;
    let mut sleeper = None;
    for _ in 0..3000 {
        let out = Command::new("pgrep")
            .args(["-P", &pid.to_string(), "sleep"])
            .output()
            .unwrap();
        sleeper = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<i32>()
            .ok();
        if sleeper.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let sleeper = sleeper.expect("the shell runs sleep");
    app.terminal_close(workspace.id.clone(), None, term("term-1"))
        .await
        .unwrap();
    assert!(!alive(pid), "Close returns after the shell is reaped");
    gone(sleeper, "Close must end the foreground job").await;
    app.terminal_close(workspace.id.clone(), None, term("term-1"))
        .await
        .unwrap();
    write(&app, &workspace.id, None, "echo ignored\n").await;
    app.terminal_resize(workspace.id.clone(), None, term("term-1"), 80, 24)
        .unwrap();
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn exit_reports_the_code_and_the_next_attach_starts_fresh() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let events = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        None,
        term("term-1"),
        80,
        24,
        events.sink(),
    )
    .await
    .unwrap();
    write(&app, &workspace.id, None, "echo pid=$$\n").await;
    let pid = events.pid().await;
    write(&app, &workspace.id, None, "exit 3\n").await;
    events
        .until("exit", |events| {
            events.last() == Some(&TerminalEvent::Exited { exit_code: Some(3) })
        })
        .await;
    assert!(!alive(pid), "Exit reaps the shell");

    let fresh = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        None,
        term("term-1"),
        80,
        24,
        fresh.sink(),
    )
    .await
    .unwrap();
    assert_eq!(
        fresh.snapshot(),
        "",
        "A new shell starts with empty history"
    );
    write(&app, &workspace.id, None, "echo pid=$$\n").await;
    assert_ne!(fresh.pid().await, pid);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_kills_shells_and_releases_the_data_directory() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let events = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        None,
        term("term-1"),
        80,
        24,
        events.sink(),
    )
    .await
    .unwrap();
    write(&app, &workspace.id, None, "echo pid=$$\n").await;
    let pid = events.pid().await;

    let open_files = |pid: u32| {
        let out = Command::new("lsof")
            .args(["-p", &pid.to_string(), "-Fn"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    assert!(
        open_files(std::process::id()).contains("runtime.lock"),
        "The runtime holds its lock, so lsof can see it"
    );
    let shell_files = open_files(pid as u32);
    assert!(shell_files.contains("/dev/tty"), "{shell_files}");
    assert!(
        !shell_files.contains("runtime.lock"),
        "The shell must not inherit runtime.lock: {shell_files}"
    );

    app.shutdown().await.unwrap();
    assert!(!alive(pid), "Shutdown returns after shells are reaped");
    let reopened = App::open(f.config.clone()).await.unwrap();
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn dropping_the_app_kills_shells() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let events = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        None,
        term("term-1"),
        80,
        24,
        events.sink(),
    )
    .await
    .unwrap();
    write(&app, &workspace.id, None, "echo pid=$$\n").await;
    let pid = events.pid().await;
    drop(app);
    gone(pid, "Dropping all App handles must kill the shell").await;
}

#[tokio::test]
async fn removing_a_workspace_closes_its_terminals() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let events = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        None,
        term("term-1"),
        80,
        24,
        events.sink(),
    )
    .await
    .unwrap();
    write(&app, &workspace.id, None, "echo pid=$$\n").await;
    let pid = events.pid().await;
    app.remove_workspace(workspace.id.clone()).await.unwrap();
    assert!(!alive(pid), "Removing the workspace reaps its shell");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn boundaries_reject_invalid_input() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    assert!(serde_json::from_str::<TerminalId>("\"\"").is_err());
    assert!(serde_json::from_str::<TerminalId>("\"   \"").is_err());
    assert_eq!(
        "".parse::<TerminalId>().unwrap_err().code,
        "invalid_terminal"
    );
    let attach = |cols, rows| {
        app.terminal_attach(
            workspace.id.clone(),
            None,
            term("term-1"),
            cols,
            rows,
            |_| {},
        )
    };
    for (cols, rows) in [(0, 24), (80, 0), (1001, 24), (80, 501)] {
        assert_eq!(
            attach(cols, rows).await.unwrap_err().code,
            "invalid_terminal_size"
        );
    }
    assert_eq!(
        app.terminal_resize(workspace.id.clone(), None, term("term-1"), 0, 24)
            .unwrap_err()
            .code,
        "invalid_terminal_size"
    );
    for data in [String::new(), "x".repeat(65_537)] {
        assert_eq!(
            app.terminal_write(workspace.id.clone(), None, term("term-1"), data)
                .await
                .unwrap_err()
                .code,
            "invalid_terminal_input"
        );
    }
    app.terminal_write(
        workspace.id.clone(),
        None,
        term("term-1"),
        "x".repeat(65_536),
    )
    .await
    .unwrap();

    let thread = app
        .create_thread(
            workspace.id.clone(),
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: false,
            },
        )
        .await
        .unwrap();
    let Checkout::Worktree { path, .. } = &thread.checkout else {
        panic!("expected a worktree checkout")
    };
    std::fs::remove_dir_all(path).unwrap();
    assert_eq!(
        app.terminal_attach(
            workspace.id.clone(),
            Some(thread.id),
            term("term-1"),
            80,
            24,
            |_| {}
        )
        .await
        .unwrap_err()
        .code,
        "worktree_removed"
    );

    let scratch = app.ensure_scratch().await.unwrap();
    assert_eq!(
        app.terminal_attach(scratch.id, None, term("term-1"), 80, 24, |_| {})
            .await
            .unwrap_err()
            .code,
        "terminal_unavailable"
    );
    app.shutdown().await.unwrap();
}

#[test]
fn events_serialize_with_a_type_tag_and_camel_case_fields() {
    let json = |event| serde_json::to_value(event).unwrap();
    assert_eq!(
        json(TerminalEvent::Snapshot {
            history: "h".into()
        }),
        serde_json::json!({"type":"snapshot","history":"h"})
    );
    assert_eq!(
        json(TerminalEvent::Output { data: "d".into() }),
        serde_json::json!({"type":"output","data":"d"})
    );
    assert_eq!(
        json(TerminalEvent::Exited { exit_code: Some(3) }),
        serde_json::json!({"type":"exited","exitCode":3})
    );
    assert_eq!(
        json(TerminalEvent::Exited { exit_code: None }),
        serde_json::json!({"type":"exited","exitCode":null})
    );
}

#[tokio::test]
async fn deleting_a_thread_reaps_all_its_shells_and_preserves_other_terminals() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = app
        .create_thread(workspace.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let draft = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        None,
        term("term-1"),
        80,
        24,
        draft.sink(),
    )
    .await
    .unwrap();
    write(&app, &workspace.id, None, "echo pid=$$\n").await;
    let draft_pid = draft.pid().await;
    let mut pids = vec![];
    for name in ["term-1", "term-2"] {
        let events = Events::default();
        app.terminal_attach(
            workspace.id.clone(),
            Some(thread.id.clone()),
            term(name),
            80,
            24,
            events.sink(),
        )
        .await
        .unwrap();
        app.terminal_write(
            workspace.id.clone(),
            Some(thread.id.clone()),
            term(name),
            "echo pid=$$\n".into(),
        )
        .await
        .unwrap();
        pids.push(events.pid().await);
    }
    app.delete_thread(thread.id.clone()).await.unwrap();
    for pid in pids {
        assert!(!alive(pid), "Deletion returns after every shell is reaped");
    }
    assert!(alive(draft_pid));
    assert!(
        app.terminal_attach(
            workspace.id.clone(),
            Some(thread.id),
            term("term-3"),
            80,
            24,
            |_| {}
        )
        .await
        .is_err()
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn canceled_delete_caller_does_not_release_the_actor_job_or_checkout_hold() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = app
        .create_thread(workspace.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let sibling = app
        .create_thread(workspace.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let events = Events::default();
    app.terminal_attach(
        workspace.id.clone(),
        Some(thread.id.clone()),
        term("term-1"),
        80,
        24,
        events.sink(),
    )
    .await
    .unwrap();
    write(
        &app,
        &workspace.id,
        Some(&thread.id),
        "trap '' HUP; echo pid=$$\n",
    )
    .await;
    let pid = events.pid().await;
    let deletion = tokio::spawn({
        let app = app.clone();
        let id = thread.id.clone();
        async move { app.delete_thread(id).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !deletion.is_finished(),
        "The shell ignores HUP, so the actor job is still stopping it"
    );
    deletion.abort();
    assert_eq!(
        app.delete_thread(sibling.id.clone())
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    gone(
        pid,
        "Deletion must reap the shell even after caller cancellation",
    )
    .await;
    for _ in 0..3000 {
        if app
            .thread(thread.id.clone())
            .await
            .is_err_and(|error| error.code == "missing_thread")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        app.thread(thread.id).await.unwrap_err().code,
        "missing_thread"
    );
    app.delete_thread(sibling.id).await.unwrap();
    app.shutdown().await.unwrap();
}
