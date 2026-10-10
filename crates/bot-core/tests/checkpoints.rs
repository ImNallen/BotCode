#![cfg(unix)]
#![allow(clippy::disallowed_methods)]
use bot_core::*;
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

struct Fixture {
    _dir: tempfile::TempDir,
    repo: PathBuf,
    peer: PathBuf,
    config: RuntimeConfig,
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
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repository");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.name", "Test"]);
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(repo.join("README.md"), "initial\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "cache.txt\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "initial"]);
        let peer = dir.path().join("peer.py");
        std::fs::write(&peer, PEER).unwrap();
        std::fs::set_permissions(&peer, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = RuntimeConfig {
            data_dir: dir.path().join("state"),
            codex_binary: peer.clone(),
            gh_binary: dir.path().join("no-gh"),
            network_timeout: Duration::from_secs(20),
            shell: None,
        };
        Self {
            _dir: dir,
            repo,
            peer,
            config,
        }
    }
    fn flag(&self, name: &str) -> PathBuf {
        self.peer.parent().unwrap().join(name)
    }
    fn calls(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.flag("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    async fn thread(&self, app: &App, checkout: NewCheckout) -> ThreadSnapshot {
        let workspace = app.open_workspace(self.repo.clone()).await.unwrap();
        app.create_thread(workspace.id, checkout).await.unwrap()
    }
    async fn edit(&self, app: &App, id: &ThreadId, number: usize) -> ThreadSnapshot {
        app.submit(
            id.clone(),
            format!("edit-{number}"),
            format!("edit-{number}"),
            vec![],
        )
        .await
        .unwrap();
        wait(app, id, |t| {
            t.turns.len() == number
                && matches!(
                    t.turns.last().unwrap().checkpoint,
                    TurnCheckpoint::Complete { .. }
                )
        })
        .await
    }
    async fn three(&self, app: &App) -> ThreadSnapshot {
        let t = self.thread(app, NewCheckout::Local).await;
        for n in 1..=3 {
            self.edit(app, &t.id, n).await;
        }
        app.thread(t.id).await.unwrap()
    }
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.config.data_dir.join("z1.sqlite")).unwrap()
    }
}
async fn wait(
    app: &App,
    id: &ThreadId,
    predicate: impl Fn(&ThreadSnapshot) -> bool,
) -> ThreadSnapshot {
    let started = Instant::now();
    let mut last = None;
    for _ in 0..3000 {
        let t = app.thread(id.clone()).await.unwrap();
        if predicate(&t) {
            return t;
        }
        last = Some(t);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "Timed out waiting for checkpoint behavior after {:?}; last snapshot: {last:#?}",
        started.elapsed()
    );
}
async fn reopen(f: &Fixture) -> App {
    for _ in 0..100 {
        match App::open(f.config.clone()).await {
            Err(error) if error.code == "already_running" => {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            result => return result.unwrap(),
        }
    }
    panic!("Runtime lock was not released")
}

#[tokio::test]
async fn per_turn_diff_and_file_revert_preserve_the_exact_before_boundary() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.three(&app).await;
    let head = git(&f.repo, &["rev-parse", "HEAD"]);
    std::fs::write(f.repo.join("cache.txt"), "ignored local data").unwrap();
    let TurnCheckpoint::Complete { files, .. } = &t.turns[1].checkpoint else {
        panic!()
    };
    assert_eq!(
        files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec!["README.md", "turn2.txt"]
    );
    let view = app
        .read_turn_diff(t.id.clone(), t.turns[1].id.clone(), "README.md".into())
        .await
        .unwrap();
    let TurnDiffView::Text {
        old: Some(old),
        new: Some(new),
    } = view
    else {
        panic!()
    };
    assert_eq!(old.contents, "initial\nedit-1\n");
    assert_eq!(new.contents, "initial\nedit-1\nedit-2\n");
    let view = app
        .read_turn_diff(t.id.clone(), t.turns[1].id.clone(), "turn2.txt".into())
        .await
        .unwrap();
    assert!(matches!(
        view,
        TurnDiffView::Text {
            old: None,
            new: Some(_)
        }
    ));
    let result = app
        .revert_thread(t.id.clone(), "rewind".into(), t.turns[1].id.clone(), true)
        .await
        .unwrap();
    assert_eq!(result.turns.len(), 1);
    assert_eq!(result.turns[0].id, t.turns[0].id);
    assert_ne!(result.native_thread_id, t.native_thread_id);
    assert_eq!(result.last_revert.as_ref().unwrap().prompt, "edit-2");
    assert_eq!(result.last_revert.as_ref().unwrap().turn_count, 1);
    assert_eq!(
        std::fs::read_to_string(f.repo.join("README.md")).unwrap(),
        "initial\nedit-1\n"
    );
    assert!(f.repo.join("turn1.txt").exists());
    assert!(!f.repo.join("turn2.txt").exists());
    assert!(!f.repo.join("turn3.txt").exists());
    assert_eq!(
        std::fs::read_to_string(f.repo.join("cache.txt")).unwrap(),
        "ignored local data"
    );
    assert_eq!(git(&f.repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&f.repo, &["diff", "--cached", "--name-only"]), "");
    let history: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.flag("threads.json")).unwrap()).unwrap();
    assert_eq!(
        history[t.native_thread_id.as_ref().unwrap()]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        history[result.native_thread_id.as_ref().unwrap()]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    app.submit(
        t.id.clone(),
        "continuation".into(),
        "continue".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &t.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].checkpoint, TurnCheckpoint::Complete { .. })
    })
    .await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn keep_changes_and_first_turn_rewind_use_honest_native_history() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.three(&app).await;
    let before = std::fs::read(f.repo.join("README.md")).unwrap();
    let result = app
        .revert_thread(t.id.clone(), "keep".into(), t.turns[1].id.clone(), false)
        .await
        .unwrap();
    assert_eq!(result.turns.len(), 1);
    assert_eq!(std::fs::read(f.repo.join("README.md")).unwrap(), before);
    let reset = app
        .revert_thread(
            t.id.clone(),
            "first".into(),
            result.turns[0].id.clone(),
            false,
        )
        .await
        .unwrap();
    assert!(reset.turns.is_empty());
    assert!(reset.native_thread_id.is_none());
    assert_eq!(std::fs::read(f.repo.join("README.md")).unwrap(), before);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn completed_revert_retry_does_not_overwrite_later_files_and_survives_restart() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.three(&app).await;
    let target = t.turns[1].id.clone();
    app.revert_thread(t.id.clone(), "stable".into(), target.clone(), true)
        .await
        .unwrap();
    app.shutdown().await.unwrap();
    std::fs::write(f.repo.join("README.md"), "later user edit\n").unwrap();
    let app = reopen(&f).await;
    let result = app
        .revert_thread(t.id.clone(), "stable".into(), target.clone(), true)
        .await
        .unwrap();
    assert_eq!(result.turns.len(), 1);
    assert_eq!(result.last_revert.as_ref().unwrap().prompt, "edit-2");
    assert_eq!(
        std::fs::read_to_string(f.repo.join("README.md")).unwrap(),
        "later user edit\n"
    );
    assert_eq!(
        app.revert_thread(t.id.clone(), "stable".into(), target, false)
            .await
            .unwrap_err()
            .code,
        "request_conflict"
    );
    assert_eq!(
        f.calls()
            .iter()
            .filter(|call| call["method"] == "thread/fork")
            .count(),
        1
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn pending_revert_crash_phases_resume_without_duplicate_forks_or_wrong_truncation() {
    for phase in ["preparing", "conversation_ready", "files_restored"] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let t = f.three(&app).await;
        let db = f.db();
        match phase {
            "preparing" => std::fs::write(f.flag("fork_fail"), "").unwrap(),
            "conversation_ready" => db.execute_batch("CREATE TRIGGER reject_revert BEFORE UPDATE ON threads WHEN json_extract(NEW.data,'$.pendingRevert.phase.kind')='restoring_files' BEGIN SELECT RAISE(FAIL,'injected before file restoration'); END;").unwrap(),
            _ => db.execute_batch("CREATE TRIGGER reject_revert BEFORE UPDATE ON threads WHEN json_extract(NEW.data,'$.pendingRevert') IS NULL AND json_array_length(json_extract(NEW.data,'$.turns'))=1 BEGIN SELECT RAISE(FAIL,'injected after file restoration'); END;").unwrap(),
        }
        assert!(
            app.revert_thread(t.id.clone(), "recover".into(), t.turns[1].id.clone(), true)
                .await
                .is_err()
        );
        let pending = app.thread(t.id.clone()).await.unwrap();
        assert_eq!(pending.turns.len(), 3);
        let serialized = serde_json::to_value(pending.pending_revert.as_ref().unwrap()).unwrap();
        assert_eq!(serialized["phase"]["kind"], phase);
        assert_eq!(
            app.submit(t.id.clone(), "blocked".into(), "continue".into(), vec![])
                .await
                .unwrap_err()
                .code,
            "checkout_busy"
        );
        app.shutdown().await.unwrap();
        if phase == "preparing" {
            std::fs::remove_file(f.flag("fork_fail")).unwrap();
        } else {
            db.execute_batch("DROP TRIGGER reject_revert;").unwrap();
        }
        if phase == "files_restored" {
            std::fs::write(f.repo.join("README.md"), "later user edit\n").unwrap();
        }
        let app = reopen(&f).await;
        assert_eq!(
            app.switch_branch(
                t.workspace_id.clone(),
                Some(t.id.clone()),
                "other".into(),
                true
            )
            .await
            .unwrap_err()
            .code,
            "checkout_busy"
        );
        let result = app
            .revert_thread(t.id.clone(), "recover".into(), t.turns[1].id.clone(), true)
            .await
            .unwrap();
        assert_eq!(result.turns.len(), 1);
        assert!(result.pending_revert.is_none());
        assert_eq!(
            std::fs::read_to_string(f.repo.join("README.md")).unwrap(),
            if phase == "files_restored" {
                "later user edit\n"
            } else {
                "initial\nedit-1\n"
            }
        );
        assert_eq!(
            f.calls()
                .iter()
                .filter(|call| call["method"] == "thread/fork")
                .count(),
            if phase == "preparing" { 2 } else { 1 }
        );
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn active_turn_and_git_hold_refuse_both_revert_modes() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.three(&app).await;
    let other = f.thread(&app, NewCheckout::Local).await;
    app.submit(other.id.clone(), "held".into(), "hold".into(), vec![])
        .await
        .unwrap();
    wait(&app, &other.id, |t| {
        matches!(t.session, SessionState::Running)
    })
    .await;
    for files in [false, true] {
        assert_eq!(
            app.revert_thread(
                t.id.clone(),
                format!("turn-{files}"),
                t.turns[1].id.clone(),
                files
            )
            .await
            .unwrap_err()
            .code,
            "checkout_busy"
        );
    }
    app.interrupt(other.id.clone()).await.unwrap();
    wait(&app, &other.id, |t| {
        matches!(t.turns[0].checkpoint, TurnCheckpoint::Complete { .. })
    })
    .await;
    let hooks = f.repo.join(".git/hooks");
    let hook = hooks.join("pre-commit");
    let marker = f.flag("git_hold");
    std::fs::write(
        &hook,
        format!("#!/bin/sh\ntouch '{}'\nsleep 1\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let run = app.clone();
    let workspace = t.workspace_id.clone();
    let thread = t.id.clone();
    let git_action = tokio::spawn(async move {
        run.run_git_action(
            workspace,
            Some(thread),
            GitAction::Commit {
                request: CommitRequest {
                    message: Some("checkpoint verification".to_owned().try_into().unwrap()),
                    ..CommitRequest::default()
                },
            },
            |_| {},
        )
        .await
    });
    for _ in 0..3000 {
        if marker.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(marker.exists());
    for files in [false, true] {
        assert_eq!(
            app.revert_thread(
                t.id.clone(),
                format!("git-{files}"),
                t.turns[1].id.clone(),
                files
            )
            .await
            .unwrap_err()
            .code,
            "checkout_busy"
        );
    }
    git_action.await.unwrap().unwrap();
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn bad_native_prefix_does_not_restore_files_or_hide_local_history() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.three(&app).await;
    std::fs::write(f.flag("fork_bad"), "").unwrap();
    let before = std::fs::read(f.repo.join("README.md")).unwrap();
    assert_eq!(
        app.revert_thread(
            t.id.clone(),
            "bad-prefix".into(),
            t.turns[1].id.clone(),
            true
        )
        .await
        .unwrap_err()
        .code,
        "native_history_unconfirmed"
    );
    assert_eq!(std::fs::read(f.repo.join("README.md")).unwrap(), before);
    assert_eq!(app.thread(t.id.clone()).await.unwrap().turns.len(), 3);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn checkpoint_results_wait_for_storage_recovery_without_losing_the_checkout() {
    for kind in ["before", "complete"] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let t = f.thread(&app, NewCheckout::Local).await;
        let db = f.db();
        db.execute_batch(&format!("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON threads WHEN json_extract(NEW.data,'$.turns[0].checkpoint.kind')='{kind}' BEGIN SELECT RAISE(FAIL,'injected checkpoint save failure'); END;")).unwrap();
        app.submit(t.id.clone(), "storage".into(), "edit-1".into(), vec![])
            .await
            .unwrap();
        let snapshot = if kind == "complete" {
            wait(&app, &t.id, |t| {
                matches!(t.turns[0].execution, Execution::Completed)
            })
            .await
        } else {
            tokio::time::sleep(Duration::from_millis(350)).await;
            app.thread(t.id.clone()).await.unwrap()
        };
        assert!(matches!(
            snapshot.turns[0].checkpoint,
            TurnCheckpoint::Pending | TurnCheckpoint::Before { .. }
        ));
        assert_eq!(
            f.calls()
                .iter()
                .filter(|call| call["method"] == "turn/start")
                .count(),
            if kind == "before" { 0 } else { 1 }
        );
        assert_eq!(
            app.delete_thread(t.id.clone()).await.unwrap_err().code,
            "busy"
        );
        assert_eq!(
            app.arrange(t.id.clone(), Arrange::Archive)
                .await
                .unwrap_err()
                .code,
            "busy"
        );
        let other = f.thread(&app, NewCheckout::Local).await;
        assert_eq!(
            app.submit(other.id, "excluded".into(), "hold".into(), vec![])
                .await
                .unwrap_err()
                .code,
            "checkout_busy"
        );
        db.execute_batch("DROP TRIGGER reject_checkpoint;").unwrap();
        wait(&app, &t.id, |t| {
            matches!(t.turns[0].checkpoint, TurnCheckpoint::Complete { .. })
        })
        .await;
        assert_eq!(
            f.calls()
                .iter()
                .filter(|call| call["method"] == "turn/start")
                .count(),
            1
        );
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn provider_prepare_and_dispatch_failures_retain_a_usable_before_checkpoint() {
    for flag in ["start_fail", "turn_fail"] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let t = f.thread(&app, NewCheckout::Local).await;
        std::fs::write(f.flag(flag), "").unwrap();
        app.submit(t.id.clone(), "failed".into(), "edit-1".into(), vec![])
            .await
            .unwrap();
        let failed = wait(&app, &t.id, |t| {
            matches!(
                t.turns[0].checkpoint,
                TurnCheckpoint::Unavailable {
                    before: Some(_),
                    ..
                }
            )
        })
        .await;
        assert!(!failed.turns[0].execution.active());
        std::fs::remove_file(f.flag(flag)).unwrap();
        app.submit(t.id.clone(), "recovered".into(), "edit-2".into(), vec![])
            .await
            .unwrap();
        wait(&app, &t.id, |t| {
            t.turns.len() == 2 && matches!(t.turns[1].checkpoint, TurnCheckpoint::Complete { .. })
        })
        .await;
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn rejected_file_preflight_clears_its_intent_and_allows_keep_changes() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.three(&app).await;
    std::fs::write(f.repo.join("cache.txt"), "private ignored data").unwrap();
    std::fs::write(f.repo.join(".gitignore"), "cache.txt\nmore.txt\n").unwrap();
    assert!(
        app.revert_thread(t.id.clone(), "refused".into(), t.turns[1].id.clone(), true)
            .await
            .is_err()
    );
    assert!(
        app.thread(t.id.clone())
            .await
            .unwrap()
            .pending_revert
            .is_none()
    );
    let result = app
        .revert_thread(
            t.id.clone(),
            "keep-after-refusal".into(),
            t.turns[1].id.clone(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(result.turns.len(), 1);
    assert_eq!(
        std::fs::read_to_string(f.repo.join("cache.txt")).unwrap(),
        "private ignored data"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn old_completion_cannot_release_a_newer_turn_checkout_lease() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.thread(&app, NewCheckout::Local).await;
    f.edit(&app, &t.id, 1).await;
    app.submit(t.id.clone(), "new-held".into(), "hold".into(), vec![])
        .await
        .unwrap();
    wait(&app, &t.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].execution, Execution::Running)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(matches!(
        app.thread(t.id.clone()).await.unwrap().session,
        SessionState::Running
    ));
    let other = f.thread(&app, NewCheckout::Local).await;
    assert_eq!(
        app.submit(other.id, "should-refuse".into(), "hold".into(), vec![])
            .await
            .unwrap_err()
            .code,
        "checkout_busy"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn provider_loss_during_restore_keeps_one_live_worker_and_retry_coalesces() {
    let f = Fixture::new();
    std::fs::write(f.repo.join(".gitattributes"), "README.md filter=slow\n").unwrap();
    git(&f.repo, &["add", ".gitattributes"]);
    git(&f.repo, &["commit", "-qm", "restore filter fixture"]);
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.three(&app).await;
    let filter = f.flag("smudge.sh");
    let marker = f.flag("restore_started");
    let count = f.flag("restore_count");
    std::fs::write(
        &filter,
        format!(
            "#!/bin/sh\nprintf 'restore\\n' >> '{}'\ntouch '{}'\nsleep 1\ncat\n",
            count.display(),
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&filter, std::fs::Permissions::from_mode(0o755)).unwrap();
    git(
        &f.repo,
        &["config", "filter.slow.smudge", filter.to_str().unwrap()],
    );
    let first_app = app.clone();
    let id = t.id.clone();
    let target = t.turns[1].id.clone();
    let first = tokio::spawn(async move {
        first_app
            .revert_thread(id, "one-worker".into(), target, true)
            .await
    });
    for _ in 0..3000 {
        if marker.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(marker.exists());
    let pid: i32 = std::fs::read_to_string(f.flag("pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    assert!(first.await.unwrap().is_err());
    let result = app
        .revert_thread(
            t.id.clone(),
            "one-worker".into(),
            t.turns[1].id.clone(),
            true,
        )
        .await
        .unwrap();
    assert_eq!(result.turns.len(), 1);
    assert_eq!(std::fs::read_to_string(count).unwrap(), "restore\n");
    assert_eq!(
        f.calls()
            .iter()
            .filter(|call| call["method"] == "thread/fork")
            .count(),
        1
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn folder_capture_save_failure_recovers_before_dispatch() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let scratch = app.ensure_scratch().await.unwrap();
    let t = app
        .create_thread(
            scratch.id,
            NewCheckout::Folder {
                prompt: "folder".into(),
            },
        )
        .await
        .unwrap();
    let db = f.db();
    db.execute_batch("CREATE TRIGGER reject_folder BEFORE UPDATE ON threads WHEN json_extract(NEW.data,'$.turns[0].checkpoint.kind')='unavailable' BEGIN SELECT RAISE(FAIL,'injected folder save failure'); END;").unwrap();
    app.submit(t.id.clone(), "folder".into(), "continue".into(), vec![])
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(!f.calls().iter().any(|call| call["method"] == "turn/start"));
    db.execute_batch("DROP TRIGGER reject_folder;").unwrap();
    let done = wait(&app, &t.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert!(matches!(
        done.turns[0].checkpoint,
        TurnCheckpoint::Unavailable { before: None, .. }
    ));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn folder_capture_save_retry_keeps_its_hold_after_another_thread_loses_the_provider() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let repository = f.thread(&app, NewCheckout::Local).await;
    f.edit(&app, &repository.id, 1).await;
    let scratch = app.ensure_scratch().await.unwrap();
    let folder = app
        .create_thread(
            scratch.id,
            NewCheckout::Folder {
                prompt: "folder".into(),
            },
        )
        .await
        .unwrap();
    let db = f.db();
    db.execute_batch("CREATE TRIGGER reject_folder BEFORE UPDATE ON threads WHEN json_extract(NEW.data,'$.turns[0].checkpoint.kind')='unavailable' BEGIN SELECT RAISE(FAIL,'injected folder save failure'); END;").unwrap();
    app.submit(
        folder.id.clone(),
        "folder".into(),
        "folder-pending".into(),
        vec![],
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    let pid: i32 = std::fs::read_to_string(f.flag("pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    let lost = wait(&app, &folder.id, |t| {
        matches!(t.session, SessionState::Unavailable { .. })
    })
    .await;
    assert_eq!(
        app.revert_thread(
            folder.id.clone(),
            "refuse-until-saved".into(),
            lost.turns[0].id.clone(),
            false
        )
        .await
        .unwrap_err()
        .code,
        "checkout_busy"
    );
    db.execute_batch("DROP TRIGGER reject_folder;").unwrap();
    wait(&app, &folder.id, |t| {
        matches!(
            &t.turns[0].checkpoint,
            TurnCheckpoint::Unavailable { reason, .. } if reason == "Checkpoints require a Git repository."
        )
    })
    .await;
    let rewound = app
        .revert_thread(
            folder.id.clone(),
            "after-save".into(),
            lost.turns[0].id.clone(),
            false,
        )
        .await
        .unwrap();
    assert!(rewound.turns.is_empty());
    assert_eq!(
        f.calls()
            .iter()
            .filter(|call| call["method"] == "turn/start")
            .count(),
        1
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_worktree_keeps_diffs_and_refuses_file_revert_without_pinning_restore() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f
        .thread(
            &app,
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: false,
            },
        )
        .await;
    for n in 1..=3 {
        f.edit(&app, &t.id, n).await;
    }
    let t = app.thread(t.id.clone()).await.unwrap();
    let Checkout::Worktree { path, .. } = &t.checkout else {
        panic!()
    };
    git(path, &["add", "."]);
    git(path, &["commit", "-qm", "retain worktree files"]);
    git(&f.repo, &["worktree", "remove", path.to_str().unwrap()]);
    let diff = app
        .read_turn_diff(t.id.clone(), t.turns[1].id.clone(), "README.md".into())
        .await
        .unwrap();
    assert!(matches!(
        diff,
        TurnDiffView::Text {
            old: Some(_),
            new: Some(_)
        }
    ));
    assert_eq!(
        app.revert_thread(
            t.id.clone(),
            "missing-files".into(),
            t.turns[1].id.clone(),
            true
        )
        .await
        .unwrap_err()
        .code,
        "worktree_removed"
    );
    assert!(
        app.thread(t.id.clone())
            .await
            .unwrap()
            .pending_revert
            .is_none()
    );
    let reset = app
        .revert_thread(
            t.id.clone(),
            "missing-keep".into(),
            t.turns[1].id.clone(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(reset.turns.len(), 1);
    app.submit(
        t.id.clone(),
        "restore-send".into(),
        "continue".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &t.id, |t| {
        t.turns.len() == 2 && matches!(t.turns[1].checkpoint, TurnCheckpoint::Complete { .. })
    })
    .await;
    assert!(path.exists());
    app.shutdown().await.unwrap();
}

async fn image_turn(f: &Fixture, app: &App, prompt: &str) -> ThreadSnapshot {
    let t = f.thread(app, NewCheckout::Local).await;
    let mut images = Vec::new();
    for (name, bytes) in [
        ("second.gif", b"GIF89asecond".as_slice()),
        ("first.png", b"\x89PNG\r\n\x1a\nfirst".as_slice()),
    ] {
        images.push(
            app.stage_attachment(name.into(), bytes.to_vec(), AttachmentKind::Image)
                .await
                .unwrap(),
        );
    }
    app.submit(t.id.clone(), "images".into(), prompt.into(), images)
        .await
        .unwrap();
    wait(app, &t.id, |t| {
        matches!(t.turns[0].checkpoint, TurnCheckpoint::Complete { .. })
    })
    .await
}

#[tokio::test]
async fn revert_recovers_ordered_images_and_text_until_an_accepted_send() {
    for prompt in ["Look at these", ""] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let t = image_turn(&f, &app, prompt).await;
        let target = t.turns[0].id.clone();
        let expected = serde_json::to_value(&t.turns[0].attachments).unwrap();
        let reverted = app
            .revert_thread(t.id.clone(), "recover-images".into(), target.clone(), false)
            .await
            .unwrap();
        let json = serde_json::to_value(&reverted).unwrap();
        assert_eq!(json["lastRevert"]["attachments"], expected);
        assert_eq!(json["lastRevert"]["prompt"], prompt);
        assert!(reverted.turns.is_empty());
        assert_eq!(
            app.submit(t.id.clone(), "rejected".into(), "".into(), vec![])
                .await
                .unwrap_err()
                .code,
            "invalid_prompt"
        );
        assert_eq!(
            serde_json::to_value(app.thread(t.id.clone()).await.unwrap()).unwrap()["lastRevert"],
            json["lastRevert"]
        );
        let db = f.db();
        db.execute_batch("CREATE TRIGGER reject_send BEFORE UPDATE ON threads WHEN json_array_length(json_extract(NEW.data,'$.turns'))=1 BEGIN SELECT RAISE(FAIL,'injected send failure'); END;").unwrap();
        assert!(
            app.submit(t.id.clone(), "next".into(), "continue".into(), vec![])
                .await
                .is_err()
        );
        assert_eq!(
            serde_json::to_value(app.thread(t.id.clone()).await.unwrap()).unwrap()["lastRevert"],
            json["lastRevert"]
        );
        db.execute_batch("DROP TRIGGER reject_send;").unwrap();
        app.submit(t.id.clone(), "next".into(), "continue".into(), vec![])
            .await
            .unwrap();
        wait(&app, &t.id, |t| {
            matches!(t.turns[0].checkpoint, TurnCheckpoint::Complete { .. })
        })
        .await;
        app.shutdown().await.unwrap();
        let app = reopen(&f).await;
        let retried = app
            .revert_thread(t.id.clone(), "recover-images".into(), target, false)
            .await
            .unwrap();
        assert!(retried.last_revert.is_none());
        assert_eq!(retried.turns[0].prompt, "continue");
        app.shutdown().await.unwrap();
    }
}

fn image_path(f: &Fixture, image: &Attachment) -> PathBuf {
    f.config
        .data_dir
        .canonicalize()
        .unwrap()
        .join("attachments")
        .join(format!("{}.{}", image.id(), image.extension()))
}
fn age_image(path: &Path) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new()
                .set_modified(std::time::SystemTime::now() - Duration::from_secs(25 * 60 * 60)),
        )
        .unwrap();
}

#[tokio::test]
async fn outstanding_revert_images_survive_archived_restart_and_sweep() {
    for archived in [false, true] {
        let f = Fixture::new();
        let app = App::open(f.config.clone()).await.unwrap();
        let t = image_turn(&f, &app, "").await;
        let images = t.turns[0].attachments.clone();
        let orphan = app
            .stage_attachment(
                "orphan.gif".into(),
                b"GIF89aorphan".to_vec(),
                AttachmentKind::Image,
            )
            .await
            .unwrap();
        app.revert_thread(t.id.clone(), "recover".into(), t.turns[0].id.clone(), false)
            .await
            .unwrap();
        if archived {
            app.arrange(t.id.clone(), Arrange::Archive).await.unwrap();
        }
        app.shutdown().await.unwrap();
        for image in images.iter().chain([&orphan]) {
            age_image(&image_path(&f, image));
        }
        let app = reopen(&f).await;
        let restored = app.thread(t.id.clone()).await.unwrap();
        assert_eq!(restored.last_revert.unwrap().attachments, images);
        for image in &images {
            assert!(image_path(&f, image).is_file());
        }
        assert!(!image_path(&f, &orphan).exists());
        if archived {
            app.arrange(t.id.clone(), Arrange::Unarchive).await.unwrap();
        }
        app.submit(t.id.clone(), "resend".into(), "".into(), images.clone())
            .await
            .unwrap();
        wait(&app, &t.id, |t| {
            matches!(t.turns[0].checkpoint, TurnCheckpoint::Complete { .. })
        })
        .await;
        let calls = f.calls();
        let sent = calls
            .iter()
            .rev()
            .find(|call| call["method"] == "turn/start")
            .unwrap();
        assert_eq!(
            sent["params"]["input"],
            serde_json::json!([
                {"type":"text", "text":format!("[Attached image \"second.gif\" is saved at: {}]\n\n[Attached image \"first.png\" is saved at: {}]", image_path(&f, &images[0]).display(), image_path(&f, &images[1]).display()), "text_elements":[]},
                {"type":"localImage", "path":image_path(&f, &images[0])},
                {"type":"localImage", "path":image_path(&f, &images[1])}
            ])
        );
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn failed_revert_commit_keeps_original_image_references_and_checkout_exclusion() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let t = image_turn(&f, &app, "keep images").await;
    let images = t.turns[0].attachments.clone();
    let db = f.db();
    db.execute_batch("CREATE TRIGGER reject_revert BEFORE UPDATE ON threads WHEN json_extract(NEW.data,'$.pendingRevert') IS NULL AND json_array_length(json_extract(NEW.data,'$.turns'))=0 BEGIN SELECT RAISE(FAIL,'injected revert save failure'); END;").unwrap();
    assert!(
        app.revert_thread(t.id.clone(), "recover".into(), t.turns[0].id.clone(), false)
            .await
            .is_err()
    );
    let pending = app.thread(t.id.clone()).await.unwrap();
    assert_eq!(pending.turns[0].attachments, images);
    assert!(pending.last_revert.is_none());
    assert!(pending.pending_revert.is_some());
    assert_eq!(
        app.delete_thread(t.id.clone()).await.unwrap_err().code,
        "busy"
    );
    assert_eq!(
        app.arrange(t.id.clone(), Arrange::Archive)
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    app.shutdown().await.unwrap();
    for image in &images {
        age_image(&image_path(&f, image));
    }
    let app = reopen(&f).await;
    let persisted = app.thread(t.id.clone()).await.unwrap();
    assert_eq!(persisted.turns[0].attachments, images);
    assert!(persisted.last_revert.is_none());
    for image in &images {
        assert!(image_path(&f, image).exists());
    }
    db.execute_batch("DROP TRIGGER reject_revert;").unwrap();
    let recovered = app
        .revert_thread(t.id.clone(), "recover".into(), t.turns[0].id.clone(), false)
        .await
        .unwrap();
    assert_eq!(recovered.last_revert.unwrap().attachments, images);
    assert!(recovered.turns.is_empty());
    app.shutdown().await.unwrap();
}

#[test]
fn legacy_revert_result_defaults_to_no_images() {
    let result: RevertResult = serde_json::from_value(serde_json::json!({
        "requestId":"legacy", "turnId":"00000000-0000-0000-0000-000000000001", "prompt":"original", "turnCount":0
    }))
    .unwrap();
    assert!(result.attachments.is_empty());
    assert_eq!(result.prompt, "original");
}

const PEER: &str = r#"#!/usr/bin/env python3
import json,os,pathlib,sys,uuid
root=pathlib.Path(__file__).parent
(root/'pid').write_text(str(os.getpid()))
saved=root/'threads.json'
threads=json.loads(saved.read_text()) if saved.exists() else {}
current=None
cwd=None
active=None
def save(): saved.write_text(json.dumps(threads))
def emit(v): print(json.dumps(v),flush=True)
def result(r,v): emit({'id':r['id'],'result':v})
def event(m,p): emit({'method':m,'params':p})
for line in sys.stdin:
 r=json.loads(line);m=r.get('method');p=r.get('params',{})
 with (root/'calls.jsonl').open('a') as out: out.write(json.dumps(r)+'\n')
 if m=='initialize': result(r,{'userAgent':'checkpoint fixture'})
 elif m=='collaborationMode/list': emit({'id':r['id'],'error':{'code':-32601,'message':'Method not found'}})
 elif m=='account/read': result(r,{'account':None})
 elif m=='account/rateLimits/read': result(r,{'rateLimits':None})
 elif m=='thread/start':
  if (root/'start_fail').exists(): emit({'id':r['id'],'error':{'code':-32000,'message':'injected prepare failure'}});continue
  current='thread-'+str(uuid.uuid4());cwd=pathlib.Path(p['cwd']);threads[current]=[];save();result(r,{'thread':{'id':current,'turns':[]}})
 elif m=='thread/resume':
  current=p['threadId'];cwd=pathlib.Path(p['cwd']);result(r,{'thread':{'id':current,'turns':threads[current]}})
 elif m=='thread/fork':
  if (root/'fork_fail').exists(): emit({'id':r['id'],'error':{'code':-32000,'message':'injected fork failure'}});continue
  source=threads[p['threadId']];prefix=source[:next(i for i,t in enumerate(source) if t['id']==p['beforeTurnId'])]
  if (root/'fork_bad').exists(): prefix=source
  current='fork-'+str(uuid.uuid4());cwd=pathlib.Path(p['cwd']);threads[current]=prefix.copy();save();result(r,{'thread':{'id':current,'turns':threads[current]}})
 elif m=='turn/start':
  if (root/'turn_fail').exists(): emit({'id':r['id'],'error':{'code':-32000,'message':'injected turn failure'}});continue
  current=p['threadId'];prompt=next((item['text'] for item in p['input'] if item['type']=='text'),'');active={'id':'turn-'+str(uuid.uuid4()),'status':'inProgress','items':[{'id':'user-'+str(uuid.uuid4()),'type':'userMessage','clientId':p['clientUserMessageId'],'content':[{'type':'inputText','text':prompt}]}]};threads[current].append(active);save()
  result(r,{'turn':active});event('turn/started',{'threadId':current,'turn':active})
  if prompt=='hold':
   if len(threads[current])>1: event('turn/completed',{'threadId':current,'turn':threads[current][0]})
   continue
  if prompt.startswith('edit-'):
   number=int(prompt.split('-')[1]);readme=cwd/'README.md';readme.write_text(readme.read_text()+prompt+'\n');(cwd/('turn'+str(number)+'.txt')).write_text(prompt+'\n')
  active['status']='completed';save();event('turn/completed',{'threadId':current,'turn':active})
 elif m=='turn/interrupt':
  active['status']='interrupted';save();result(r,{});event('turn/completed',{'threadId':current,'turn':active})
"#;
