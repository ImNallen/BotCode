#![cfg(unix)]
#![allow(clippy::disallowed_methods)]
use bot_core::*;
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
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
        git_output(
            &repository,
            &[
                "config",
                &format!("url.{}.insteadOf", origin.display()),
                "https://github.com/bot-code/fixture.git",
            ],
        );
        git_output(
            &repository,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/bot-code/fixture.git",
            ],
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
                shell: None,
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
            .map(|line| serde_json::from_str::<Vec<String>>(line).unwrap())
            .filter(|args| args.first().is_some_and(|arg| arg == "pr"))
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
            if let GitProgress::Phase { phase } = phase {
                sink.lock().unwrap().push(phase);
            }
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
    for _ in 0..3000 {
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
            request: CommitRequest {
                message: Some(message("  Add new.txt\n\nWith a body.  ")),
                ..CommitRequest::default()
            },
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
            request: CommitRequest {
                message: Some(message("Add a")),
                ..CommitRequest::default()
            },
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
            request: CommitRequest {
                message: Some(message("Add b")),
                ..CommitRequest::default()
            },
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
            request: CommitRequest {
                message: Some(message("Add the feature")),
                ..CommitRequest::default()
            },
        },
    )
    .await
    .unwrap();
    let pr = PullRequest {
        number: 1,
        title: None,
        url: "https://github.com/bot-code/fixture/pull/1".into(),
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
    assert_eq!(
        f.gh_calls(),
        [vec![
            "pr",
            "create",
            "--repo",
            "github.com/bot-code/fixture",
            "--fill",
            "--base",
            "develop",
            "--head",
            name.as_str()
        ],]
    );
    assert_eq!(
        app.current_branch_pull_request(workspace, Some(thread.id), name)
            .await
            .unwrap(),
        PrLookup::Open {
            pr: PullRequest {
                title: Some("Add the feature".into()),
                ..pr
            }
        }
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
        title: Some("Existing".into()),
        url: "https://github.com/bot-code/fixture/pull/7".into(),
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
        generation_calls(&f, "pr").is_empty(),
        "existing pull requests bypass generation"
    );
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
        request: CommitRequest {
            message: Some(message("Add a")),
            ..CommitRequest::default()
        },
    };
    let (outcome, phases) = run(&app, &workspace, None, commit_push_pr()).await.unwrap();
    assert_eq!(failure(&outcome), (GitPhase::Pr, "gh_unauthenticated"));
    assert_eq!(
        (outcome.commit, outcome.push, phases),
        (None, None, vec![]),
        "nothing ran"
    );
    assert_eq!(
        app.current_branch_pull_request(workspace.clone(), None, "feature".into())
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
        app.current_branch_pull_request(workspace.clone(), None, "feature".into())
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
            request: CommitRequest {
                message: Some(message("Add a")),
                ..CommitRequest::default()
            },
        },
    )
    .await
    .unwrap();
    assert_eq!(outcome.failure, None, "commit and push work without gh");
    assert_eq!(
        app.current_branch_pull_request(workspace, None, "-x".into())
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
            request: CommitRequest {
                message: Some(message("Add a")),
                ..CommitRequest::default()
            },
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
        request: CommitRequest {
            message: Some(message("Nothing")),
            ..CommitRequest::default()
        },
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
            request: CommitRequest {
                message: Some(message("Ours")),
                ..CommitRequest::default()
            },
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
    app.submit(local.id.clone(), "hold".into(), "hold".into(), vec![])
        .await
        .unwrap();
    for _ in 0..3000 {
        let t = app.thread(local.id.clone()).await.unwrap();
        if matches!(t.turns[0].execution, Execution::Running) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let commit = || GitAction::Commit {
        request: CommitRequest {
            message: Some(message("Add a")),
            ..CommitRequest::default()
        },
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
    for _ in 0..3000 {
        let t = app.thread(local.id.clone()).await.unwrap();
        if matches!(t.turns[0].execution, Execution::Interrupted)
            && matches!(
                t.turns[0].checkpoint,
                TurnCheckpoint::Complete { .. } | TurnCheckpoint::Unavailable { .. }
            )
        {
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
    let sibling = app
        .create_thread(workspace.clone(), NewCheckout::Local)
        .await
        .unwrap();
    assert_eq!(
        app.delete_thread(sibling.id.clone())
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    assert!(app.thread(sibling.id).await.is_ok());
    assert_eq!(
        app.delete_thread(local.id.clone()).await.unwrap_err().code,
        "busy"
    );
    assert!(app.thread(local.id.clone()).await.is_ok());
    let busy = "A Git action is running in this checkout. Try again when it finishes.";
    let refused = app
        .submit(local.id.clone(), "second".into(), "second".into(), vec![])
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
    app.submit(local.id.clone(), "third".into(), "third".into(), vec![])
        .await
        .unwrap();
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_timed_out_push_fails_and_releases_the_checkout() {
    let mut f = Fixture::new();
    f.config.network_timeout = Duration::from_secs(5);
    git_output(&f.repository, &["switch", "-q", "-c", "feature"]);
    commit_in(&f.repository, "a.txt");
    f.hook(&f.origin, "pre-receive", "sleep 300");
    let (app, workspace) = f.open().await;
    let started = Instant::now();
    let (outcome, _) = run(&app, &workspace, None, GitAction::Push).await.unwrap();
    assert_eq!(failure(&outcome), (push_phase(), "timeout"));
    assert!(
        started.elapsed() < Duration::from_secs(60),
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
                request: CommitRequest {
                    message: Some(message("Add a")),
                    ..CommitRequest::default()
                },
            },
        ),
    )
    .await;
    assert!(dropped.is_err(), "the caller gave up while the hook waited");
    std::fs::write(&go, "").unwrap();
    let mut released = None;
    for _ in 0..3000 {
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

fn generation_file(f: &Fixture, name: &str, contents: &str) {
    std::fs::write(f.dir.path().join("peers").join(name), contents).unwrap();
}
fn generation_calls(f: &Fixture, kind: &str) -> Vec<serde_json::Value> {
    std::fs::read_to_string(f.dir.path().join("peers").join(format!("{kind}.jsonl")))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
async fn selected_thread(app: &App, workspace: &WorkspaceId) -> ThreadSnapshot {
    app.models().await.unwrap();
    let t = app
        .create_thread(workspace.clone(), NewCheckout::Local)
        .await
        .unwrap();
    let mut settings = t.settings;
    settings.model = Some("model-two".into());
    settings.effort = Some("medium".into());
    app.update_settings(t.id, settings).await.unwrap()
}

#[tokio::test]
async fn preview_uses_selected_model_and_private_split_index_without_changing_staging() {
    let f = Fixture::new();
    std::fs::write(f.repository.join("README.md"), "staged\n").unwrap();
    git_output(&f.repository, &["add", "README.md"]);
    git_output(&f.repository, &["update-index", "--split-index"]);
    std::fs::write(f.repository.join("README.md"), "unstaged preview\n").unwrap();
    std::fs::write(f.repository.join("new.txt"), "new preview\n").unwrap();
    let index = std::fs::read(f.repository.join(".git/index")).unwrap();
    let staged = git_output(&f.repository, &["diff", "--cached"]);
    generation_file(
        &f,
        "commit_output",
        r#"{"subject":"Describe the staged changes","body":"- Include the new file"}"#,
    );
    let (app, workspace) = f.open().await;
    let t = selected_thread(&app, &workspace).await;
    let job = app
        .begin_commit_message(t.id, CommitSelection::All)
        .await
        .unwrap();
    assert_eq!(
        app.await_commit_message(job).await.unwrap(),
        "Describe the staged changes\n\n- Include the new file"
    );
    assert_eq!(
        std::fs::read(f.repository.join(".git/index")).unwrap(),
        index
    );
    assert_eq!(git_output(&f.repository, &["diff", "--cached"]), staged);
    let calls = generation_calls(&f, "commit");
    assert_eq!(calls.len(), 1);
    let args = calls[0]["args"].as_array().unwrap();
    assert!(
        args.windows(2)
            .any(|pair| pair[0] == "--model" && pair[1] == "model-two")
    );
    let prompt = calls[0]["prompt"].as_str().unwrap();
    assert!(prompt.contains("+unstaged preview"));
    assert!(prompt.contains("+new preview"));
    assert!(!prompt.contains("+staged\n"));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn preview_supports_an_unborn_repository_without_creating_its_index() {
    let f = Fixture::new();
    let unborn = f.dir.path().join("unborn");
    std::fs::create_dir(&unborn).unwrap();
    git_output(&unborn, &["init", "-q", "-b", "main"]);
    std::fs::write(unborn.join("first.txt"), "first content\n").unwrap();
    generation_file(
        &f,
        "commit_output",
        r#"{"subject":"Add the first file","body":""}"#,
    );
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(unborn.clone()).await.unwrap();
    let t = app
        .create_thread(workspace.id, NewCheckout::Local)
        .await
        .unwrap();
    let job = app
        .begin_commit_message(t.id, CommitSelection::All)
        .await
        .unwrap();
    assert_eq!(
        app.await_commit_message(job).await.unwrap(),
        "Add the first file"
    );
    assert!(!unborn.join(".git/index").exists());
    assert!(
        generation_calls(&f, "commit")[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("+first content")
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelling_preview_reaps_process_group_and_manual_commit_never_waits_for_generation() {
    let f = Fixture::new();
    std::fs::write(f.repository.join("new.txt"), "new\n").unwrap();
    generation_file(&f, "commit_stall", "");
    generation_file(&f, "commit_descendant", "");
    let (app, workspace) = f.open().await;
    let t = selected_thread(&app, &workspace).await;
    let job = app
        .begin_commit_message(t.id.clone(), CommitSelection::All)
        .await
        .unwrap();
    wait_until(|| f.dir.path().join("peers/commit_child.pid").exists()).await;
    let pids: Vec<i32> = ["commit.pid", "commit_child.pid"]
        .into_iter()
        .map(|file| {
            std::fs::read_to_string(f.dir.path().join("peers").join(file))
                .unwrap()
                .parse()
                .unwrap()
        })
        .collect();
    tokio::time::timeout(Duration::from_secs(30), app.thread(t.id.clone()))
        .await
        .unwrap()
        .unwrap();
    let (outcome, _) = tokio::time::timeout(
        Duration::from_secs(30),
        run(
            &app,
            &workspace,
            Some(&t.id),
            GitAction::Commit {
                request: CommitRequest {
                    message: Some(message("Use the edited message")),
                    ..CommitRequest::default()
                },
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(outcome.failure.is_none(), "{outcome:?}");
    assert_eq!(
        git_output(&f.repository, &["log", "-1", "--format=%s"]),
        "Use the edited message"
    );
    assert_eq!(
        generation_calls(&f, "commit").len(),
        1,
        "manual submission never starts another generation"
    );
    assert_eq!(
        app.await_commit_message(job).await.unwrap_err().code,
        "cancelled"
    );
    wait_until(|| pids.iter().all(|pid| unsafe { libc::kill(*pid, 0) } != 0)).await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelling_the_acknowledged_job_before_await_stops_generation() {
    let f = Fixture::new();
    std::fs::write(f.repository.join("new.txt"), "new\n").unwrap();
    generation_file(&f, "commit_stall", "");
    let (app, workspace) = f.open().await;
    let t = selected_thread(&app, &workspace).await;
    let job = app
        .begin_commit_message(t.id, CommitSelection::All)
        .await
        .unwrap();
    app.cancel_commit_message(job.clone()).await.unwrap();
    assert_eq!(
        app.await_commit_message(job).await.unwrap_err().code,
        "cancelled"
    );
    app.shutdown().await.unwrap();
    if let Ok(pid) = std::fs::read_to_string(f.dir.path().join("peers/commit.pid")) {
        assert_ne!(unsafe { libc::kill(pid.parse().unwrap(), 0) }, 0);
    }
}

#[tokio::test]
async fn worktree_cleanup_cancels_a_running_commit_preview() {
    let f = Fixture::new();
    generation_file(&f, "commit_stall", "");
    generation_file(&f, "commit_descendant", "");
    let (app, workspace) = f.open().await;
    let thread = app
        .create_thread(
            workspace,
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: false,
            },
        )
        .await
        .unwrap();
    let Checkout::Worktree { path, .. } = thread.checkout else {
        panic!("expected a worktree");
    };
    let changed = path.join("preview.txt");
    std::fs::write(&changed, "preview content\n").unwrap();
    let job = app
        .begin_commit_message(thread.id, CommitSelection::All)
        .await
        .unwrap();
    wait_until(|| f.dir.path().join("peers/commit_child.pid").exists()).await;
    let pids: Vec<i32> = ["commit.pid", "commit_child.pid"]
        .into_iter()
        .map(|name| {
            std::fs::read_to_string(f.dir.path().join("peers").join(name))
                .unwrap()
                .parse()
                .unwrap()
        })
        .collect();
    std::fs::remove_file(changed).unwrap();
    app.save_settings(r#"{"storageCleanup":{"worktreeAfterDays":null,"worktreeUnchanged":true}}"#)
        .await
        .unwrap();
    app.sweep_worktrees_at(u64::MAX / 2).await;
    assert!(!path.exists(), "the unchanged worktree was removed");
    let cancelled = tokio::time::timeout(Duration::from_secs(30), app.await_commit_message(job))
        .await
        .expect("cleanup must cancel generation before its timeout")
        .unwrap_err();
    assert_eq!(cancelled.code, "cancelled");
    wait_until(|| pids.iter().all(|pid| unsafe { libc::kill(*pid, 0) } != 0)).await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn thread_deletion_cancels_a_running_commit_preview() {
    let f = Fixture::new();
    generation_file(&f, "commit_stall", "");
    generation_file(&f, "commit_descendant", "");
    let (app, workspace) = f.open().await;
    let thread = app
        .create_thread(
            workspace,
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: false,
            },
        )
        .await
        .unwrap();
    let Checkout::Worktree { path, .. } = thread.checkout else {
        panic!("expected a worktree");
    };
    let changed = path.join("preview.txt");
    std::fs::write(&changed, "preview content\n").unwrap();
    let job = app
        .begin_commit_message(thread.id.clone(), CommitSelection::All)
        .await
        .unwrap();
    wait_until(|| f.dir.path().join("peers/commit_child.pid").exists()).await;
    let pids: Vec<i32> = ["commit.pid", "commit_child.pid"]
        .into_iter()
        .map(|name| {
            std::fs::read_to_string(f.dir.path().join("peers").join(name))
                .unwrap()
                .parse()
                .unwrap()
        })
        .collect();
    std::fs::remove_file(changed).unwrap();
    app.save_settings(r#"{"storageCleanup":{"worktreeOnDelete":true}}"#)
        .await
        .unwrap();
    assert!(matches!(
        app.delete_thread(thread.id.clone()).await.unwrap(),
        DeletedWorktree::Removed
    ));
    assert!(!path.exists());
    assert_eq!(
        app.thread(thread.id).await.unwrap_err().code,
        "missing_thread"
    );
    let cancelled = tokio::time::timeout(Duration::from_secs(30), app.await_commit_message(job))
        .await
        .expect("deletion must cancel generation before its timeout")
        .unwrap_err();
    assert_eq!(cancelled.code, "cancelled");
    wait_until(|| pids.iter().all(|pid| unsafe { libc::kill(*pid, 0) } != 0)).await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn blank_combined_action_generates_from_actual_index_and_new_commit_against_recorded_base() {
    let f = Fixture::new();
    git_output(&f.repository, &["checkout", "-qb", "develop"]);
    commit_in(&f.repository, "base-only.txt");
    git_output(&f.repository, &["push", "-q", "origin", "develop"]);
    git_output(&f.repository, &["checkout", "-qb", "feature"]);
    git_output(
        &f.repository,
        &["config", "branch.feature.gh-merge-base", "develop"],
    );
    commit_in(&f.repository, "earlier-feature.txt");
    std::fs::write(
        f.repository.join("latest-feature.txt"),
        "latest staged change\n",
    )
    .unwrap();
    generation_file(
        &f,
        "commit_output",
        r#"{"subject":"Add the latest feature","body":"Explain the change"}"#,
    );
    generation_file(
        &f,
        "pr_output",
        r###"{"title":"Ship the branch feature","body":"## Summary\n- Add the branch feature\n\n## Testing\n- Not run"}"###,
    );
    let (app, workspace) = f.open().await;
    let t = selected_thread(&app, &workspace).await;
    let (outcome, phases) = run(
        &app,
        &workspace,
        Some(&t.id),
        GitAction::CommitPushPr {
            request: CommitRequest {
                message: None,
                ..CommitRequest::default()
            },
        },
    )
    .await
    .unwrap();
    assert!(outcome.failure.is_none(), "{outcome:?}");
    assert!(outcome.warnings.is_empty());
    assert_eq!(phases, [GitPhase::Commit, push_phase(), GitPhase::Pr]);
    assert_eq!(outcome.commit.unwrap().subject, "Add the latest feature");
    assert_eq!(
        outcome.pr.unwrap().pr.title.as_deref(),
        Some("Ship the branch feature")
    );
    assert_eq!(
        git_output(&f.repository, &["log", "-1", "--format=%B"]),
        "Add the latest feature\n\nExplain the change"
    );
    let commit = generation_calls(&f, "commit");
    assert!(
        commit[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("+latest staged change")
    );
    let pr = generation_calls(&f, "pr");
    let prompt = pr[0]["prompt"].as_str().unwrap();
    assert!(prompt.contains("Base branch: develop"));
    assert!(prompt.contains("Add the latest feature"));
    assert!(prompt.contains("earlier-feature.txt"));
    assert!(!prompt.contains("base-only.txt"));
    assert!(
        pr[0]["args"]
            .as_array()
            .unwrap()
            .windows(2)
            .any(|pair| pair[0] == "--model" && pair[1] == "model-two")
    );
    let calls = f.gh_calls();
    let created = calls.iter().find(|args| args[1] == "create").unwrap();
    assert!(!created.iter().any(|arg| arg == "--fill"));
    assert!(
        created
            .windows(2)
            .any(|pair| pair == ["--title", "Ship the branch feature"])
    );
    assert_eq!(
        std::fs::read_to_string(f.dir.path().join("peers/created_body")).unwrap(),
        "## Summary\n- Add the branch feature\n\n## Testing\n- Not run"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn blank_commit_generation_failure_requires_a_message_and_stops_the_stack() {
    for response in [
        None,
        Some(r#"{"subject":"","body":"invalid"}"#),
        Some("not JSON"),
    ] {
        let f = Fixture::new();
        git_output(&f.repository, &["checkout", "-qb", "feature"]);
        std::fs::write(f.repository.join("new.txt"), "new\n").unwrap();
        if let Some(response) = response {
            generation_file(&f, "commit_output", response);
        }
        let before = git_output(&f.repository, &["rev-parse", "HEAD"]);
        let (app, workspace) = f.open().await;
        let (outcome, phases) = run(
            &app,
            &workspace,
            None,
            GitAction::CommitPushPr {
                request: CommitRequest {
                    message: None,
                    ..CommitRequest::default()
                },
            },
        )
        .await
        .unwrap();
        assert_eq!(failure(&outcome), (GitPhase::Commit, "commit_generation"));
        assert!(
            outcome
                .failure
                .unwrap()
                .error
                .message
                .contains("Enter a commit message")
        );
        assert_eq!(phases, [GitPhase::Commit]);
        assert_eq!(git_output(&f.repository, &["rev-parse", "HEAD"]), before);
        assert!(f.gh_calls().iter().all(|call| call[1] != "create"));
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn pull_request_generation_failure_uses_fill_with_a_visible_warning() {
    for response in [
        None,
        Some("not JSON"),
        Some(r#"{"title":"","body":"invalid"}"#),
    ] {
        let f = Fixture::new();
        git_output(&f.repository, &["checkout", "-qb", "feature"]);
        commit_in(&f.repository, "feature.txt");
        if let Some(response) = response {
            generation_file(&f, "pr_output", response);
        }
        let (app, workspace) = f.open().await;
        let (outcome, _) = run(&app, &workspace, None, GitAction::CreatePr)
            .await
            .unwrap();
        assert!(outcome.failure.is_none(), "{outcome:?}");
        assert!(outcome.pr.unwrap().created);
        assert_eq!(outcome.warnings.len(), 1);
        assert!(outcome.warnings[0].contains("Used GitHub CLI"));
        assert!(
            f.gh_calls()
                .iter()
                .any(|args| args[1] == "create" && args.iter().any(|arg| arg == "--fill"))
        );
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn preflight_denial_of_blank_stack_never_starts_generation_or_commits() {
    let f = Fixture::new();
    git_output(&f.repository, &["checkout", "-qb", "feature"]);
    std::fs::write(f.repository.join("new.txt"), "new\n").unwrap();
    generation_file(&f, "unauthenticated", "");
    generation_file(&f, "commit_stall", "");
    let before = git_output(&f.repository, &["rev-parse", "HEAD"]);
    let (app, workspace) = f.open().await;
    let (outcome, phases) = tokio::time::timeout(
        Duration::from_secs(30),
        run(
            &app,
            &workspace,
            None,
            GitAction::CommitPushPr {
                request: CommitRequest {
                    message: None,
                    ..CommitRequest::default()
                },
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(failure(&outcome), (GitPhase::Pr, "gh_unauthenticated"));
    assert!(phases.is_empty());
    assert!(generation_calls(&f, "commit").is_empty());
    assert_eq!(git_output(&f.repository, &["rev-parse", "HEAD"]), before);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_stalled_preview_does_not_delay_or_reorder_a_denied_blank_stack() {
    let f = Fixture::new();
    git_output(&f.repository, &["checkout", "-qb", "feature"]);
    std::fs::write(f.repository.join("new.txt"), "new\n").unwrap();
    generation_file(&f, "commit_stall", "");
    let before = git_output(&f.repository, &["rev-parse", "HEAD"]);
    let (app, workspace) = f.open().await;
    let t = selected_thread(&app, &workspace).await;
    let job = app
        .begin_commit_message(t.id.clone(), CommitSelection::All)
        .await
        .unwrap();
    wait_until(|| f.dir.path().join("peers/commit_ready").exists()).await;
    generation_file(&f, "unauthenticated", "");
    let (outcome, phases) = tokio::time::timeout(
        Duration::from_secs(30),
        run(
            &app,
            &workspace,
            Some(&t.id),
            GitAction::CommitPushPr {
                request: CommitRequest {
                    message: None,
                    ..CommitRequest::default()
                },
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(failure(&outcome), (GitPhase::Pr, "gh_unauthenticated"));
    assert!(phases.is_empty());
    assert_eq!(
        generation_calls(&f, "commit").len(),
        1,
        "preflight never starts action generation"
    );
    assert_eq!(git_output(&f.repository, &["rev-parse", "HEAD"]), before);
    assert!(git_output(&f.repository, &["diff", "--cached"]).is_empty());
    assert_eq!(
        app.await_commit_message(job).await.unwrap_err().code,
        "cancelled"
    );
    app.shutdown().await.unwrap();
}

fn paths(names: &[&str]) -> CommitSelection {
    CommitSelection::Paths {
        paths: SelectedPaths::try_from(
            names
                .iter()
                .map(|name| RepoPath::try_from((*name).to_owned()).unwrap())
                .collect::<Vec<_>>(),
        )
        .unwrap(),
    }
}
fn selected_commit(names: &[&str]) -> GitAction {
    GitAction::Commit {
        request: CommitRequest {
            message: Some(message("Commit selected files")),
            selection: paths(names),
            destination: CommitDestination::Current,
        },
    }
}

#[tokio::test]
async fn selected_files_commit_current_contents_and_unstage_every_excluded_change() {
    let f = Fixture::new();
    for name in ["selected.txt", "staged.txt", "unstaged.txt"] {
        commit_in(&f.repository, name);
    }
    std::fs::write(f.repository.join("selected.txt"), "selected staged\n").unwrap();
    std::fs::write(f.repository.join("staged.txt"), "excluded staged\n").unwrap();
    git_output(&f.repository, &["add", "selected.txt", "staged.txt"]);
    std::fs::write(f.repository.join("selected.txt"), "selected working tree\n").unwrap();
    std::fs::write(f.repository.join("unstaged.txt"), "excluded unstaged\n").unwrap();
    std::fs::write(f.repository.join("untracked.txt"), "excluded untracked\n").unwrap();
    std::fs::write(
        f.repository.join("new-selected.txt"),
        "selected untracked\n",
    )
    .unwrap();
    let (app, workspace) = f.open().await;
    let (out, _) = run(
        &app,
        &workspace,
        None,
        selected_commit(&["selected.txt", "new-selected.txt"]),
    )
    .await
    .unwrap();
    assert_eq!(out.failure, None);
    assert_eq!(
        git_output(&f.repository, &["show", "HEAD:selected.txt"]),
        "selected working tree"
    );
    assert_eq!(
        git_output(&f.repository, &["show", "HEAD:staged.txt"]),
        "staged.txt"
    );
    assert_eq!(
        git_output(&f.repository, &["show", "HEAD:unstaged.txt"]),
        "unstaged.txt"
    );
    assert_eq!(
        git_output(
            &f.repository,
            &["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]
        ),
        "new-selected.txt\nselected.txt"
    );
    assert_eq!(git_output(&f.repository, &["diff", "--cached"]), "");
    let status = git_output(&f.repository, &["status", "--porcelain"]);
    assert!(
        status.contains("M staged.txt")
            && status.contains(" M unstaged.txt")
            && status.contains("?? untracked.txt"),
        "{status}"
    );
    assert_eq!(
        std::fs::read_to_string(f.repository.join("staged.txt")).unwrap(),
        "excluded staged\n"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn selected_paths_are_literal_and_include_deletions_and_rename_sources() {
    let f = Fixture::new();
    for name in [
        "old.txt",
        "deleted.txt",
        "[literal]*.txt",
        "matched.txt",
        "exclude.txt",
    ] {
        commit_in(&f.repository, name);
    }
    git_output(&f.repository, &["mv", "old.txt", "new.txt"]);
    std::fs::remove_file(f.repository.join("deleted.txt")).unwrap();
    for name in ["[literal]*.txt", "matched.txt", "exclude.txt"] {
        std::fs::write(f.repository.join(name), "changed\n").unwrap();
    }
    std::fs::write(f.repository.join(":(glob)*"), "literal magic\n").unwrap();
    git_output(&f.repository, &["add", "exclude.txt"]);
    let (app, workspace) = f.open().await;
    let (out, _) = run(
        &app,
        &workspace,
        None,
        selected_commit(&["new.txt", "deleted.txt", "[literal]*.txt", ":(glob)*"]),
    )
    .await
    .unwrap();
    assert_eq!(out.failure, None);
    let tree = git_output(&f.repository, &["ls-tree", "--name-only", "HEAD"]);
    assert!(
        !tree
            .lines()
            .any(|name| matches!(name, "old.txt" | "deleted.txt"))
    );
    assert!(tree.lines().any(|name| name == "new.txt"));
    assert_eq!(
        git_output(&f.repository, &["show", "HEAD:[literal]*.txt"]),
        "changed"
    );
    assert_eq!(
        git_output(&f.repository, &["show", "HEAD::(glob)*"]),
        "literal magic"
    );
    assert_eq!(
        git_output(&f.repository, &["show", "HEAD:matched.txt"]),
        "matched.txt"
    );
    assert_eq!(
        git_output(&f.repository, &["show", "HEAD:exclude.txt"]),
        "exclude.txt"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn displayed_paths_preview_and_commit_an_ambiguous_rename_and_independent_deletion() {
    let f = Fixture::new();
    for name in ["old name.txt", "deleted.txt"] {
        std::fs::write(f.repository.join(name), "identical content\n").unwrap();
    }
    git_output(&f.repository, &["add", "."]);
    git_output(&f.repository, &["commit", "-qm", "Identical files"]);
    git_output(&f.repository, &["mv", "old name.txt", "new name.txt"]);
    std::fs::remove_file(f.repository.join("deleted.txt")).unwrap();
    std::fs::write(f.repository.join("README.md"), "excluded content\n").unwrap();
    let numstat = git_output(&f.repository, &["diff", "HEAD", "--numstat", "-z"]);
    assert!(
        numstat.contains("deleted.txt\0new name.txt\0"),
        "{numstat:?}"
    );
    assert!(numstat.contains("0\t1\told name.txt\0"), "{numstat:?}");
    generation_file(
        &f,
        "commit_output",
        r#"{"subject":"Rename and delete","body":""}"#,
    );
    let (app, workspace) = f.open().await;
    let status = app.git_status(workspace.clone(), None).await.unwrap();
    let displayed: Vec<_> = status.files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(displayed, ["README.md", "deleted.txt", "new name.txt"]);
    let selected: Vec<_> = displayed
        .into_iter()
        .filter(|path| *path != "README.md")
        .collect();
    let index = std::fs::read(f.repository.join(".git/index")).unwrap();
    let t = selected_thread(&app, &workspace).await;
    let job = app
        .begin_commit_message(t.id, paths(&selected))
        .await
        .unwrap();
    assert_eq!(
        app.await_commit_message(job).await.unwrap(),
        "Rename and delete"
    );
    let calls = generation_calls(&f, "commit");
    let prompt = calls[0]["prompt"].as_str().unwrap();
    assert!(prompt.contains("new name.txt"));
    assert!(!prompt.contains("excluded content"));
    assert_eq!(
        std::fs::read(f.repository.join(".git/index")).unwrap(),
        index
    );
    let (out, _) = run(&app, &workspace, None, selected_commit(&selected))
        .await
        .unwrap();
    assert_eq!(out.failure, None);
    assert_eq!(
        git_output(&f.repository, &["ls-tree", "--name-only", "HEAD"]),
        "README.md\nnew name.txt"
    );
    assert_eq!(
        git_output(&f.repository, &["show", "HEAD:new name.txt"]),
        "identical content"
    );
    assert_eq!(
        git_output(&f.repository, &["show", "HEAD:README.md"]),
        "README.md"
    );
    assert_eq!(git_output(&f.repository, &["diff", "--cached"]), "");
    assert_eq!(
        std::fs::read_to_string(f.repository.join("README.md")).unwrap(),
        "excluded content\n"
    );
    assert_eq!(
        app.git_status(workspace, None)
            .await
            .unwrap()
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["README.md"]
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn empty_invalid_and_stale_selections_are_refused_before_index_changes() {
    for value in [
        serde_json::json!({"kind":"paths", "paths": []}),
        serde_json::json!({"kind":"paths", "paths": ["../outside"]}),
        serde_json::json!({"kind":"paths", "paths": ["/absolute"]}),
        serde_json::json!({"kind":"paths", "paths": [".git/config"]}),
        serde_json::json!({"kind":"paths", "paths": ["nul\u{0}byte"]}),
    ] {
        assert!(serde_json::from_value::<CommitSelection>(value).is_err());
    }
    let f = Fixture::new();
    std::fs::write(f.repository.join("README.md"), "staged\n").unwrap();
    git_output(&f.repository, &["add", "README.md"]);
    let index = std::fs::read(f.repository.join(".git/index")).unwrap();
    let (app, workspace) = f.open().await;
    let (out, _) = run(&app, &workspace, None, selected_commit(&["vanished.txt"]))
        .await
        .unwrap();
    assert_eq!(failure(&out), (GitPhase::Commit, "stale_commit_selection"));
    assert_eq!(
        std::fs::read(f.repository.join(".git/index")).unwrap(),
        index
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn selected_preview_uses_private_split_index_and_excludes_staged_content() {
    let f = Fixture::new();
    std::fs::write(
        f.repository.join("README.md"),
        "exclude this staged content\n",
    )
    .unwrap();
    git_output(&f.repository, &["add", "README.md"]);
    git_output(&f.repository, &["update-index", "--split-index"]);
    std::fs::write(
        f.repository.join("selected.txt"),
        "selected preview content\n",
    )
    .unwrap();
    let index = std::fs::read(f.repository.join(".git/index")).unwrap();
    let staged = git_output(&f.repository, &["diff", "--cached"]);
    generation_file(
        &f,
        "commit_output",
        r#"{"subject":"Selected preview","body":""}"#,
    );
    let (app, workspace) = f.open().await;
    let t = selected_thread(&app, &workspace).await;
    let job = app
        .begin_commit_message(t.id, paths(&["selected.txt"]))
        .await
        .unwrap();
    assert_eq!(
        app.await_commit_message(job).await.unwrap(),
        "Selected preview"
    );
    let calls = generation_calls(&f, "commit");
    let prompt = calls[0]["prompt"].as_str().unwrap();
    assert!(prompt.contains("+selected preview content"));
    assert!(!prompt.contains("exclude this staged content"));
    assert_eq!(
        std::fs::read(f.repository.join(".git/index")).unwrap(),
        index
    );
    assert_eq!(git_output(&f.repository, &["diff", "--cached"]), staged);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn selected_unborn_preview_and_commit_leave_excluded_added_file_unstaged() {
    let f = Fixture::new();
    let unborn = f.dir.path().join("unborn-selected");
    std::fs::create_dir(&unborn).unwrap();
    git_output(&unborn, &["init", "-q", "-b", "main"]);
    git_output(&unborn, &["config", "user.name", "Test"]);
    git_output(&unborn, &["config", "user.email", "test@example.invalid"]);
    std::fs::write(unborn.join("selected.txt"), "first selected content\n").unwrap();
    std::fs::write(unborn.join("excluded.txt"), "excluded first content\n").unwrap();
    git_output(&unborn, &["add", "excluded.txt"]);
    let index = std::fs::read(unborn.join(".git/index")).unwrap();
    generation_file(
        &f,
        "commit_output",
        r#"{"subject":"First selected file","body":""}"#,
    );
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(unborn.clone()).await.unwrap();
    let t = selected_thread(&app, &workspace.id).await;
    let job = app
        .begin_commit_message(t.id, paths(&["selected.txt"]))
        .await
        .unwrap();
    app.await_commit_message(job).await.unwrap();
    assert_eq!(std::fs::read(unborn.join(".git/index")).unwrap(), index);
    let calls = generation_calls(&f, "commit");
    assert!(
        !calls[0]["prompt"]
            .as_str()
            .unwrap()
            .contains("excluded first content")
    );
    let (out, _) = run(
        &app,
        &workspace.id,
        None,
        selected_commit(&["selected.txt"]),
    )
    .await
    .unwrap();
    assert_eq!(out.failure, None);
    assert_eq!(
        git_output(&unborn, &["ls-tree", "--name-only", "HEAD"]),
        "selected.txt"
    );
    assert_eq!(
        git_output(&unborn, &["status", "--porcelain"]),
        "?? excluded.txt"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn new_branch_collision_and_hook_failure_preserve_worktree_metadata() {
    let f = Fixture::new();
    git_output(&f.repository, &["branch", "FEATURE/add-file"]);
    git_output(&f.repository, &["branch", "feature/add-file-2"]);
    let (app, workspace) = f.open().await;
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
        panic!("expected worktree");
    };
    std::fs::write(path.join("selected.txt"), "branch change\n").unwrap();
    f.hook(
        &f.repository.join(".git"),
        "pre-commit",
        "echo validation-failed >&2; exit 1",
    );
    let (out, _) = run(
        &app,
        &workspace,
        Some(&thread.id),
        GitAction::Commit {
            request: CommitRequest {
                message: Some(message("Add 'file'")),
                selection: paths(&["selected.txt"]),
                destination: CommitDestination::NewBranch,
            },
        },
    )
    .await
    .unwrap();
    assert_eq!(out.branch.as_deref(), Some("feature/add-file-3"));
    assert!(out.commit.is_none());
    assert_eq!(failure(&out), (GitPhase::Commit, "git"));
    assert_eq!(
        git_output(path, &["branch", "--show-current"]),
        "feature/add-file-3"
    );
    let saved = app.thread(thread.id.clone()).await.unwrap();
    assert!(
        matches!(saved.checkout, Checkout::Worktree { branch, .. } if branch == "feature/add-file-3")
    );
    std::fs::remove_file(f.repository.join(".git/hooks/pre-commit")).unwrap();
    let (retried, _) = run(
        &app,
        &workspace,
        Some(&thread.id),
        selected_commit(&["selected.txt"]),
    )
    .await
    .unwrap();
    assert_eq!(retried.failure, None);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn hook_output_streams_while_blocked_and_named_lifecycle_flushes_before_completion() {
    let f = Fixture::new();
    std::fs::write(f.repository.join("selected.txt"), "content\n").unwrap();
    let go = f.dir.path().join("release-streaming-hook");
    f.hook(&f.repository.join(".git"), "pre-commit", &format!("printf 'first\\rsecond\\n'; echo error-line >&2; while [ ! -e '{}' ]; do sleep 0.05; done; printf trailing", go.display()));
    let (app, workspace) = f.open().await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let running = app.run_git_action(
        workspace.clone(),
        None,
        selected_commit(&["selected.txt"]),
        move |event| sink.lock().unwrap().push(event),
    );
    tokio::pin!(running);
    tokio::select! {
        result = &mut running => panic!("hook unexpectedly finished: {result:?}"),
        _ = wait_until(|| {
            let events = events.lock().unwrap();
            events.iter().any(|e| matches!(e, GitProgress::HookStarted { name } if name == "pre-commit")) &&
            ["first", "second", "error-line"].iter().all(|expected| events.iter().any(|e| matches!(e, GitProgress::Output { line, .. } if line == expected)))
        }) => {}
    }
    assert!(
        !events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, GitProgress::HookFinished { .. }))
    );
    assert_eq!(
        run(&app, &workspace, None, GitAction::Push)
            .await
            .unwrap_err()
            .code,
        "checkout_busy"
    );
    std::fs::write(go, "").unwrap();
    let out = running.await.unwrap();
    assert_eq!(out.failure, None);
    let events = events.lock().unwrap().clone();
    assert!(events.iter().any(
        |e| matches!(e, GitProgress::HookFinished { name, code: Some(0) } if name == "pre-commit")
    ));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, GitProgress::Output { line, .. } if line.contains("trailing")))
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn pre_push_hook_failure_reports_landed_selected_commit_and_hook_exit() {
    let f = Fixture::new();
    std::fs::write(f.repository.join("selected.txt"), "content\n").unwrap();
    f.hook(
        &f.repository.join(".git"),
        "pre-push",
        "echo push-validation-failed >&2; exit 7",
    );
    let (app, workspace) = f.open().await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let out = app
        .run_git_action(
            workspace,
            None,
            GitAction::CommitPush {
                request: CommitRequest {
                    message: Some(message("Selected before push")),
                    selection: paths(&["selected.txt"]),
                    destination: CommitDestination::Current,
                },
            },
            move |event| sink.lock().unwrap().push(event),
        )
        .await
        .unwrap();
    assert!(out.commit.is_some());
    assert!(out.push.is_none());
    assert_eq!(failure(&out), (push_phase(), "git"));
    assert!(events.lock().unwrap().iter().any(
        |e| matches!(e, GitProgress::HookFinished { name, code: Some(7) } if name == "pre-push")
    ));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn post_commit_hook_failure_does_not_hide_the_commit_git_landed() {
    let f = Fixture::new();
    std::fs::write(f.repository.join("selected.txt"), "content\n").unwrap();
    f.hook(
        &f.repository.join(".git"),
        "post-commit",
        "echo post-commit-failed >&2; exit 9",
    );
    let (app, workspace) = f.open().await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let out = app
        .run_git_action(
            workspace,
            None,
            selected_commit(&["selected.txt"]),
            move |event| sink.lock().unwrap().push(event),
        )
        .await
        .unwrap();
    assert_eq!(out.failure, None);
    assert_eq!(out.warnings, ["post-commit hook failed (exit 9)."]);
    assert_eq!(
        out.commit.unwrap().sha,
        git_output(&f.repository, &["rev-parse", "HEAD"])
    );
    assert!(events.lock().unwrap().iter().any(
        |e| matches!(e, GitProgress::HookFinished { name, code: Some(9) } if name == "post-commit")
    ));
    app.shutdown().await.unwrap();
}
