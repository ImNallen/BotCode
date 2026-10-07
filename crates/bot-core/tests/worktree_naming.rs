use bot_core::*;
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    peer: PathBuf,
    config: RuntimeConfig,
}
impl Fixture {
    fn new(output: Option<&str>) -> Self {
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
        if let Some(output) = output {
            std::fs::write(dir.path().join("naming_output"), output).unwrap();
        }
        let config = RuntimeConfig {
            data_dir: dir.path().join("state"),
            codex_binary: peer.clone(),
            gh_binary: dir.path().join("no-gh"),
            network_timeout: Duration::from_secs(2),
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
        std::fs::write(self.peer.parent().unwrap().join(name), value).unwrap();
    }
    fn invocations(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.peer.parent().unwrap().join("naming.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    async fn thread(&self, app: &App) -> ThreadSnapshot {
        let workspace = app.open_workspace(self.root.clone()).await.unwrap();
        app.create_thread(
            workspace.id,
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: false,
            },
        )
        .await
        .unwrap()
    }
}
fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}
fn checkout(t: &ThreadSnapshot) -> (&Path, &str) {
    match &t.checkout {
        Checkout::Worktree { path, branch } => (path, branch),
        _ => panic!("worktree expected"),
    }
}
async fn wait(
    app: &App,
    id: &ThreadId,
    predicate: impl Fn(&ThreadSnapshot) -> bool,
) -> ThreadSnapshot {
    let started = Instant::now();
    let mut last = None;
    for _ in 0..500 {
        let t = app.thread(id.clone()).await.unwrap();
        if predicate(&t)
            && !t.turns.last().is_some_and(|turn| {
                !turn.execution.active()
                    && matches!(
                        turn.checkpoint,
                        TurnCheckpoint::Pending | TurnCheckpoint::Before { .. }
                    )
            })
        {
            return t;
        }
        last = Some(t);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "snapshot did not reach expected state after {:?}; last snapshot: {last:#?}",
        started.elapsed()
    )
}
async fn wait_file(path: &Path) {
    for _ in 0..500 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("fixture file did not appear")
}
#[tokio::test]
async fn first_message_generates_once_keeps_folder_and_base_and_survives_restart() {
    let f = Fixture::new(Some(r#"{"branch":"BOTCODE/Fix API: token refresh!"}"#));
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.thread(&app).await;
    let (path, original) = checkout(&t);
    let path = path.to_owned();
    assert!(original.starts_with("botcode/"));
    assert_eq!(original.len(), 16);
    app.models().await.unwrap();
    app.update_settings(
        t.id.clone(),
        SessionSettings {
            model: Some("model-two".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let first = app
        .submit(
            t.id.clone(),
            "first".into(),
            "Fix API token refresh".into(),
            vec![],
        )
        .await
        .unwrap();
    let replay = app
        .submit(
            t.id.clone(),
            "first".into(),
            "Fix API token refresh".into(),
            vec![],
        )
        .await
        .unwrap();
    assert_eq!(first.turn_id, replay.turn_id);
    let renamed = wait(&app, &t.id, |t| {
        checkout(t).1 == "botcode/fix-api-token-refresh"
    })
    .await;
    assert_eq!(checkout(&renamed).0, path);
    assert_eq!(
        git(&path, &["symbolic-ref", "--short", "HEAD"]),
        "botcode/fix-api-token-refresh"
    );
    assert_eq!(
        git(
            &path,
            &[
                "config",
                "--get",
                "branch.botcode/fix-api-token-refresh.gh-merge-base"
            ]
        ),
        "main"
    );
    let calls = f.invocations();
    assert_eq!(calls.len(), 1);
    assert!(
        calls[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("Fix API token refresh")
    );
    let args = calls[0]["args"].as_array().unwrap();
    assert!(
        args.windows(2)
            .any(|a| a[0] == "--model" && a[1] == "model-two")
    );
    assert!(args.windows(2).any(|a| a[0] == "-s" && a[1] == "read-only"));
    assert!(args.iter().any(|a| a == "--ephemeral"));
    assert_eq!(args.last().unwrap(), "-");
    assert!(!Path::new(calls[0]["cwd"].as_str().unwrap()).starts_with(&f.root));
    app.submit(
        t.id.clone(),
        "second".into(),
        "Now add tests".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &t.id, |t| matches!(t.session, SessionState::Ready)).await;
    app.shutdown().await.unwrap();
    assert_eq!(f.invocations().len(), 1);
    let reopened = App::open(f.config.clone()).await.unwrap();
    assert_eq!(
        checkout(&reopened.thread(t.id.clone()).await.unwrap()).1,
        "botcode/fix-api-token-refresh"
    );
    reopened.models().await.unwrap();
    reopened
        .submit(t.id.clone(), "third".into(), "Next change".into(), vec![])
        .await
        .unwrap();
    wait(&reopened, &t.id, |t| {
        matches!(t.session, SessionState::Ready)
    })
    .await;
    reopened.shutdown().await.unwrap();
    assert_eq!(f.invocations().len(), 1);
}
#[tokio::test]
async fn collisions_use_original_suffix_without_overwriting_branch() {
    for reference in [
        "refs/heads/botcode/shared-name",
        "refs/remotes/origin/botcode/shared-name",
        "refs/remotes/team/origin/botcode/shared-name",
    ] {
        let f = Fixture::new(Some(r#"{"branch":"shared-name"}"#));
        git(
            &f.root,
            &[
                "remote",
                "add",
                "team/origin",
                "https://example.invalid/repo.git",
            ],
        );
        git(&f.root, &["update-ref", reference, "HEAD"]);
        let before = git(&f.root, &["rev-parse", reference]);
        git(
            &f.root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "next",
            ],
        );
        let app = App::open(f.config.clone()).await.unwrap();
        let t = f.thread(&app).await;
        let suffix = checkout(&t).1.strip_prefix("botcode/").unwrap();
        let expected = format!("botcode/shared-name-{suffix}");
        app.submit(
            t.id.clone(),
            "first".into(),
            "Name this work".into(),
            vec![],
        )
        .await
        .unwrap();
        wait(&app, &t.id, |t| checkout(t).1 == expected).await;
        assert_eq!(git(&f.root, &["rev-parse", reference]), before);
        app.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn name_is_ready_in_background_but_git_waits_for_first_turn_lease() {
    let f = Fixture::new(Some(r#"{"branch":"held-turn"}"#));
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.thread(&app).await;
    app.submit(t.id.clone(), "first".into(), "hold".into(), vec![])
        .await
        .unwrap();
    wait(&app, &t.id, |t| matches!(t.session, SessionState::Running)).await;
    wait_file(&f.peer.parent().unwrap().join("naming.jsonl")).await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(
        checkout(&app.thread(t.id.clone()).await.unwrap()).1,
        checkout(&t).1
    );
    app.interrupt(t.id.clone()).await.unwrap();
    wait(&app, &t.id, |t| checkout(t).1 == "botcode/held-turn").await;
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn generation_failures_leave_the_user_turn_and_branch_intact() {
    let oversized = serde_json::json!({"branch": "x".repeat(64 * 1024)}).to_string();
    for output in [
        None,
        Some("not JSON"),
        Some(r#"{"branch":"💜"}"#),
        Some(oversized.as_str()),
    ] {
        let f = Fixture::new(output);
        let app = App::open(f.config.clone()).await.unwrap();
        let t = f.thread(&app).await;
        app.submit(
            t.id.clone(),
            "first".into(),
            "ordinary prompt".into(),
            vec![],
        )
        .await
        .unwrap();
        wait(&app, &t.id, |t| matches!(t.session, SessionState::Ready)).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        let unchanged = app.thread(t.id.clone()).await.unwrap();
        assert_eq!(checkout(&unchanged), checkout(&t));
        assert!(matches!(unchanged.turns[0].delivery, Delivery::Accepted));
        app.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn delayed_generation_cannot_rename_after_second_submit_or_manual_switch() {
    for switched in [false, true] {
        let f = Fixture::new(Some(r#"{"branch":"late-name"}"#));
        f.control("naming_stall", "");
        let app = App::open(f.config.clone()).await.unwrap();
        let t = f.thread(&app).await;
        app.submit(
            t.id.clone(),
            "first".into(),
            "ordinary prompt".into(),
            vec![],
        )
        .await
        .unwrap();
        let root = f.peer.parent().unwrap();
        wait_file(&root.join("naming_ready")).await;
        wait(&app, &t.id, |t| matches!(t.session, SessionState::Ready)).await;
        let pid = std::fs::read_to_string(root.join("naming.pid"))
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
        if switched {
            app.switch_branch(
                t.workspace_id.clone(),
                Some(t.id.clone()),
                "manual".into(),
                true,
            )
            .await
            .unwrap();
        } else {
            app.submit(t.id.clone(), "second".into(), "follow up".into(), vec![])
                .await
                .unwrap();
            wait(&app, &t.id, |t| matches!(t.session, SessionState::Ready)).await;
        }
        let cancelled = tokio::time::timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let actual = app.thread(t.id.clone()).await.unwrap();
        app.shutdown().await.unwrap();
        assert!(cancelled.is_ok(), "naming process survived cancellation");
        assert_eq!(
            checkout(&actual).1,
            if switched { "manual" } else { checkout(&t).1 }
        );
        assert_eq!(f.invocations().len(), 1);
    }
}
#[tokio::test]
async fn published_or_externally_switched_temporary_branches_are_preserved() {
    for guard in ["switch", "upstream", "tracking", "slash-remote-tracking"] {
        let f = Fixture::new(Some(r#"{"branch":"late-name"}"#));
        f.control("naming_delay", "0.3");
        let app = App::open(f.config.clone()).await.unwrap();
        let t = f.thread(&app).await;
        let (path, branch) = checkout(&t);
        app.submit(
            t.id.clone(),
            "first".into(),
            "ordinary prompt".into(),
            vec![],
        )
        .await
        .unwrap();
        wait(&app, &t.id, |t| matches!(t.session, SessionState::Ready)).await;
        match guard {
            "switch" => {
                git(path, &["switch", "-qc", "external"]);
            }
            "upstream" => {
                git(
                    path,
                    &[
                        "remote",
                        "add",
                        "origin",
                        "https://example.invalid/repo.git",
                    ],
                );
                git(path, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
                git(path, &["branch", "--set-upstream-to=origin/main", branch]);
            }
            _ => {
                let remote = if guard == "slash-remote-tracking" {
                    "team/origin"
                } else {
                    "origin"
                };
                git(
                    path,
                    &["remote", "add", remote, "https://example.invalid/repo.git"],
                );
                git(
                    path,
                    &[
                        "update-ref",
                        &format!("refs/remotes/{remote}/{branch}"),
                        "HEAD",
                    ],
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(checkout(&app.thread(t.id.clone()).await.unwrap()).1, branch);
        assert_eq!(
            git(path, &["symbolic-ref", "--short", "HEAD"]),
            if guard == "switch" {
                "external"
            } else {
                branch
            }
        );
        app.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn shutdown_reaps_stalled_generation_and_its_descendant() {
    let f = Fixture::new(Some(r#"{"branch":"never-name"}"#));
    f.control("naming_stall", "");
    f.control("naming_descendant", "");
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.thread(&app).await;
    app.submit(
        t.id.clone(),
        "first".into(),
        "ordinary prompt".into(),
        vec![],
    )
    .await
    .unwrap();
    let root = f.peer.parent().unwrap();
    wait_file(&root.join("naming_child.pid")).await;
    let pid = |file: &str| {
        std::fs::read_to_string(root.join(file))
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap()
    };
    let (parent, child) = (pid("naming.pid"), pid("naming_child.pid"));
    tokio::time::timeout(Duration::from_secs(5), app.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert_ne!(unsafe { libc::kill(parent, 0) }, 0);
    assert_ne!(unsafe { libc::kill(child, 0) }, 0);
    assert_eq!(
        git(checkout(&t).0, &["symbolic-ref", "--short", "HEAD"]),
        checkout(&t).1
    );
}

#[tokio::test]
async fn local_folder_and_custom_worktree_branches_do_not_generate_names() {
    let f = Fixture::new(Some(r#"{"branch":"unused-name"}"#));
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.root.clone()).await.unwrap();
    let local = app
        .create_thread(workspace.id, NewCheckout::Local)
        .await
        .unwrap();
    app.submit(
        local.id.clone(),
        "local".into(),
        "ordinary prompt".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &local.id, |t| {
        matches!(t.session, SessionState::Ready)
    })
    .await;
    let custom = f.thread(&app).await;
    app.switch_branch(
        custom.workspace_id.clone(),
        Some(custom.id.clone()),
        "user-name".into(),
        true,
    )
    .await
    .unwrap();
    app.submit(
        custom.id.clone(),
        "custom".into(),
        "ordinary prompt".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &custom.id, |t| {
        matches!(t.session, SessionState::Ready)
    })
    .await;
    let scratch = app.ensure_scratch().await.unwrap();
    let folder = app
        .create_thread(
            scratch.id,
            NewCheckout::Folder {
                prompt: "ordinary prompt".into(),
            },
        )
        .await
        .unwrap();
    app.submit(
        folder.id.clone(),
        "folder".into(),
        "ordinary prompt".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &folder.id, |t| {
        matches!(t.session, SessionState::Ready)
    })
    .await;
    app.shutdown().await.unwrap();
    assert!(f.invocations().is_empty());
}
#[tokio::test]
async fn pending_generation_is_cancelled_on_cleanup_project_removal_and_provider_loss() {
    for operation in ["cleanup", "remove", "lose"] {
        let f = Fixture::new(Some(r#"{"branch":"stale-name"}"#));
        f.control("naming_stall", "");
        let app = App::open(f.config.clone()).await.unwrap();
        let t = f.thread(&app).await;
        app.submit(
            t.id.clone(),
            "first".into(),
            if operation == "lose" {
                "lose".into()
            } else {
                "ordinary prompt".into()
            },
            vec![],
        )
        .await
        .unwrap();
        if operation != "lose" {
            wait(&app, &t.id, |t| matches!(t.session, SessionState::Ready)).await;
            wait_file(&f.peer.parent().unwrap().join("naming.pid")).await;
        }
        match operation {
            "cleanup" => {
                app.save_settings(r#"{"storageCleanup":{"worktreeAfterDays":1}}"#)
                    .await
                    .unwrap();
                app.sweep_worktrees_at(u64::MAX / 2).await;
                assert!(!checkout(&t).0.exists());
            }
            "remove" => {
                app.remove_workspace(t.workspace_id.clone()).await.unwrap();
            }
            _ => {
                wait(&app, &t.id, |t| {
                    matches!(t.session, SessionState::Unavailable { .. })
                })
                .await;
            }
        }
        app.shutdown().await.unwrap();
        let pidfile = f.peer.parent().unwrap().join("naming.pid");
        if pidfile.exists() {
            let pid: i32 = std::fs::read_to_string(pidfile)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
        }
        assert_eq!(
            git(
                &f.root,
                &["rev-parse", &format!("refs/heads/{}", checkout(&t).1)]
            ),
            git(&f.root, &["rev-parse", "main"])
        );
    }
}
#[tokio::test]
async fn git_action_cancels_pending_name_before_it_changes_checkout() {
    let f = Fixture::new(Some(r#"{"branch":"stale-name"}"#));
    f.control("naming_delay", "1");
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.thread(&app).await;
    app.submit(
        t.id.clone(),
        "first".into(),
        "ordinary prompt".into(),
        vec![],
    )
    .await
    .unwrap();
    wait(&app, &t.id, |t| matches!(t.session, SessionState::Ready)).await;
    std::fs::write(checkout(&t).0.join("fixture.txt"), "change").unwrap();
    git(checkout(&t).0, &["config", "user.name", "Fixture"]);
    git(
        checkout(&t).0,
        &["config", "user.email", "fixture@example.invalid"],
    );
    let result = app
        .run_git_action(
            t.workspace_id.clone(),
            Some(t.id.clone()),
            GitAction::Commit {
                message: Some(CommitMessage::try_from("fixture".to_owned()).unwrap()),
            },
            |_| {},
        )
        .await
        .unwrap();
    assert!(result.failure.is_none());
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(
        checkout(&app.thread(t.id.clone()).await.unwrap()).1,
        checkout(&t).1
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn generated_names_are_capped_at_64_bytes_including_the_prefix() {
    let output = serde_json::json!({"branch": "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(4)}).to_string();
    let f = Fixture::new(Some(&output));
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.thread(&app).await;
    app.submit(
        t.id.clone(),
        "first".into(),
        "ordinary prompt".into(),
        vec![],
    )
    .await
    .unwrap();
    let expected = format!(
        "botcode/{}",
        "abcdefghijklmnopqrstuvwxyz".repeat(4)[..56].to_owned()
    );
    let named = wait(&app, &t.id, |t| checkout(t).1 == expected).await;
    assert_eq!(checkout(&named).1.len(), 64);
    assert_eq!(
        git(checkout(&t).0, &["symbolic-ref", "--short", "HEAD"]),
        expected
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn long_collision_names_reserve_suffix_space_and_preserve_existing_ref() {
    let fragment = format!("{}-{}", "a".repeat(47), "x".repeat(64));
    let output = serde_json::json!({"branch": fragment}).to_string();
    let f = Fixture::new(Some(&output));
    let requested = format!("botcode/{}", &fragment[..56]);
    git(&f.root, &["branch", &requested]);
    let before = git(&f.root, &["rev-parse", &requested]);
    git(
        &f.root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "next",
        ],
    );
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.thread(&app).await;
    let suffix = checkout(&t).1.strip_prefix("botcode/").unwrap();
    let expected = format!("botcode/{}-{suffix}", "a".repeat(47));
    app.submit(
        t.id.clone(),
        "first".into(),
        "ordinary prompt".into(),
        vec![],
    )
    .await
    .unwrap();
    let named = wait(&app, &t.id, |t| checkout(t).1 == expected).await;
    assert!(checkout(&named).1.len() <= 64);
    assert_eq!(
        git(checkout(&named).0, &["symbolic-ref", "--short", "HEAD"]),
        expected
    );
    assert_eq!(git(&f.root, &["rev-parse", &requested]), before);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn an_image_only_first_message_keeps_the_temporary_branch() {
    let f = Fixture::new(Some(r#"{"branch":"unused-name"}"#));
    let app = App::open(f.config.clone()).await.unwrap();
    let t = f.thread(&app).await;
    let (_, temporary) = checkout(&t);
    let temporary = temporary.to_owned();
    let image = app
        .stage_attachment("shot.png".into(), b"\x89PNG\r\n\x1a\nshot".to_vec())
        .await
        .unwrap();
    app.submit(t.id.clone(), "image".into(), "".into(), vec![image])
        .await
        .unwrap();
    let done = wait(&app, &t.id, |t| matches!(t.session, SessionState::Ready)).await;
    assert_eq!(checkout(&done).1, temporary);
    app.shutdown().await.unwrap();
    assert!(f.invocations().is_empty());
}

#[tokio::test]
async fn shared_worktree_threads_keep_their_actual_branch_without_auto_renaming() {
    let f = Fixture::new(Some(r#"{"branch":"composer-plan"}"#));
    let app = App::open(f.config.clone()).await.unwrap();
    let source = f.thread(&app).await;
    let sibling = app
        .create_thread(
            source.workspace_id.clone(),
            NewCheckout::Existing {
                thread_id: source.id.clone(),
            },
        )
        .await
        .unwrap();
    app.submit(
        source.id.clone(),
        "shared-source".into(),
        "hello".into(),
        vec![],
    )
    .await
    .unwrap();
    let completed = wait(&app, &source.id, |t| {
        matches!(t.turns[0].execution, Execution::Completed)
    })
    .await;
    assert_eq!(completed.checkout, sibling.checkout);
    let (path, branch) = checkout(&completed);
    assert_eq!(git(path, &["branch", "--show-current"]), branch);
    app.shutdown().await.unwrap();
    assert!(f.invocations().is_empty());
}
