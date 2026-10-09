use super::*;

fn git_at(root: &std::path::Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().into()
}
fn prepare_fixture(f: &Fixture) -> String {
    git_at(&f.root, &["switch", "-c", "feature"]);
    std::fs::write(f.root.join("fork.txt"), "fork pull request\n").unwrap();
    git_at(&f.root, &["add", "."]);
    git_at(&f.root, &["commit", "-qm", "fork head"]);
    let head = git_at(&f.root, &["rev-parse", "HEAD"]);
    git_at(&f.root, &["update-ref", "refs/pull/41/head", &head]);
    git_at(&f.root, &["switch", "main"]);
    let remote = f.dir.path().join("remote.git");
    git_at(
        &f.root,
        &[
            "clone",
            "--bare",
            &f.root.to_string_lossy(),
            &remote.to_string_lossy(),
        ],
    );
    git_at(&remote, &["update-ref", "refs/pull/41/head", &head]);
    git_at(
        &f.root,
        &[
            "config",
            &format!("url.{}.insteadOf", remote.display()),
            "https://github.com/fixture/project.git",
        ],
    );
    f.state(json!({"head":head, "headRepository":"fork-owner/project"}));
    head
}
fn request(
    source: ThreadId,
    head: &str,
    destination: PrCheckoutDestination,
) -> PreparePullRequestThread {
    PreparePullRequestThread {
        source_thread_id: source.into(),
        target: PrObservation {
            key: PullRequestKey::new("fixture", "project", 41).unwrap(),
            node_id: "PR_fixture_41".into(),
            head_oid: head.into(),
            viewer: "fixture-viewer".into(),
        },
        destination,
    }
}

#[tokio::test]
async fn registered_external_detached_missing_and_foreign_worktrees() {
    let f = Fixture::new();
    let external = f.dir.path().join("external");
    git_at(
        &f.root,
        &[
            "worktree",
            "add",
            "--detach",
            &external.to_string_lossy(),
            "HEAD",
        ],
    );
    let (app, source) = f.open().await;
    let workspace = app.thread(source).await.unwrap().workspace_id;
    let rows = app.list_worktrees(workspace.clone()).await.unwrap();
    let row = rows
        .iter()
        .find(|r| r.path == external.canonicalize().unwrap())
        .unwrap();
    assert_eq!(row.branch, None);
    assert!(row.unavailable.is_none());
    let adopted = app
        .create_thread(
            workspace.clone(),
            NewCheckout::Registered {
                path: external.clone(),
            },
        )
        .await
        .unwrap();
    assert!(adopted.worktree_setup.is_none());
    assert!(matches!(adopted.checkout, Checkout::Worktree { branch, .. } if branch == "HEAD"));
    let other = Fixture::new();
    assert_eq!(
        app.create_thread(
            workspace.clone(),
            NewCheckout::Registered { path: other.root }
        )
        .await
        .unwrap_err()
        .code,
        "invalid_checkout"
    );
    std::fs::remove_dir_all(&external).unwrap();
    assert!(
        app.list_worktrees(workspace.clone())
            .await
            .unwrap()
            .iter()
            .any(|r| r.unavailable.is_some())
    );
    assert_eq!(
        app.create_thread(workspace, NewCheckout::Registered { path: external })
            .await
            .unwrap_err()
            .code,
        "missing_checkout"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn dedicated_pr_checkout_uses_fork_oid_without_overwriting_branch_and_persists_link() {
    let f = Fixture::new();
    let head = prepare_fixture(&f);
    let main = git_at(&f.root, &["rev-parse", "HEAD"]);
    git_at(&f.root, &["branch", "-f", "feature", "main"]);
    let (app, source) = f.open().await;
    let created = app
        .prepare_pull_request_thread(request(source, &head, PrCheckoutDestination::Dedicated))
        .await
        .unwrap();
    let Checkout::Worktree { path, branch } = &created.checkout else {
        panic!()
    };
    assert_eq!(git_at(path, &["rev-parse", "HEAD"]), head);
    assert_ne!(branch, "feature");
    assert_eq!(git_at(&f.root, &["rev-parse", "feature"]), main);
    assert_eq!(git_at(&f.root, &["branch", "--show-current"]), "main");
    assert_eq!(
        app.list_thread_pull_requests(created.id.clone(), false)
            .await
            .unwrap()
            .links[0]
            .pr
            .key,
        f.key()
    );
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    assert_eq!(
        app.thread(created.id.clone()).await.unwrap().checkout,
        created.checkout
    );
    assert_eq!(
        app.list_thread_pull_requests(created.id, false)
            .await
            .unwrap()
            .links[0]
            .pr
            .key,
        f.key()
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn stale_head_and_dirty_existing_refuse_without_switching() {
    let f = Fixture::new();
    let head = prepare_fixture(&f);
    let external = f.dir.path().join("external");
    git_at(
        &f.root,
        &[
            "worktree",
            "add",
            "-b",
            "existing",
            &external.to_string_lossy(),
            "main",
        ],
    );
    let (app, source) = f.open().await;
    let bad = request(
        source.clone(),
        &"f".repeat(40),
        PrCheckoutDestination::Dedicated,
    );
    assert_eq!(
        app.prepare_pull_request_thread(bad).await.unwrap_err().code,
        "pr_review_stale"
    );
    std::fs::write(external.join("precious"), "unsaved").unwrap();
    let input = request(
        source.clone(),
        &head,
        PrCheckoutDestination::Existing {
            path: external.clone(),
        },
    );
    assert_eq!(
        app.prepare_pull_request_thread(input)
            .await
            .unwrap_err()
            .code,
        "dirty_checkout"
    );
    assert_eq!(
        std::fs::read_to_string(external.join("precious")).unwrap(),
        "unsaved"
    );
    assert_eq!(git_at(&external, &["branch", "--show-current"]), "existing");
    std::fs::remove_file(external.join("precious")).unwrap();
    let workspace = app.thread(source.clone()).await.unwrap().workspace_id;
    let old = app
        .create_thread(
            workspace,
            NewCheckout::Registered {
                path: external.clone(),
            },
        )
        .await
        .unwrap();
    let created = app
        .prepare_pull_request_thread(request(
            source,
            &head,
            PrCheckoutDestination::Existing {
                path: external.clone(),
            },
        ))
        .await
        .unwrap();
    assert_eq!(git_at(&external, &["rev-parse", "HEAD"]), head);
    assert_eq!(app.thread(old.id).await.unwrap().checkout, created.checkout);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn exact_head_checkout_changed_during_final_refresh_refuses_preparation() {
    let f = Fixture::new();
    let head = prepare_fixture(&f);
    let external = f.dir.path().join("external");
    git_at(
        &f.root,
        &[
            "worktree",
            "add",
            "--detach",
            &external.to_string_lossy(),
            &head,
        ],
    );
    f.state(json!({"head":head, "metaDelay":0.25}));
    let (app, source) = f.open().await;
    let workspace = app.thread(source.clone()).await.unwrap().workspace_id;
    let worker = app.clone();
    let destination = PrCheckoutDestination::Existing {
        path: external.clone(),
    };
    let expected = head.clone();
    let pending = tokio::spawn(async move {
        worker
            .prepare_pull_request_thread(request(source, &expected, destination))
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.calls("BotReviewMeta", 41) < 3 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    std::fs::write(external.join("precious"), "unsaved").unwrap();
    let error = pending.await.unwrap().unwrap_err();
    assert_eq!(error.code, "dirty_checkout");
    assert_eq!(
        std::fs::read_to_string(external.join("precious")).unwrap(),
        "unsaved"
    );
    assert_eq!(git_at(&external, &["rev-parse", "HEAD"]), head);
    assert_eq!(app.list_thread_summaries(workspace).await.unwrap().len(), 1);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn late_head_change_retains_prepared_checkout_updates_shared_owners_and_releases_hold() {
    let f = Fixture::new();
    let head = prepare_fixture(&f);
    let external = f.dir.path().join("external");
    git_at(
        &f.root,
        &[
            "worktree",
            "add",
            "-b",
            "existing",
            &external.to_string_lossy(),
            "main",
        ],
    );
    f.state(json!({"head":head, "metaHeads":[head, head, "f".repeat(40)]}));
    let (app, source) = f.open().await;
    let workspace = app.thread(source.clone()).await.unwrap().workspace_id;
    let old = app
        .create_thread(
            workspace.clone(),
            NewCheckout::Registered {
                path: external.clone(),
            },
        )
        .await
        .unwrap();
    let error = app
        .prepare_pull_request_thread(request(
            source,
            &head,
            PrCheckoutDestination::Existing {
                path: external.clone(),
            },
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, "pr_review_stale");
    assert!(error.message.contains("retained"));
    assert_eq!(git_at(&external, &["rev-parse", "HEAD"]), head);
    let branch = git_at(&external, &["branch", "--show-current"]);
    assert!(
        matches!(app.thread(old.id).await.unwrap().checkout, Checkout::Worktree { branch: saved, .. } if saved == branch)
    );
    assert_eq!(
        app.list_thread_summaries(workspace.clone())
            .await
            .unwrap()
            .len(),
        2
    );
    assert!(
        app.list_worktrees(workspace)
            .await
            .unwrap()
            .iter()
            .find(|r| r.path == external.canonicalize().unwrap())
            .unwrap()
            .unavailable
            .is_none()
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn pr_setup_blocks_reuse_then_exact_head_skips_rerun_and_preserves_history() {
    let f = Fixture::new();
    let head = prepare_fixture(&f);
    std::fs::write(f.root.join("t3.json"), json!({"scripts":[{"name":"Install","command":"echo once >> \"$T3CODE_PROJECT_ROOT/count\"; while [ ! -e \"$T3CODE_PROJECT_ROOT/release\" ]; do sleep 0.05; done", "runOnWorktreeCreate":true}]}).to_string()).unwrap();
    let (app, source) = f.open().await;
    let created = app
        .prepare_pull_request_thread(request(
            source.clone(),
            &head,
            PrCheckoutDestination::Dedicated,
        ))
        .await
        .unwrap();
    let Checkout::Worktree { path, .. } = &created.checkout else {
        panic!()
    };
    let attempt = created.worktree_setup.as_ref().unwrap().id.clone();
    assert!(matches!(
        created.worktree_setup.as_ref().unwrap().state,
        SetupState::Pending | SetupState::Running
    ));
    let error = app
        .prepare_pull_request_thread(request(
            source.clone(),
            &head,
            PrCheckoutDestination::Existing { path: path.clone() },
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, "setup_busy");
    std::fs::write(f.root.join("release"), "").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(
                app.thread(created.id.clone())
                    .await
                    .unwrap()
                    .worktree_setup
                    .unwrap()
                    .state,
                SetupState::Succeeded
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    let reused = app
        .prepare_pull_request_thread(request(
            source.clone(),
            &head,
            PrCheckoutDestination::Existing { path: path.clone() },
        ))
        .await
        .unwrap();
    assert!(reused.worktree_setup.is_none());
    assert_eq!(
        app.thread(created.id.clone())
            .await
            .unwrap()
            .worktree_setup
            .unwrap()
            .id,
        attempt
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("count")).unwrap(),
        "once\n"
    );
    git_at(path, &["switch", "--detach", "main"]);
    let moved = app
        .prepare_pull_request_thread(request(
            source,
            &head,
            PrCheckoutDestination::Existing { path: path.clone() },
        ))
        .await
        .unwrap();
    assert_ne!(moved.worktree_setup.as_ref().unwrap().id, attempt);
    assert_eq!(
        app.thread(created.id)
            .await
            .unwrap()
            .worktree_setup
            .unwrap()
            .id,
        attempt
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn checkout_reservation_blocks_workspace_removal_and_shutdown_cancels_preparation() {
    for existing in [false, true] {
        let f = Fixture::new();
        let head = prepare_fixture(&f);
        let external = f.dir.path().join("external");
        git_at(
            &f.root,
            &[
                "worktree",
                "add",
                "--detach",
                &external.to_string_lossy(),
                "main",
            ],
        );
        let release = f.dir.path().join("meta-release");
        f.state(json!({"head":head,"waitFor":{"BotReviewMeta":release}}));
        let (app, source) = f.open().await;
        let workspace = app.thread(source.clone()).await.unwrap().workspace_id;
        let worker = app.clone();
        let destination = if existing {
            PrCheckoutDestination::Existing {
                path: external.clone(),
            }
        } else {
            PrCheckoutDestination::Dedicated
        };
        let pending = tokio::spawn(async move {
            worker
                .prepare_pull_request_thread(request(source, &head, destination))
                .await
        });
        f.wait_for("BotReviewMeta").await;
        assert!(app.remove_workspace(workspace.clone()).await.is_err());
        if existing {
            assert!(
                app.list_worktrees(workspace)
                    .await
                    .unwrap()
                    .iter()
                    .find(|r| r.path == external.canonicalize().unwrap())
                    .unwrap()
                    .unavailable
                    .is_some()
            );
        }
        app.shutdown().await.unwrap();
        assert_eq!(pending.await.unwrap().unwrap_err().code, "cancelled");
        assert_eq!(
            git_at(&external, &["rev-parse", "HEAD"]),
            git_at(&f.root, &["rev-parse", "main"])
        );
    }
}

#[tokio::test]
async fn active_review_read_excludes_checkout_preparation() {
    let f = Fixture::new();
    let head = prepare_fixture(&f);
    let release = f.dir.path().join("meta-release");
    f.state(json!({"head":head,"waitFor":{"BotReviewMeta":release}}));
    let (app, source) = f.open().await;
    let reader = app.clone();
    let read_source = source.clone();
    let key = f.key();
    let pending = tokio::spawn(async move { reader.read_pull_request(read_source, key).await });
    f.wait_for("BotReviewMeta").await;
    let error = app
        .prepare_pull_request_thread(request(source, &head, PrCheckoutDestination::Dedicated))
        .await
        .unwrap_err();
    assert_eq!(error.code, "pr_busy");
    std::fs::write(release, "").unwrap();
    pending.await.unwrap().unwrap();
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn pr_preparation_in_repository_root_retains_local_checkout_ownership() {
    let f = Fixture::new();
    let head = prepare_fixture(&f);
    let (app, source) = f.open().await;
    let created = app
        .prepare_pull_request_thread(request(
            source,
            &head,
            PrCheckoutDestination::Existing {
                path: f.root.clone(),
            },
        ))
        .await
        .unwrap();
    assert_eq!(created.checkout, Checkout::Local);
    assert_eq!(git_at(&f.root, &["rev-parse", "HEAD"]), head);
    assert!(created.worktree_setup.is_none());
    assert_eq!(
        app.list_thread_pull_requests(created.id, false)
            .await
            .unwrap()
            .links[0]
            .pr
            .key,
        f.key()
    );
    app.shutdown().await.unwrap();
}
