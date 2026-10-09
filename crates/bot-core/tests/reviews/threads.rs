use super::*;

#[tokio::test]
async fn current_thread_location_survives_renames_and_null_lines_without_changing_evidence() {
    let f = Fixture::new();
    f.state(json!({"threadPath":"renamed.ts","threadLine":12,"threadSide":"LEFT"}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let entry = detail
        .findings
        .iter()
        .find(|entry| matches!(entry.finding.source, ReviewSource::Thread { .. }))
        .unwrap();
    let location = entry.thread_location.as_ref().unwrap();
    assert_eq!(location.path, "renamed.ts");
    assert_eq!(location.line, Some(12));
    assert_eq!(location.side, PrSide::Left);
    assert_eq!(
        entry.finding.comments[0]
            .context
            .as_ref()
            .unwrap()
            .path
            .as_deref(),
        Some("calculate.ts")
    );
    let digest = entry.finding.observation.content_digest.clone();
    assert!(
        detail
            .findings
            .iter()
            .filter(|entry| !matches!(entry.finding.source, ReviewSource::Thread { .. }))
            .all(|entry| entry.thread_location.is_none())
    );
    f.state(json!({"threadPath":"renamed.ts","threadLine":null,"threadSide":"RIGHT"}));
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let entry = detail
        .findings
        .iter()
        .find(|entry| matches!(entry.finding.source, ReviewSource::Thread { .. }))
        .unwrap();
    assert_eq!(entry.thread_location.as_ref().unwrap().line, None);
    assert_eq!(entry.finding.observation.content_digest, digest);
    f.state(json!({"threadSide":"UNKNOWN"}));
    let detail = app.read_pull_request(thread, f.key()).await.unwrap();
    assert!(
        detail
            .findings
            .iter()
            .all(|entry| entry.thread_location.is_none())
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn thread_refresh_returns_posted_replies_and_resolution() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let reply = app
        .change_pull_request(
            thread.clone(),
            PrReviewChange {
                request_id: uuid::Uuid::new_v4().to_string(),
                target: detail.observation.clone(),
                action: PrReviewAction::Reply {
                    thread_id: "THREAD_0".into(),
                    body: "Confirmed current anchor".into(),
                },
            },
        )
        .await
        .unwrap();
    assert!(matches!(reply, PrChangeResult::Applied { .. }));
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let entry = detail
        .findings
        .iter()
        .find(|entry| entry.finding.observation.finding_id == "THREAD_0")
        .unwrap();
    assert_eq!(entry.finding.comments.len(), 2);
    assert_eq!(entry.finding.comments[1].body, "Confirmed current anchor");
    let result = app
        .change_pull_request(
            thread.clone(),
            PrReviewChange {
                request_id: uuid::Uuid::new_v4().to_string(),
                target: detail.observation.clone(),
                action: PrReviewAction::SetResolved {
                    thread_id: "THREAD_0".into(),
                    resolved: true,
                },
            },
        )
        .await
        .unwrap();
    assert!(matches!(result, PrChangeResult::Applied { .. }));
    let detail = app.read_pull_request(thread, f.key()).await.unwrap();
    assert!(
        detail
            .findings
            .iter()
            .any(|entry| entry.finding.observation.finding_id == "THREAD_0"
                && matches!(
                    entry.finding.source,
                    ReviewSource::Thread { resolved: true, .. }
                ))
    );
    app.shutdown().await.unwrap();
}
