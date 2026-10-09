use super::*;

#[tokio::test]
async fn pickers_keep_applied_labels_and_requested_teams_and_change_only_the_selected_entry() {
    let f = Fixture::new();
    f.state(json!({"labels":[{"name":"legacy","color":"123456"}],"labelCandidates":[{"name":"needs/design","color":"abcdef","description":"A design discussion"}],"labelsTruncated":true,
        "assignableUsers":[{"login":"fixture-author"},{"login":"reviewer","name":"Review Person"}],"reviewRequests":[{"requestedReviewer":{"slug":"design","name":"Design Team"}},{"requestedReviewer":{"login":"review-bot[bot]"}}],"reviewersTruncated":true}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let labels = app
        .read_pull_request_candidates(
            thread.clone(),
            detail.observation.clone(),
            PrCandidateKind::Labels,
        )
        .await
        .unwrap();
    assert!(labels.truncated);
    assert_eq!(labels.labels[0].name, "legacy");
    assert!(labels.labels[0].is_applied);
    let reviewers = app
        .read_pull_request_candidates(
            thread.clone(),
            detail.observation.clone(),
            PrCandidateKind::Reviewers,
        )
        .await
        .unwrap();
    assert!(reviewers.truncated);
    assert_eq!(reviewers.reviewers.len(), 3);
    assert_eq!(reviewers.reviewers[0].kind, PrReviewerKind::Team);
    assert!(reviewers.reviewers[0].is_requested);
    let input = PrReviewChange {
        request_id: "add-label".into(),
        target: detail.observation.clone(),
        action: PrReviewAction::SetLabel {
            name: "needs/design".into(),
            applied: true,
        },
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    assert!(matches!(
        app.change_pull_request(thread.clone(), input)
            .await
            .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(detail.labels.len(), 2);
    let input = PrReviewChange {
        request_id: "remove-label".into(),
        target: detail.observation.clone(),
        action: PrReviewAction::SetLabel {
            name: "needs/design".into(),
            applied: false,
        },
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), input)
            .await
            .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    for (index, (id, kind, requested)) in [
        ("reviewer", PrReviewerKind::User, true),
        ("design", PrReviewerKind::Team, false),
        ("review-bot[bot]", PrReviewerKind::User, false),
    ]
    .into_iter()
    .enumerate()
    {
        let input = PrReviewChange {
            request_id: format!("reviewer-{index}"),
            target: detail.observation.clone(),
            action: PrReviewAction::RequestReviewer {
                id: id.into(),
                reviewer_kind: kind,
                requested,
            },
        };
        assert!(matches!(
            app.change_pull_request(thread.clone(), input)
                .await
                .unwrap(),
            PrChangeResult::Applied { .. }
        ));
    }
    let updated = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(updated.labels[0].name, "legacy");
    assert!(
        updated
            .reviewers
            .iter()
            .any(|actor| actor.login == "reviewer")
    );
    assert!(
        !updated
            .reviewers
            .iter()
            .any(|actor| actor.login == "design")
    );
    let writes: Vec<_> = f
        .mutations()
        .into_iter()
        .filter(|row| row["args"][1] == "--method")
        .collect();
    assert_eq!(writes.len(), 5);
    assert!(
        writes
            .iter()
            .any(|row| row["payload"]["reviewers"] == json!(["review-bot[bot]"]))
    );
    assert!(
        writes
            .iter()
            .any(|row| row.to_string().contains("needs%2Fdesign"))
    );
    assert!(writes.iter().all(|row| row["inputMode"] == "0o600"));
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn picker_permissions_are_distinct_from_author_edit_permissions_and_rechecked_before_writes()
{
    let f = Fixture::new();
    f.state(json!({"viewerPermission":"READ"}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(detail.capabilities.edit);
    assert!(!detail.capabilities.labels);
    assert!(!detail.capabilities.request_reviewers);
    assert!(
        app.read_pull_request_candidates(
            thread.clone(),
            detail.observation.clone(),
            PrCandidateKind::Labels
        )
        .await
        .is_err()
    );
    let input = PrReviewChange {
        request_id: "denied-label".into(),
        target: detail.observation.clone(),
        action: PrReviewAction::SetLabel {
            name: "bug".into(),
            applied: true,
        },
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), input)
            .await
            .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert!(f.mutations().is_empty());
    f.state(json!({"viewerPermission":"TRIAGE"}));
    let triage = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(triage.capabilities.labels);
    assert!(!triage.capabilities.request_reviewers);
    assert!(
        app.read_pull_request_candidates(
            thread.clone(),
            triage.observation,
            PrCandidateKind::Labels
        )
        .await
        .is_ok()
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn picker_uncertainty_has_one_durable_receipt_and_never_replays_a_write() {
    let f = Fixture::new();
    f.state(json!({"pickerMutationMode":"acceptThenUncertain"}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let input = PrReviewChange {
        request_id: "uncertain-label".into(),
        target: detail.observation,
        action: PrReviewAction::SetLabel {
            name: "bug".into(),
            applied: true,
        },
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        PrChangeResult::Uncertain { .. }
    ));
    assert!(matches!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        PrChangeResult::Uncertain { .. }
    ));
    assert_eq!(f.mutations().len(), 1);
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(detail.labels[0].name, "bug");
    let saved_target = detail.observation;
    app.shutdown().await.unwrap();
    f.state(json!({"labels":[{"name":"bug","color":"ff0000"}]}));
    let app = App::open(f.config.clone()).await.unwrap();
    assert!(matches!(
        app.change_pull_request(thread.clone(), input)
            .await
            .unwrap(),
        PrChangeResult::Uncertain { .. }
    ));
    assert_eq!(f.mutations().len(), 1);
    let labels = app
        .read_pull_request_candidates(
            thread.clone(),
            saved_target.clone(),
            PrCandidateKind::Labels,
        )
        .await
        .unwrap();
    assert!(
        labels
            .labels
            .iter()
            .find(|label| label.name == "bug")
            .unwrap()
            .is_applied
    );
    let next = PrReviewChange {
        request_id: "next-label-action".into(),
        target: saved_target,
        action: PrReviewAction::SetLabel {
            name: "bug".into(),
            applied: false,
        },
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), next).await.unwrap(),
        PrChangeResult::Applied { .. }
    ));
    assert_eq!(f.mutations().len(), 2);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn global_candidate_completion_refuses_a_remote_switch_and_thread_reads_need_a_link() {
    let f = Fixture::new();
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&f.root)
            .args([
                "config",
                "remote.origin.url",
                "https://github.com/fixture/project.git"
            ])
            .status()
            .unwrap()
            .success()
    );
    f.state(json!({}));
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.root.clone()).await.unwrap();
    let access = PrAccess::Workspace {
        workspace_id: workspace.id.clone(),
    };
    let detail = app
        .read_pull_request(access.clone(), f.key())
        .await
        .unwrap();
    let thread = app
        .create_thread(workspace.id, NewCheckout::Local)
        .await
        .unwrap();
    assert!(
        app.read_pull_request_candidates(
            thread.id,
            detail.observation.clone(),
            PrCandidateKind::Labels
        )
        .await
        .is_err()
    );
    let release = f.dir.path().join("release");
    f.state(json!({"waitFor":{"BotLabelCandidates":release}}));
    let reader = app.clone();
    let target = detail.observation;
    let task = tokio::spawn(async move {
        reader
            .read_pull_request_candidates(access, target, PrCandidateKind::Labels)
            .await
    });
    f.wait_for("BotLabelCandidates").await;
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&f.root)
            .args([
                "config",
                "remote.origin.url",
                "https://github.com/other/repo.git"
            ])
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(release, "").unwrap();
    assert!(task.await.unwrap().is_err());
    app.shutdown().await.unwrap();
}
