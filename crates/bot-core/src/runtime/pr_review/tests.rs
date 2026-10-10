use super::*;
use crate::pull_requests::CachedPr;

#[tokio::test]
async fn cleanup_failure_survives_receipt_storage_failure_and_later_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let input = PrReviewChange {
        request_id: uuid::Uuid::new_v4().to_string(),
        target: PrObservation {
            key: PullRequestKey::new("fixture", "project", 41).unwrap(),
            node_id: "PR_fixture_41".into(),
            head_oid: "a".repeat(40),
            viewer: "fixture-viewer".into(),
        },
        action: PrReviewAction::Reply {
            thread_id: "THREAD_0".into(),
            body: "Keep this ambiguous reply".into(),
        },
    };
    store
        .save_pull_request(&CachedPr::unknown(input.target.key.clone()), None)
        .unwrap();
    store.start_pr_operation(&input).unwrap();
    let db = rusqlite::Connection::open(dir.path().join("z1.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER deny_completion BEFORE UPDATE ON pull_request_operations BEGIN SELECT RAISE(FAIL, 'fixture completion storage failure'); END;").unwrap();
    let (provider_events, signals) = mpsc::channel(1);
    let (done, completions) = mpsc::channel(1);
    let mut owner = Owner {
        project_clones: Default::default(),
        tools: crate::runtime::tools::ToolWork::new(
            &RuntimeConfig {
                data_dir: dir.path().into(),
                gh_binary: "/no/gh".into(),
                codex_binary: "/no/codex".into(),
                network_timeout: Duration::from_secs(1),
                shell: None,
            },
            crate::AgentTools::default(),
            &store,
        )
        .unwrap(),
        project_search: crate::project_search::ProjectSearch::default(),
        closing: false,
        checkpoint_work: checkpoints::CheckpointWork::new(),
        naming: naming::Naming::default(),
        writing: writing::Writing::default(),
        prs: PrWork::load(&mut store).unwrap(),
        review_work: ReviewWork::new(),
        git_jobs: JoinSet::new(),
        attachments: Attachments::new(dir.path()),
        delete_jobs: JoinSet::new(),
        deleting: HashSet::new(),
        terminals: Terminals::new(None),
        config: RuntimeConfig {
            data_dir: dir.path().into(),
            gh_binary: "/no/gh".into(),
            codex_binary: "/no/codex".into(),
            network_timeout: Duration::from_secs(1),
            shell: None,
        },
        store,
        workspaces: HashMap::new(),
        threads: HashMap::new(),
        auto_settle: settings::auto_settle(&dir.path().join("settings.json")),
        source_control_settings: settings::source_control(&dir.path().join("settings.json")),
        source_control: source_control::RefreshWork::default(),
        leases: HashMap::new(),
        held: HashMap::new(),
        callbacks: HashMap::new(),
        collaboration_modes: vec![],
        collaboration_waiters: vec![],
        provider: None,
        epoch: 0,
        launching: false,
        restarts: restarts::Restarts::default(),
        log: RotatingLog::open(dir.path().join("logs").join("codex.log")),
        pending: vec![],
        models: None,
        model_waiters: vec![],
        listing_models: false,
        limits: tokio::sync::watch::channel(None).0,
        limit_waiters: vec![],
        reading_limits: false,
        dirty: HashSet::new(),
        changes: broadcast::channel(1).0,
        provider_events,
        done,
    };
    let original = AppError::new(
        "process_cleanup",
        "Fixture process group was not confirmed reaped.",
    );
    let (reply, response) = oneshot::channel();
    let completion = owner.finish_review(Ok(ReviewCompletion::Change(
        input.clone(),
        Err(original.clone()),
        reply,
    )));
    let caller_error = response.await.unwrap().unwrap_err();
    assert_eq!(caller_error.code, "process_cleanup");
    assert!(caller_error.message.contains(&original.message));
    assert!(
        caller_error
            .message
            .contains("fixture completion storage failure")
    );
    assert_eq!(completion.unwrap_err(), caller_error);
    assert!(matches!(
        owner.store.pr_operation(&input).unwrap(),
        Some(PrChangeResult::Uncertain { .. })
    ));
    assert_eq!(
        db.query_row(
            "SELECT state FROM pull_request_operations WHERE request_id=?1",
            [&input.request_id],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        "started"
    );
    let mut later_input = input.clone();
    later_input.request_id = uuid::Uuid::new_v4().to_string();
    owner.store.start_pr_operation(&later_input).unwrap();
    let (reply, later_response) = oneshot::channel();
    let later_command = later_input.clone();
    owner.review_work.active.spawn(async move {
        ReviewCompletion::Change(
            later_command,
            Ok(PrChangeResult::Applied {
                host_id: "COMMENT_saved".into(),
            }),
            reply,
        )
    });
    assert_eq!(owner.stop_reviews().await.unwrap_err(), original);
    assert_eq!(later_response.await.unwrap().unwrap_err().code, "storage");
    assert!(matches!(
        owner.store.pr_operation(&later_input).unwrap(),
        Some(PrChangeResult::Uncertain { .. })
    ));
    db.execute_batch("DROP TRIGGER deny_completion;").unwrap();
    let (commands, requests) = mpsc::channel(1);
    let (reply, shutdown) = oneshot::channel();
    commands.send(Command::Shutdown(reply)).await.unwrap();
    owner.run(requests, signals, completions).await;
    assert_eq!(shutdown.await.unwrap().unwrap_err().code, "process_cleanup");
    let store = Store::open(dir.path()).unwrap();
    assert!(matches!(
        store.pr_operation(&input).unwrap(),
        Some(PrChangeResult::Uncertain { .. })
    ));
    let data: String = db
        .query_row(
            "SELECT data FROM pull_request_operations WHERE request_id=?1",
            [&input.request_id],
            |row| row.get(0),
        )
        .unwrap();
    let receipt: Value = serde_json::from_str(&data).unwrap();
    assert_eq!(receipt["input"], serde_json::to_value(input).unwrap());
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM pull_request_operations WHERE state='uncertain'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    store.close().unwrap();
}

#[tokio::test]
async fn late_lifecycle_completion_preserves_supersession_and_cleanup_latch() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let input = PrReviewChange {
        request_id: "late-update".into(),
        target: PrObservation {
            key: PullRequestKey::new("fixture", "project", 41).unwrap(),
            node_id: "PR_fixture_41".into(),
            head_oid: "a".repeat(40),
            viewer: "fixture-viewer".into(),
        },
        action: PrReviewAction::UpdateBranch {
            method: BranchUpdateMethod::Merge,
        },
    };
    store
        .save_pull_request(&CachedPr::unknown(input.target.key.clone()), None)
        .unwrap();
    store.start_pr_operation(&input).unwrap();
    let superseded = PrChangeResult::Superseded {
        evidence: PrSupersession::PullRequestMerged {
            key: input.target.key.clone(),
            node_id: input.target.node_id.clone(),
            observed_head_oid: "d".repeat(40),
        },
        message: "Unknown original outcome".into(),
    };
    store.finish_pr_operation(&input, &superseded).unwrap();
    let (provider_events, _signals) = mpsc::channel(1);
    let (done, _completions) = mpsc::channel(1);
    let mut owner = Owner {
        project_clones: Default::default(),
        tools: crate::runtime::tools::ToolWork::new(
            &RuntimeConfig {
                data_dir: dir.path().into(),
                gh_binary: "/no/gh".into(),
                codex_binary: "/no/codex".into(),
                network_timeout: Duration::from_secs(1),
                shell: None,
            },
            crate::AgentTools::default(),
            &store,
        )
        .unwrap(),
        project_search: crate::project_search::ProjectSearch::default(),
        closing: false,
        checkpoint_work: checkpoints::CheckpointWork::new(),
        naming: naming::Naming::default(),
        writing: writing::Writing::default(),
        prs: PrWork::load(&mut store).unwrap(),
        review_work: ReviewWork::new(),
        git_jobs: JoinSet::new(),
        attachments: Attachments::new(dir.path()),
        delete_jobs: JoinSet::new(),
        deleting: HashSet::new(),
        terminals: Terminals::new(None),
        config: RuntimeConfig {
            data_dir: dir.path().into(),
            gh_binary: "/no/gh".into(),
            codex_binary: "/no/codex".into(),
            network_timeout: Duration::from_secs(1),
            shell: None,
        },
        store,
        workspaces: HashMap::new(),
        threads: HashMap::new(),
        auto_settle: settings::auto_settle(&dir.path().join("settings.json")),
        source_control_settings: settings::source_control(&dir.path().join("settings.json")),
        source_control: source_control::RefreshWork::default(),
        leases: HashMap::new(),
        held: HashMap::new(),
        callbacks: HashMap::new(),
        collaboration_modes: vec![],
        collaboration_waiters: vec![],
        provider: None,
        epoch: 0,
        launching: false,
        restarts: restarts::Restarts::default(),
        log: RotatingLog::open(dir.path().join("logs").join("codex.log")),
        pending: vec![],
        models: None,
        model_waiters: vec![],
        listing_models: false,
        limits: tokio::sync::watch::channel(None).0,
        limit_waiters: vec![],
        reading_limits: false,
        dirty: HashSet::new(),
        changes: broadcast::channel(1).0,
        provider_events,
        done,
    };

    for result in [
        Ok(PrChangeResult::Accepted {
            progress: PrProgress::AwaitingConfirmation,
        }),
        Ok(PrChangeResult::Uncertain {
            message: "Late timeout".into(),
        }),
        Err(AppError::new(
            "process_cleanup",
            "Late child cleanup failure",
        )),
    ] {
        let cleanup = result.is_err();
        let (reply, response) = oneshot::channel();
        let completion = owner.finish_review(Ok(ReviewCompletion::Lifecycle(
            input.clone(),
            result,
            None,
            reply,
        )));
        if cleanup {
            assert_eq!(completion.unwrap_err().code, "process_cleanup");
            assert_eq!(response.await.unwrap().unwrap_err().code, "process_cleanup");
        } else {
            completion.unwrap();
            assert_eq!(response.await.unwrap().unwrap(), superseded);
        }
        assert_eq!(
            owner.store.pr_operation(&input).unwrap(),
            Some(superseded.clone())
        );
        assert!(owner.review_work.pending.is_empty());
    }
    assert_eq!(
        owner.stop_reviews().await.unwrap_err().code,
        "process_cleanup"
    );
    let mut conflict = input.clone();
    conflict.target.viewer = "other".into();
    assert_eq!(
        owner
            .store
            .finish_pr_operation(&conflict, &superseded)
            .unwrap_err()
            .code,
        "pr_request_conflict"
    );
    assert_eq!(owner.store.pr_operation(&input).unwrap(), Some(superseded));
}
