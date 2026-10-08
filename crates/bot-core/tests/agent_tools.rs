use bot_core::*;
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct Fixture {
    directory: tempfile::TempDir,
    config: RuntimeConfig,
}
impl Fixture {
    fn new(plans: Value) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let peer = directory.path().join("peer.py");
        std::fs::write(&peer, include_str!("support/agent_tools_peer.py")).unwrap();
        std::fs::set_permissions(&peer, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(directory.path().join("plans.json"), plans.to_string()).unwrap();
        Self {
            config: RuntimeConfig {
                data_dir: directory.path().join("data"),
                codex_binary: peer,
                gh_binary: directory.path().join("no-gh"),
                network_timeout: Duration::from_secs(2),
                shell: None,
            },
            directory,
        }
    }
    fn rows(&self, file: &str) -> Vec<Value> {
        std::fs::read_to_string(self.directory.path().join(file))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    async fn thread(&self, app: &App, name: &str) -> ThreadSnapshot {
        let repository = self.directory.path().join(name);
        std::fs::create_dir(&repository).unwrap();
        let status = Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .arg(&repository)
            .status()
            .unwrap();
        assert!(status.success());
        let workspace = app.open_workspace(repository).await.unwrap();
        app.create_thread(workspace.id, NewCheckout::Local)
            .await
            .unwrap()
    }
    async fn result(&self, count: usize) -> Vec<Value> {
        for _ in 0..500 {
            let rows = self.rows("tool-results.jsonl");
            if rows.len() >= count {
                return rows;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "Tool result {count} never arrived. Calls {:?}",
            self.rows("calls.jsonl")
        )
    }
    fn kill(&self) {
        let pid: i32 = std::fs::read_to_string(self.directory.path().join("pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    }
    fn membership(&self, thread: &ThreadId) -> Value {
        let db = rusqlite::Connection::open(self.config.data_dir.join("z1.sqlite")).unwrap();
        let data: String = db
            .query_row(
                "SELECT data FROM thread_pull_requests WHERE thread_id=?1",
                [thread.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str(&data).unwrap()
    }
}

async fn wait(
    app: &App,
    thread: &ThreadId,
    predicate: impl Fn(&ThreadSnapshot) -> bool,
) -> ThreadSnapshot {
    for _ in 0..500 {
        let snapshot = app.thread(thread.clone()).await.unwrap();
        if predicate(&snapshot) {
            return snapshot;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("Thread did not reach required state")
}

async fn submit(app: &App, thread: &ThreadId, prompt: &str) {
    app.submit(
        thread.clone(),
        uuid::Uuid::new_v4().to_string(),
        prompt.into(),
        vec![],
    )
    .await
    .unwrap();
}

fn dynamic_value(row: &Value) -> Value {
    let result = &row["response"]["result"];
    assert_eq!(result["success"], true, "{row}");
    serde_json::from_str(result["contentItems"][0]["text"].as_str().unwrap()).unwrap()
}

async fn socket_request(path: &Path, credential: &str, operation: Value) -> Value {
    let stream = tokio::net::UnixStream::connect(path).await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut bytes =
        serde_json::to_vec(&json!({"credential":credential,"operation":operation})).unwrap();
    bytes.push(b'\n');
    write.write_all(&bytes).await.unwrap();
    let mut line = String::new();
    BufReader::new(read).read_line(&mut line).await.unwrap();
    serde_json::from_str(&line).unwrap()
}

#[tokio::test]
async fn dynamic_pr_links_are_durable_idempotent_and_preserve_existing_source() {
    let f = Fixture::new(json!({
        "link":{"steps":[
            {"name":"link_pull_request","arguments":{"url":"https://github.com/Owner/Repo/pull/42"}},
            {"name":"link_pull_request","arguments":{"repository":"owner/repo","number":42}},
            {"name":"list_thread_pull_requests"}
        ]},
        "unlink":{"steps":[
            {"name":"unlink_pull_request","arguments":{"url":"https://github.com/owner/repo/pull/42"}},
            {"name":"unlink_pull_request","arguments":{"repository":"owner/repo","number":42}}
        ]}
    }));
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = f.thread(&app, "repository").await;
    let key = PullRequestKey::new("owner", "repo", 42).unwrap();
    let original = app
        .link_pull_request(thread.id.clone(), key.url())
        .await
        .unwrap();
    let original_membership = f.membership(&thread.id);
    submit(&app, &thread.id, "link").await;
    let rows = f.result(3).await;
    assert_eq!(dynamic_value(&rows[0])["alreadyLinked"], true);
    assert_eq!(dynamic_value(&rows[1])["alreadyLinked"], true);
    assert_eq!(dynamic_value(&rows[2])["pullRequests"][0]["url"], key.url());
    assert_eq!(
        dynamic_value(&rows[2])["pullRequests"][0]["state"],
        "unknown"
    );
    let linked = app
        .list_thread_pull_requests(thread.id.clone(), false)
        .await
        .unwrap();
    assert_eq!(original_membership, f.membership(&thread.id));
    assert_eq!(original.links[0].linked_at, linked.links[0].linked_at);
    assert_eq!(linked.links[0].source, PrLinkSource::Manual);
    let start = f
        .rows("calls.jsonl")
        .into_iter()
        .find(|row| row["method"] == "thread/start")
        .unwrap();
    assert_eq!(start["params"]["dynamicTools"][0]["type"], "function");
    assert_eq!(start["params"]["dynamicTools"].as_array().unwrap().len(), 3);
    let turn_start = f
        .rows("calls.jsonl")
        .into_iter()
        .find(|row| row["method"] == "turn/start")
        .unwrap();
    assert_eq!(
        turn_start["params"]["additionalContext"]["botcode_tools"]["kind"],
        "application"
    );
    assert!(
        !turn_start["params"]["additionalContext"]["botcode_tools"]["value"]
            .as_str()
            .unwrap()
            .contains("preview")
    );
    let snapshot = wait(&app, &thread.id, |thread| {
        thread.turns.last().is_some_and(|turn| {
            matches!(turn.execution, Execution::Completed)
                && matches!(
                    turn.checkpoint,
                    TurnCheckpoint::Complete { .. } | TurnCheckpoint::Unavailable { .. }
                )
        })
    })
    .await;
    assert!(snapshot.approvals.is_empty());
    app.shutdown().await.unwrap();
    let reopened = App::open(f.config.clone()).await.unwrap();
    let saved = reopened
        .list_thread_pull_requests(thread.id.clone(), false)
        .await
        .unwrap();
    assert_eq!(saved.links[0].source, PrLinkSource::Manual);
    assert_eq!(saved.links[0].linked_at, original.links[0].linked_at);
    submit(&reopened, &thread.id, "unlink").await;
    let rows = f.result(5).await;
    assert_eq!(dynamic_value(&rows[3])["wasLinked"], true);
    assert_eq!(dynamic_value(&rows[4])["wasLinked"], false);
    let summary = reopened
        .list_thread_pull_requests(thread.id.clone(), false)
        .await
        .unwrap();
    assert!(summary.links.is_empty());
    assert_eq!(
        f.membership(&thread.id)["generation"].as_u64().unwrap(),
        original_membership["generation"].as_u64().unwrap() + 1
    );
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
async fn dynamic_calls_reject_stale_unknown_and_malformed_requests_without_mutation() {
    let f = Fixture::new(json!({"refusals":{"steps":[
        {"name":"link_pull_request","arguments":{"url":"https://github.com/owner/repo/pull/1"},"override":{"turnId":"old-turn"}},
        {"name":"link_pull_request","arguments":{"url":"https://github.com/owner/repo/pull/2"},"override":{"threadId":"other-thread"}},
        {"name":"link_pull_request","arguments":{"url":"https://gitlab.com/owner/repo/pull/3"}},
        {"name":"link_pull_request","arguments":{"url":"https://github.com/owner/repo/pull/4","threadId":"other"}},
        {"name":"unavailable_tool"},
        {"name":"link_pull_request","arguments":{"url":"https://github.com/owner/repo/pull/5"},"override":{"namespace":"foreign"}},
        {"name":"link_pull_request","omit":["arguments"]},
        {"name":"link_pull_request","arguments":{"url":"https://github.com/owner/repo/pull/6"},"omit":["callId"]}
    ]}}));
    let app = App::open(f.config.clone()).await.unwrap();
    let thread = f.thread(&app, "repository").await;
    submit(&app, &thread.id, "refusals").await;
    let rows = f.result(8).await;
    for row in &rows[..5] {
        assert_eq!(row["response"]["result"]["success"], false, "{row}");
    }
    for row in &rows[5..] {
        assert_eq!(row["response"]["error"]["code"], -32602, "{row}");
    }
    assert!(
        app.list_thread_pull_requests(thread.id.clone(), false)
            .await
            .unwrap()
            .links
            .is_empty()
    );
    assert!(
        app.thread(thread.id.clone())
            .await
            .unwrap()
            .approvals
            .is_empty()
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn stdio_scopes_isolate_threads_expire_on_restart_and_receive_resume_configuration() {
    let f = Fixture::new(json!({
        "mcp":{"transport":"mcp","steps":[{"name":"link_pull_request","arguments":{"url":"https://github.com/owner/repo/pull/21"}}]},
        "idle":{"steps":[],"finish":false},
        "done":{"steps":[]}
    }));
    let agent_tools = AgentTools {
        registration: Registration::Stdio {
            executable: PathBuf::from("/native-app"),
        },
        backend: None,
    };
    let app = App::open_with_tools(f.config.clone(), agent_tools)
        .await
        .unwrap();
    let first = f.thread(&app, "first").await;
    let second = f.thread(&app, "second").await;
    submit(&app, &first.id, "mcp").await;
    let rows = f.result(1).await;
    assert_eq!(rows[0]["response"]["Ok"]["isError"], false, "{rows:?}");
    wait(&app, &first.id, |thread| {
        thread.turns.last().is_some_and(|turn| {
            matches!(turn.execution, Execution::Completed)
                && matches!(
                    turn.checkpoint,
                    TurnCheckpoint::Complete { .. } | TurnCheckpoint::Unavailable { .. }
                )
        })
    })
    .await;
    assert_eq!(
        app.list_thread_pull_requests(first.id.clone(), false)
            .await
            .unwrap()
            .links
            .len(),
        1
    );
    assert!(
        app.list_thread_pull_requests(second.id.clone(), false)
            .await
            .unwrap()
            .links
            .is_empty()
    );
    submit(&app, &second.id, "idle").await;
    let second_live = wait(&app, &second.id, |thread| {
        matches!(thread.session, SessionState::Running)
    })
    .await;
    let calls = f.rows("calls.jsonl");
    let starts: Vec<_> = calls
        .iter()
        .filter(|row| row["method"] == "thread/start")
        .collect();
    assert_eq!(starts.len(), 2);
    let config_a = &starts[0]["params"]["config"]["mcp_servers.botcode"];
    let config_b = &starts[1]["params"]["config"]["mcp_servers.botcode"];
    assert_ne!(
        config_a["env"]["BOT_CODE_AGENT_TOKEN"],
        config_b["env"]["BOT_CODE_AGENT_TOKEN"]
    );
    assert!(
        starts
            .iter()
            .all(|row| row["params"].get("dynamicTools").is_none())
    );
    assert_eq!(
        config_b["tools"]["link_pull_request"]["approval_mode"],
        "approve"
    );
    let socket = PathBuf::from(config_a["env"]["BOT_CODE_AGENT_SOCKET"].as_str().unwrap());
    let old_token = config_a["env"]["BOT_CODE_AGENT_TOKEN"].as_str().unwrap();
    let result = socket_request(&socket, old_token, json!({"operation":"call","caller":{"native_thread":second_live.native_thread_id,"native_turn":second_live.turns.last().unwrap().native_turn_id,"call_id":"wrong-scope"},"call":{"name":"link_pull_request","arguments":{"repository":"owner/repo","number":22}}})).await;
    assert_eq!(result["Ok"]["isError"], true);
    assert!(
        app.list_thread_pull_requests(second.id.clone(), false)
            .await
            .unwrap()
            .links
            .is_empty()
    );
    f.kill();
    wait(&app, &second.id, |thread| {
        matches!(thread.session, SessionState::Unavailable { .. })
    })
    .await;
    let revoked = socket_request(&socket, old_token, json!({"operation":"list"})).await;
    assert_eq!(revoked["Err"]["code"], "tool_expired");
    submit(&app, &first.id, "done").await;
    wait(&app, &first.id, |thread| {
        thread
            .turns
            .last()
            .is_some_and(|turn| matches!(turn.execution, Execution::Completed))
    })
    .await;
    let calls = f.rows("calls.jsonl");
    let resumed = calls
        .iter()
        .rev()
        .find(|row| row["method"] == "thread/resume")
        .unwrap();
    let new_token =
        &resumed["params"]["config"]["mcp_servers.botcode"]["env"]["BOT_CODE_AGENT_TOKEN"];
    assert_ne!(new_token.as_str().unwrap(), old_token);
    app.shutdown().await.unwrap();
    assert!(!socket.exists());
}

struct PendingBackend {
    started: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
}
impl ToolBackend for PendingBackend {
    fn specs(&self) -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "preview_wait_for".into(),
            description: "Wait for preview content.".into(),
            input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
            annotations: ToolAnnotations {
                read_only_hint: true,
                destructive_hint: false,
                idempotent_hint: true,
                open_world_hint: false,
            },
        }]
    }
    fn execute(&self, _context: ToolContext, _call: ToolCall) -> ToolFuture {
        struct Guard(Arc<AtomicUsize>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let started = self.started.clone();
        let dropped = self.dropped.clone();
        Box::pin(async move {
            let _guard = Guard(dropped);
            started.fetch_add(1, Ordering::SeqCst);
            std::future::pending().await
        })
    }
}

#[tokio::test]
async fn provider_loss_cancels_pending_preview_and_never_replays_the_call() {
    let f = Fixture::new(
        json!({"wait":{"steps":[{"name":"preview_wait_for","requestId":"reused-route"}],"staleCompletion":true},"next":{"steps":[{"name":"link_pull_request","arguments":{"repository":"owner/repo","number":31},"requestId":"reused-route"}]}}),
    );
    let started = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let app = App::open_with_tools(
        f.config.clone(),
        AgentTools {
            registration: Registration::Dynamic,
            backend: Some(Arc::new(PendingBackend {
                started: started.clone(),
                dropped: dropped.clone(),
            })),
        },
    )
    .await
    .unwrap();
    let thread = f.thread(&app, "repository").await;
    submit(&app, &thread.id, "wait").await;
    for _ in 0..500 {
        if started.load(Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(started.load(Ordering::SeqCst), 1);
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    assert!(matches!(
        app.thread(thread.id.clone()).await.unwrap().session,
        SessionState::Running
    ));
    f.kill();
    wait(&app, &thread.id, |thread| {
        matches!(thread.session, SessionState::Unavailable { .. })
    })
    .await;
    for _ in 0..100 {
        if dropped.load(Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    submit(&app, &thread.id, "next").await;
    let rows = f.result(1).await;
    assert_eq!(rows[0]["response"]["id"], "reused-route");
    assert_eq!(dynamic_value(&rows[0])["alreadyLinked"], false);
    assert_eq!(started.load(Ordering::SeqCst), 1);
    assert_eq!(
        app.list_thread_pull_requests(thread.id.clone(), false)
            .await
            .unwrap()
            .links
            .len(),
        1
    );
    app.shutdown().await.unwrap();
}
