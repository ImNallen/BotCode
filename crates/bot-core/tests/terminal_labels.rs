#![cfg(any(target_os = "macos", windows))]
use bot_core::*;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(if cfg!(windows) { 10 } else { 5 });

struct Fixture {
    _dir: tempfile::TempDir,
    app: App,
    workspace: WorkspaceId,
}
impl Fixture {
    async fn new(shell: Option<std::path::PathBuf>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("repository");
        std::fs::create_dir(&folder).unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "initial",
            ],
        ] {
            let status = process::command("git")
                .arg("-C")
                .arg(&folder)
                .args(args)
                .status()
                .unwrap();
            assert!(status.success());
        }
        let app = App::open(RuntimeConfig {
            data_dir: dir.path().join("state"),
            codex_binary: dir.path().join("no-codex"),
            gh_binary: dir.path().join("no-gh"),
            network_timeout: Duration::from_secs(5),
            compaction_timeout: Duration::from_secs(600),
            shell,
        })
        .await
        .unwrap();
        let workspace = app.open_workspace(folder).await.unwrap().id;
        Self {
            _dir: dir,
            app,
            workspace,
        }
    }
    #[cfg(target_os = "macos")]
    async fn start(&self) {
        let subscription = self
            .app
            .terminal_attach(self.workspace.clone(), None, term(), 80, 24, |_| {})
            .await
            .unwrap();
        self.app.terminal_detach(subscription);
    }
    /// ConPTY asks for the cursor position before the shell runs and waits for the terminal to
    /// answer, as Ghostty does in the app.
    #[cfg(windows)]
    async fn start_answering_cursor_queries(&self) {
        let (queries, mut asked) = tokio::sync::mpsc::unbounded_channel();
        self.app
            .terminal_attach(self.workspace.clone(), None, term(), 80, 24, move |event| {
                if let TerminalEvent::Output { data } = event
                    && data.contains("\x1b[6n")
                {
                    let _ = queries.send(());
                }
            })
            .await
            .unwrap();
        let (app, workspace) = (self.app.clone(), self.workspace.clone());
        tokio::spawn(async move {
            while asked.recv().await.is_some() {
                let _ = app
                    .terminal_write(workspace.clone(), None, term(), "\x1b[1;1R".into())
                    .await;
            }
        });
    }
    async fn write(&self, data: &str) {
        self.app
            .terminal_write(self.workspace.clone(), None, term(), data.into())
            .await
            .unwrap();
    }
    fn labels(&self) -> TerminalLabels {
        self.app.watch_terminal_labels().borrow().clone()
    }
    async fn until(&self, what: &str, done: impl Fn(&TerminalLabels) -> bool) -> TerminalLabels {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            let labels = self.labels();
            if done(&labels) {
                return labels;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("Timed out awaiting {what}. Labels: {:?}", self.labels());
    }
    fn only(&self, label: &str) -> Vec<TerminalLabel> {
        vec![TerminalLabel {
            workspace_id: self.workspace.clone(),
            thread_id: None,
            terminal_id: term(),
            label: label.into(),
        }]
    }
}
fn term() -> TerminalId {
    "term-1".parse().unwrap()
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_running_command_labels_its_terminal_until_it_ends() {
    let f = Fixture::new(Some("/bin/sh".into())).await;
    f.start().await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(f.labels().labels, [], "An idle shell has no label");

    f.write("sleep 30\n").await;
    let running = f
        .until("the sleep label", |l| l.labels == f.only("sleep"))
        .await;
    f.write("\x03").await;
    let idle = f.until("the label to clear", |l| l.labels.is_empty()).await;
    assert!(idle.sequence > running.sequence);

    f.write("sleep 30\n").await;
    let running = f
        .until("the sleep label again", |l| l.labels == f.only("sleep"))
        .await;
    f.app
        .terminal_close(f.workspace.clone(), None, term())
        .await
        .unwrap();
    let closed = f.labels();
    assert_eq!(closed.labels, [], "Closing forgets the label at once");
    assert!(closed.sequence > running.sequence);
    f.app.shutdown().await.unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn a_running_command_labels_its_terminal_until_it_is_closed() {
    let f = Fixture::new(None).await;
    f.start_answering_cursor_queries().await;
    f.write("ping -n 30 127.0.0.1\r\n").await;
    let running = f
        .until("the ping label", |l| {
            l.labels.len() == 1 && l.labels[0].label.eq_ignore_ascii_case("ping")
        })
        .await;
    assert_eq!(running.labels, f.only(&running.labels[0].label));
    f.app
        .terminal_close(f.workspace.clone(), None, term())
        .await
        .unwrap();
    let closed = f.labels();
    assert_eq!(closed.labels, []);
    assert!(closed.sequence > running.sequence);
    f.app.shutdown().await.unwrap();
}
