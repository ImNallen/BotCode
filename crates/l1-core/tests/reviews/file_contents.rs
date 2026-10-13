use super::*;

fn file(path: &str, status: &str, previous: Option<&str>) -> Value {
    json!({"filename":path,"previous_filename":previous,"status":status,"additions":1,"deletions":1,"patch":"@@ -20 +20 @@\n-old\n+new"})
}
fn request(detail: &PrReviewDetail, index: usize) -> PrFileContentsRequest {
    PrFileContentsRequest {
        target: detail.observation.clone(),
        source_id: detail.files[index]
            .contents_source
            .as_ref()
            .unwrap()
            .id
            .clone(),
    }
}

#[tokio::test]
async fn context_uses_captured_merge_base_and_literal_rename_paths_after_base_moves() {
    let f = Fixture::new();
    let old_path = "src/old ?#% name.ts";
    let new_path = "src/new ?#% name.ts";
    f.state(json!({"files":[file(new_path,"renamed",Some(old_path))]}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let input = request(&detail, 0);
    assert_eq!(detail.files[0].previous_path.as_deref(), Some(old_path));
    assert_eq!(
        detail.files[0]
            .contents_source
            .as_ref()
            .unwrap()
            .old_oid
            .as_deref(),
        Some("b".repeat(40).as_str())
    );
    f.state(json!({"baseRefOid":"d".repeat(40),"compareMergeBase":"f".repeat(40),"fileContents":{format!("{}:{old_path}","b".repeat(40)):"old exact\n",format!("{}:{new_path}","a".repeat(40)):"new exact\n"}}));
    let contents = app
        .read_pull_request_file_contents(thread.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(contents.old_contents, "old exact\n");
    assert_eq!(contents.new_contents, "new exact\n");
    assert!(
        f.log().iter().any(
            |entry| entry["args"].as_array().unwrap().contains(&json!(format!(
                "repos/fixture/project/contents/src/old%20%3F%23%25%20name%2Ets?ref={}",
                "b".repeat(40)
            )))
        )
    );
    for changes in [
        json!({"head":"d".repeat(40)}),
        json!({"viewer":"someone-else"}),
        json!({"nodeId":"PR_other"}),
    ] {
        f.state(changes);
        assert_eq!(
            app.read_pull_request_file_contents(thread.clone(), input.clone())
                .await
                .unwrap_err()
                .code,
            "pr_review_identity"
        );
    }
    let mut forged = input.clone();
    forged.source_id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        app.read_pull_request_file_contents(thread.clone(), forged)
            .await
            .unwrap_err()
            .code,
        "pr_contents_missing"
    );
    let mut foreign = input;
    foreign.target.key = PullRequestKey::new("fixture", "project", 99).unwrap();
    assert_eq!(
        app.read_pull_request_file_contents(thread, foreign)
            .await
            .unwrap_err()
            .code,
        "pr_not_linked"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn context_uses_selected_commit_first_parent_and_handles_root_additions() {
    let f = Fixture::new();
    let oid = "c".repeat(40);
    let parent = "d".repeat(40);
    f.state(json!({"commitFiles":{&oid:[file("selected.ts","modified",None)]},"commitParents":{&oid:[&parent]},"fileContents":{format!("{parent}:selected.ts"):"first parent\n",format!("{oid}:selected.ts"):"selected commit\n"}}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let input = PrCommitFilesRequest {
        target: detail.observation.clone(),
        commit_oid: oid.clone(),
    };
    let scoped = app
        .read_pull_request_commit_files(thread.clone(), input.clone())
        .await
        .unwrap();
    let source = scoped.files[0].contents_source.as_ref().unwrap();
    assert_eq!(source.old_oid.as_ref(), Some(&parent));
    let contents = app
        .read_pull_request_file_contents(
            thread.clone(),
            PrFileContentsRequest {
                target: detail.observation.clone(),
                source_id: source.id.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(contents.old_contents, "first parent\n");
    assert_eq!(contents.new_contents, "selected commit\n");
    let mut added = file("root.ts", "added", None);
    added["deletions"] = json!(0);
    added["patch"] = json!("@@ -0,0 +1 @@\n+root");
    f.state(json!({"commitFiles":{&oid:[added]},"commitParents":{&oid:[]},"fileContents":{format!("{oid}:root.ts"):"root\n"}}));
    let root = app
        .read_pull_request_commit_files(thread.clone(), input)
        .await
        .unwrap();
    let source = root.files[0].contents_source.as_ref().unwrap();
    assert!(source.old_oid.is_none());
    let contents = app
        .read_pull_request_file_contents(
            thread,
            PrFileContentsRequest {
                target: detail.observation,
                source_id: source.id.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(contents.old_contents, "");
    assert_eq!(contents.new_contents, "root\n");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn context_rejects_missing_binary_oversized_and_invalid_utf8_and_keeps_patches_on_compare_failure()
 {
    let f = Fixture::new();
    f.state(json!({"files":[file("a.ts","modified",None)]}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let input = request(&detail, 0);
    for value in [
        Value::Null,
        json!({"type":"file","encoding":"base64","size":2,"content":"AP8="}),
        json!({"type":"file","encoding":"base64","size":1,"content":"/w=="}),
        json!({"type":"file","encoding":"base64","size":1048577,"content":""}),
        json!({"type":"file","encoding":"none","size":0,"content":""}),
        json!({"type":"file","encoding":"base64","size":5,"content":"bmV3"}),
    ] {
        f.state(json!({"fileContents":{format!("{}:a.ts","b".repeat(40)):value,format!("{}:a.ts","a".repeat(40)):"new"}}));
        assert!(
            app.read_pull_request_file_contents(thread.clone(), input.clone())
                .await
                .is_err()
        );
    }
    let limit = "a".repeat(1024 * 1024);
    f.state(json!({"fileContents":{format!("{}:a.ts","b".repeat(40)):limit,format!("{}:a.ts","a".repeat(40)):"new"}}));
    assert_eq!(
        app.read_pull_request_file_contents(thread.clone(), input)
            .await
            .unwrap()
            .old_contents
            .len(),
        1024 * 1024
    );
    f.state(json!({"files":[file("a.ts","modified",None)],"failCompare":true}));
    let failed = app.read_pull_request(thread, f.key()).await.unwrap();
    assert!(failed.files[0].patch.is_some());
    assert!(failed.files[0].contents_source.is_none());
    assert!(failed.problems.iter().any(|problem| matches!(
        problem,
        PrSectionProblem::Failed {
            section: PrSection::Files,
            ..
        }
    )));
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn deleted_files_load_only_old_version_and_pure_renames_keep_metadata() {
    let f = Fixture::new();
    let mut removed = file("gone.ts", "removed", None);
    removed["additions"] = json!(0);
    removed["patch"] = json!("@@ -1 +0,0 @@\n-old");
    f.state(json!({"files":[removed,{"filename":"new.ts","previous_filename":"old.ts","status":"renamed","additions":0,"deletions":0,"patch":null}],"fileContents":{format!("{}:gone.ts","b".repeat(40)):"old\n"}}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    assert_eq!(detail.files[1].patch.as_deref(), Some(""));
    assert!(detail.files[1].unavailable.is_none());
    let contents = app
        .read_pull_request_file_contents(thread, request(&detail, 0))
        .await
        .unwrap();
    assert_eq!(contents.old_contents, "old\n");
    assert_eq!(contents.new_contents, "");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn unlink_invalidates_running_file_contents_read() {
    let f = Fixture::new();
    f.state(json!({"files":[file("a.ts","modified",None)]}));
    let (app, thread) = f.open().await;
    let detail = app
        .read_pull_request(thread.clone(), f.key())
        .await
        .unwrap();
    let release = f.dir.path().join("release-contents");
    f.state(json!({"waitFor":{"/contents/":release},"fileContents":{format!("{}:a.ts","b".repeat(40)):"old\n",format!("{}:a.ts","a".repeat(40)):"new\n"}}));
    std::fs::remove_file(f.dir.path().join("gh.log")).unwrap();
    let worker = app.clone();
    let worker_thread = thread.clone();
    let input = request(&detail, 0);
    let task = tokio::spawn(async move {
        worker
            .read_pull_request_file_contents(worker_thread, input)
            .await
    });
    f.wait_for("/contents/").await;
    app.unlink_pull_request(thread, f.key()).await.unwrap();
    std::fs::write(release, "go").unwrap();
    assert_eq!(task.await.unwrap().unwrap_err().code, "pr_not_linked");
    app.shutdown().await.unwrap();
}
