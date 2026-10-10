use super::*;
use crate::{ToolAnnotations, ToolBackend, ToolCall, ToolFuture, ToolSpec};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingBackend(Arc<AtomicUsize>);
impl ToolBackend for CountingBackend {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "preview_click".into(),
            description: "Click a preview element.".into(),
            input_schema: json!({"type":"object"}),
            annotations: ToolAnnotations {
                read_only_hint: false,
                destructive_hint: true,
                idempotent_hint: false,
                open_world_hint: true,
            },
        }]
    }
    fn execute(&self, _: ToolContext, _: ToolCall) -> ToolFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(ToolResult::text("clicked")) })
    }
}

#[tokio::test]
async fn disconnected_queued_caller_cannot_link_a_pr_or_construct_a_browser_action() {
    let directory = tempfile::tempdir().unwrap();
    let config = RuntimeConfig {
        data_dir: directory.path().into(),
        codex_binary: "/no/codex".into(),
        gh_binary: "/no/gh".into(),
        network_timeout: Duration::from_secs(1),
        shell: None,
    };
    let mut store = Store::open(directory.path()).unwrap();
    let workspace = Workspace {
        id: WorkspaceId::default(),
        root: directory.path().into(),
        label: "fixture".into(),
        kind: WorkspaceKind::Repository,
    };
    store.workspace(&workspace).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let tools = ToolWork::new(
        &config,
        AgentTools {
            registration: Registration::Dynamic,
            backend: Some(Arc::new(CountingBackend(calls.clone()))),
        },
        &store,
    )
    .unwrap();
    let mut owner = Owner {
        tools,
        project_search: crate::project_search::ProjectSearch::default(),
        closing: false,
        checkpoint_work: checkpoints::CheckpointWork::new(),
        naming: naming::Naming::default(),
        writing: writing::Writing::default(),
        prs: PrWork::load(&mut store).unwrap(),
        review_work: ReviewWork::new(),
        git_jobs: JoinSet::new(),
        attachments: Attachments::new(directory.path()),
        delete_jobs: JoinSet::new(),
        deleting: HashSet::new(),
        terminals: Terminals::new(None),
        config,
        store,
        workspaces: HashMap::from([(workspace.id.clone(), workspace.clone())]),
        threads: HashMap::new(),
        auto_settle: settings::auto_settle(&directory.path().join("settings.json")),
        source_control_settings: settings::source_control(&directory.path().join("settings.json")),
        source_control: source_control::RefreshWork::default(),
        leases: HashMap::new(),
        held: HashMap::new(),
        callbacks: HashMap::new(),
        collaboration_modes: vec![],
        collaboration_waiters: vec![],
        provider: None,
        epoch: 1,
        launching: false,
        restarts: restarts::Restarts::default(),
        log: RotatingLog::open(directory.path().join("log")),
        pending: vec![],
        models: None,
        model_waiters: vec![],
        listing_models: false,
        limits: watch::channel(None).0,
        limit_waiters: vec![],
        reading_limits: false,
        dirty: HashSet::new(),
        changes: broadcast::channel(1).0,
        provider_events: mpsc::channel(1).0,
        done: mpsc::channel(1).0,
    };
    let thread = owner
        .new_thread(
            workspace.id,
            Checkout::Local,
            SessionSettings::default(),
            None,
        )
        .unwrap();
    for call in [
        ToolCall {
            name: "link_pull_request".into(),
            arguments: json!({"repository":"owner/repo","number":42}),
        },
        ToolCall {
            name: "preview_click".into(),
            arguments: json!({}),
        },
    ] {
        let (reply, disconnected) = oneshot::channel();
        drop(disconnected);
        owner
            .dispatch_tool(
                ToolContext {
                    thread_id: thread.id.clone(),
                    turn_id: TurnId::default(),
                    session_epoch: 1,
                    call_id: call.name.clone(),
                },
                Caller {
                    native_thread: "native-thread".into(),
                    native_turn: "native-turn".into(),
                    call_id: call.name.clone(),
                },
                call,
                ToolReply::Mcp {
                    credential: "revoked".into(),
                    reply,
                },
            )
            .await
            .unwrap();
    }
    assert!(owner.pr_summary(&thread.id).links.is_empty());
    assert!(owner.store.pr_memberships().unwrap().is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(owner.tools.jobs.is_empty());
}
