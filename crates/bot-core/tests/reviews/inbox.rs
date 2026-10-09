use super::*;
fn inbox_input(state: &str, query: &str, limit: usize) -> PrInboxInput {
    serde_json::from_value(json!({"workspaceId":null,"state":state,"query":query,"limit":limit}))
        .unwrap()
}
fn remote(f: &Fixture, url: &str) {
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&f.root)
            .args(["config", "remote.origin.url", url])
            .status()
            .unwrap()
            .success()
    );
}
#[tokio::test]
async fn inbox_browses_unlinked_requests_without_creating_conversations() {
    let f = Fixture::new();
    remote(&f, "https://github.com/fixture/project.git");
    f.state(json!({"matchNumber":true}));
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.root.clone()).await.unwrap();
    let access = PrAccess::Workspace {
        workspace_id: workspace.id.clone(),
    };
    let key = PullRequestKey::new("fixture", "project", 42).unwrap();
    assert!(
        app.read_pull_request(access.clone(), key.clone())
            .await
            .is_ok()
    );
    let inbox = app
        .list_pull_requests(inbox_input("open", "", 99))
        .await
        .unwrap();
    assert_eq!(inbox.entries.len(), 3);
    assert!(
        inbox
            .entries
            .iter()
            .any(|entry| entry.number == 42 && entry.viewer_review_requested)
    );
    assert!(inbox.errors.is_empty());
    let detail = app
        .read_pull_request(access.clone(), key.clone())
        .await
        .unwrap();
    assert_eq!(detail.observation.key, key);
    assert!(
        app.list_thread_summaries(workspace.id.clone())
            .await
            .unwrap()
            .is_empty()
    );
    let filtered = app
        .list_pull_requests(inbox_input("open", "label:bug draft:false", 99))
        .await
        .unwrap();
    assert_eq!(filtered.entries.len(), 1);
    assert_eq!(filtered.entries[0].number, 41);
    let mine = app
        .list_pull_requests(inbox_input("open", "author:@me", 99))
        .await
        .unwrap();
    assert_eq!(mine.entries.len(), 1);
    assert_eq!(mine.entries[0].number, 41);
    assert!(
        f.log()
            .iter()
            .filter_map(|entry| entry["args"].as_array())
            .flatten()
            .filter_map(Value::as_str)
            .any(|argument| argument.contains("author:fixture-viewer"))
    );
    let changed = app
        .change_pull_request(
            access.clone(),
            PrReviewChange {
                request_id: uuid::Uuid::new_v4().to_string(),
                target: detail.observation,
                action: PrReviewAction::EditTitle {
                    title: "Inbox title edited".into(),
                },
            },
        )
        .await
        .unwrap();
    assert!(
        matches!(changed, PrChangeResult::Applied { .. }),
        "{changed:?}"
    );
    assert!(
        app.list_thread_summaries(workspace.id.clone())
            .await
            .unwrap()
            .is_empty()
    );
    remote(&f, "https://github.com/fixture/another.git");
    let error = app.read_pull_request(access, key).await.unwrap_err();
    assert_eq!(error.code, "pr_repository");
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn inbox_keeps_priority_rows_and_reports_bounded_more() {
    let f = Fixture::new();
    remote(&f, "https://github.com/fixture/project.git");
    let mut rows:Vec<Value>=(1..=105).map(|number|json!({"number":number,"title":format!("Other change {number}"),"author":{"login":"other","avatarUrl":null}})).collect();
    rows.push(json!({"number":200,"title":"Authored past feed","author":{"login":"fixture-viewer","avatarUrl":null}}));
    rows.push(json!({"number":201,"title":"Requested past feed","author":{"login":"other","avatarUrl":null},"reviewRequests":[{"login":"fixture-viewer"}]}));
    f.state(json!({"inboxRows":rows}));
    let app = App::open(f.config.clone()).await.unwrap();
    let w = app.open_workspace(f.root.clone()).await.unwrap();
    let inbox = app
        .list_pull_requests(inbox_input("open", "", 99))
        .await
        .unwrap();
    assert!(inbox.limited);
    assert!(inbox.entries.iter().any(|entry| entry.number == 200));
    assert!(
        inbox
            .entries
            .iter()
            .any(|entry| entry.number == 201 && entry.viewer_review_requested)
    );
    let mut continuation = inbox_input("open", "", 99);
    continuation.cursors = inbox.cursors;
    continuation.continuation = true;
    let more = app.list_pull_requests(continuation).await.unwrap();
    assert!(!more.limited);
    assert_eq!(more.entries.len(), 8);
    app.remove_workspace(w.id.clone()).await.unwrap();
    let error = app
        .read_pull_request(PrAccess::Workspace { workspace_id: w.id }, f.key())
        .await
        .unwrap_err();
    assert_eq!(error.code, "missing_workspace");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn inbox_preserves_priority_results_when_general_feed_fails_and_refuses_missing_scope() {
    let f = Fixture::new();
    remote(&f, "https://github.com/fixture/project.git");
    let app = App::open(f.config.clone()).await.unwrap();
    app.open_workspace(f.root.clone()).await.unwrap();
    f.state(json!({"inboxFailPartitions":["is:pr is:open  sort:updated-desc"]}));
    let result = app
        .list_pull_requests(inbox_input("open", "", 99))
        .await
        .unwrap();
    assert_eq!(result.entries.len(), 2);
    assert_eq!(result.errors.len(), 1);
    let mut input = inbox_input("open", "", 99);
    input.workspace_id = Some(WorkspaceId::default());
    assert_eq!(
        app.list_pull_requests(input).await.unwrap_err().code,
        "workspace_missing"
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn global_detail_refuses_remote_change_during_a_read_and_thread_access_stays_linked() {
    let f = Fixture::new();
    remote(&f, "https://github.com/fixture/project.git");
    let app = App::open(f.config.clone()).await.unwrap();
    let w = app.open_workspace(f.root.clone()).await.unwrap();
    let thread = app
        .create_thread(w.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    assert_eq!(
        app.read_pull_request(thread.id.clone(), f.key())
            .await
            .unwrap_err()
            .code,
        "pr_not_linked"
    );
    let release = f.dir.path().join("release");
    f.state(json!({"waitFor":{"BotReviewMeta":release}}));
    let reader = app.clone();
    let access = PrAccess::Workspace {
        workspace_id: w.id.clone(),
    };
    let key = f.key();
    let pending = tokio::spawn(async move { reader.read_pull_request(access, key).await });
    for _ in 0..200 {
        if f.log().iter().any(|entry| {
            entry["args"].as_array().is_some_and(|args| {
                args.iter().any(|arg| {
                    arg.as_str()
                        .is_some_and(|arg| arg.contains("BotReviewMeta"))
                })
            })
        }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    remote(&f, "https://github.com/fixture/other.git");
    std::fs::write(release, "").unwrap();
    assert_eq!(pending.await.unwrap().unwrap_err().code, "pr_repository");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn global_close_is_confirmed_and_a_refreshed_open_inbox_drops_the_row() {
    let f = Fixture::new();
    remote(&f, "https://github.com/fixture/project.git");
    f.state(json!({"matchNumber":true,"perNumber":{"42":{}}}));
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
    let result = app
        .change_pull_request(
            access,
            PrReviewChange {
                request_id: uuid::Uuid::new_v4().to_string(),
                target: detail.observation,
                action: PrReviewAction::SetClosed { closed: true },
            },
        )
        .await
        .unwrap();
    assert!(
        matches!(result, PrChangeResult::Confirmed { .. }),
        "{result:?}"
    );
    let inbox = app
        .list_pull_requests(inbox_input("open", "", 99))
        .await
        .unwrap();
    assert!(inbox.entries.iter().all(|entry| entry.number != 42));
    app.shutdown().await.unwrap();
}
