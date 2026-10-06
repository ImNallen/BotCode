use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use z1_core::*;

struct Fixture {
    dir: tempfile::TempDir,
    root: PathBuf,
    config: RuntimeConfig,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.name", "Fixture"]);
        git(&root, &["config", "user.email", "fixture@example.invalid"]);
        std::fs::write(root.join("file.txt"), "base\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "base"]);
        git(
            &root,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/fixture/project.git",
            ],
        );
        git(&root, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git(
            &root,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        git(&root, &["checkout", "-qb", "feature"]);
        std::fs::write(root.join("file.txt"), "feature\n").unwrap();
        git(&root, &["commit", "-qam", "feature"]);
        git(
            &root,
            &["update-ref", "refs/remotes/origin/feature", "HEAD"],
        );
        git(&root, &["config", "branch.feature.remote", "origin"]);
        git(
            &root,
            &["config", "branch.feature.merge", "refs/heads/feature"],
        );
        let gh = dir.path().join("gh");
        std::fs::write(&gh, include_str!("fixtures/gh-lifecycle.py")).unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = RuntimeConfig {
            data_dir: dir.path().join("state"),
            codex_binary: PathBuf::from("/no/codex"),
            gh_binary: gh,
            network_timeout: Duration::from_secs(15),
            shell: None,
        };
        let fixture = Self { dir, root, config };
        fixture.state(json!({"exists": false}));
        fixture
    }
    fn state(&self, value: Value) {
        let mut state = json!({"head": git(&self.root, &["rev-parse", "HEAD"]), "repository":"fixture/project", "branch":"feature", "number":41});
        for (key, value) in value.as_object().unwrap() {
            state[key] = value.clone();
        }
        let path = self.dir.path().join("gh.json");
        let pending = self.dir.path().join("gh.next");
        std::fs::write(&pending, state.to_string()).unwrap();
        std::fs::rename(pending, path).unwrap();
    }
    async fn open(&self) -> (App, WorkspaceId, ThreadId) {
        let app = App::open(self.config.clone()).await.unwrap();
        let workspace = app.open_workspace(self.root.clone()).await.unwrap();
        let thread = app
            .create_thread(workspace.id.clone(), NewCheckout::Local)
            .await
            .unwrap();
        wait(&app, &thread.id, |s| !s.discovering).await;
        (app, workspace.id, thread.id)
    }
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
    String::from_utf8(output.stdout).unwrap().trim().into()
}
async fn wait(
    app: &App,
    thread: &ThreadId,
    predicate: impl Fn(&ThreadPrSummary) -> bool,
) -> ThreadPrSummary {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let summary = app
                .list_thread_pull_requests(thread.clone(), false)
                .await
                .unwrap();
            if predicate(&summary) {
                return summary;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("Expected pull request state did not arrive")
}
fn current(summary: &ThreadPrSummary) -> bool {
    summary
        .links
        .first()
        .is_some_and(|l| matches!(l.pr.freshness, PrFreshness::Current { .. }))
}
fn key(number: u64) -> PullRequestKey {
    PullRequestKey::new("fixture", "project", number).unwrap()
}

#[tokio::test]
async fn create_reuse_shared_status_restart_and_unlink_tombstones() {
    let f = Fixture::new();
    let (app, workspace, first) = f.open().await;
    let second = app
        .create_thread(workspace.clone(), NewCheckout::Local)
        .await
        .unwrap()
        .id;
    wait(&app, &second, |s| !s.discovering).await;
    let created = app
        .run_git_action(
            workspace.clone(),
            Some(first.clone()),
            GitAction::CreatePr,
            |_| {},
        )
        .await
        .unwrap();
    assert!(created.failure.is_none(), "{:?}", created.failure);
    assert!(created.pr.unwrap().created);
    let first_summary = wait(&app, &first, current).await;
    assert_eq!(first_summary.links[0].source, PrLinkSource::GitCreated);
    let reused = app
        .run_git_action(
            workspace.clone(),
            Some(second.clone()),
            GitAction::CreatePr,
            |_| {},
        )
        .await
        .unwrap();
    assert!(!reused.pr.unwrap().created);
    let second_summary = wait(&app, &second, current).await;
    assert_eq!(second_summary.links[0].source, PrLinkSource::GitReused);
    assert_eq!(
        first_summary.links[0].pr.key,
        second_summary.links[0].pr.key
    );
    app.link_pull_request(first.clone(), key(42).url())
        .await
        .unwrap();
    app.unlink_pull_request(first.clone(), key(42))
        .await
        .unwrap();
    app.unlink_pull_request(first.clone(), key(41))
        .await
        .unwrap();
    app.shutdown().await.unwrap();
    drop(app);
    let app = App::open(f.config.clone()).await.unwrap();
    wait(&app, &first, |s| !s.discovering).await;
    assert!(
        app.list_thread_pull_requests(first.clone(), false)
            .await
            .unwrap()
            .links
            .is_empty()
    );
    assert_eq!(
        app.list_thread_pull_requests(second.clone(), false)
            .await
            .unwrap()
            .links
            .len(),
        1
    );
    app.link_pull_request(first.clone(), key(41).url())
        .await
        .unwrap();
    assert_eq!(
        app.workspace_view(workspace, None)
            .await
            .unwrap()
            .threads
            .iter()
            .find(|t| t.id == first)
            .unwrap()
            .pull_requests
            .links
            .len(),
        1
    );
    app.shutdown().await.unwrap();
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    let generation: i64 = db
        .query_row(
            "SELECT pr_generation FROM threads WHERE id=?1",
            [first.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        generation, 5,
        "restart must preserve newest membership generation"
    );
}

#[tokio::test]
async fn refresh_preserves_last_status_on_error_and_rejects_older_host_observation() {
    let f = Fixture::new();
    let (app, _, thread) = f.open().await;
    f.state(json!({"exists":true}));
    app.link_pull_request(thread.clone(), key(41).url())
        .await
        .unwrap();
    let initial = wait(&app, &thread, current).await.links.remove(0).pr;
    f.state(json!({"mode":"error"}));
    app.list_thread_pull_requests(thread.clone(), true)
        .await
        .unwrap();
    let stale = wait(&app, &thread, |s| {
        s.links
            .first()
            .is_some_and(|l| matches!(l.pr.freshness, PrFreshness::Stale { .. }))
    })
    .await
    .links
    .remove(0)
    .pr;
    assert_eq!(initial.snapshot, stale.snapshot);
    f.state(json!({"lifecycle":"CLOSED", "updatedAt":"2020-01-01T00:00:00Z"}));
    app.list_thread_pull_requests(thread.clone(), true)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(350)).await;
    let saved = app.list_thread_pull_requests(thread, false).await.unwrap();
    assert_eq!(initial.snapshot, saved.links[0].pr.snapshot);
    assert_eq!(initial.revision, saved.links[0].pr.revision);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn late_discovery_cannot_relink_unlinked_or_switched_checkout() {
    let f = Fixture::new();
    let (app, _, thread) = f.open().await;
    f.state(json!({"mode":"slow", "delay":0.5}));
    app.list_thread_pull_requests(thread.clone(), true)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;
    app.unlink_pull_request(thread.clone(), key(41))
        .await
        .unwrap();
    wait(&app, &thread, |s| !s.discovering).await;
    assert!(
        app.list_thread_pull_requests(thread.clone(), false)
            .await
            .unwrap()
            .links
            .is_empty()
    );
    app.list_thread_pull_requests(thread.clone(), true)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;
    git(&f.root, &["checkout", "-q", "main"]);
    let result = wait(&app, &thread, |s| !s.discovering).await;
    assert!(result.links.is_empty());
    assert!(result.discovery_error.unwrap().contains("changed"));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_reaps_hanging_github_descendants_and_releases_database() {
    let f = Fixture::new();
    let (app, _, thread) = f.open().await;
    f.state(json!({"mode":"hang"}));
    app.list_thread_pull_requests(thread, true).await.unwrap();
    let pid_file = f.dir.path().join("gh.pid");
    tokio::time::timeout(Duration::from_secs(3), async {
        while !pid_file.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let pid: i32 = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
    tokio::time::timeout(Duration::from_secs(5), app.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert_ne!(
        unsafe { libc::kill(pid, 0) },
        0,
        "GitHub child must be gone before shutdown completes"
    );
    let reopened = App::open(f.config.clone()).await.unwrap();
    reopened.shutdown().await.unwrap();
}

#[test]
fn canonical_identity_rejects_other_hosts_and_normalizes_repository_case() {
    assert_eq!(
        PullRequestKey::from_url("https://github.com/Fixture/PROJECT/pull/41/").unwrap(),
        key(41)
    );
    for url in [
        "https://evil.example/fixture/project/pull/41",
        "https://github.com/fixture/project/pull/0",
        "https://github.com/fixture/project/pull/41?x=y",
        "https://github.com/../project/pull/41",
    ] {
        assert!(PullRequestKey::from_url(url).is_err());
    }
}

#[tokio::test]
async fn fork_discovery_uses_head_repository_and_allows_unpushed_local_commits() {
    let f = Fixture::new();
    git(
        &f.root,
        &[
            "remote",
            "set-url",
            "origin",
            "git@github.com:contributor/fork.git",
        ],
    );
    git(
        &f.root,
        &[
            "remote",
            "add",
            "upstream",
            "https://github.com/fixture/project.git",
        ],
    );
    let (app, _, thread) = f.open().await;
    f.state(json!({"headRepository":"contributor/fork", "head":"b".repeat(40)}));
    app.list_thread_pull_requests(thread.clone(), true)
        .await
        .unwrap();
    let summary = wait(&app, &thread, current).await;
    assert_eq!(summary.links[0].pr.key, key(41));
    assert_eq!(
        summary.links[0].pr.snapshot.as_ref().unwrap().head_oid,
        "b".repeat(40)
    );
    assert_eq!(summary.links[0].source, PrLinkSource::BranchDiscovery);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn explicit_unlink_wins_over_an_already_started_create() {
    let f = Fixture::new();
    let (app, workspace, thread) = f.open().await;
    f.state(json!({"exists":false, "mode":"slow", "delay":0.2}));
    let creator = app.clone();
    let origin = thread.clone();
    let create = tokio::spawn(async move {
        creator
            .run_git_action(workspace, Some(origin), GitAction::CreatePr, |_| {})
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    app.unlink_pull_request(thread.clone(), key(41))
        .await
        .unwrap();
    let outcome = create.await.unwrap().unwrap();
    assert!(outcome.pr.unwrap().created);
    assert!(outcome.failure.is_none());
    let summary = wait(&app, &thread, |s| !s.discovering).await;
    assert!(summary.links.is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn shared_requests_coalesce_and_pin_the_explicit_host_and_repository() {
    let f = Fixture::new();
    let (app, workspace, first) = f.open().await;
    let second = app
        .create_thread(workspace, NewCheckout::Local)
        .await
        .unwrap()
        .id;
    wait(&app, &second, |s| !s.discovering).await;
    f.state(json!({"exists":true, "mode":"slow", "delay":0.3}));
    app.link_pull_request(first.clone(), key(41).url())
        .await
        .unwrap();
    app.link_pull_request(second.clone(), key(41).url())
        .await
        .unwrap();
    for _ in 0..10 {
        app.list_thread_pull_requests(first.clone(), true)
            .await
            .unwrap();
        app.list_thread_pull_requests(second.clone(), true)
            .await
            .unwrap();
    }
    wait(&app, &first, current).await;
    tokio::time::sleep(Duration::from_millis(900)).await;
    let one = app.list_thread_pull_requests(first, false).await.unwrap();
    let two = app.list_thread_pull_requests(second, false).await.unwrap();
    assert_eq!(one.links[0].pr, two.links[0].pr);
    app.shutdown().await.unwrap();
    let calls: Vec<Value> = std::fs::read_to_string(f.dir.path().join("gh.log"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let reads: Vec<_> = calls
        .iter()
        .filter(|call| {
            call["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a.as_str().is_some_and(|v| v.contains("Z1PullRequest")))
        })
        .collect();
    assert_eq!(
        reads.len(),
        2,
        "burst should share one read and one bounded rerun"
    );
    for read in reads {
        let args = read["args"].as_array().unwrap();
        assert!(
            args.windows(2)
                .any(|pair| pair == [json!("--hostname"), json!("github.com")])
        );
        for variable in ["owner=fixture", "name=project", "number=41"] {
            assert!(args.contains(&json!(variable)));
        }
    }
}

#[tokio::test]
async fn running_discovery_keeps_new_conversation_and_agent_completion_source() {
    let f = Fixture::new();
    let codex = f.dir.path().join("codex");
    std::fs::write(&codex, include_str!("support/codex_peer.py")).unwrap();
    std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut config = f.config.clone();
    config.codex_binary = codex;
    let app = App::open(config).await.unwrap();
    let workspace = app.open_workspace(f.root.clone()).await.unwrap();
    let first = app
        .create_thread(workspace.id.clone(), NewCheckout::Local)
        .await
        .unwrap()
        .id;
    wait(&app, &first, |s| !s.discovering).await;
    f.state(json!({"mode":"slow", "delay":0.7}));
    app.list_thread_pull_requests(first.clone(), true)
        .await
        .unwrap();
    let second = app
        .create_thread(workspace.id, NewCheckout::Local)
        .await
        .unwrap()
        .id;
    app.submit(second.clone(), "agent-discovery".into(), "hello".into())
        .await
        .unwrap();
    let summary = wait(&app, &second, current).await;
    assert_eq!(summary.links[0].source, PrLinkSource::AgentDiscovered);
    assert_eq!(wait(&app, &first, current).await.links[0].pr.key, key(41));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn restart_marks_saved_status_stale_until_github_confirms_it() {
    let f = Fixture::new();
    let (app, _, thread) = f.open().await;
    f.state(json!({}));
    app.link_pull_request(thread.clone(), key(41).url())
        .await
        .unwrap();
    let before = wait(&app, &thread, current).await;
    app.shutdown().await.unwrap();
    f.state(json!({"mode":"slow", "delay":0.5}));
    let app = App::open(f.config.clone()).await.unwrap();
    let restored = app
        .list_thread_pull_requests(thread.clone(), false)
        .await
        .unwrap();
    assert_eq!(restored.links[0].pr.snapshot, before.links[0].pr.snapshot);
    assert!(matches!(
        restored.links[0].pr.freshness,
        PrFreshness::Stale {
            last_success: Some(_),
            ..
        }
    ));
    wait(&app, &thread, current).await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn ambiguous_discovery_does_not_choose_the_first_pull_request() {
    let f = Fixture::new();
    let (app, _, thread) = f.open().await;
    f.state(json!({"mode":"ambiguous"}));
    app.list_thread_pull_requests(thread.clone(), true)
        .await
        .unwrap();
    let result = wait(&app, &thread, |s| !s.discovering).await;
    assert!(result.links.is_empty());
    assert!(
        result
            .discovery_error
            .unwrap()
            .contains("Several pull requests")
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn linked_status_survives_branch_switch_and_removed_worktree() {
    let f = Fixture::new();
    let (app, workspace, _) = f.open().await;
    let thread = app
        .create_thread(
            workspace.clone(),
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: false,
            },
        )
        .await
        .unwrap();
    let Checkout::Worktree { path, .. } = &thread.checkout else {
        panic!("expected worktree")
    };
    f.state(json!({}));
    app.link_pull_request(thread.id.clone(), key(41).url())
        .await
        .unwrap();
    wait(&app, &thread.id, current).await;
    app.switch_branch(
        workspace.clone(),
        Some(thread.id.clone()),
        "other".into(),
        true,
    )
    .await
    .unwrap();
    assert_eq!(
        app.list_thread_pull_requests(thread.id.clone(), false)
            .await
            .unwrap()
            .links
            .len(),
        1
    );
    git(
        &f.root,
        &["worktree", "remove", "--force", path.to_str().unwrap()],
    );
    app.list_thread_pull_requests(thread.id.clone(), true)
        .await
        .unwrap();
    let summary = wait(&app, &thread.id, current).await;
    assert_eq!(summary.links[0].pr.key, key(41));
    assert!(
        app.workspace_view(workspace, Some(thread.id))
            .await
            .unwrap()
            .unavailable
            .is_some()
    );
    app.shutdown().await.unwrap();
}

fn create_calls(f: &Fixture) -> usize {
    std::fs::read_to_string(f.dir.path().join("gh.log"))
        .unwrap()
        .lines()
        .filter(|line| {
            let row: Value = serde_json::from_str(line).unwrap();
            row["args"][0] == "pr" && row["args"][1] == "create"
        })
        .count()
}

#[tokio::test]
async fn shutdown_drains_create_and_saves_origin_before_immediate_reopen() {
    let f = Fixture::new();
    let (app, workspace, thread) = f.open().await;
    f.state(json!({"exists": false, "createDelay": 0.8}));
    let running = app.clone();
    let origin = thread.clone();
    let create = tokio::spawn(async move {
        running
            .run_git_action(workspace, Some(origin), GitAction::CreatePr, |_| {})
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while create_calls(&f) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    app.shutdown().await.unwrap();
    let reopened = App::open(f.config.clone()).await.unwrap();
    let saved = reopened
        .list_thread_pull_requests(thread, false)
        .await
        .unwrap();
    assert_eq!(saved.links.len(), 1);
    assert_eq!(saved.links[0].source, PrLinkSource::GitCreated);
    assert_eq!(saved.links[0].pr.key, key(41));
    assert_eq!(create_calls(&f), 1);
    let outcome = create.await.unwrap();
    assert!(outcome.failure.is_none());
    assert!(outcome.pr.unwrap().created);
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn creation_identity_survives_failed_following_metadata_read() {
    let f = Fixture::new();
    let (app, workspace, thread) = f.open().await;
    f.state(json!({"exists": false, "failReadAfterCreate": true}));
    let outcome = app
        .run_git_action(workspace, Some(thread.clone()), GitAction::CreatePr, |_| {})
        .await
        .unwrap();
    assert!(outcome.failure.is_none(), "{:?}", outcome.failure);
    let opened = outcome.pr.unwrap();
    assert!(opened.created);
    assert_eq!(opened.pr.url, key(41).url());
    assert_eq!(opened.pr.title, None);
    let saved = wait(&app, &thread, |summary| {
        summary
            .links
            .first()
            .is_some_and(|link| matches!(link.pr.freshness, PrFreshness::Stale { .. }))
    })
    .await;
    assert_eq!(saved.links[0].source, PrLinkSource::GitCreated);
    assert!(saved.links[0].pr.snapshot.is_none());
    assert_eq!(create_calls(&f), 1);
    let log = std::fs::read_to_string(f.dir.path().join("gh.log")).unwrap();
    assert!(!log.contains("\"view\""));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn timed_out_creation_is_uncertain_and_is_not_retried() {
    let mut f = Fixture::new();
    f.config.network_timeout = Duration::from_millis(200);
    let (app, workspace, thread) = f.open().await;
    f.state(json!({"exists": false, "createDelay": 3}));
    let outcome = app
        .run_git_action(workspace, Some(thread), GitAction::CreatePr, |_| {})
        .await
        .unwrap();
    assert_eq!(outcome.failure.unwrap().error.code, "pr_creation_uncertain");
    assert!(outcome.pr.is_none());
    app.shutdown().await.unwrap();
    assert_eq!(create_calls(&f), 1);
}

#[tokio::test]
async fn unrelated_mutation_preserves_in_flight_checkout_discovery() {
    for review in [true, false] {
        let f = Fixture::new();
        let (app, _, first) = f.open().await;
        f.state(json!({}));
        app.link_pull_request(first.clone(), key(41).url())
            .await
            .unwrap();
        wait(&app, &first, current).await;
        let detail = app.read_pull_request(first.clone(), key(41)).await.unwrap();
        let other_root = f.dir.path().join("other");
        git(
            f.dir.path(),
            &[
                "clone",
                "-q",
                f.root.to_str().unwrap(),
                other_root.to_str().unwrap(),
            ],
        );
        git(
            &other_root,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/fixture/project.git",
            ],
        );
        let release = f.dir.path().join("release-discovery");
        f.state(json!({"number":42,"matchNumber":true,"waitFor":{"Z1Discover":release}}));
        let log = f.dir.path().join("gh.log");
        std::fs::write(&log, "").unwrap();
        let workspace = app.open_workspace(other_root).await.unwrap();
        let second = app
            .create_thread(workspace.id, NewCheckout::Local)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !std::fs::read_to_string(&log)
                .unwrap()
                .contains("Z1Discover")
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let action = if review {
            PrReviewAction::SubmitReview {
                verdict: ReviewVerdict::Comment,
                body: "Review while another checkout discovers its PR".into(),
                comments: vec![],
            }
        } else {
            PrReviewAction::SetDraft { draft: true }
        };
        let result = app
            .change_pull_request(
                first,
                PrReviewChange {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    target: detail.observation,
                    action,
                },
            )
            .await
            .unwrap();
        assert!(
            matches!(
                result,
                PrChangeResult::Applied { .. }
                    | PrChangeResult::Confirmed {
                        state: PrConfirmedState::Draft
                    }
            ),
            "{result:?}"
        );
        std::fs::write(release, "").unwrap();
        let projection = wait(&app, &second.id, |s| !s.discovering).await;
        app.shutdown().await.unwrap();
        assert_eq!(
            projection
                .links
                .iter()
                .map(|link| link.pr.key.clone())
                .collect::<Vec<_>>(),
            vec![key(42)],
            "review mutation = {review}, discovery error = {:?}",
            projection.discovery_error
        );
        assert_eq!(projection.links[0].source, PrLinkSource::BranchDiscovery);
        assert!(matches!(
            projection.links[0].pr.freshness,
            PrFreshness::Current { .. }
        ));
    }
}
