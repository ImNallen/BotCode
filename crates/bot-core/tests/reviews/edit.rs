use super::*;

fn edit(detail: &PrReviewDetail, action: PrReviewAction) -> PrReviewChange {
    PrReviewChange {
        request_id: uuid::Uuid::new_v4().to_string(),
        target: detail.observation.clone(),
        action,
    }
}
#[tokio::test]
async fn edit_title_sends_only_the_title_and_github_returns_it() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    assert!(detail.capabilities.edit);
    let result = app
        .change_pull_request(
            t.clone(),
            edit(
                &detail,
                PrReviewAction::EditTitle {
                    title: "Retitled pull request".into(),
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        result,
        PrChangeResult::Applied {
            host_id: "PR_fixture_41".into()
        }
    );
    let mutations = f.mutations();
    assert_eq!(mutations.len(), 1);
    let query = mutations[0]["payload"]["query"].as_str().unwrap();
    assert!(query.starts_with("mutation BotEditTitle($input:UpdatePullRequestInput!)"));
    assert!(query.contains("updatePullRequest(input:$input){pullRequest{id}}"));
    assert_eq!(
        mutations[0]["payload"]["variables"]["input"],
        json!({"pullRequestId":"PR_fixture_41","title":"Retitled pull request"})
    );
    let refreshed = app.read_pull_request(t, f.key()).await.unwrap();
    assert_eq!(refreshed.snapshot.title, "Retitled pull request");
    assert_eq!(refreshed.body, "Review the calculation update.");
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn edit_body_may_clear_the_description_but_a_blank_title_is_refused() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    assert_eq!(
        app.change_pull_request(
            t.clone(),
            edit(
                &detail,
                PrReviewAction::EditTitle {
                    title: "  \n".into()
                }
            ),
        )
        .await
        .unwrap(),
        PrChangeResult::Refused {
            message: "Review text or line comments are invalid or too large.".into()
        }
    );
    assert_eq!(
        app.change_pull_request(
            t.clone(),
            edit(
                &detail,
                PrReviewAction::EditTitle {
                    title: "x".repeat(257)
                }
            ),
        )
        .await
        .unwrap(),
        PrChangeResult::Refused {
            message: "Review text or line comments are invalid or too large.".into()
        }
    );
    assert!(f.mutations().is_empty());
    assert_eq!(
        app.change_pull_request(
            t.clone(),
            edit(&detail, PrReviewAction::EditBody { body: "".into() }),
        )
        .await
        .unwrap(),
        PrChangeResult::Applied {
            host_id: "PR_fixture_41".into()
        }
    );
    let mutations = f.mutations();
    assert_eq!(mutations.len(), 1);
    assert!(
        mutations[0]["payload"]["query"]
            .as_str()
            .unwrap()
            .starts_with("mutation BotEditBody($input:UpdatePullRequestInput!)")
    );
    assert_eq!(
        mutations[0]["payload"]["variables"]["input"],
        json!({"pullRequestId":"PR_fixture_41","body":""})
    );
    let refreshed = app.read_pull_request(t, f.key()).await.unwrap();
    assert_eq!(refreshed.body, "");
    assert_eq!(refreshed.snapshot.title, "Durable fixture pull request");
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn edits_are_refused_without_viewer_can_update_before_or_during_validation() {
    let f = Fixture::new();
    f.state(json!({"viewerCanUpdate":false}));
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    assert!(!detail.capabilities.edit);
    assert_eq!(
        app.change_pull_request(
            t.clone(),
            edit(
                &detail,
                PrReviewAction::EditTitle {
                    title: "Retitled".into()
                }
            ),
        )
        .await
        .unwrap(),
        PrChangeResult::Refused {
            message: "GitHub does not permit editing this pull request.".into()
        }
    );
    f.state(json!({"finalMeta":{"viewerCanUpdate":false}}));
    assert_eq!(
        app.change_pull_request(
            t.clone(),
            edit(
                &detail,
                PrReviewAction::EditBody {
                    body: "New description".into()
                }
            ),
        )
        .await
        .unwrap(),
        PrChangeResult::Refused {
            message: "Edit permissions changed during validation. Refresh.".into()
        }
    );
    assert!(f.mutations().is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn edits_apply_after_the_head_moves_but_not_after_the_account_changes() {
    let f = Fixture::new();
    let (app, t) = f.open().await;
    let detail = app.read_pull_request(t.clone(), f.key()).await.unwrap();
    assert_eq!(detail.observation.head_oid, "a".repeat(40));
    f.state(json!({"head":"e".repeat(40)}));
    assert_eq!(
        app.change_pull_request(
            t.clone(),
            edit(
                &detail,
                PrReviewAction::EditTitle {
                    title: "Retitled after a push".into()
                }
            ),
        )
        .await
        .unwrap(),
        PrChangeResult::Applied {
            host_id: "PR_fixture_41".into()
        }
    );
    assert_eq!(f.mutations().len(), 1);
    f.state(json!({"head":"e".repeat(40),"viewer":"other-viewer"}));
    assert!(matches!(
        app.change_pull_request(
            t.clone(),
            edit(
                &detail,
                PrReviewAction::EditBody {
                    body: "Other account".into()
                }
            ),
        )
        .await
        .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    f.state(json!({"head":"e".repeat(40)}));
    assert!(matches!(
        app.change_pull_request(
            t,
            edit(
                &detail,
                PrReviewAction::Reply {
                    thread_id: "THREAD_0".into(),
                    body: "Reply against the old head".into(),
                }
            ),
        )
        .await
        .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert_eq!(f.mutations().len(), 1);
    app.shutdown().await.unwrap();
}
