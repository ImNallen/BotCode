use super::*;

fn files() -> Value {
    json!([{"filename":"calculate.ts","status":"modified","additions":3,"deletions":3,"patch":"@@ -1,3 +1,3 @@\n-old1\n-old2\n-old3\n+new1\n+new2\n+new3"}])
}
fn ranged(detail: &PrReviewDetail, side: PrSide, start: Option<u64>, end: u64) -> PrReviewChange {
    let mut input = submission(detail);
    if let PrReviewAction::SubmitReview { comments, .. } = &mut input.action {
        comments[0].side = side;
        comments[0].start_line = start;
        comments[0].line = end;
    }
    input
}

#[tokio::test]
async fn posts_true_right_and_left_ranges_and_omits_range_fields_for_single_lines() {
    for (side, start) in [
        (PrSide::Right, Some(1)),
        (PrSide::Left, Some(1)),
        (PrSide::Right, None),
    ] {
        let f = Fixture::new();
        f.state(json!({"files":files()}));
        let (app, thread) = f.open().await;
        let detail = app
            .read_pull_request(thread.clone(), f.key())
            .await
            .unwrap();
        let result = app
            .change_pull_request(thread, ranged(&detail, side.clone(), start, 3))
            .await
            .unwrap();
        assert!(matches!(result, PrChangeResult::Applied { .. }));
        let mutations = f.mutations();
        assert_eq!(mutations.len(), 1);
        let posted = &mutations[0]["payload"]["variables"]["input"]["threads"][0];
        assert_eq!(posted["line"], 3);
        assert_eq!(posted["side"], json!(side));
        if start.is_some() {
            assert_eq!(posted["startLine"], 1);
            assert_eq!(posted["startSide"], json!(side));
        } else {
            assert!(posted.get("startLine").is_none());
            assert!(posted.get("startSide").is_none());
        }
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn refuses_forged_ranges_before_any_mutation() {
    for (start, end) in [(0, 3), (3, 3), (4, 3), (1, u64::MAX), (1, 4)] {
        let f = Fixture::new();
        f.state(json!({"files":files()}));
        let (app, thread) = f.open().await;
        let detail = app
            .read_pull_request(thread.clone(), f.key())
            .await
            .unwrap();
        assert!(matches!(
            app.change_pull_request(thread, ranged(&detail, PrSide::Right, Some(start), end))
                .await
                .unwrap(),
            PrChangeResult::Refused { .. }
        ));
        assert!(f.mutations().is_empty());
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn refuses_ranges_across_hunks_or_after_head_changes() {
    let f = Fixture::new();
    let separated = json!([{"filename":"calculate.ts","status":"modified","additions":2,"deletions":0,"patch":"@@ -0,0 +1 @@\n+one\n@@ -0,0 +2 @@\n+two"}]);
    f.state(json!({"files":separated}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert!(matches!(
        app.change_pull_request(thread.clone(), ranged(&detail, PrSide::Right, Some(1), 2))
            .await
            .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    f.state(json!({"files":files(),"head":"c".repeat(40)}));
    assert!(matches!(
        app.change_pull_request(thread, ranged(&detail, PrSide::Right, Some(1), 3))
            .await
            .unwrap(),
        PrChangeResult::Refused { .. }
    ));
    assert!(f.mutations().is_empty());
    app.shutdown().await.unwrap();
}

#[test]
fn old_single_line_wire_shape_is_unchanged() {
    let single =
        json!({"id":"draft","revision":0,"path":"a","side":"RIGHT","line":1,"body":"text"});
    let comment: DraftReviewComment = serde_json::from_value(single.clone()).unwrap();
    assert_eq!(comment.start_line, None);
    assert_eq!(serde_json::to_value(comment).unwrap(), single);
}

#[tokio::test]
async fn refuses_incomplete_and_mixed_side_ranges_without_mutating() {
    for file in [
        json!({"filename":"calculate.ts","status":"modified","additions":99,"deletions":3,"patch":"@@ -1,3 +1,3 @@\n-old1\n-old2\n-old3\n+new1\n+new2\n+new3"}),
        json!({"filename":"calculate.ts","status":"modified","additions":1,"deletions":1,"patch":"@@ -1,3 +1,3 @@\n before\n-old\n+new\n after"}),
    ] {
        let f = Fixture::new();
        f.state(json!({"files":[file]}));
        let (app, thread) = f.open().await;
        let detail = app
            .read_pull_request(thread.clone(), f.key())
            .await
            .unwrap();
        assert!(matches!(
            app.change_pull_request(thread, ranged(&detail, PrSide::Left, Some(1), 3))
                .await
                .unwrap(),
            PrChangeResult::Refused { .. }
        ));
        assert!(f.mutations().is_empty());
        app.shutdown().await.unwrap();
    }
}
