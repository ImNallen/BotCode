use super::*;

fn update(target: &PrObservation, path: &str, viewed: bool) -> PrSetFilesViewed {
    PrSetFilesViewed {
        target: target.clone(),
        files: vec![PrFileViewedUpdate {
            path: path.into(),
            viewed,
        }],
    }
}

#[tokio::test]
async fn viewed_batch_uses_literal_path_variables_and_both_mutations() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    let target = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap()
        .observation;
    let paths = [
        "quote\"\\ space.ts",
        "true",
        "@literal.ts",
        "nested/line\nbreak.ts",
    ];
    let input = PrSetFilesViewed {
        target: target.clone(),
        files: paths
            .iter()
            .enumerate()
            .map(|(index, path)| PrFileViewedUpdate {
                path: (*path).into(),
                viewed: index % 2 == 0,
            })
            .collect(),
    };
    app.set_pull_request_files_viewed(thread.clone(), input)
        .await
        .unwrap();
    let result = app
        .read_pull_request_files_viewed(thread.clone(), target.clone())
        .await
        .unwrap();
    assert_eq!(result.target, target);
    assert_eq!(result.files.len(), 4);
    for (index, path) in paths.iter().enumerate() {
        let file = result.files.iter().find(|file| file.path == *path).unwrap();
        assert_eq!(
            matches!(file.state, PrFileViewedState::Viewed),
            index % 2 == 0
        );
    }
    let entry = f
        .log()
        .into_iter()
        .find(|entry| {
            entry["args"]
                .as_array()
                .unwrap()
                .iter()
                .any(|arg| arg.as_str().unwrap().contains("mutation BotSetFilesViewed"))
        })
        .unwrap();
    let args = entry["args"].as_array().unwrap();
    let document = args
        .iter()
        .filter_map(Value::as_str)
        .find(|arg| arg.starts_with("query="))
        .unwrap();
    assert!(document.contains("f0:markFileAsViewed"));
    assert!(document.contains("f1:unmarkFileAsViewed"));
    assert!(!document.contains(paths[0]));
    for (index, path) in paths.iter().enumerate() {
        let position = args
            .iter()
            .position(|arg| arg == &json!(format!("path{index}={path}")))
            .unwrap();
        assert_eq!(args[position - 1], "-f");
    }
    assert!(
        app.pull_request_operations(thread, f.key())
            .await
            .unwrap()
            .is_empty()
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn viewed_reads_page_and_disclose_truncation_and_unknown_values() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    let target = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap()
        .observation;
    f.state(json!({"viewedPageCount":2,"viewedPages":{"0":[null,{"path":"","viewerViewedState":"VIEWED"},{"path":"a.ts","viewerViewedState":" viewed "}],"1":[{"path":"b.ts","viewerViewedState":"DISMISSED"},{"path":"c.ts","viewerViewedState":"FUTURE_STATE"}]}}));
    let result = app
        .read_pull_request_files_viewed(thread.clone(), target.clone())
        .await
        .unwrap();
    assert!(!result.truncated);
    assert_eq!(result.files.len(), 3);
    assert!(matches!(result.files[0].state, PrFileViewedState::Viewed));
    assert!(matches!(
        result.files[1].state,
        PrFileViewedState::Dismissed
    ));
    assert!(matches!(result.files[2].state, PrFileViewedState::Unviewed));
    f.state(json!({"viewedPageCount":6,"viewedStates":{"a.ts":"VIEWED"}}));
    let result = app
        .read_pull_request_files_viewed(thread.clone(), target.clone())
        .await
        .unwrap();
    assert!(result.truncated);
    assert_eq!(result.files.len(), 5);
    f.state(json!({"viewedNodes":null}));
    assert!(
        app.read_pull_request_files_viewed(thread.clone(), target.clone())
            .await
            .unwrap()
            .files
            .is_empty()
    );
    f.state(json!({"viewedPageCount":2,"viewedFailPages":[1],"viewedStates":{"a.ts":"VIEWED"}}));
    assert!(
        app.read_pull_request_files_viewed(thread, target)
            .await
            .is_err()
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn viewed_rejects_stale_head_account_identity_and_unlinked_access() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    let target = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap()
        .observation;
    for state in [
        json!({"head":"d".repeat(40)}),
        json!({"viewer":"other"}),
        json!({"nodeId":"PR_other"}),
    ] {
        f.state(state);
        assert_eq!(
            app.read_pull_request_files_viewed(thread.clone(), target.clone())
                .await
                .unwrap_err()
                .code,
            "pr_review_identity"
        );
        assert_eq!(
            app.set_pull_request_files_viewed(thread.clone(), update(&target, "a.ts", true))
                .await
                .unwrap_err()
                .code,
            "pr_review_identity"
        );
    }
    assert!(!f.log().iter().any(|entry| {
        entry["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|arg| arg.as_str().unwrap().contains("mutation BotSetFilesViewed"))
    }));
    app.unlink_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(
        app.read_pull_request_files_viewed(thread.clone(), target.clone())
            .await
            .unwrap_err()
            .code,
        "pr_not_linked"
    );
    assert_eq!(
        app.set_pull_request_files_viewed(thread, update(&target, "a.ts", true))
            .await
            .unwrap_err()
            .code,
        "pr_not_linked"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn viewed_rejects_head_and_account_changes_during_read_and_reports_write_failure() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    let target = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap()
        .observation;
    for state in [
        json!({"metaHeads":["a".repeat(40),"d".repeat(40)]}),
        json!({"finalViewer":"other"}),
    ] {
        f.state(state);
        assert_eq!(
            app.read_pull_request_files_viewed(thread.clone(), target.clone())
                .await
                .unwrap_err()
                .code,
            "pr_review_identity"
        );
    }
    f.state(json!({"viewedMutationFailure":true}));
    assert!(
        app.set_pull_request_files_viewed(thread.clone(), update(&target, "a.ts", true))
            .await
            .unwrap_err()
            .message
            .contains("Could not update viewed files")
    );
    f.state(json!({}));
    for path in ["", "bad\0path"] {
        assert_eq!(
            app.set_pull_request_files_viewed(thread.clone(), update(&target, path, true))
                .await
                .unwrap_err()
                .code,
            "invalid_review"
        );
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn viewed_writes_are_ordered_and_reads_do_not_cause_busy_refusals() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    let target = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap()
        .observation;
    f.state(json!({"viewedMutationDelay":0.2,"viewedReadDelay":0.1}));
    let first_app = app.clone();
    let first_thread = thread.clone();
    let first_input = update(&target, "a.ts", true);
    let first = tokio::spawn(async move {
        first_app
            .set_pull_request_files_viewed(first_thread, first_input)
            .await
    });
    f.wait_for("BotSetFilesViewed").await;
    let read_app = app.clone();
    let read_thread = thread.clone();
    let read_target = target.clone();
    let read = tokio::spawn(async move {
        read_app
            .read_pull_request_files_viewed(read_thread, read_target)
            .await
    });
    app.set_pull_request_files_viewed(thread.clone(), update(&target, "a.ts", false))
        .await
        .unwrap();
    first.await.unwrap().unwrap();
    read.await.unwrap().unwrap();
    let result = app
        .read_pull_request_files_viewed(thread.clone(), target)
        .await
        .unwrap();
    assert!(matches!(result.files[0].state, PrFileViewedState::Unviewed));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn viewed_unlink_invalidates_running_read() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    let target = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap()
        .observation;
    f.state(json!({"viewedReadDelay":0.3}));
    let worker = app.clone();
    let worker_thread = thread.clone();
    let task = tokio::spawn(async move {
        worker
            .read_pull_request_files_viewed(worker_thread, target)
            .await
    });
    f.wait_for("BotFilesViewed").await;
    app.unlink_pull_request(thread, f.key()).await.unwrap();
    assert!(task.await.unwrap().is_err());
    app.shutdown().await.unwrap();
}
