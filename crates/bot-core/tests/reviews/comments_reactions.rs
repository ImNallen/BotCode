use super::*;
fn group(content: &str, count: u64, viewer: bool) -> Value {
    json!({"content":content,"viewerHasReacted":viewer,"reactors":{"totalCount":count,"nodes":[{"login":"fixture-viewer"},{"login":"alice"},{"login":"bob"}]}})
}
#[tokio::test]
async fn reactions_read_all_subjects_and_use_fresh_membership_before_add_remove() {
    let f = Fixture::new();
    f.state(json!({"reactionGroups":[group("THUMBS_UP",5,true)],"subjectReactions":{"COMMENT_0":[group("HEART",3,false)],"COMMENTS_0":[group("EYES",4,false)],"REVIEWS_0":[group("ROCKET",3,false)]},"subjectScope":{"COMMENT_0":{"type":"PullRequestReviewComment"}}}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(detail.reactions[0].count, 5);
    assert_eq!(detail.reactions[0].actors, vec!["alice", "bob"]);
    assert!(detail.capabilities.react);
    for id in ["COMMENT_0", "COMMENTS_0", "REVIEWS_0"] {
        assert!(
            detail
                .findings
                .iter()
                .flat_map(|finding| &finding.reaction_subjects)
                .any(|subject| subject.subject_id == id && !subject.reactions.is_empty())
        );
    }
    for (index, subject) in [
        None,
        Some("COMMENT_0"),
        Some("COMMENTS_0"),
        Some("REVIEWS_0"),
    ]
    .into_iter()
    .enumerate()
    {
        let input = PrReviewChange {
            request_id: format!("reaction-{index}"),
            target: detail.observation.clone(),
            action: PrReviewAction::SetReaction {
                subject_id: subject.map(str::to_owned),
                content: PrReactionContent::Laugh,
                reacted: true,
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
    }
    let remove = PrReviewChange {
        request_id: "remove-reaction".into(),
        target: detail.observation.clone(),
        action: PrReviewAction::SetReaction {
            subject_id: None,
            content: PrReactionContent::Laugh,
            reacted: false,
        },
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), remove)
            .await
            .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    assert_eq!(f.mutations().len(), 5);
    let refreshed = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(
        !refreshed
            .reactions
            .iter()
            .any(|reaction| reaction.content == PrReactionContent::Laugh)
    );
    let remove_seeded = PrReviewChange {
        request_id: "remove-seeded-reaction".into(),
        target: refreshed.observation.clone(),
        action: PrReviewAction::SetReaction {
            subject_id: None,
            content: PrReactionContent::ThumbsUp,
            reacted: false,
        },
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), remove_seeded)
            .await
            .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    let removed = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let thumbs = removed
        .reactions
        .iter()
        .find(|reaction| reaction.content == PrReactionContent::ThumbsUp)
        .unwrap();
    assert!(!thumbs.viewer_has_reacted);
    assert_eq!(thumbs.count, 4);
    assert_eq!(thumbs.actors, vec!["alice", "bob"]);
    f.state(json!({"crossPrReaction":true}));
    let wrong = PrReviewChange {
        request_id: "wrong-reaction".into(),
        target: detail.observation,
        action: PrReviewAction::SetReaction {
            subject_id: Some("COMMENTS_0".into()),
            content: PrReactionContent::Eyes,
            reacted: true,
        },
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), wrong)
            .await
            .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert_eq!(f.mutations().len(), 6);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn ordinary_comment_uses_add_comment_and_survives_head_changes_without_reposting_after_close_refusal()
 {
    let f = Fixture::new();
    f.state(json!({}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    f.state(json!({"head":"b".repeat(40),"contentMutationModes":{"BotClose":"refuse"}}));
    let input = PrReviewChange {
        request_id: "plain-comment".into(),
        target: detail.observation,
        action: PrReviewAction::AddComment {
            body: "A plain comment before closing.".into(),
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
    let fresh = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(
        fresh
            .findings
            .iter()
            .any(|entry| entry.finding.source == ReviewSource::Conversation
                && entry.finding.comments[0].body == "A plain comment before closing.")
    );
    let close = PrReviewChange {
        request_id: "close-after-comment".into(),
        target: fresh.observation,
        action: PrReviewAction::SetClosed { closed: true },
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), close)
            .await
            .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert_eq!(
        f.mutations()
            .iter()
            .filter(|entry| entry.to_string().contains("mutation BotAddComment"))
            .count(),
        1
    );
    assert!(
        !f.mutations()
            .iter()
            .any(|entry| entry.to_string().contains("BotSubmitReview"))
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn ordinary_comment_unknown_acceptance_is_durable_and_same_request_never_reposts_after_restart()
 {
    let f = Fixture::new();
    f.state(json!({"contentMutationModes":{"BotAddComment":"acceptThenUncertain"}}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let input = PrReviewChange {
        request_id: "unknown-comment".into(),
        target: detail.observation,
        action: PrReviewAction::AddComment {
            body: "Post exactly once.".into(),
        },
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), input.clone())
            .await
            .unwrap(),
        PrChangeResult::Uncertain { .. }
    ));
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    assert!(matches!(
        app.change_pull_request(thread.clone(), input)
            .await
            .unwrap(),
        PrChangeResult::Uncertain { .. }
    ));
    assert_eq!(f.mutations().len(), 1);
    let detail = app.read_pull_request(thread, f.key()).await.unwrap();
    assert_eq!(
        detail
            .findings
            .iter()
            .filter(|entry| entry.finding.comments[0].body == "Post exactly once.")
            .count(),
        1
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn comment_reaction_permissions_are_read_role_enabled_but_locked_or_changed_account_refuses()
{
    let f = Fixture::new();
    f.state(json!({"viewerPermission":"READ","lifecycle":"CLOSED"}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(detail.capabilities.comment && detail.capabilities.react);
    assert!(detail.verdicts.is_empty());
    f.state(json!({"locked":true}));
    assert!(matches!(
        app.change_pull_request(
            thread.clone(),
            PrReviewChange {
                request_id: "locked-reaction".into(),
                target: detail.observation.clone(),
                action: PrReviewAction::SetReaction {
                    subject_id: None,
                    content: PrReactionContent::Heart,
                    reacted: true
                },
            }
        )
        .await
        .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert!(f.mutations().is_empty());
    let locked = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(locked.capabilities.comment);
    assert!(!locked.capabilities.react);
    assert!(matches!(
        app.change_pull_request(
            thread.clone(),
            PrReviewChange {
                request_id: "locked-collaborator-comment".into(),
                target: locked.observation,
                action: PrReviewAction::AddComment {
                    body: "Collaborator can comment while locked".into()
                },
            }
        )
        .await
        .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    assert_eq!(f.mutations().len(), 1);
    f.state(json!({"viewer":"other-viewer"}));
    let input = PrReviewChange {
        request_id: "changed-account".into(),
        target: detail.observation,
        action: PrReviewAction::AddComment {
            body: "Denied account switch".into(),
        },
    };
    assert!(matches!(
        app.change_pull_request(thread.clone(), input)
            .await
            .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn global_content_subjects_route_to_number_42_without_changing_number_41() {
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
    f.state(json!({"matchNumber":true,"perNumber":{"41":{"title":"Untouched","reactionGroups":[]},"42":{"subjectReactions":{"COMMENT_0":[group("HEART",2,true)]},"subjectScope":{"COMMENTS_0":{"type":"IssueComment","prId":"PR_fixture_42"},"REVIEWS_0":{"type":"PullRequestReview","prId":"PR_fixture_42"},"COMMENT_0":{"type":"PullRequestReviewComment","prId":"PR_fixture_42"}}}}}));
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.root.clone()).await.unwrap();
    let access = PrAccess::Workspace {
        workspace_id: workspace.id,
    };
    let key = PullRequestKey::new("fixture", "project", 42).unwrap();
    let detail = app
        .read_pull_request(access.clone(), key.clone())
        .await
        .unwrap();
    for (index, subject) in [
        None,
        Some("COMMENTS_0"),
        Some("REVIEWS_0"),
        Some("COMMENT_0"),
    ]
    .into_iter()
    .enumerate()
    {
        assert!(matches!(
            app.change_pull_request(
                access.clone(),
                PrReviewChange {
                    request_id: format!("global-subject-{index}"),
                    target: detail.observation.clone(),
                    action: PrReviewAction::SetReaction {
                        subject_id: subject.map(str::to_owned),
                        content: PrReactionContent::Heart,
                        reacted: true
                    }
                }
            )
            .await
            .unwrap(),
            PrChangeResult::Applied { .. }
        ));
    }
    assert!(matches!(
        app.change_pull_request(
            access.clone(),
            PrReviewChange {
                request_id: "global-plain-comment".into(),
                target: detail.observation,
                action: PrReviewAction::AddComment {
                    body: "Only on number 42".into()
                }
            }
        )
        .await
        .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    let refreshed = app.read_pull_request(access.clone(), key).await.unwrap();
    assert!(refreshed.reactions.iter().any(|reaction| reaction.content
        == PrReactionContent::Heart
        && reaction.viewer_has_reacted));
    for id in ["COMMENTS_0", "REVIEWS_0", "COMMENT_0"] {
        assert!(
            refreshed
                .findings
                .iter()
                .flat_map(|finding| &finding.reaction_subjects)
                .any(|subject| subject.subject_id == id
                    && subject
                        .reactions
                        .iter()
                        .any(|reaction| reaction.content == PrReactionContent::Heart
                            && reaction.viewer_has_reacted))
        );
    }
    assert!(
        refreshed
            .findings
            .iter()
            .flat_map(|finding| &finding.finding.comments)
            .any(|comment| comment.body == "Only on number 42")
    );
    let posted = refreshed
        .findings
        .iter()
        .flat_map(|finding| &finding.finding.comments)
        .find(|comment| comment.body == "Only on number 42")
        .unwrap();
    let posted_reactions = refreshed
        .findings
        .iter()
        .flat_map(|finding| &finding.reaction_subjects)
        .find(|subject| subject.subject_id == posted.id)
        .unwrap();
    assert!(posted_reactions.reactions.is_empty());
    assert!(matches!(
        app.change_pull_request(
            access.clone(),
            PrReviewChange {
                request_id: "react-to-new-comment".into(),
                target: refreshed.observation.clone(),
                action: PrReviewAction::SetReaction {
                    subject_id: Some(posted.id.clone()),
                    content: PrReactionContent::Eyes,
                    reacted: true
                },
            }
        )
        .await
        .unwrap(),
        PrChangeResult::Applied { .. }
    ));
    let reacted = app
        .read_pull_request(
            access.clone(),
            PullRequestKey::new("fixture", "project", 42).unwrap(),
        )
        .await
        .unwrap();
    let new_reaction = reacted
        .findings
        .iter()
        .flat_map(|finding| &finding.reaction_subjects)
        .find(|subject| subject.subject_id == posted.id)
        .unwrap();
    assert_eq!(new_reaction.reactions.len(), 1);
    assert_eq!(new_reaction.reactions[0].content, PrReactionContent::Eyes);
    assert_eq!(new_reaction.reactions[0].count, 1);
    assert!(new_reaction.reactions[0].viewer_has_reacted);
    let untouched = app.read_pull_request(access, f.key()).await.unwrap();
    assert!(untouched.reactions.is_empty());
    assert!(
        !untouched
            .findings
            .iter()
            .flat_map(|finding| &finding.finding.comments)
            .any(|comment| comment.body == "Only on number 42")
    );
    let saved: Value =
        serde_json::from_slice(&std::fs::read(f.dir.path().join("gh.json")).unwrap()).unwrap();
    assert!(saved["perNumber"]["41"]["submitted"].is_null());
    assert_eq!(
        saved["perNumber"]["42"]["submitted"]
            .as_array()
            .unwrap()
            .len(),
        6
    );
    app.shutdown().await.unwrap();
}
