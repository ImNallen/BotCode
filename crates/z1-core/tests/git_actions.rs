use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use z1_core::*;
struct Fixture {
    dir: tempfile::TempDir,
    config: RuntimeConfig,
    repository: PathBuf,
    origin: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repository = dir.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        git_output(&repository, &["init", "-q", "-b", "main"]);
        git_output(&repository, &["config", "user.name", "Test"]);
        git_output(
            &repository,
            &["config", "user.email", "test@example.invalid"],
        );
        commit_in(&repository, "README.md");
        let origin = dir.path().join("origin.git");
        git_output(
            dir.path(),
            &["clone", "-q", "--bare", "repository", "origin.git"],
        );
        git_output(
            &repository,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        git_output(&repository, &["fetch", "-q", "origin"]);
        git_output(&repository, &["remote", "set-head", "origin", "main"]);
        git_output(&repository, &["branch", "-q", "-u", "origin/main", "main"]);
        let peers = dir.path().join("peers");
        std::fs::create_dir(&peers).unwrap();
        let install = |name: &str, source: &str| {
            let path = peers.join(name);
            std::fs::write(&path, source).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        Self {
            config: RuntimeConfig {
                data_dir: dir.path().join("state"),
                codex_binary: install("codex", include_str!("support/codex_peer.py")),
                gh_binary: install("gh", include_str!("support/gh_peer.py")),
                network_timeout: Duration::from_secs(60),
            },
            dir,
            repository,
            origin,
        }
    }
    fn gh_calls(&self) -> Vec<Vec<String>> {
        std::fs::read_to_string(self.dir.path().join("peers/calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| line.starts_with('['))
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn hook(&self, git_dir: &Path, name: &str, script: &str) {
        let path = git_dir.join("hooks").join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    async fn open(&self) -> (App, WorkspaceId) {
        let app = App::open(self.config.clone()).await.unwrap();
        let workspace = app.open_workspace(self.repository.clone()).await.unwrap();
        (app, workspace.id)
    }
}
fn git_output(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}
fn commit_in(root: &Path, file: &str) {
    std::fs::write(root.join(file), format!("{file}\n")).unwrap();
    git_output(root, &["add", file]);
    git_output(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            file,
        ],
    );
}
fn advance_origin(f: &Fixture, branch: &str, file: &str) {
    let other = f.dir.path().join("other");
    if !other.exists() {
        git_output(f.dir.path(), &["clone", "-q", "origin.git", "other"]);
    }
    git_output(&other, &["fetch", "-q", "origin"]);
    git_output(
        &other,
        &["checkout", "-q", "-B", branch, &format!("origin/{branch}")],
    );
    commit_in(&other, file);
    git_output(&other, &["push", "-q", "origin", branch]);
}
fn message(text: &str) -> CommitMessage {
    CommitMessage::try_from(text.to_owned()).unwrap()
}
async fn run(
    app: &App,
    workspace: &WorkspaceId,
    thread: Option<&ThreadId>,
    action: GitAction,
) -> Result<(GitOutcome, Vec<GitPhase>)> {
    let phases = Arc::new(Mutex::new(Vec::new()));
    let sink = phases.clone();
    let outcome = app
        .run_git_action(workspace.clone(), thread.cloned(), action, move |phase| {
            sink.lock().unwrap().push(phase)
        })
        .await?;
    let phases = phases.lock().unwrap().clone();
    Ok((outcome, phases))
}
fn failure(outcome: &GitOutcome) -> (GitPhase, &str) {
    let failure = outcome.failure.as_ref().expect("the action should fail");
    (failure.phase.clone(), failure.error.code.as_str())
}
fn push_phase() -> GitPhase {
    GitPhase::Push {
        remote: "origin".into(),
    }
}
fn branch(name: &str, base: &str, ahead_of_base: u32, upstream: Option<Tracking>) -> BranchStatus {
    BranchStatus {
        name: name.into(),
        is_default: name == "main",
        base: base.into(),
        ahead_of_base,
        upstream,
    }
}
fn tracking(branch: &str, ahead: u32, behind: u32) -> Option<Tracking> {
    Some(Tracking {
        remote: "origin".into(),
        branch: branch.into(),
        ahead,
        behind,
    })
}
fn stat(path: &str, insertions: u32, deletions: u32) -> FileStat {
    FileStat {
        path: path.into(),
        insertions,
        deletions,
    }
}
async fn wait_until(mut ready: impl FnMut() -> bool) {
    for _ in 0..500 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("Timed out awaiting the condition")
}

#[tokio::test]
async fn status_reports_the_tracked_default_branch_and_line_counts_including_untracked() {
    let f = Fixture::new();
    std::fs::write(f.repository.join("README.md"), "one\ntwo\n").unwrap();
    std::fs::write(f.repository.join("new.txt"), "a\nb\nc\n").unwrap();
    std::fs::write(f.repository.join("image.bin"), [0u8, 1, 2]).unwrap();
    git_output(&f.repository, &["add", "image.bin"]);
    let (app, workspace) = f.open().await;
    assert_eq!(
        app.git_status(workspace, None).await.unwrap(),
        GitStatus {
            branch: Some(branch("main", "main", 0, tracking("main", 0, 0))),
            origin: true,
            files: vec![
                stat("README.md", 2, 1),
                stat("image.bin", 0, 0),
                stat("new.txt", 0, 0),
            ],
        }
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn status_counts_commits_ahead_of_base_before_a_branch_is_published() {
    let f = Fixture::new();
    git_output(&f.repository, &["switch", "-q", "-c", "feature"]);
    commit_in(&f.repository, "a.txt");
    commit_in(&f.repository, "b.txt");
    let (app, workspace) = f.open().await;
    assert_eq!(
        app.git_status(workspace, None).await.unwrap().branch,
        Some(branch("feature", "main", 2, None))
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn branches_that_track_origin_main_read_as_unpublished_with_main_as_base() {
    let f = Fixture::new();
    git_output(
        &f.repository,
        &["switch", "-q", "-c", "old", "--track", "origin/main"],
    );
    commit_in(&f.repository, "a.txt");
    let (app, workspace) = f.open().await;
    assert_eq!(
        app.git_status(workspace, None).await.unwrap().branch,
        Some(branch("old", "main", 1, None)),
        "a worktree created before --no-track tracks origin/main under another name"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn status_reports_ahead_and_behind_against_the_upstream() {
    let f = Fixture::new();
    advance_origin(&f, "main", "theirs.txt");
    git_output(&f.repository, &["fetch", "-q", "origin"]);
    commit_in(&f.repository, "ours.txt");
    let (app, workspace) = f.open().await;
    assert_eq!(
        app.git_status(workspace, None).await.unwrap().branch,
        Some(branch("main", "main", 0, tracking("main", 1, 1)))
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn status_has_no_branch_on_a_detached_head() {
    let f = Fixture::new();
    git_output(&f.repository, &["checkout", "-q", "--detach", "HEAD"]);
    let (app, workspace) = f.open().await;
    assert_eq!(
        app.git_status(workspace, None).await.unwrap(),
        GitStatus {
            branch: None,
            origin: true,
            files: vec![],
        }
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn worktree_threads_record_their_base_and_refuse_once_removed() {
    let f = Fixture::new();
    git_output(&f.repository, &["branch", "develop"]);
    let (app, workspace) = f.open().await;
    let thread = app
        .create_thread(
            workspace.clone(),
            NewCheckout::Worktree {
                base: "develop".into(),
                from_origin: false,
            },
        )
        .await
        .unwrap();
    let Checkout::Worktree { path, branch: name } = thread.checkout.clone() else {
        panic!("expected a worktree");
    };
    assert_eq!(
        git_output(
            &f.repository,
            &["config", "--get", &format!("branch.{name}.gh-merge-base")]
        ),
        "develop"
    );
    assert_eq!(
        app.git_status(workspace.clone(), Some(thread.id.clone()))
            .await
            .unwrap()
            .branch,
        Some(branch(&name, "develop", 0, None))
    );
    std::fs::remove_dir_all(&path).unwrap();
    assert_eq!(
        app.git_status(workspace.clone(), Some(thread.id.clone()))
            .await
            .unwrap_err()
            .code,
        "worktree_removed"
    );
    let scratch = app.ensure_scratch().await.unwrap();
    let folder = app
        .create_thread(
            scratch.id.clone(),
            NewCheckout::Folder {
                prompt: "notes".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        app.git_status(scratch.id, Some(folder.id))
            .await
            .unwrap_err()
            .code,
        "not_repository"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn commit_includes_untracked_files_and_reports_its_subject() {
    let f = Fixture::new();
    std::fs::write(f.repository.join("README.md"), "changed\n").unwrap();
    std::fs::write(f.repository.join("new.txt"), "new\n").unwrap();
    let (app, workspace) = f.open().await;
    let (outcome, phases) = run(
        &app,
        &workspace,
        None,
        GitAction::Commit {
            message: message("  Add new.txt\n\nWith a body.  "),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        outcome,
        GitOutcome {
            commit: Some(Committed {
                sha: git_output(&f.repository, &["rev-parse", "HEAD"]),
                subject: "Add new.txt".into(),
            }),
            ..GitOutcome::default()
        }
    );
    assert_eq!(phases, [GitPhase::Commit]);
    assert_eq!(
        git_output(&f.repository, &["log", "-1", "--format=%B"]),
        "Add new.txt\n\nWith a body."
    );
    assert_eq!(
        git_output(&f.repository, &["show", "--name-only", "--format=", "HEAD"]),
        "README.md\nnew.txt"
    );
    assert_eq!(
        app.git_status(workspace, None).await.unwrap().files,
        vec![],
        "the working tree is clean after the commit"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn commit_push_publishes_a_branch_and_records_its_base() {
    let f = Fixture::new();
    git_output(&f.repository, &["switch", "-q", "-c", "feature"]);
    std::fs::write(f.repository.join("a.txt"), "a\n").unwrap();
    let (app, workspace) = f.open().await;
    let (outcome, phases) = run(
        &app,
        &workspace,
        None,
        GitAction::CommitPush {
            message: message("Add a"),
        },
    )
    .await
    .unwrap();
    let sha = git_output(&f.repository, &["rev-parse", "HEAD"]);
    assert_eq!(
        outcome.push,
        Some(Pushed {
            sha: sha.clone(),
            upstream: "origin/feature".into(),
            set_upstream: true,
        })
    );
    assert_eq!(outcome.failure, None);
    assert_eq!(phases, [GitPhase::Commit, push_phase()]);
    assert_eq!(git_output(&f.origin, &["rev-parse", "feature"]), sha);
    assert_eq!(
        git_output(
            &f.repository,
            &["config", "--get", "branch.feature.gh-merge-base"]
        ),
        "main"
    );
    assert_eq!(
        app.git_status(workspace.clone(), None)
            .await
            .unwrap()
            .branch,
        Some(branch("feature", "main", 1, tracking("feature", 0, 0)))
    );
    std::fs::write(f.repository.join("b.txt"), "b\n").unwrap();
    let (outcome, _) = run(
        &app,
        &workspace,
        None,
        GitAction::CommitPush {
            message: message("Add b"),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        outcome.push.map(|p| p.set_upstream),
        Some(false),
        "a published branch pushes to its upstream without -u"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn commit_push_pr_opens_one_pull_request_against_the_worktree_base() {
    let f = Fixture::new();
    git_output(&f.repository, &["push", "-q", "origin", "main:develop"]);
    let (app, workspace) = f.open().await;
    let thread = app
        .create_thread(
            workspace.clone(),
            NewCheckout::Worktree {
                base: "develop".into(),
                from_origin: true,
            },
        )
        .await
        .unwrap();
    let Checkout::Worktree { path, branch: name } = thread.checkout.clone() else {
        panic!("expected a worktree");
    };
    std::fs::write(path.join("feature.txt"), "feature\n").unwrap();
    let (outcome, phases) = run(
        &app,
        &workspace,
        Some(&thread.id),
        GitAction::CommitPushPr {
            message: message("Add the feature"),
        },
    )
    .await
    .unwrap();
    let pr = PullRequest {
        number: 1,
        title: "Add the feature".into(),
        url: "https://github.com/z1/fixture/pull/1".into(),
        base: "develop".into(),
        head: name.clone(),
    };
    assert_eq!(
        outcome.pr,
        Some(PrOpened {
            pr: pr.clone(),
            created: true,
        })
    );
    assert_eq!(outcome.failure, None);
    assert_eq!(phases, [GitPhase::Commit, push_phase(), GitPhase::Pr]);
    let json = "number,title,url,baseRefName,headRefName,isCrossRepository";
    assert_eq!(
        f.gh_calls(),
        [
            vec![
                "pr",
                "list",
                "--head",
                name.as_str(),
                "--state",
                "open",
                "--limit",
                "20",
                "--json",
                json
            ],
            vec![
                "pr",
                "create",
                "--fill",
                "--base",
                "develop",
                "--head",
                name.as_str()
            ],
            vec![
                "pr",
                "view",
                "https://github.com/z1/fixture/pull/1",
                "--json",
                json
            ],
        ]
    );
    assert_eq!(
        app.pull_request(workspace, Some(thread.id), name)
            .await
            .unwrap(),
        PrLookup::Open { pr }
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn create_pr_returns_the_open_pull_request_instead_of_creating_one() {
    let f = Fixture::new();
    git_output(&f.repository, &["switch", "-q", "-c", "feature"]);
    commit_in(&f.repository, "a.txt");
    git_output(&f.repository, &["push", "-q", "-u", "origin", "feature"]);
    let pr = PullRequest {
        number: 7,
        title: "Existing".into(),
        url: "https://github.com/z1/fixture/pull/7".into(),
        base: "main".into(),
        head: "feature".into(),
    };
    std::fs::write(
        f.dir.path().join("peers/prs.json"),
        serde_json::json!([{
            "number": 7, "title": "Existing", "url": pr.url, "baseRefName": "main",
            "headRefName": "feature", "isCrossRepository": false, "state": "OPEN"
        }])
        .to_string(),
    )
    .unwrap();
    let (app, workspace) = f.open().await;
    let (outcome, phases) = run(&app, &workspace, None, GitAction::CreatePr)
        .await
        .unwrap();
    assert_eq!(
        outcome,
        GitOutcome {
            pr: Some(PrOpened { pr, created: false }),
            ..GitOutcome::default()
        }
    );
    assert_eq!(phases, [GitPhase::Pr], "nothing to push, nothing to create");
    assert!(
        f.gh_calls().iter().all(|call| call[1] != "create"),
        "gh pr create never ran: {:?}",
        f.gh_calls()
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn pull_request_actions_are_refused_before_the_commit_without_gh() {
    let mut f = Fixture::new();
    git_output(&f.repository, &["switch", "-q", "-c", "feature"]);
    std::fs::write(f.repository.join("a.txt"), "a\n").unwrap();
    let head = git_output(&f.repository, &["rev-parse", "HEAD"]);
    std::fs::write(f.dir.path().join("peers/unauthenticated"), "").unwrap();
    let (app, workspace) = f.open().await;
    let commit_push_pr = || GitAction::CommitPushPr {
        message: message("Add a"),
    };
    let (outcome, phases) = run(&app, &workspace, None, commit_push_pr()).await.unwrap();
    assert_eq!(failure(&outcome), (GitPhase::Pr, "gh_unauthenticated"));
    assert_eq!(
        (outcome.commit, outcome.push, phases),
        (None, None, vec![]),
        "nothing ran"
    );
    assert_eq!(
        app.pull_request(workspace.clone(), None, "feature".into())
            .await
            .unwrap(),
        PrLookup::Unavailable {
            reason: GhProblem::Unauthenticated,
            message: "Run `gh auth login` to create pull requests.".into(),
        }
    );
    app.shutdown().await.unwrap();
    f.config.gh_binary = f.dir.path().join("no-gh");
    f.config.data_dir = f.dir.path().join("state-without-gh");
    let (app, workspace) = f.open().await;
    let (outcome, _) = run(&app, &workspace, None, commit_push_pr()).await.unwrap();
    assert_eq!(failure(&outcome), (GitPhase::Pr, "gh_missing"));
    assert_eq!(outcome.commit, None);
    assert_eq!(git_output(&f.repository, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        app.pull_request(workspace.clone(), None, "feature".into())
            .await
            .unwrap(),
        PrLookup::Unavailable {
            reason: GhProblem::Missing,
            message: "Install GitHub CLI (gh) to create pull requests.".into(),
        }
    );
    let (outcome, _) = run(
        &app,
        &workspace,
        None,
        GitAction::CommitPush {
            message: message("Add a"),
        },
    )
    .await
    .unwrap();
    assert_eq!(outcome.failure, None, "commit and push work without gh");
    assert_eq!(
        app.pull_request(workspace, None, "-x".into())
            .await
            .unwrap_err()
            .code,
        "invalid_branch"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_rejected_push_keeps_the_commit_and_a_rerun_converges() {
    let f = Fixture::new();
    git_output(&f.repository, &["switch", "-q", "-c", "feature"]);
    std::fs::write(f.repository.join("a.txt"), "a\n").unwrap();
    f.hook(
        &f.origin,
        "pre-receive",
        "echo 'protected by policy' >&2; exit 1",
    );
    let (app, workspace) = f.open().await;
    let (outcome, phases) = run(
        &app,
        &workspace,
        None,
        GitAction::CommitPushPr {
            message: message("Add a"),
        },
    )
    .await
    .unwrap();
    let sha = git_output(&f.repository, &["rev-parse", "HEAD"]);
    assert_eq!(
        outcome.commit,
        Some(Committed {
            sha: sha.clone(),
            subject: "Add a".into(),
        })
    );
    assert_eq!((outcome.push.clone(), outcome.pr.clone()), (None, None));
    assert_eq!(failure(&outcome), (push_phase(), "git"));
    assert!(
        outcome
            .failure
            .unwrap()
            .error
            .message
            .contains("protected by policy"),
        "the toast can show git's message"
    );
    assert_eq!(phases, [GitPhase::Commit, push_phase()]);
    std::fs::remove_file(f.origin.join("hooks/pre-receive")).unwrap();
    let (outcome, phases) = run(&app, &workspace, None, GitAction::CreatePr)
        .await
        .unwrap();
    assert_eq!(
        (outcome.push.map(|p| p.sha), outcome.pr.map(|p| p.created)),
        (Some(sha.clone()), Some(true))
    );
    assert_eq!(phases, [push_phase(), GitPhase::Pr]);
    let (outcome, phases) = run(&app, &workspace, None, GitAction::CreatePr)
        .await
        .unwrap();
    assert_eq!(
        (outcome.push, outcome.pr.map(|p| (p.pr.number, p.created))),
        (None, Some((1, false))),
        "the second run neither pushes nor opens another pull request"
    );
    assert_eq!(phases, [GitPhase::Pr]);
    assert_eq!(
        f.gh_calls()
            .iter()
            .filter(|call| call[1] == "create")
            .count(),
        1
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn refusals_are_decided_before_anything_runs() {
    let f = Fixture::new();
    let (app, workspace) = f.open().await;
    let code = |outcome: GitOutcome| {
        assert_eq!(
            (outcome.commit, outcome.push, outcome.pr, outcome.pull),
            (None, None, None, None)
        );
        failure(&GitOutcome {
            failure: outcome.failure,
            ..GitOutcome::default()
        })
        .1
        .to_owned()
    };
    let attempt = |action| {
        let (app, workspace) = (&app, &workspace);
        async move { code(run(app, workspace, None, action).await.unwrap().0) }
    };
    let commit = || GitAction::Commit {
        message: message("Nothing"),
    };
    assert_eq!(attempt(commit()).await, "nothing_to_commit");
    assert_eq!(attempt(GitAction::Push).await, "nothing_to_push");
    advance_origin(&f, "main", "theirs.txt");
    git_output(&f.repository, &["fetch", "-q", "origin"]);
    commit_in(&f.repository, "ours.txt");
    std::fs::write(f.repository.join("dirty.txt"), "dirty\n").unwrap();
    let head = git_output(&f.repository, &["rev-parse", "HEAD"]);
    assert_eq!(attempt(GitAction::Push).await, "behind_upstream");
    assert_eq!(
        attempt(GitAction::CommitPush {
            message: message("Ours"),
        })
        .await,
        "behind_upstream"
    );
    assert_eq!(
        git_output(&f.repository, &["rev-parse", "HEAD"]),
        head,
        "the commit did not land ahead of a refused push"
    );
    assert_eq!(attempt(GitAction::Pull).await, "diverged");
    git_output(&f.repository, &["switch", "-q", "-c", "feature"]);
    assert_eq!(attempt(GitAction::CreatePr).await, "uncommitted_changes");
    git_output(&f.repository, &["checkout", "-q", "--detach"]);
    assert_eq!(attempt(GitAction::Push).await, "detached_head");
    assert!(
        f.gh_calls().is_empty(),
        "refusals before the lookup never ran gh"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn pull_fast_forwards_once() {
    let f = Fixture::new();
    advance_origin(&f, "main", "theirs.txt");
    git_output(&f.repository, &["fetch", "-q", "origin"]);
    let (app, workspace) = f.open().await;
    let pulled = |updated| Pulled {
        upstream: "origin/main".into(),
        updated,
    };
    let (outcome, phases) = run(&app, &workspace, None, GitAction::Pull).await.unwrap();
    assert_eq!(outcome.pull, Some(pulled(true)));
    assert_eq!(phases, [GitPhase::Pull]);
    assert!(f.repository.join("theirs.txt").exists());
    let (outcome, _) = run(&app, &workspace, None, GitAction::Pull).await.unwrap();
    assert_eq!(outcome.pull, Some(pulled(false)));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn git_actions_and_codex_turns_exclude_each_other() {
    let f = Fixture::new();
    std::fs::write(f.repository.join("a.txt"), "a\n").unwrap();
    let (app, workspace) = f.open().await;
    let local = app
        .create_thread(workspace.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let isolated = app
        .create_thread(
            workspace.clone(),
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: false,
            },
        )
        .await
        .unwrap();
    app.submit(local.id.clone(), "hold".into(), "hold".into())
        .await
        .unwrap();
    for _ in 0..500 {
        let t = app.thread(local.id.clone()).await.unwrap();
        if matches!(t.turns[0].execution, Execution::Running) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let commit = || GitAction::Commit {
        message: message("Add a"),
    };
    let refused = run(&app, &workspace, None, commit()).await.unwrap_err();
    assert_eq!(
        (refused.code.as_str(), refused.message.as_str()),
        (
            "checkout_busy",
            "Codex is working in this checkout. Git actions return when the turn finishes."
        )
    );
    let (outcome, _) = run(&app, &workspace, Some(&isolated.id), GitAction::Push)
        .await
        .unwrap();
    assert_eq!(
        failure(&outcome).1,
        "nothing_to_push",
        "a worktree thread's checkout is not held by the local turn"
    );
    app.interrupt(local.id.clone()).await.unwrap();
    for _ in 0..500 {
        let t = app.thread(local.id.clone()).await.unwrap();
        if matches!(t.turns[0].execution, Execution::Interrupted) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (started, go) = (f.dir.path().join("started"), f.dir.path().join("go"));
    f.hook(
        &f.repository.join(".git"),
        "pre-commit",
        &format!(
            "touch {}; while [ ! -e {} ]; do sleep 0.05; done",
            started.display(),
            go.display()
        ),
    );
    let action = {
        let (app, workspace) = (app.clone(), workspace.clone());
        tokio::spawn(async move { run(&app, &workspace, None, commit()).await })
    };
    wait_until(|| started.exists()).await;
    let busy = "A Git action is running in this checkout. Try again when it finishes.";
    let refused = app
        .submit(local.id.clone(), "second".into(), "second".into())
        .await
        .unwrap_err();
    assert_eq!(
        (refused.code.as_str(), refused.message.as_str()),
        ("checkout_busy", busy)
    );
    let refused = app
        .switch_branch(workspace.clone(), None, "other".into(), true)
        .await
        .unwrap_err();
    assert_eq!(refused.message, busy);
    std::fs::write(&go, "").unwrap();
    let (outcome, _) = action.await.unwrap().unwrap();
    assert_eq!(outcome.failure, None);
    app.submit(local.id.clone(), "third".into(), "third".into())
        .await
        .unwrap();
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_timed_out_push_fails_and_releases_the_checkout() {
    let mut f = Fixture::new();
    f.config.network_timeout = Duration::from_secs(1);
    git_output(&f.repository, &["switch", "-q", "-c", "feature"]);
    commit_in(&f.repository, "a.txt");
    f.hook(&f.origin, "pre-receive", "sleep 30");
    let (app, workspace) = f.open().await;
    let started = Instant::now();
    let (outcome, _) = run(&app, &workspace, None, GitAction::Push).await.unwrap();
    assert_eq!(failure(&outcome), (push_phase(), "timeout"));
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "stopped after the limit and the grace period, took {:?}",
        started.elapsed()
    );
    std::fs::remove_file(f.origin.join("hooks/pre-receive")).unwrap();
    let (outcome, _) = run(&app, &workspace, None, GitAction::Push).await.unwrap();
    assert_eq!(outcome.failure, None, "the checkout was released");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_checkout_is_released_when_the_caller_stops_waiting() {
    let f = Fixture::new();
    std::fs::write(f.repository.join("a.txt"), "a\n").unwrap();
    let go = f.dir.path().join("go");
    f.hook(
        &f.repository.join(".git"),
        "pre-commit",
        &format!("while [ ! -e {} ]; do sleep 0.05; done", go.display()),
    );
    let (app, workspace) = f.open().await;
    let dropped = tokio::time::timeout(
        Duration::from_millis(300),
        run(
            &app,
            &workspace,
            None,
            GitAction::Commit {
                message: message("Add a"),
            },
        ),
    )
    .await;
    assert!(dropped.is_err(), "the caller gave up while the hook waited");
    std::fs::write(&go, "").unwrap();
    let mut released = None;
    for _ in 0..500 {
        match run(&app, &workspace, None, GitAction::Push).await {
            Err(e) if e.code == "checkout_busy" => {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            other => {
                released = Some(other.unwrap().0);
                break;
            }
        }
    }
    assert_eq!(
        released
            .and_then(|outcome| outcome.failure)
            .map(|f| f.phase),
        None,
        "the abandoned commit finished and the next action pushed it"
    );
    assert_eq!(
        git_output(&f.origin, &["log", "-1", "--format=%s", "main"]),
        "Add a"
    );
    app.shutdown().await.unwrap();
}
