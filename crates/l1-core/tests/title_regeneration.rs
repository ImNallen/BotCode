#![cfg(unix)]
#![allow(clippy::disallowed_methods)]
use l1_core::*;
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

const LIMIT: Duration = Duration::from_secs(30);
const PEER_TITLE: &str = "Regenerated Fixture Title";
struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    peer: PathBuf,
    config: RuntimeConfig,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-qb", "main"]);
        git(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
        );
        let peer = dir.path().join("peer.py");
        std::fs::write(&peer, include_str!("support/codex_peer.py")).unwrap();
        std::fs::set_permissions(&peer, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = RuntimeConfig {
            data_dir: dir.path().join("state"),
            codex_binary: peer.clone(),
            gh_binary: dir.path().join("no-gh"),
            network_timeout: Duration::from_secs(180),
            compaction_timeout: Duration::from_secs(600),
            shell: None,
        };
        Self {
            _dir: dir,
            root,
            peer,
            config,
        }
    }
    fn control(&self, name: &str, value: &str) {
        std::fs::write(self.file(name), value).unwrap();
    }
    fn file(&self, name: &str) -> PathBuf {
        self.peer.parent().unwrap().join(name)
    }
    fn invocations(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.file("title.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    async fn thread(&self, app: &App) -> ThreadSnapshot {
        let workspace = app.open_workspace(self.root.clone()).await.unwrap();
        app.create_thread(workspace.id, NewCheckout::Local)
            .await
            .unwrap()
    }
    async fn worked_thread(&self, app: &App) -> ThreadSnapshot {
        let t = self.thread(app).await;
        app.submit(
            t.id.clone(),
            "first".into(),
            "Fix API token refresh".into(),
            vec![],
        )
        .await
        .unwrap();
        wait(app, &t.id, |t| {
            matches!(t.session, SessionState::Ready)
                && t.turns[0]
                    .items
                    .iter()
                    .any(|item| matches!(item, Item::Assistant { complete: true, .. }))
        })
        .await;
        app.rename_thread(t.id.clone(), "Previous title".into())
            .await
            .unwrap()
    }
}
fn git(path: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().into()
}
async fn wait(
    app: &App,
    id: &ThreadId,
    predicate: impl Fn(&ThreadSnapshot) -> bool,
) -> ThreadSnapshot {
    let started = Instant::now();
    let mut last = None;
    while started.elapsed() < LIMIT {
        let t = app.thread(id.clone()).await.unwrap();
        if predicate(&t) {
            return t;
        }
        last = Some(t);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("snapshot did not reach expected state; last snapshot: {last:#?}")
}
async fn wait_file(path: &Path) {
    let started = Instant::now();
    while started.elapsed() < LIMIT {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("fixture file did not appear")
}
async fn wait_dead(pid: i32) {
    tokio::time::timeout(LIMIT, async {
        while unsafe { libc::kill(pid, 0) } == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("title process survived cancellation");
}
async fn summary(app: &App, t: &ThreadSnapshot) -> ThreadSummary {
    app.list_thread_summaries(t.workspace_id.clone())
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.id == t.id)
        .unwrap()
}

#[tokio::test]
async fn regeneration_titles_the_thread_from_its_history_and_previous_title() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.worked_thread(&app).await;
    app.regenerate_title(t.id.clone()).await.unwrap();
    assert_eq!(app.thread(t.id.clone()).await.unwrap().title, PEER_TITLE);
    let after = summary(&app, &t).await;
    assert_eq!(after.title, PEER_TITLE);
    assert!(!after.is_regenerating_title);
    let calls = f.invocations();
    assert_eq!(calls.len(), 1);
    let prompt = calls[0]["prompt"].as_str().unwrap();
    assert!(prompt.contains("The previous title was \"Previous title\"."));
    assert!(
        prompt.contains(
            "Thread contents:\nUSER:\nFix API token refresh\n\nASSISTANT:\nfixture reply"
        )
    );
    let args = calls[0]["args"].as_array().unwrap();
    assert!(args.windows(2).any(|a| a[0] == "-s" && a[1] == "read-only"));
    assert!(args.iter().any(|a| a == "--ephemeral"));
    assert!(!Path::new(calls[0]["cwd"].as_str().unwrap()).starts_with(&f.root));
    app.shutdown().await.unwrap();
    let reopened = App::open(f.config.clone()).await.unwrap();
    assert_eq!(
        reopened.thread(t.id.clone()).await.unwrap().title,
        PEER_TITLE
    );
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn regeneration_uses_the_device_text_generation_model_without_a_project_override() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.worked_thread(&app).await;
    std::fs::write(
        f.config.data_dir.join("settings.json"),
        serde_json::json!({
            "textGenerationModelSelection": { "model": "device-writer", "effort": null },
            "projectOverrides": {
                WorkspaceId::default().to_string(): {
                    "textGenerationModelSelection": { "model": "other-project-writer", "effort": "high" }
                },
                t.workspace_id.to_string(): {
                    "textGenerationModelSelection": { "model": "", "effort": "high" }
                }
            }
        })
        .to_string(),
    )
    .unwrap();
    app.regenerate_title(t.id.clone()).await.unwrap();
    let calls = f.invocations();
    let args: Vec<&str> = calls[0]["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|arg| arg.as_str().unwrap())
        .collect();
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--model", "device-writer"]),
        "{args:?}"
    );
    assert!(
        !args
            .iter()
            .any(|arg| arg.starts_with("model_reasoning_effort")),
        "a null effort leaves the model's default effort: {args:?}"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_rename_during_regeneration_wins_and_the_late_result_is_ignored() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.worked_thread(&app).await;
    f.control("title_hold", "20");
    let pending = tokio::spawn({
        let app = app.clone();
        let id = t.id.clone();
        async move { app.regenerate_title(id).await }
    });
    wait_file(&f.file("title_ready")).await;
    assert!(summary(&app, &t).await.is_regenerating_title);
    let pid: i32 = std::fs::read_to_string(f.file("title.pid"))
        .unwrap()
        .parse()
        .unwrap();
    app.rename_thread(t.id.clone(), "Manual title".into())
        .await
        .unwrap();
    pending.await.unwrap().unwrap();
    assert!(!summary(&app, &t).await.is_regenerating_title);
    f.control("title_release", "");
    wait_dead(pid).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        app.thread(t.id.clone()).await.unwrap().title,
        "Manual title"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn failure_keeps_the_previous_title_reports_the_error_and_clears_the_request() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.worked_thread(&app).await;
    f.control("title_fail", "");
    let error = app.regenerate_title(t.id.clone()).await.unwrap_err();
    assert_eq!(error.code, "text_generation");
    let after = summary(&app, &t).await;
    assert_eq!(after.title, "Previous title");
    assert!(!after.is_regenerating_title);
    f.control(
        "title_output",
        r#"{"title":"Previous title","needsRefinement":false}"#,
    );
    let revision = app.thread(t.id.clone()).await.unwrap().revision;
    app.regenerate_title(t.id.clone()).await.unwrap();
    let unchanged = app.thread(t.id.clone()).await.unwrap();
    assert_eq!(unchanged.title, "Previous title");
    assert_eq!(unchanged.revision, revision);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_thread_without_messages_keeps_its_title_without_running_codex() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.thread(&app).await;
    app.regenerate_title(t.id.clone()).await.unwrap();
    assert_eq!(app.thread(t.id.clone()).await.unwrap().title, t.title);
    assert!(f.invocations().is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_reaps_a_stalled_regeneration_and_a_restart_is_not_regenerating() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.worked_thread(&app).await;
    f.control("title_stall", "");
    let pending = tokio::spawn({
        let app = app.clone();
        let id = t.id.clone();
        async move { app.regenerate_title(id).await }
    });
    wait_file(&f.file("title_ready")).await;
    let pid: i32 = std::fs::read_to_string(f.file("title.pid"))
        .unwrap()
        .parse()
        .unwrap();
    app.shutdown().await.unwrap();
    wait_dead(pid).await;
    pending.await.unwrap().unwrap();
    let reopened = App::open(f.config.clone()).await.unwrap();
    let after = summary(&reopened, &t).await;
    assert_eq!(after.title, "Previous title");
    assert!(!after.is_regenerating_title);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_auto_settle_opt_out_survives_a_restart() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.thread(&app).await;
    assert!(summary(&app, &t).await.auto_settle_enabled);
    app.arrange(t.id.clone(), Arrange::SetAutoSettle { enabled: false })
        .await
        .unwrap();
    assert!(!summary(&app, &t).await.auto_settle_enabled);
    app.shutdown().await.unwrap();
    let reopened = App::open(f.config.clone()).await.unwrap();
    assert!(!summary(&reopened, &t).await.auto_settle_enabled);
    reopened
        .arrange(t.id.clone(), Arrange::SetAutoSettle { enabled: true })
        .await
        .unwrap();
    assert!(summary(&reopened, &t).await.auto_settle_enabled);
    reopened.shutdown().await.unwrap();
}
