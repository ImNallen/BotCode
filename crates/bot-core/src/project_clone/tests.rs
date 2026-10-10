use super::*;
use crate::{App, NewCheckout, RuntimeConfig};
use std::{net::TcpListener, time::Duration};

struct Fixture {
    dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
        }
    }
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }
    async fn app(&self) -> App {
        App::open(RuntimeConfig {
            data_dir: self.path("state"),
            codex_binary: self.path("no-codex"),
            gh_binary: self.path("no-gh"),
            network_timeout: Duration::from_secs(1),
            shell: None,
        })
        .await
        .unwrap()
    }
    fn repository(&self, name: &str) -> PathBuf {
        let root = self.path(name);
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "--initial-branch=main"]);
        std::fs::write(root.join("README.md"), "clone fixture\n").unwrap();
        git(&root, &["add", "README.md"]);
        git(
            &root,
            &[
                "-c",
                "user.name=Clone Test",
                "-c",
                "user.email=clone@example.invalid",
                "-c",
                "commit.gpgSign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "-m",
                "fixture",
            ],
        );
        root
    }
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = crate::process::command("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

async fn finished(app: &App, id: &WorkspaceId) -> ProjectCloneSnapshot {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let snapshot = app
                .project_clones()
                .await
                .unwrap()
                .into_iter()
                .find(|snapshot| &snapshot.workspace_id == id)
                .unwrap();
            if snapshot.phase != ProjectClonePhase::Running {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

struct StalledRemote {
    url: String,
    accepted: tokio::sync::oneshot::Receiver<()>,
    worker: JoinHandle<()>,
}
impl StalledRemote {
    fn new() -> Self {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        socket.set_nonblocking(true).unwrap();
        let port = socket.local_addr().unwrap().port();
        let (send, accepted) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            let socket = tokio::net::TcpListener::from_std(socket).unwrap();
            let (_connection, _) = socket.accept().await.unwrap();
            let _ = send.send(());
            std::future::pending::<()>().await;
        });
        Self {
            url: format!("git://127.0.0.1:{port}/fixture"),
            accepted,
            worker,
        }
    }
    async fn connected(&mut self) {
        tokio::time::timeout(Duration::from_secs(10), &mut self.accepted)
            .await
            .unwrap()
            .unwrap();
    }
}
impl Drop for StalledRemote {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

#[tokio::test]
async fn detached_clone_registers_before_completion_and_preserves_completed_checkout() {
    let f = Fixture::new();
    let source = f.repository("source");
    let app = f.app().await;
    let destination = f.path("checkout");
    let result = app
        .start_project_clone(format!("file://{}", source.display()), destination.clone())
        .await
        .unwrap();
    assert_eq!(result.snapshot.phase, ProjectClonePhase::Running);
    assert_eq!(result.snapshot.workspace_id, result.workspace.id);
    assert_eq!(
        result.workspace.root,
        dunce::canonicalize(&destination).unwrap()
    );
    assert!(
        app.list_workspaces()
            .await
            .unwrap()
            .iter()
            .any(|workspace| workspace.id == result.workspace.id)
    );
    let outcome = finished(&app, &result.workspace.id).await;
    assert_eq!(
        outcome.phase,
        ProjectClonePhase::Done,
        "{:?}",
        outcome.error
    );
    assert_eq!(outcome.percent, Some(100));
    assert!(outcome.sequence > result.snapshot.sequence);
    assert!(outcome.ended_at_ms.is_some());
    assert_eq!(
        std::fs::read_to_string(destination.join("README.md")).unwrap(),
        "clone fixture\n"
    );
    assert_eq!(git(&destination, &["branch", "--show-current"]), "main\n");
    assert!(
        app.workspace_view(result.workspace.id.clone(), None)
            .await
            .unwrap()
            .files
            .contains(&"README.md".into())
    );
    let thread = app
        .create_thread(result.workspace.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    assert_eq!(thread.workspace_id, result.workspace.id);
    std::fs::write(destination.join("my-work"), "keep me").unwrap();
    assert!(
        !app.cancel_project_clone(result.workspace.id.clone())
            .await
            .unwrap()
    );
    assert!(
        !app.retry_project_clone(result.workspace.id.clone())
            .await
            .unwrap()
    );
    app.remove_workspace(result.workspace.id).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(destination.join("my-work")).unwrap(),
        "keep me"
    );
    assert!(destination.join(".git").is_dir());
    assert!(app.project_clones().await.unwrap().is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_clone_is_visible_blocks_threads_and_retries_same_workspace() {
    let f = Fixture::new();
    let app = f.app().await;
    let destination = f.path("checkout");
    let result = app
        .start_project_clone(
            f.path("source").to_string_lossy().into_owned(),
            destination.clone(),
        )
        .await
        .unwrap();
    let outcome = finished(&app, &result.workspace.id).await;
    assert_eq!(outcome.phase, ProjectClonePhase::Failed);
    assert!(outcome.error.unwrap().contains("does not exist"));
    assert_eq!(
        app.create_thread(result.workspace.id.clone(), NewCheckout::Local)
            .await
            .unwrap_err()
            .message,
        "The repository was not cloned. Retry the clone first."
    );
    let view = app
        .workspace_view(result.workspace.id.clone(), None)
        .await
        .unwrap();
    assert!(view.files.is_empty());
    assert!(view.changes.is_empty());
    assert!(view.threads.is_empty());
    assert_eq!(view.workspace.id, result.workspace.id);
    f.repository("source");
    assert!(
        app.retry_project_clone(result.workspace.id.clone())
            .await
            .unwrap()
    );
    let outcome = finished(&app, &result.workspace.id).await;
    assert_eq!(
        outcome.phase,
        ProjectClonePhase::Done,
        "{:?}",
        outcome.error
    );
    assert_eq!(app.list_workspaces().await.unwrap().len(), 1);
    assert!(destination.join("README.md").is_file());
    app.shutdown().await.unwrap();
    assert!(destination.join("README.md").is_file());
}

#[tokio::test]
async fn cancellation_stops_real_git_and_cleans_partial_checkout() {
    let f = Fixture::new();
    let app = f.app().await;
    let mut remote = StalledRemote::new();
    let destination = f.path("checkout");
    let result = app
        .start_project_clone(remote.url.clone(), destination.clone())
        .await
        .unwrap();
    remote.connected().await;
    assert_eq!(
        app.create_thread(result.workspace.id.clone(), NewCheckout::Local)
            .await
            .unwrap_err()
            .message,
        "The repository is still being cloned."
    );
    assert!(
        app.workspace_view(result.workspace.id.clone(), None)
            .await
            .unwrap()
            .files
            .is_empty()
    );
    assert!(
        app.cancel_project_clone(result.workspace.id.clone())
            .await
            .unwrap()
    );
    let outcome = finished(&app, &result.workspace.id).await;
    assert_eq!(outcome.phase, ProjectClonePhase::Cancelled);
    assert!(outcome.error.is_none());
    assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0);
    assert!(
        !app.cancel_project_clone(result.workspace.id.clone())
            .await
            .unwrap()
    );
    assert!(
        app.retry_project_clone(result.workspace.id.clone())
            .await
            .unwrap()
    );
    let retry = app.project_clones().await.unwrap().pop().unwrap();
    assert_eq!(retry.phase, ProjectClonePhase::Running);
    assert_eq!(retry.stage, ProjectCloneStage::Connecting);
    assert!(retry.sequence > outcome.sequence);
    assert!(retry.ended_at_ms.is_none());
    assert!(
        app.cancel_project_clone(result.workspace.id.clone())
            .await
            .unwrap()
    );
    app.remove_workspace(result.workspace.id).await.unwrap();
    assert!(app.project_clones().await.unwrap().is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn removing_running_project_and_shutdown_both_drain_clone_processes() {
    let f = Fixture::new();
    let app = f.app().await;
    let mut remote = StalledRemote::new();
    let destination = f.path("checkout");
    let result = app
        .start_project_clone(remote.url.clone(), destination.clone())
        .await
        .unwrap();
    remote.connected().await;
    app.remove_workspace(result.workspace.id).await.unwrap();
    assert!(app.list_workspaces().await.unwrap().is_empty());
    assert!(app.project_clones().await.unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0);
    let mut remote = StalledRemote::new();
    app.start_project_clone(remote.url.clone(), destination.clone())
        .await
        .unwrap();
    remote.connected().await;
    app.shutdown().await.unwrap();
    assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0);
}

#[tokio::test]
async fn an_existing_empty_destination_is_claimed_and_reserved_until_discard() {
    let f = Fixture::new();
    let app = f.app().await;
    let mut remote = StalledRemote::new();
    let destination = f.path("checkout");
    std::fs::create_dir(&destination).unwrap();
    let result = app
        .start_project_clone(remote.url.clone(), destination.clone())
        .await
        .unwrap();
    remote.connected().await;
    let error = app
        .start_project_clone(remote.url.clone(), destination.clone())
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "A clone into this destination is already in progress."
    );
    app.cancel_project_clone(result.workspace.id.clone())
        .await
        .unwrap();
    assert!(
        app.start_project_clone(remote.url.clone(), destination.clone())
            .await
            .is_err()
    );
    app.remove_workspace(result.workspace.id).await.unwrap();
    assert!(
        app.start_project_clone(
            f.path("missing").to_string_lossy().into_owned(),
            destination
        )
        .await
        .is_ok()
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn retry_reclaims_a_destination_removed_by_git_and_can_cancel_again() {
    let f = Fixture::new();
    let tracker = ProjectClones::default();
    let remote = StalledRemote::new();
    let destination = f.path("checkout");
    let snapshot = tracker
        .claim(remote.url.clone(), destination.clone())
        .unwrap();
    tracker.update(&snapshot.workspace_id, |entry| {
        entry.snapshot.phase = ProjectClonePhase::Failed
    });
    std::fs::remove_dir(&destination).unwrap();
    assert!(
        tracker
            .retry(&snapshot.workspace_id, Default::default())
            .await
            .unwrap()
    );
    assert!(tracker.cancel(&snapshot.workspace_id).await.unwrap());
    assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0);
    tracker.shutdown().await.unwrap();
}

#[tokio::test]
async fn invalid_destination_or_remote_never_registers_or_overwrites_user_files() {
    let f = Fixture::new();
    let app = f.app().await;
    let source = f.repository("source");
    let nonempty = f.path("nonempty");
    std::fs::create_dir(&nonempty).unwrap();
    std::fs::write(nonempty.join("keep"), "keep").unwrap();
    let file = f.path("file");
    std::fs::write(&file, "keep").unwrap();
    for destination in [nonempty.clone(), file.clone(), PathBuf::new()] {
        assert!(
            app.start_project_clone(source.to_string_lossy().into_owned(), destination)
                .await
                .is_err()
        );
    }
    for url in ["", "  ", "--upload-pack=bad", "a\0b"] {
        assert!(
            app.start_project_clone(url.into(), f.path("unused"))
                .await
                .is_err()
        );
    }
    assert!(app.list_workspaces().await.unwrap().is_empty());
    assert!(app.project_clones().await.unwrap().is_empty());
    assert_eq!(
        std::fs::read_to_string(nonempty.join("keep")).unwrap(),
        "keep"
    );
    assert_eq!(std::fs::read_to_string(file).unwrap(), "keep");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn retry_refuses_user_files_added_after_a_failed_clone() {
    let f = Fixture::new();
    let app = f.app().await;
    let destination = f.path("checkout");
    let result = app
        .start_project_clone(
            f.path("missing").to_string_lossy().into_owned(),
            destination.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        finished(&app, &result.workspace.id).await.phase,
        ProjectClonePhase::Failed
    );
    std::fs::create_dir_all(&destination).unwrap();
    std::fs::write(destination.join("keep"), "my file").unwrap();
    assert_eq!(
        app.retry_project_clone(result.workspace.id.clone())
            .await
            .unwrap_err()
            .message,
        "Destination path contains files that are not from the clone."
    );
    assert!(
        app.remove_workspace(result.workspace.id.clone())
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(destination.join("keep")).unwrap(),
        "my file"
    );
    assert!(app.shutdown().await.is_err());
    assert_eq!(
        std::fs::read_to_string(destination.join("keep")).unwrap(),
        "my file"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn replaced_destination_is_preserved_and_symlink_destination_is_rejected() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let app = f.app().await;
    let other = f.path("other");
    std::fs::create_dir(&other).unwrap();
    std::fs::write(other.join("keep"), "keep").unwrap();
    let link = f.path("link");
    symlink(&other, &link).unwrap();
    assert!(
        app.start_project_clone("missing".into(), link)
            .await
            .is_err()
    );
    let destination = f.path("checkout");
    let result = app
        .start_project_clone(
            f.path("missing").to_string_lossy().into_owned(),
            destination.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        finished(&app, &result.workspace.id).await.phase,
        ProjectClonePhase::Failed
    );
    if destination.exists() {
        std::fs::rename(&destination, f.path("original")).unwrap();
    }
    symlink(&other, &destination).unwrap();
    assert!(app.retry_project_clone(result.workspace.id).await.is_err());
    assert!(app.shutdown().await.is_err());
    assert_eq!(std::fs::read_to_string(other.join("keep")).unwrap(), "keep");
}

#[tokio::test]
async fn completed_snapshots_expire_and_failed_snapshots_are_retained() {
    let f = Fixture::new();
    let tracker = ProjectClones::default();
    let source = f.repository("source");
    let result = tracker
        .claim(source.to_string_lossy().into_owned(), f.path("checkout"))
        .unwrap();
    tracker.launch(&result.workspace_id, Default::default());
    tracker.join(&result.workspace_id, false).await.unwrap();
    assert_eq!(
        tracker.snapshot(&result.workspace_id).unwrap().phase,
        ProjectClonePhase::Done
    );
    tracker.update(&result.workspace_id, |entry| {
        entry.snapshot.ended_at_ms = Some(now_ms().saturating_sub(30_001))
    });
    assert!(tracker.list().is_empty());
    let failed = tracker
        .claim(
            f.path("missing").to_string_lossy().into_owned(),
            f.path("failed"),
        )
        .unwrap();
    tracker.launch(&failed.workspace_id, Default::default());
    tracker.join(&failed.workspace_id, false).await.unwrap();
    assert_eq!(
        tracker.snapshot(&failed.workspace_id).unwrap().phase,
        ProjectClonePhase::Failed
    );
    tracker.update(&failed.workspace_id, |entry| {
        entry.snapshot.ended_at_ms = Some(0)
    });
    assert_eq!(tracker.list().len(), 1);
    tracker.shutdown().await.unwrap();
    assert!(f.path("checkout/README.md").is_file());
}

#[test]
fn progress_parsing_matches_reference_counters_and_transfer_detail() {
    for (line, stage, percent, detail) in [
        (
            "Receiving objects:  45% (4500/10000), 12.30 MiB | 5.00 MiB/s",
            ProjectCloneStage::Receiving,
            Some(45),
            Some("12.30 MiB | 5.00 MiB/s"),
        ),
        (
            "Resolving deltas: 100% (700/700), done.",
            ProjectCloneStage::Resolving,
            Some(100),
            None,
        ),
        (
            "remote: Compressing objects:  12% (3/25)",
            ProjectCloneStage::Counting,
            Some(12),
            None,
        ),
        (
            "Updating files:  78% (2104/2700)",
            ProjectCloneStage::Checkout,
            Some(78),
            None,
        ),
        (
            "Checking out files:  50% (1/2)",
            ProjectCloneStage::Checkout,
            Some(50),
            None,
        ),
        (
            "remote: Enumerating objects: 10, done.",
            ProjectCloneStage::Counting,
            None,
            None,
        ),
    ] {
        assert_eq!(
            parse_progress(line),
            Some((stage, percent, detail.map(String::from)))
        );
    }
    assert!(parse_progress("Cloning into 'fixture'...").is_none());
    assert!(parse_progress("fatal: repository not found").is_none());
    assert_eq!(
        parse_progress(&format!(
            "Receiving objects: 150% (1/1), {}",
            "x".repeat(1000)
        )),
        Some((
            ProjectCloneStage::Receiving,
            Some(100),
            Some(clamp(&"x".repeat(1000), 200))
        ))
    );
    assert_eq!(
        redact_credentials("fatal: https://user:secret@example.invalid/repo denied"),
        "fatal: https://***@example.invalid/repo denied"
    );
    assert!(clamp(&"😀".repeat(1500), 1000).encode_utf16().count() <= 1000);
    assert!(clamp(&"😀".repeat(1500), 200).encode_utf16().count() <= 200);
}
