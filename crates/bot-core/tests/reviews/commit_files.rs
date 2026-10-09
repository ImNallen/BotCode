use super::*;

fn request(detail: &PrReviewDetail, oid: &str) -> PrCommitFilesRequest {
    PrCommitFilesRequest {
        target: detail.observation.clone(),
        commit_oid: oid.into(),
    }
}
fn file(path: &str) -> Value {
    json!({"filename":path,"status":"modified","additions":1,"deletions":1,"patch":"@@ -1 +1 @@\n-old\n+new"})
}
fn commit(oid: &str) -> Value {
    json!({"oid":oid,"messageHeadline":"Selected commit","committedDate":"2026-10-03T12:00:00Z","author":{"name":"Contributor"}})
}

#[tokio::test]
async fn commit_diff_is_exact_and_does_not_replace_whole_pr_files() {
    let f = Fixture::new();
    let oid = "c".repeat(40);
    f.state(json!({"files":[file("overall.ts")],"commitFiles":{&oid:[file("commit.ts")]}}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let scoped = app
        .read_pull_request_commit_files(thread.clone(), request(&detail, &oid))
        .await
        .unwrap();
    assert_eq!(scoped.files.len(), 1);
    assert_eq!(scoped.files[0].path, "commit.ts");
    assert_eq!(scoped.files[0].anchors.len(), 2);
    assert_eq!(scoped.target, detail.observation);
    assert_eq!(scoped.commit_oid, oid);
    assert_eq!(
        app.read_pull_request(thread.clone(), f.key())
            .await
            .unwrap()
            .files[0]
            .path,
        "overall.ts"
    );
    assert!(
        f.log().iter().any(
            |entry| entry["args"].as_array().unwrap().contains(&json!(format!(
                "repos/fixture/project/commits/{oid}?per_page=100&page=1"
            )))
        )
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn commit_admission_rejects_malformed_foreign_stale_and_unlinked_reads() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    for oid in [
        "c".repeat(7),
        "../files".into(),
        "z".repeat(40),
        "d".repeat(40),
    ] {
        assert!(
            app.read_pull_request_commit_files(thread.clone(), request(&detail, &oid))
                .await
                .is_err()
        );
    }
    assert!(!f.log().iter().any(|entry| {
        entry["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|arg| arg.as_str().unwrap().contains("/commits/"))
    }));
    for changes in [
        json!({"head":"d".repeat(40)}),
        json!({"viewer":"another-viewer"}),
        json!({"nodeId":"PR_other"}),
    ] {
        f.state(changes);
        assert_eq!(
            app.read_pull_request_commit_files(thread.clone(), request(&detail, &"c".repeat(40)))
                .await
                .unwrap_err()
                .code,
            "pr_review_identity"
        );
    }
    let mut unlinked = request(&detail, &"c".repeat(40));
    unlinked.target.key = PullRequestKey::new("fixture", "project", 99).unwrap();
    assert_eq!(
        app.read_pull_request_commit_files(thread, unlinked)
            .await
            .unwrap_err()
            .code,
        "pr_not_linked"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn commit_membership_is_paged_and_fails_closed_when_not_established() {
    let f = Fixture::new();
    let oid = "d".repeat(40);
    f.state(json!({"pages":2,"commitPages":{"0":[commit(&"c".repeat(40))],"1":[commit(&oid)]},"commitFiles":{&oid:[file("second-page.ts")]}}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(
        app.read_pull_request_commit_files(thread.clone(), request(&detail, &oid))
            .await
            .unwrap()
            .files[0]
            .path,
        "second-page.ts"
    );
    for changes in [
        json!({"commits":[]}),
        json!({"pages":5}),
        json!({"failSections":["BotReviewCommits"]}),
        json!({"wrongIdentitySections":["BotReviewCommits"]}),
    ] {
        f.state(changes);
        assert!(
            app.read_pull_request_commit_files(thread.clone(), request(&detail, &oid))
                .await
                .is_err()
        );
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn commit_read_rejects_head_and_account_changes_during_file_read() {
    let f = Fixture::new();
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    for changes in [
        json!({"metaHeads":["a".repeat(40),"d".repeat(40)],"commitDelays":{"c".repeat(40):0.05}}),
        json!({"finalViewer":"another-viewer","commitDelays":{"c".repeat(40):0.05}}),
    ] {
        f.state(changes);
        assert_eq!(
            app.read_pull_request_commit_files(thread.clone(), request(&detail, &"c".repeat(40)))
                .await
                .unwrap_err()
                .code,
            "pr_review_identity"
        );
    }
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn commit_read_handles_empty_binary_partial_and_failed_file_pages() {
    let f = Fixture::new();
    let oid = "c".repeat(40);
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    for changes in [json!({}), json!({"commitModes":{&oid:"omitted"}})] {
        f.state(changes);
        assert!(
            app.read_pull_request_commit_files(thread.clone(), request(&detail, &oid))
                .await
                .unwrap()
                .files
                .is_empty()
        );
    }
    f.state(json!({"commitFiles":{&oid:[{"filename":"binary.png","status":"added","additions":0,"deletions":0},{"filename":"partial.ts","status":"modified","additions":2,"deletions":1,"patch":"@@ -1 +1 @@\n-old\n+new"}]}}));
    let scoped = app
        .read_pull_request_commit_files(thread.clone(), request(&detail, &oid))
        .await
        .unwrap();
    assert_eq!(scoped.files.len(), 2);
    assert!(
        scoped
            .files
            .iter()
            .all(|file| file.unavailable.is_some() && file.anchors.is_empty())
    );
    assert!(!scoped.problems.is_empty());
    let files: Vec<_> = (0..100).map(|n| file(&format!("file-{n}.ts"))).collect();
    f.state(json!({"commitFilePages":{&oid:{"1":files}},"failCommitPages":[2]}));
    let scoped = app
        .read_pull_request_commit_files(thread.clone(), request(&detail, &oid))
        .await
        .unwrap();
    assert_eq!(scoped.files.len(), 100);
    assert!(matches!(
        &scoped.problems[0],
        PrSectionProblem::Failed {
            section: PrSection::Files,
            ..
        }
    ));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn commit_file_failure_is_an_error_and_unlink_invalidates_running_read() {
    let f = Fixture::new();
    let oid = "c".repeat(40);
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    f.state(json!({"commitModes":{&oid:"error"}}));
    assert!(
        app.read_pull_request_commit_files(thread.clone(), request(&detail, &oid))
            .await
            .is_err()
    );
    f.state(json!({"commitDelays":{&oid:0.3}}));
    std::fs::remove_file(f.dir.path().join("gh.log")).unwrap();
    let worker = app.clone();
    let worker_thread = thread.clone();
    let input = request(&detail, &oid);
    let task = tokio::spawn(async move {
        worker
            .read_pull_request_commit_files(worker_thread, input)
            .await
    });
    f.wait_for("/commits/").await;
    app.unlink_pull_request(thread, f.key()).await.unwrap();
    assert!(task.await.unwrap().is_err());
    app.shutdown().await.unwrap();
}
