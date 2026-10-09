#![cfg(unix)]
#![allow(clippy::disallowed_methods)]
use bot_core::*;
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, path::PathBuf, process::Command, time::Duration};
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
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.name", "Fixture"],
            &["config", "user.email", "fixture@example.invalid"],
        ] {
            assert!(
                Command::new("git")
                    .arg("-C")
                    .arg(&root)
                    .args(args)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        std::fs::write(root.join("README"), "main checkout, not PR files\n").unwrap();
        for args in [&["add", "."][..], &["commit", "-qm", "initial"]] {
            assert!(
                Command::new("git")
                    .arg("-C")
                    .arg(&root)
                    .args(args)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let gh = dir.path().join("gh");
        std::fs::write(&gh, include_str!("fixtures/gh-lifecycle.py")).unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = RuntimeConfig {
            data_dir: dir.path().join("state"),
            codex_binary: "/no/codex".into(),
            gh_binary: gh,
            network_timeout: Duration::from_secs(5),
            shell: None,
        };
        let fixture = Self { dir, root, config };
        fixture.state(json!({}));
        fixture
    }
    fn state(&self, changes: Value) {
        let mut state = json!({"repository":"fixture/project","branch":"feature","number":41,"head":"a".repeat(40)});
        for (k, v) in changes.as_object().unwrap() {
            state[k] = v.clone();
        }
        let next = self.dir.path().join("gh.next");
        std::fs::write(&next, state.to_string()).unwrap();
        std::fs::rename(next, self.dir.path().join("gh.json")).unwrap();
    }
    fn key(&self) -> PullRequestKey {
        PullRequestKey::from_url("https://github.com/fixture/project/pull/41").unwrap()
    }
    async fn open(&self) -> (App, ThreadId) {
        let app = App::open(self.config.clone()).await.unwrap();
        let w = app.open_workspace(self.root.clone()).await.unwrap();
        let thread = app.create_thread(w.id, NewCheckout::Local).await.unwrap();
        app.link_pull_request(thread.id.clone(), self.key().url())
            .await
            .unwrap();
        (app, thread.id)
    }
    fn log(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("gh.log"))
            .unwrap_or_default()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    fn mutations(&self) -> Vec<Value> {
        self.log()
            .into_iter()
            .filter(|v| v.get("payload").is_some())
            .collect()
    }
    fn calls(&self, operation: &str, number: u64) -> usize {
        self.log()
            .iter()
            .filter(|entry| {
                let args = entry["args"].as_array().unwrap();
                args.iter()
                    .any(|arg| arg.as_str().is_some_and(|s| s.contains(operation)))
                    && args.contains(&json!(format!("number={number}")))
            })
            .count()
    }
    async fn wait_for(&self, operation: &str) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !self
                .log()
                .iter()
                .any(|entry| entry.to_string().contains(operation))
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}
fn submission(detail: &PrReviewDetail) -> PrReviewChange {
    PrReviewChange {
        request_id: uuid::Uuid::new_v4().to_string(),
        target: detail.observation.clone(),
        action: PrReviewAction::SubmitReview {
            verdict: ReviewVerdict::Comment,
            body: "Private summary `$(secret)`".into(),
            comments: vec![DraftReviewComment {
                id: "draft-one".into(),
                revision: 1,
                path: "calculate.ts".into(),
                side: PrSide::Right,
                line: 1,
                start_line: None,
                body: "Private line body".into(),
            }],
        },
    }
}
#[tokio::test]
async fn remote_detail_pages_original_context_and_saved_triage_survive_checkout_and_restart() {
    let f = Fixture::new();
    f.state(json!({"pages":2,"replyPages":true}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(detail.findings.len(), 6);
    assert_eq!(detail.checks.len(), 2);
    assert_eq!(detail.observation.head_oid, "a".repeat(40));
    assert!(!f.root.join("calculate.ts").exists());
    assert_eq!(detail.files[0].anchors[1].line, 1);
    let finding = &detail.findings[0].finding;
    assert_eq!(finding.comments.len(), 2);
    assert_eq!(
        finding.comments[0]
            .context
            .as_ref()
            .unwrap()
            .original_commit
            .as_deref(),
        Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    );
    let saved = app
        .set_review_disposition(
            thread.clone(),
            f.key(),
            SetReviewDisposition {
                observation: finding.observation.clone(),
                expected: None,
                choice: Some(ReviewChoice::Dismiss {
                    reason: "Checked the original boundary".into(),
                }),
            },
        )
        .await
        .unwrap();
    assert!(saved.is_some());
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let detail = app.read_pull_request(thread, f.key()).await.unwrap();
    assert_eq!(detail.findings[0].finding.saved, saved);
    app.shutdown().await.unwrap();
    for entry in f.log() {
        let args = entry["args"].as_array().unwrap();
        if args.first() == Some(&json!("api")) {
            assert!(
                args.windows(2)
                    .any(|pair| pair == [json!("--hostname"), json!("github.com")])
            );
        }
    }
}
#[tokio::test]
async fn explicit_limits_and_missing_or_truncated_patches_have_no_anchors() {
    let mut f = Fixture::new();
    f.config.network_timeout = Duration::from_secs(30);
    f.state(json!({"pages":5,"filePages":true}));
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    assert_eq!(detail.files.len(), 400);
    assert_eq!(detail.findings.len(), 12);
    assert!(detail.problems.iter().any(|s| matches!(
        s,
        PrSectionProblem::Limited {
            section: PrSection::Threads,
            ..
        }
    )));
    assert!(detail.problems.iter().any(|s| matches!(s, PrSectionProblem::Limited { section: PrSection::Files, message } if message.contains("400 files"))));
    f.state(json!({"missingPatch":true}));
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    assert!(detail.files[0].unavailable.is_some());
    assert!(detail.files[0].anchors.is_empty());
    f.state(json!({"files":[{"filename":"large.ts","status":"modified","additions":20,"deletions":1,"patch":"@@ -1 +1 @@\n-old\n+new"}]}));
    let detail = app.read_pull_request(t, f.key()).await.unwrap();
    assert!(
        detail.files[0]
            .unavailable
            .as_ref()
            .unwrap()
            .contains("incomplete")
    );
    assert!(detail.files[0].anchors.is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn successful_review_is_private_head_bound_and_deduped_even_after_confirmation_failure() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    let input = submission(&detail);
    f.state(json!({"failReadAfterReview":true}));
    assert!(
        matches!(app.change_pull_request(t.clone(),input.clone()).await.unwrap(),PrChangeResult::Applied{host_id} if host_id=="REVIEW_saved")
    );
    assert!(app.read_pull_request(t.clone(), f.key()).await.is_err());
    assert!(matches!(
        app.change_pull_request(t.clone(), input.clone())
            .await
            .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    let mut changed = input.clone();
    if let PrReviewAction::SubmitReview { body, .. } = &mut changed.action {
        *body = "Different".into();
    }
    assert!(matches!(
        app.change_pull_request(t.clone(), changed).await.unwrap(),
        PrChangeResult::Refused { .. }
    ));
    let mutations = f.mutations();
    assert_eq!(mutations.len(), 1);
    assert_eq!(mutations[0]["inputMode"], "0o600");
    assert_eq!(
        mutations[0]["payload"]["variables"]["input"]["commitOID"],
        "a".repeat(40)
    );
    let args = mutations[0]["args"].to_string();
    assert!(!args.contains("Private"));
    let path = mutations[0]["args"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .as_str()
        .unwrap();
    assert!(!std::path::Path::new(path).exists());
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    assert!(matches!(
        app.change_pull_request(t, input).await.unwrap(),
        PrChangeResult::Applied { .. }
    ));
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn native_revalidates_head_viewer_verdict_and_remote_line_before_mutation() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    for state in [
        json!({"head":"b".repeat(40)}),
        json!({"viewer":"other"}),
        json!({"locked":true}),
        json!({"finalMeta":{"locked":true}}),
    ] {
        f.state(state);
        assert!(matches!(
            app.change_pull_request(t.clone(), submission(&detail))
                .await
                .unwrap(),
            PrChangeResult::Refused { .. }
        ));
    }
    f.state(json!({"didAuthor":true}));
    let author = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    assert_eq!(author.verdicts, vec![ReviewVerdict::Comment]);
    let mut input = submission(&author);
    if let PrReviewAction::SubmitReview { verdict, .. } = &mut input.action {
        *verdict = ReviewVerdict::Approve;
    }
    assert!(matches!(
        app.change_pull_request(t.clone(), input).await.unwrap(),
        PrChangeResult::Refused { .. }
    ));
    f.state(json!({}));
    let mut input = submission(&detail);
    if let PrReviewAction::SubmitReview { comments, .. } = &mut input.action {
        comments[0].line = 99;
    }
    assert!(matches!(
        app.change_pull_request(t.clone(), input).await.unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert!(f.mutations().is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn replies_and_resolution_validate_thread_membership_and_capability() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    let actions = [
        PrReviewAction::Reply {
            thread_id: "THREAD_0".into(),
            body: "Reply text".into(),
        },
        PrReviewAction::SetResolved {
            thread_id: "THREAD_0".into(),
            resolved: true,
        },
        PrReviewAction::SetResolved {
            thread_id: "THREAD_0".into(),
            resolved: false,
        },
    ];
    for action in &actions {
        f.state(json!({"crossPrThread":true}));
        let input = PrReviewChange {
            request_id: uuid::Uuid::new_v4().to_string(),
            target: detail.observation.clone(),
            action: action.clone(),
        };
        assert!(matches!(
            app.change_pull_request(t.clone(), input).await.unwrap(),
            PrChangeResult::Refused { .. }
        ));
    }
    assert!(f.mutations().is_empty());
    f.state(json!({}));
    for action in actions {
        let input = PrReviewChange {
            request_id: uuid::Uuid::new_v4().to_string(),
            target: detail.observation.clone(),
            action,
        };
        assert!(matches!(
            app.change_pull_request(t.clone(), input).await.unwrap(),
            PrChangeResult::Applied { .. }
        ));
    }
    assert_eq!(f.mutations().len(), 3);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn uncertain_receipts_prevent_restart_replay_and_refusal_remains_distinct() {
    let mut f = Fixture::new();
    f.config.network_timeout = Duration::from_secs(1);
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    let input = submission(&detail);
    f.state(json!({"mutation":"uncertain"}));
    assert!(matches!(
        app.change_pull_request(t.clone(), input.clone())
            .await
            .unwrap(),
        PrChangeResult::Uncertain { .. }
    ));
    app.shutdown().await.unwrap();
    f.state(json!({}));
    let app = App::open(f.config.clone()).await.unwrap();
    assert!(matches!(
        app.change_pull_request(t.clone(), input).await.unwrap(),
        PrChangeResult::Uncertain { .. }
    ));
    assert_eq!(f.mutations().len(), 1);
    f.state(json!({"mutation":"refuse"}));
    assert!(matches!(
        app.change_pull_request(t, submission(&detail))
            .await
            .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn owned_delayed_mutation_persists_before_shutdown_acknowledgment() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    let input = submission(&detail);
    f.state(json!({"mutationDelay":0.4}));
    let worker = app.clone();
    let task_input = input.clone();
    let thread = t.clone();
    let task = tokio::spawn(async move { worker.change_pull_request(thread, task_input).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.mutations().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    app.shutdown().await.unwrap();
    assert!(matches!(
        task.await.unwrap().unwrap(),
        PrChangeResult::Applied { .. }
    ));
    let app = App::open(f.config.clone()).await.unwrap();
    assert!(matches!(
        app.change_pull_request(t, input).await.unwrap(),
        PrChangeResult::Applied { .. }
    ));
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn final_metadata_controls_lifecycle_and_verdicts_even_when_head_is_unchanged() {
    let f = Fixture::new();
    f.state(json!({"finalMeta":{"state":"CLOSED","locked":true,"closedAt":"2026-10-05T13:00:00Z","updatedAt":"2026-10-05T13:00:00Z"}}));
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    assert_eq!(detail.observation.head_oid, "a".repeat(40));
    assert!(matches!(
        detail.snapshot.lifecycle,
        PrLifecycle::Closed { .. }
    ));
    assert!(detail.verdicts.is_empty());
    let linked = app.list_thread_pull_requests(t, false).await.unwrap();
    assert!(matches!(
        linked.links[0].pr.snapshot.as_ref().unwrap().lifecycle,
        PrLifecycle::Closed { .. }
    ));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn removed_worktree_detail_is_remote_and_simultaneous_reads_share_one_job() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.root.clone()).await.unwrap();
    let thread = app
        .create_thread(
            workspace.id,
            NewCheckout::Worktree {
                base: "main".into(),
                from_origin: false,
            },
        )
        .await
        .unwrap();
    let Checkout::Worktree { path, .. } = &thread.checkout else {
        panic!("worktree required");
    };
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&f.root)
            .args(["worktree", "remove"])
            .arg(path)
            .status()
            .unwrap()
            .success()
    );
    app.link_pull_request(thread.id.clone(), f.key().url())
        .await
        .unwrap();
    f.state(json!({"metaDelay":0.1}));
    let (first, second) = tokio::join!(
        app.read_pull_request(thread.id.clone(), f.key()),
        app.read_pull_request(thread.id.clone(), f.key())
    );
    assert_eq!(first.unwrap().files[0].path, "calculate.ts");
    assert_eq!(second.unwrap().files[0].path, "calculate.ts");
    let reads = f
        .log()
        .into_iter()
        .filter(|line| {
            line["args"].as_array().unwrap().iter().any(|arg| {
                arg.as_str()
                    .is_some_and(|s| s.contains("query BotReviewMeta"))
            })
        })
        .count();
    assert_eq!(
        reads, 2,
        "one initial and one final metadata query for shared job"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_cancels_detail_processes_and_their_children_before_reopen() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    f.state(json!({"mode":"hang"}));
    let worker = app.clone();
    let key = f.key();
    let task = tokio::spawn(async move { worker.read_pull_request(t, key).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !f.dir.path().join("gh.children").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    app.shutdown().await.unwrap();
    assert!(task.await.unwrap().is_err());
    for line in std::fs::read_to_string(f.dir.path().join("gh.children"))
        .unwrap()
        .lines()
    {
        let pid = line.parse::<i32>().unwrap();
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "child {pid} survived shutdown"
        );
    }
    let app = App::open(f.config.clone()).await.unwrap();
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn optional_section_failures_preserve_core_and_other_sections() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    for (operation, section) in [
        ("BotReviewThreads", PrSection::Threads),
        ("BotReviewConversation", PrSection::ConversationComments),
        ("BotReviewSummaries", PrSection::Reviews),
        ("BotReviewChecks", PrSection::Checks),
        ("files", PrSection::Files),
        ("BotReviewCommits", PrSection::Commits),
    ] {
        f.state(json!({"failSections":[operation]}));
        let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
        assert_eq!(detail.body, "Review the calculation update.");
        assert_eq!(detail.observation.node_id, "PR_fixture_41");
        assert_eq!(detail.problems.len(), 1);
        assert!(
            matches!(&detail.problems[0], PrSectionProblem::Failed { section: failed, .. } if *failed == section)
        );
        let expected_findings = if matches!(
            section,
            PrSection::Threads | PrSection::ConversationComments | PrSection::Reviews
        ) {
            2
        } else {
            3
        };
        assert_eq!(detail.findings.len(), expected_findings);
        assert_eq!(
            detail.checks.len(),
            usize::from(section != PrSection::Checks)
        );
        assert_eq!(detail.files.len(), usize::from(section != PrSection::Files));
        assert_eq!(
            detail
                .timeline
                .iter()
                .filter(|entry| matches!(entry.event, PrTimelineEvent::Commit { .. }))
                .count(),
            usize::from(section != PrSection::Commits)
        );
        let linked = app
            .list_thread_pull_requests(t.clone(), false)
            .await
            .unwrap();
        assert!(matches!(
            linked.links[0].pr.freshness,
            PrFreshness::Current { .. }
        ));
    }
    f.state(json!({"failSections":["BotReviewChecks","files"]}));
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    assert_eq!(detail.problems.len(), 2);
    assert_eq!(detail.findings.len(), 3);
    assert!(!detail.verdicts.is_empty());
    assert!(detail.checks.is_empty() && detail.files.is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_core_or_final_read_marks_every_link_stale_without_losing_snapshot() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    let workspace = app.open_workspace(f.root.clone()).await.unwrap();
    let second = app
        .create_thread(workspace.id, NewCheckout::Local)
        .await
        .unwrap();
    app.link_pull_request(second.id.clone(), f.key().url())
        .await
        .unwrap();
    for changes in [json!({"failCore":true}), json!({"failFinal":true})] {
        f.state(json!({}));
        let prior = app
            .read_pull_request(t.clone(), f.key())
            .await
            .unwrap()
            .snapshot;
        let mut hints = app.subscribe();
        f.state(changes);
        assert!(app.read_pull_request(t.clone(), f.key()).await.is_err());
        for id in [&t, &second.id] {
            let linked = app
                .list_thread_pull_requests(id.clone(), false)
                .await
                .unwrap();
            assert_eq!(linked.links[0].pr.snapshot.as_ref(), Some(&prior));
            assert!(matches!(
                linked.links[0].pr.freshness,
                PrFreshness::Stale {
                    last_success: Some(_),
                    ..
                }
            ));
        }
        let mut notified = std::collections::HashSet::new();
        while let Ok(hint) = hints.try_recv() {
            if matches!(
                hint.summary
                    .pull_requests
                    .links
                    .first()
                    .map(|link| &link.pr.freshness),
                Some(PrFreshness::Stale { .. })
            ) {
                notified.insert(hint.summary.id);
            }
        }
        assert!(notified.contains(&t) && notified.contains(&second.id));
    }
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let saved = app.list_thread_pull_requests(t, false).await.unwrap();
    assert!(saved.links[0].pr.snapshot.is_some());
    assert!(matches!(
        saved.links[0].pr.freshness,
        PrFreshness::Stale { .. }
    ));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn optional_failures_cannot_hide_identity_changes() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    for changes in [
        json!({"failSections":["BotReviewChecks"],"finalMeta":{"headRefOid":"b".repeat(40)}}),
        json!({"failSections":["files"],"finalMeta":{"id":"PR_other"}}),
        json!({"wrongIdentitySections":["BotReviewConversation"]}),
        json!({"failSections":["files"],"finalViewer":"other-viewer"}),
        json!({"replyPages":true,"crossPrReply":true}),
    ] {
        f.state(changes);
        assert_eq!(
            app.read_pull_request(t.clone(), f.key())
                .await
                .unwrap_err()
                .code,
            "pr_review_identity"
        );
    }
    assert!(f.mutations().is_empty());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn timeline_combines_lifecycle_commits_and_feedback_newest_first() {
    let f = Fixture::new();
    f.state(json!({"lifecycle":"MERGED","mergedAt":"2026-10-06T12:00:00Z","closedAt":"2026-10-06T12:00:00Z","threadAt":"2026-10-05T12:00:00Z","reviewAt":"2026-10-04T12:00:00Z","commentAt":"2026-10-02T12:00:00Z"}));
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    let kinds: Vec<_> = detail
        .timeline
        .iter()
        .map(|entry| match &entry.event {
            PrTimelineEvent::Merged => "merged",
            PrTimelineEvent::Closed => "closed",
            PrTimelineEvent::Opened { .. } => "opened",
            PrTimelineEvent::Commit { .. } => "commit",
            PrTimelineEvent::Review { .. } => "review",
            PrTimelineEvent::Comment { finding_id } if finding_id.starts_with("THREAD") => "thread",
            PrTimelineEvent::Comment { .. } => "conversation",
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "merged",
            "thread",
            "review",
            "commit",
            "conversation",
            "opened"
        ]
    );
    f.state(json!({"lifecycle":"CLOSED","closedAt":"2026-10-06T12:00:00Z","createdAt":"invalid","commits":[{"oid":"d".repeat(40),"messageHeadline":"Bad date","committedDate":"not a date"}]}));
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    assert!(matches!(detail.timeline[0].event, PrTimelineEvent::Closed));
    assert_eq!(
        detail
            .timeline
            .iter()
            .filter(|entry| entry.at.is_none())
            .count(),
        2
    );
    assert!(detail.timeline.last().unwrap().at.is_none());
    f.state(json!({"pages":2}));
    let detail = app.read_pull_request(t, f.key()).await.unwrap();
    assert_eq!(
        detail
            .timeline
            .iter()
            .filter(|entry| matches!(entry.event, PrTimelineEvent::Commit { .. }))
            .count(),
        2
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn detail_header_reads_author_labels_reviewers_totals_and_auto_merge_method() {
    let f = Fixture::new();
    f.state(json!({
        "authorAvatar": "https://avatars.example/author",
        "labels": [{"name": "bug", "color": "d73a4a"}],
        "reviewRequests": [
            {"requestedReviewer": {"__typename": "User", "login": "Alice", "avatarUrl": "https://avatars.example/alice"}},
            {"requestedReviewer": {"__typename": "Team", "combinedSlug": "fixture/core", "avatarUrl": "https://avatars.example/core"}}
        ],
        "latestReviews": [
            {"state": "APPROVED", "author": {"login": "alice", "avatarUrl": "https://avatars.example/alice"}},
            {"state": "COMMENTED", "author": {"login": "bob", "avatarUrl": "https://avatars.example/bob"}},
            {"state": "DISMISSED", "author": null}
        ],
        "additions": 120,
        "deletions": 7,
        "changedFiles": 9,
        "autoMerge": true,
        "autoMethod": "SQUASH"
    }));
    let (app, t) = f.open().await;
    let detail = serde_json::to_value(app.read_pull_request(t, f.key()).await.unwrap()).unwrap();
    assert_eq!(detail["files"].as_array().unwrap().len(), 1);
    assert_eq!(detail["files"][0]["additions"], 1);
    assert_eq!(
        detail["author"],
        json!({"login": "fixture-author", "avatarUrl": "https://avatars.example/author"})
    );
    assert_eq!(
        detail["labels"],
        json!([{"name": "bug", "color": "d73a4a"}])
    );
    assert_eq!(
        detail["reviewers"],
        json!([
            {"login": "Alice", "avatarUrl": "https://avatars.example/alice", "outcome": "APPROVED"},
            {"login": "fixture/core", "avatarUrl": "https://avatars.example/core", "outcome": null},
            {"login": "bob", "avatarUrl": "https://avatars.example/bob", "outcome": "COMMENTED"},
            {"login": "ghost", "avatarUrl": null, "outcome": "DISMISSED"}
        ])
    );
    assert_eq!(detail["additions"], 120);
    assert_eq!(detail["deletions"], 7);
    assert_eq!(detail["changedFiles"], 9);
    assert_eq!(detail["autoMergeMethod"], "squash");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn admission_denials_are_refused_without_dispatching_a_mutation() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    let mut invalid = submission(&detail);
    invalid.request_id = "".into();
    assert!(matches!(
        app.change_pull_request(t.clone(), invalid).await.unwrap(),
        PrChangeResult::Refused { .. }
    ));
    let mut unlinked = submission(&detail);
    unlinked.target.key = PullRequestKey::new("fixture", "project", 99).unwrap();
    assert!(matches!(
        app.change_pull_request(t.clone(), unlinked).await.unwrap(),
        PrChangeResult::Refused { .. }
    ));
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER deny_review_receipt BEFORE INSERT ON pull_request_operations BEGIN SELECT RAISE(FAIL, 'fixture admission storage failure'); END;").unwrap();
    assert!(matches!(
        app.change_pull_request(t.clone(), submission(&detail))
            .await
            .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    db.execute_batch("DROP TRIGGER deny_review_receipt;")
        .unwrap();
    assert!(f.mutations().is_empty());
    f.state(json!({"sectionModes":{"BotReviewThreads":"hang"}}));
    let worker = app.clone();
    let key = f.key();
    let thread = t.clone();
    let task = tokio::spawn(async move { worker.read_pull_request(thread, key).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !f.dir.path().join("gh.children").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    app.shutdown().await.unwrap();
    assert_eq!(task.await.unwrap().unwrap_err().code, "cancelled");
    for pid in std::fs::read_to_string(f.dir.path().join("gh.children"))
        .unwrap()
        .lines()
    {
        assert_eq!(unsafe { libc::kill(pid.parse().unwrap(), 0) }, -1);
    }
    assert!(f.mutations().is_empty());
}

#[tokio::test]
async fn busy_admission_refuses_before_any_mutation() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    let keys: Vec<_> = (41..45)
        .map(|number| PullRequestKey::new("fixture", "project", number).unwrap())
        .collect();
    for key in &keys {
        app.link_pull_request(t.clone(), key.url()).await.unwrap();
    }
    f.state(json!({"sectionModes":{"BotReviewMeta":"hang"}}));
    let mut tasks = Vec::new();
    for key in keys {
        let worker = app.clone();
        let thread = t.clone();
        tasks.push(tokio::spawn(async move {
            worker.read_pull_request(thread, key).await
        }));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while std::fs::read_to_string(f.dir.path().join("gh.children"))
            .unwrap_or_default()
            .lines()
            .count()
            < 4
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        matches!(app.change_pull_request(t, submission(&detail)).await.unwrap(), PrChangeResult::Refused { message } if message.contains("already running"))
    );
    assert!(f.mutations().is_empty());
    app.shutdown().await.unwrap();
    for task in tasks {
        assert!(task.await.unwrap().is_err());
    }
}

#[tokio::test]
async fn optional_timeout_reserves_final_core_confirmation() {
    let mut f = Fixture::new();
    f.config.network_timeout = Duration::from_secs(3);
    let (app, t) = f.open().await;
    f.state(json!({"sectionModes":{"BotReviewThreads":"slow"},"delay":10}));
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    assert_eq!(detail.body, "Review the calculation update.");
    assert!(detail.problems.iter().any(|problem| matches!(
        problem,
        PrSectionProblem::Failed {
            section: PrSection::Threads,
            ..
        }
    )));
    assert!(detail.problems.iter().any(|problem| matches!(
        problem,
        PrSectionProblem::Limited {
            section: PrSection::Files,
            ..
        }
    )));
    assert!(detail.problems.len() <= 6);
    let linked = app.list_thread_pull_requests(t, false).await.unwrap();
    assert!(matches!(
        linked.links[0].pr.freshness,
        PrFreshness::Current { .. }
    ));
    assert_eq!(
        f.log()
            .iter()
            .filter(|row| row["args"].to_string().contains("query BotReviewMeta"))
            .count(),
        2
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn shared_detail_read_refuses_mutation_and_preserves_coalescing_and_other_pr_reads() {
    let f = Fixture::new();
    let (app, first) = f.open().await;
    let workspace = app.open_workspace(f.root.clone()).await.unwrap();
    let second = app
        .create_thread(workspace.id, NewCheckout::Local)
        .await
        .unwrap()
        .id;
    app.link_pull_request(second.clone(), f.key().url())
        .await
        .unwrap();
    let other = PullRequestKey::new("fixture", "project", 42).unwrap();
    app.link_pull_request(second.clone(), other.url())
        .await
        .unwrap();
    let detail = app.read_pull_request(first.clone(), f.key()).await.unwrap();
    let saved = submission(&detail);
    assert!(matches!(
        app.change_pull_request(first.clone(), saved.clone())
            .await
            .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    let input = PrReviewChange {
        request_id: uuid::Uuid::new_v4().to_string(),
        target: detail.observation,
        action: PrReviewAction::SetResolved {
            thread_id: "THREAD_0".into(),
            resolved: true,
        },
    };
    let release = f.dir.path().join("release-read");
    f.state(json!({"matchNumber":true,"waitFor":{"BotReviewConversation:41":release}}));
    std::fs::write(f.dir.path().join("gh.log"), "").unwrap();
    let worker = app.clone();
    let key = f.key();
    let task = tokio::spawn(async move { worker.read_pull_request(first, key).await });
    f.wait_for("BotReviewConversation").await;
    assert!(
        matches!(app.change_pull_request(second.clone(), input.clone()).await.unwrap(), PrChangeResult::Refused { message } if message.contains("already running"))
    );
    assert!(matches!(
        app.change_pull_request(second.clone(), saved)
            .await
            .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    assert!(
        f.mutations().is_empty(),
        "read-busy refusal and receipt replay must not dispatch"
    );
    let joined = app.read_pull_request(second.clone(), f.key());
    tokio::pin!(joined);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut joined)
            .await
            .is_err()
    );
    let other_detail = app
        .read_pull_request(second.clone(), other.clone())
        .await
        .unwrap();
    assert_eq!(other_detail.observation.key, other);
    assert_eq!(f.calls("BotReviewMeta", 42), 2);
    assert_eq!(f.calls("BotReviewMeta", 41), 1);
    std::fs::write(release, "").unwrap();
    for old in [task.await.unwrap().unwrap(), joined.await.unwrap()] {
        assert!(matches!(
            old.findings[0].finding.source,
            ReviewSource::Thread {
                resolved: false,
                ..
            }
        ));
    }
    assert_eq!(
        f.calls("BotReviewMeta", 41),
        2,
        "both conversations share one read"
    );
    assert!(matches!(
        app.change_pull_request(second.clone(), input)
            .await
            .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    let fresh = app.read_pull_request(second, f.key()).await.unwrap();
    assert!(matches!(
        fresh.findings[0].finding.source,
        ReviewSource::Thread { resolved: true, .. }
    ));
    assert_eq!(
        f.calls("BotReviewThreads", 41),
        2,
        "the post-action refresh starts a new detail job"
    );
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn pending_mutation_refuses_shared_detail_reads_but_allows_receipt_replay_and_other_pr_reads()
{
    let f = Fixture::new();
    let (app, first) = f.open().await;
    let workspace = app.open_workspace(f.root.clone()).await.unwrap();
    let second = app
        .create_thread(workspace.id, NewCheckout::Local)
        .await
        .unwrap()
        .id;
    app.link_pull_request(second.clone(), f.key().url())
        .await
        .unwrap();
    let other = PullRequestKey::new("fixture", "project", 42).unwrap();
    app.link_pull_request(second.clone(), other.url())
        .await
        .unwrap();
    let detail = app.read_pull_request(first.clone(), f.key()).await.unwrap();
    let saved = submission(&detail);
    assert!(matches!(
        app.change_pull_request(first.clone(), saved.clone())
            .await
            .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    let input = PrReviewChange {
        request_id: uuid::Uuid::new_v4().to_string(),
        target: detail.observation,
        action: PrReviewAction::SetResolved {
            thread_id: "THREAD_0".into(),
            resolved: true,
        },
    };
    let release = f.dir.path().join("release-mutation");
    f.state(json!({"matchNumber":true,"waitFor":{"BotResolve":release}}));
    std::fs::write(f.dir.path().join("gh.log"), "").unwrap();
    let worker = app.clone();
    let origin = first.clone();
    let command = input.clone();
    let task = tokio::spawn(async move { worker.change_pull_request(origin, command).await });
    f.wait_for("BotResolve").await;
    let reads_before = f.calls("BotReviewMeta", 41);
    for thread in [first, second.clone()] {
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            app.read_pull_request(thread, f.key()),
        )
        .await
        .unwrap();
        assert_eq!(result.unwrap_err().code, "pr_busy");
    }
    assert_eq!(f.calls("BotReviewMeta", 41), reads_before);
    assert_eq!(
        f.calls("BotReviewThreads", 41),
        0,
        "no detail reader starts or coalesces during mutation"
    );
    assert!(matches!(
        app.change_pull_request(second.clone(), saved)
            .await
            .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    assert!(matches!(
        app.change_pull_request(second.clone(), input.clone())
            .await
            .unwrap(),
        PrChangeResult::Uncertain { .. }
    ));
    let mut conflict = input;
    conflict.action = PrReviewAction::SetResolved {
        thread_id: "THREAD_0".into(),
        resolved: false,
    };
    assert!(
        matches!(app.change_pull_request(second.clone(), conflict).await.unwrap(), PrChangeResult::Refused { message } if message.contains("different pull request command"))
    );
    let other_detail = app
        .read_pull_request(second.clone(), other.clone())
        .await
        .unwrap();
    assert_eq!(other_detail.observation.key, other);
    assert_eq!(f.mutations().len(), 1);
    std::fs::write(release, "").unwrap();
    assert!(matches!(
        task.await.unwrap().unwrap(),
        PrChangeResult::Applied { .. }
    ));
    let fresh = app.read_pull_request(second, f.key()).await.unwrap();
    assert!(matches!(
        fresh.findings[0].finding.source,
        ReviewSource::Thread { resolved: true, .. }
    ));
    assert_eq!(f.calls("BotReviewThreads", 41), 1);
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}

#[path = "reviews/lifecycle.rs"]
mod lifecycle_tests;

#[tokio::test]
async fn check_conclusions_preserve_startup_failure_and_stale_states() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    for conclusion in ["STARTUP_FAILURE", "STALE"] {
        f.state(json!({"checkConclusion":conclusion}));
        let detail = app
            .read_pull_request(thread.clone(), f.key())
            .await
            .unwrap();
        assert_eq!(detail.checks.len(), 1);
        assert_eq!(detail.checks[0].name, "unit tests");
        assert_eq!(detail.checks[0].state, conclusion);
        assert_eq!(
            detail.checks[0].url.as_deref(),
            Some("https://github.com/fixture/project/pull/41/checks")
        );
        assert!(detail.problems.is_empty());
    }
    app.shutdown().await.unwrap();
}
#[path = "reviews/edit.rs"]
mod edit_tests;

#[path = "reviews/checkout.rs"]
mod checkout;

#[path = "reviews/commit_files.rs"]
mod commit_files;

#[path = "reviews/viewed.rs"]
mod viewed;

#[path = "reviews/file_contents.rs"]
mod file_contents;

#[path = "reviews/threads.rs"]
mod threads;

#[path = "reviews/ranges.rs"]
mod ranges;

#[path = "reviews/inbox.rs"]
mod inbox;

#[path = "reviews/pickers.rs"]
mod pickers;

#[path = "reviews/comments_reactions.rs"]
mod comments_reactions;
#[path = "reviews/stack.rs"]
mod stack;
