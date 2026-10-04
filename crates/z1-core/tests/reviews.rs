use serde_json::json;
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use z1_core::*;

struct Fixture {
    dir: tempfile::TempDir,
    repository: PathBuf,
    config: RuntimeConfig,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repository = dir.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-q", "-b", "review-fixture"]);
        git(&repository, &["config", "user.name", "Test"]);
        git(
            &repository,
            &["config", "user.email", "test@example.invalid"],
        );
        std::fs::write(repository.join("README.md"), "fixture\n").unwrap();
        git(&repository, &["add", "README.md"]);
        git(&repository, &["commit", "-qm", "Initial"]);
        let gh = dir.path().join("gh");
        std::fs::write(&gh, include_str!("support/reviews_peer.py")).unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = RuntimeConfig {
            data_dir: dir.path().join("state"),
            codex_binary: "/not-needed".into(),
            gh_binary: gh,
            network_timeout: Duration::from_secs(10),
        };
        let fixture = Self {
            dir,
            repository,
            config,
        };
        fixture.state(json!({}));
        fixture
    }
    fn state(&self, value: serde_json::Value) {
        std::fs::write(self.dir.path().join("reviews.json"), value.to_string()).unwrap();
    }
    async fn open(&self) -> (App, WorkspaceId) {
        let app = App::open(self.config.clone()).await.unwrap();
        let workspace = app.open_workspace(self.repository.clone()).await.unwrap();
        (app, workspace.id)
    }
}
fn git(root: &Path, args: &[&str]) -> String {
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
    String::from_utf8(out.stdout).unwrap().trim().into()
}
async fn reopen(config: RuntimeConfig) -> App {
    for _ in 0..100 {
        match App::open(config.clone()).await {
            Ok(app) => return app,
            Err(error) if error.code == "already_running" => {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            Err(error) => panic!("{error}"),
        }
    }
    panic!("owner did not release lock")
}
fn ready(value: ReviewFindings) -> (String, String, ReviewPullRequest, Vec<ReviewFinding>) {
    match value {
        ReviewFindings::Ready {
            branch,
            checkout_head,
            pr,
            findings,
        } => (branch, checkout_head, pr, findings),
        ReviewFindings::None { .. } => panic!("expected findings"),
    }
}
fn input(
    branch: &str,
    finding: &ReviewFinding,
    choice: Option<ReviewChoice>,
) -> SetReviewDisposition {
    SetReviewDisposition {
        branch: branch.into(),
        observation: finding.observation.clone(),
        expected: finding.saved.clone(),
        choice,
    }
}

#[tokio::test]
async fn fetches_every_feedback_page_and_keeps_original_source_separate() {
    let fixture = Fixture::new();
    let (app, id) = fixture.open().await;
    let (branch, head, pr, findings) = ready(app.review_findings(id, None).await.unwrap());
    assert_eq!(branch, "review-fixture");
    assert_eq!(head, git(&fixture.repository, &["rev-parse", "HEAD"]));
    assert_eq!(pr.head_sha, "a".repeat(40));
    assert_eq!(findings.len(), 6);
    let inline = findings
        .iter()
        .find(|finding| finding.observation.finding_id == "THREAD_one")
        .unwrap();
    assert_eq!(
        inline.comments.len(),
        2,
        "nested comment pagination must finish"
    );
    for comment in &inline.comments {
        let context = comment.context.as_ref().unwrap();
        assert_eq!(
            context.original_commit.as_deref(),
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        assert!(context.diff_hunk.as_ref().unwrap().contains("+new"));
    }
    let old = findings
        .iter()
        .find(|finding| finding.observation.finding_id == "THREAD_two")
        .unwrap();
    assert_eq!(
        old.source,
        ReviewSource::Thread {
            resolved: true,
            outdated: true
        }
    );
    let general = findings
        .iter()
        .find(|finding| finding.observation.finding_id == "ISSUE_comment")
        .unwrap();
    assert_eq!(general.source, ReviewSource::Conversation);
    assert!(general.comments[0].context.is_none());
    let calls = std::fs::read_to_string(fixture.dir.path().join("reviews-calls.jsonl")).unwrap();
    assert!(calls.contains("ReviewReplies"));
    assert!(calls.contains("cursor=reviews-1"));
    assert!(calls.contains("cursor=conversation-1"));
    for line in calls.lines() {
        let args: Vec<String> = serde_json::from_str(line).unwrap();
        if args.first().is_some_and(|arg| arg == "api") {
            assert!(
                args.windows(2)
                    .any(|pair| pair == ["--hostname", "github.com"])
            );
        }
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn decisions_survive_restart_detect_staleness_and_refuse_older_writes() {
    let fixture = Fixture::new();
    let (app, id) = fixture.open().await;
    let (branch, _, _, findings) = ready(app.review_findings(id.clone(), None).await.unwrap());
    let finding = findings
        .iter()
        .find(|finding| finding.observation.finding_id == "THREAD_one")
        .unwrap();
    let dismiss = ReviewChoice::Dismiss {
        reason: "The caller already validates this input.".into(),
    };
    let saved = app
        .set_review_disposition(
            id.clone(),
            None,
            input(&branch, finding, Some(dismiss.clone())),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.choice, dismiss);
    assert_eq!(
        app.set_review_disposition(
            id.clone(),
            None,
            input(&branch, finding, Some(dismiss.clone()))
        )
        .await
        .unwrap(),
        Some(saved.clone()),
        "repeated same write is idempotent"
    );
    let error = app
        .set_review_disposition(
            id.clone(),
            None,
            input(&branch, finding, Some(ReviewChoice::Fix)),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "review_decision_conflict");
    app.shutdown().await.unwrap();
    let app = reopen(fixture.config.clone()).await;
    let (_, _, _, current) = ready(app.review_findings(id.clone(), None).await.unwrap());
    let current = current
        .iter()
        .find(|item| item.observation.finding_id == finding.observation.finding_id)
        .unwrap();
    assert_eq!(current.saved, Some(saved.clone()));
    assert_eq!(current.observation, saved.observation);
    fixture.state(json!({"body":"Edited finding"}));
    let (_, _, _, changed) = ready(app.review_findings(id.clone(), None).await.unwrap());
    let changed = changed
        .iter()
        .find(|item| item.observation.finding_id == finding.observation.finding_id)
        .unwrap();
    assert_eq!(changed.saved, Some(saved.clone()));
    assert_ne!(
        changed.observation.content_digest,
        saved.observation.content_digest
    );
    fixture.state(json!({"head":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}));
    let (_, _, _, changed_head) = ready(app.review_findings(id.clone(), None).await.unwrap());
    let changed_head = changed_head
        .iter()
        .find(|item| item.observation.finding_id == finding.observation.finding_id)
        .unwrap();
    assert_ne!(
        changed_head.observation.head_sha,
        saved.observation.head_sha
    );
    let updated = app
        .set_review_disposition(
            id.clone(),
            None,
            input(&branch, changed_head, Some(ReviewChoice::NeedsDecision)),
        )
        .await
        .unwrap()
        .unwrap();
    let mut clear = input(&branch, changed_head, None);
    clear.expected = Some(updated);
    assert!(
        app.set_review_disposition(id.clone(), None, clear.clone())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        app.set_review_disposition(id.clone(), None, clear)
            .await
            .unwrap()
            .is_none()
    );
    let mut save_again = input(&branch, changed_head, Some(ReviewChoice::Fix));
    save_again.expected = None;
    app.set_review_disposition(id.clone(), None, save_again)
        .await
        .unwrap();
    app.remove_workspace(id).await.unwrap();
    let reopened = app
        .open_workspace(fixture.repository.clone())
        .await
        .unwrap();
    let (_, _, _, findings) = ready(app.review_findings(reopened.id, None).await.unwrap());
    assert!(findings.iter().all(|finding| finding.saved.is_none()));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn incomplete_or_moving_reviews_fail_as_a_whole() {
    let fixture = Fixture::new();
    let (app, id) = fixture.open().await;
    for mode in [
        "page-failure",
        "repeated-cursor",
        "conflicting-duplicate",
        "graphql-errors",
        "null-node",
        "moving-head",
        "failed",
        "unauthenticated",
        "oversized",
        "unsupported-host",
    ] {
        fixture.state(json!({"mode":mode}));
        let error = app.review_findings(id.clone(), None).await.unwrap_err();
        assert!(!error.message.is_empty(), "{mode}");
        if mode == "unauthenticated" {
            assert_eq!(error.code, "gh_unauthenticated");
        }
    }
    fixture.state(json!({"mode":"checkout-change"}));
    assert_eq!(
        app.review_findings(id.clone(), None)
            .await
            .unwrap_err()
            .code,
        "review_checkout_changed"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn checkout_eligibility_no_pr_and_boundary_validation() {
    let fixture = Fixture::new();
    let (app, id) = fixture.open().await;
    fixture.state(json!({"mode":"no-pr"}));
    assert!(
        matches!(app.review_findings(id.clone(), None).await.unwrap(), ReviewFindings::None { branch } if branch == "review-fixture")
    );
    fixture.state(json!({"mode":"empty"}));
    assert!(
        ready(app.review_findings(id.clone(), None).await.unwrap())
            .3
            .is_empty()
    );
    fixture.state(json!({}));
    let (branch, _, _, findings) = ready(app.review_findings(id.clone(), None).await.unwrap());
    let finding = &findings[0];
    assert_eq!(
        app.set_review_disposition(
            id.clone(),
            None,
            input(
                &branch,
                finding,
                Some(ReviewChoice::Dismiss {
                    reason: " \n".into()
                })
            )
        )
        .await
        .unwrap_err()
        .code,
        "invalid_review"
    );
    let mut invalid = input(&branch, finding, Some(ReviewChoice::Fix));
    invalid.observation.head_sha = "invalid".into();
    assert_eq!(
        app.set_review_disposition(id.clone(), None, invalid)
            .await
            .unwrap_err()
            .code,
        "invalid_review"
    );
    git(&fixture.repository, &["checkout", "-qb", "other"]);
    assert_eq!(
        app.set_review_disposition(
            id.clone(),
            None,
            input(&branch, finding, Some(ReviewChoice::Fix))
        )
        .await
        .unwrap_err()
        .code,
        "review_checkout_changed"
    );
    let scratch = app.ensure_scratch().await.unwrap();
    assert_eq!(
        app.review_findings(scratch.id, None)
            .await
            .unwrap_err()
            .code,
        "not_repository"
    );
    git(&fixture.repository, &["checkout", "--detach", "-q"]);
    let detached = app.review_findings(id, None).await.unwrap_err();
    assert_eq!(detached.code, "review_checkout");
    assert!(!detached.message.is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_and_timed_out_gh_are_useful_errors() {
    let fixture = Fixture::new();
    let mut config = fixture.config.clone();
    config.gh_binary = fixture.dir.path().join("missing-gh");
    let app = App::open(config).await.unwrap();
    let workspace = app
        .open_workspace(fixture.repository.clone())
        .await
        .unwrap();
    assert_eq!(
        app.review_findings(workspace.id, None)
            .await
            .unwrap_err()
            .code,
        "gh_missing"
    );
    app.shutdown().await.unwrap();
    let mut config = fixture.config.clone();
    config.network_timeout = Duration::from_millis(150);
    let app = reopen(config).await;
    let workspace = app
        .open_workspace(fixture.repository.clone())
        .await
        .unwrap();
    fixture.state(json!({"mode":"slow"}));
    assert_eq!(
        app.review_findings(workspace.id, None)
            .await
            .unwrap_err()
            .code,
        "timeout"
    );
    app.shutdown().await.unwrap();
}
