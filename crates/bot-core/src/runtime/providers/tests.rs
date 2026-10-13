use super::*;

fn sandbox() -> EnvKey {
    EnvKey::Sandbox("0123456789ab".parse().unwrap())
}

#[test]
fn epochs_from_different_slots_never_collide() {
    let now = Instant::now();
    let mut providers = Providers::default();
    let mac = providers.begin_launch(&EnvKey::Mac, now).unwrap().epoch;
    let first = providers.begin_launch(&sandbox(), now).unwrap().epoch;
    providers.lose(&sandbox(), now, false);
    let second = providers.begin_launch(&sandbox(), now).unwrap().epoch;
    assert_eq!([mac, first, second], [1, 2, 3]);
    assert_eq!(providers.key(mac), Some(&EnvKey::Mac));
    assert_eq!(providers.key(first), None);
    assert_eq!(providers.key(second), Some(&sandbox()));
    assert!(providers.begin_launch(&EnvKey::Mac, now).is_none());
}

#[test]
fn a_failing_sandbox_slot_does_not_delay_mac_launches() {
    let now = Instant::now();
    let mut providers = Providers::default();
    for _ in 0..4 {
        providers.begin_launch(&sandbox(), now).unwrap();
        providers.lose(&sandbox(), now, false);
    }
    let sandbox_launch = providers.begin_launch(&sandbox(), now).unwrap();
    assert_eq!(
        (sandbox_launch.failures, sandbox_launch.delay),
        (4, Duration::from_secs(4))
    );
    let mac = providers.begin_launch(&EnvKey::Mac, now).unwrap();
    assert_eq!((mac.failures, mac.delay), (0, Duration::ZERO));
    assert_eq!(providers.notice(&EnvKey::Mac, now), None);
}

#[cfg(unix)]
mod owner {
    use super::super::super::*;
    use super::sandbox;
    use crate::codex::{AgentProcess, auth::TokenBroker};
    use crate::runtime::sandboxes::STOPPED_SETTLED;
    use crate::sandbox::{CodexSource, SandboxConfig};
    use crate::workdir::{Limits, Phase, SandboxHandle};
    use std::os::unix::fs::PermissionsExt;

    /// The ChatGPT account the fixture's sandbox agent was signed in with.
    const SANDBOX_ACCOUNT: &str = "acct-1";

    fn git(root: &Path, args: &[&str]) -> String {
        let output = crate::process::command("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    struct Fixture {
        dir: tempfile::TempDir,
        owner: Owner,
        signals: mpsc::Receiver<Signal>,
        completions: mpsc::Receiver<Completion>,
        mac: ThreadId,
        sandboxed: ThreadId,
        mac_epoch: u64,
        sandbox_epoch: u64,
    }
    impl Fixture {
        async fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let worktree = dir.path().join("worktree");
            std::fs::create_dir(&worktree).unwrap();
            git(&worktree, &["init", "-q", "-b", "botcode/fixture"]);
            git(&worktree, &["config", "user.name", "Fixture"]);
            git(
                &worktree,
                &["config", "user.email", "fixture@example.invalid"],
            );
            git(&worktree, &["config", "commit.gpgsign", "false"]);
            std::fs::write(worktree.join("README.md"), "fixture\n").unwrap();
            git(&worktree, &["add", "README.md"]);
            git(&worktree, &["commit", "-qm", "initial"]);
            let head = git(&worktree, &["rev-parse", "HEAD"]);
            for name in ["base", "outgoing"] {
                git(
                    &worktree,
                    &[
                        "update-ref",
                        &format!("refs/botcode/sandbox/0123456789ab/{name}"),
                        head.trim(),
                    ],
                );
            }
            let docker = dir.path().join("docker");
            std::fs::write(
                &docker,
                include_str!("../../../tests/support/docker_fake.py"),
            )
            .unwrap();
            std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::write(
                dir.path().join("state_dir"),
                dir.path().join("docker-state").to_string_lossy().as_bytes(),
            )
            .unwrap();
            let sandboxes = Sandboxes::new(
                SandboxConfig {
                    docker,
                    data_dir: dir.path().into(),
                    codex: CodexSource::Version("0.0.0".parse().unwrap()),
                },
                TokenBroker::new(&dir.path().join("codex-home"), "/no/codex".into()),
                Limits::DEFAULT,
                mpsc::unbounded_channel().0,
                RotatingLog::silent(),
            );
            let config = RuntimeConfig {
                data_dir: dir.path().into(),
                codex_binary: "/no/codex".into(),
                gh_binary: "/no/gh".into(),
                network_timeout: Duration::from_secs(1),
                compaction_timeout: Duration::from_secs(600),
                shell: None,
            };
            let mut store = Store::open(dir.path()).unwrap();
            let workspace = Workspace {
                id: WorkspaceId::default(),
                root: dir.path().into(),
                label: "fixture".into(),
                kind: WorkspaceKind::Repository,
                favicon_path: None,
                project_icon: None,
            };
            store.workspace(&workspace).unwrap();
            let (provider_events, signals) = mpsc::channel(64);
            let (done, completions) = mpsc::channel(64);
            let mut owner = Owner {
                project_clones: Default::default(),
                tools: tools::ToolWork::new(&config, crate::AgentTools::default(), &store).unwrap(),
                project_search: crate::project_search::ProjectSearch::default(),
                closing: false,
                checkpoint_work: checkpoints::CheckpointWork::new(),
                naming: naming::Naming::default(),
                titles: Default::default(),
                writing: writing::Writing::default(),
                prs: PrWork::load(&mut store).unwrap(),
                review_work: ReviewWork::new(),
                git_jobs: tokio::task::JoinSet::new(),
                attachments: Attachments::new(dir.path()),
                delete_jobs: tokio::task::JoinSet::new(),
                deleting: HashSet::new(),
                terminals: Terminals::new(None, None, None, None),
                config,
                store,
                workspaces: HashMap::from([(workspace.id.clone(), workspace.clone())]),
                threads: HashMap::new(),
                auto_settle: settings::auto_settle(&dir.path().join("settings.json")),
                source_control_settings: settings::source_control(
                    &dir.path().join("settings.json"),
                ),
                source_control: source_control::RefreshWork::default(),
                leases: HashMap::new(),
                held: HashMap::new(),
                callbacks: HashMap::new(),
                collaboration_waiters: vec![],
                providers: Default::default(),
                log: RotatingLog::open(dir.path().join("log")),
                provider_pids: Default::default(),
                models: None,
                model_waiters: vec![],
                listing_models: false,
                limits: watch::channel(None).0,
                limit_waiters: vec![],
                reading_limits: false,
                reset_redeemer: Default::default(),
                dirty: HashSet::new(),
                changes: broadcast::channel(64).0,
                provider_events,
                done,
                sandboxes: Arc::new(sandboxes),
            };
            let mac = owner
                .new_thread(
                    workspace.id.clone(),
                    Checkout::Local,
                    SessionSettings::default(),
                    None,
                )
                .unwrap()
                .id;
            let sandboxed = owner
                .new_thread(
                    workspace.id,
                    Checkout::Worktree {
                        path: dir.path().join("worktree"),
                        branch: "botcode/fixture".into(),
                        sandbox: None,
                    }
                    .into_sandbox(Sandbox::Docker {
                        id: "0123456789ab".parse().unwrap(),
                    }),
                    SessionSettings::default(),
                    None,
                )
                .unwrap()
                .id;
            let mut fixture = Self {
                mac_epoch: 0,
                sandbox_epoch: 0,
                dir,
                owner,
                signals,
                completions,
                mac,
                sandboxed,
            };
            fixture.mac_epoch = fixture.go_live(&EnvKey::Mac).await;
            fixture.sandbox_epoch = fixture.go_live(&sandbox()).await;
            fixture.running(&fixture.mac.clone(), "mac");
            fixture.running(&fixture.sandboxed.clone(), "sandbox");
            fixture
        }
        async fn go_live(&mut self, key: &EnvKey) -> u64 {
            let name = match key {
                EnvKey::Mac => "mac",
                EnvKey::Sandbox(_) => "sandbox",
            };
            if let EnvKey::Sandbox(_) = key {
                self.sandbox_handle().ready().await.unwrap();
            }
            let launch = self
                .owner
                .providers
                .begin_launch(key, Instant::now())
                .unwrap();
            let codex = self.peer_for(name, launch.epoch).await;
            let mut session = collaboration::discover(codex).await;
            if let EnvKey::Sandbox(_) = key {
                session.account = Some(SANDBOX_ACCOUNT.into());
            }
            self.owner
                .complete(Completion::Launched {
                    epoch: launch.epoch,
                    result: Ok(session),
                })
                .await
                .unwrap();
            launch.epoch
        }
        async fn peer_for(&self, name: &str, epoch: u64) -> Codex {
            let peer = self.dir.path().join(name).join("peer.py");
            std::fs::create_dir(peer.parent().unwrap()).unwrap();
            std::fs::write(&peer, include_str!("../../../tests/support/codex_peer.py")).unwrap();
            std::fs::set_permissions(&peer, std::fs::Permissions::from_mode(0o755)).unwrap();
            let codex = Codex::launch(
                AgentProcess::mac(&peer),
                epoch,
                self.owner.provider_events.clone(),
                self.owner.log.clone(),
                Default::default(),
            )
            .await
            .unwrap();
            codex.initialize().await.unwrap();
            codex
        }
        fn running(&mut self, id: &ThreadId, native: &str) {
            let owner = &mut self.owner;
            let t = owner.threads.get_mut(id).unwrap();
            t.native_thread_id = Some(native.into());
            t.session = SessionState::Running;
            t.turns.push(Turn {
                id: TurnId::default(),
                kind: TurnKind::Prompt,
                prompt: "fixture".into(),
                context: None,
                native_turn_id: Some(format!("{native}-turn")),
                delivery: Delivery::Accepted,
                execution: Execution::Running,
                items: vec![],
                settings: None,
                started_at_ms: None,
                completed_at_ms: None,
                attachments: vec![],
                checkpoint: TurnCheckpoint::default(),
                tasks: None,
            });
            let root = t.root(&owner.workspaces[&t.workspace_id]).to_path_buf();
            owner.leases.insert(root, id.clone());
            let key = owner.env(id);
            owner.tools_prepared(&key, native, true).unwrap();
        }
        fn thread(&self, id: &ThreadId) -> &ThreadSnapshot {
            &self.owner.threads[id]
        }
        fn sandbox_handle(&self) -> Arc<SandboxHandle> {
            let thread = self.owner.threads[&self.sandboxed].clone();
            self.owner.workdir(&thread).sandbox().unwrap().clone()
        }
        /// The sandboxed thread between turns: nothing the idle rule counts as busy.
        fn settle_sandbox_thread(&mut self) {
            let root = self.root(&self.sandboxed);
            let t = self.owner.threads.get_mut(&self.sandboxed).unwrap();
            t.session = SessionState::Ready;
            t.turns[0].execution = Execution::Completed;
            self.owner.leases.remove(&root);
        }
        /// The verbs the fake Docker CLI saw, `exec <program> <subcommand>` for execs.
        fn docker_verbs(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.path().join("docker-state").join("calls.jsonl"))
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter_map(|call| {
                    if let Some(exec) = call.get("exec") {
                        let words: Vec<&str> = exec
                            .as_array()?
                            .iter()
                            .filter_map(Value::as_str)
                            .take(2)
                            .map(|word| word.rsplit('/').next().unwrap_or(word))
                            .collect();
                        return Some(format!("exec {}", words.join(" ")));
                    }
                    let verb = call["argv"][0].as_str()?;
                    (!matches!(verb, "exec" | "container" | "inspect" | "image"))
                        .then(|| verb.to_owned())
                })
                .collect()
        }
        fn container_status(&self) -> Option<String> {
            let name = self.sandbox_handle().container.name().to_owned();
            let path = self
                .dir
                .path()
                .join("docker-state")
                .join(format!("container-{name}.json"));
            let record: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
            Some(record["status"].as_str()?.to_owned())
        }
        /// Waits until the lifecycle work the tick spawned has ended.
        async fn until_sandbox_work_done(&self, handle: &SandboxHandle) {
            let started = Instant::now();
            while !handle.begin_work() {
                assert!(
                    started.elapsed() < Duration::from_secs(10),
                    "the sandbox work never ended: {:?}",
                    self.docker_verbs()
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            handle.end_work();
        }
        fn root(&self, id: &ThreadId) -> PathBuf {
            let t = self.thread(id);
            t.root(&self.owner.workspaces[&t.workspace_id])
                .to_path_buf()
        }
        fn received(&self, name: &str) -> Vec<Value> {
            std::fs::read_to_string(self.dir.path().join(name).join("calls.jsonl"))
                .unwrap_or_default()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
        async fn reply(&self, name: &str, id: &str) -> Value {
            for _ in 0..500 {
                if let Some(reply) = self
                    .received(name)
                    .into_iter()
                    .find(|line| line["id"] == id && line.get("method").is_none())
                {
                    return reply;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("{name} never received a reply to {id}");
        }
        async fn until_exited(&mut self, epoch: u64) {
            loop {
                let signal = tokio::time::timeout(Duration::from_secs(10), self.signals.recv())
                    .await
                    .unwrap()
                    .unwrap();
                let exited = matches!(signal, Signal::Exited { epoch: e, .. } if e == epoch);
                self.owner.signal(signal).await;
                if exited {
                    return;
                }
            }
        }
        async fn until_completed(&mut self, stop: impl Fn(&Completion) -> bool) {
            loop {
                let done = tokio::time::timeout(Duration::from_secs(10), self.completions.recv())
                    .await
                    .unwrap()
                    .unwrap();
                let last = stop(&done);
                let key = done
                    .epoch()
                    .and_then(|epoch| self.owner.providers.key(epoch).cloned());
                if let Err(error) = self.owner.complete(done).await {
                    self.owner
                        .lose_in(key.as_ref(), &error.message, &error.message)
                        .await;
                }
                if last {
                    return;
                }
            }
        }
        async fn resume(&mut self, id: &ThreadId) {
            let (reply, snapshot) = oneshot::channel();
            self.owner
                .command(Command::Snapshot(id.clone(), true, reply))
                .await;
            snapshot.await.unwrap().unwrap();
        }
        async fn frame(&mut self, epoch: u64, value: Value) {
            self.owner.signal(Signal::Frame { epoch, value }).await;
        }
        fn mac_intact(&self) {
            let t = self.thread(&self.mac);
            assert_eq!(t.session, SessionState::Running);
            assert_eq!(t.turns[0].execution, Execution::Running);
            assert_eq!(t.diagnostic, None);
            assert_eq!(
                self.owner.leases.get(&self.root(&self.mac)),
                Some(&self.mac)
            );
            assert_eq!(
                self.owner.providers.client(&EnvKey::Mac).unwrap().0,
                self.mac_epoch
            );
        }
    }

    fn approval(id: &str, native: &str) -> Value {
        json!({"id": id, "method": "item/commandExecution/requestApproval", "params": {"threadId": native, "turnId": format!("{native}-turn"), "itemId": "item", "command": "echo fixture", "cwd": "/fixture", "reason": "Fixture approval"}})
    }

    fn tool_call(id: &str, native: &str) -> Value {
        json!({"id": id, "method": "item/tool/call", "params": {"threadId": native, "turnId": format!("{native}-turn"), "callId": id, "tool": "list_thread_pull_requests", "arguments": {}}})
    }

    #[tokio::test]
    async fn losing_the_sandbox_agent_leaves_mac_work_live() {
        let mut f = Fixture::new().await;
        f.frame(f.mac_epoch, approval("mac-approval", "mac")).await;
        f.frame(f.sandbox_epoch, approval("sandbox-approval", "sandbox"))
            .await;
        assert_eq!(f.owner.callbacks.len(), 2);

        let (_, agent) = f.owner.providers.client(&sandbox()).unwrap();
        agent.terminate().await.unwrap();
        f.until_exited(f.sandbox_epoch).await;

        f.mac_intact();
        let sandboxed = f.thread(&f.sandboxed);
        assert!(matches!(
            sandboxed.session,
            SessionState::Unavailable { .. }
        ));
        assert!(matches!(
            sandboxed.turns[0].execution,
            Execution::Lost { .. }
        ));
        assert_eq!(sandboxed.approvals[0].state, ApprovalState::Expired);
        assert_eq!(f.owner.leases.get(&f.root(&f.sandboxed)), None);
        assert!(f.owner.providers.client(&sandbox()).is_none());
        assert!(
            f.owner
                .callbacks
                .values()
                .all(|route| route.thread == f.mac)
        );

        let approval = f.thread(&f.mac).approvals[0].id.clone();
        let (reply, answered) = oneshot::channel();
        f.owner
            .command(Command::Approval(approval, ApprovalDecision::Accept, reply))
            .await;
        answered.await.unwrap().unwrap();
        assert_eq!(
            f.reply("mac", "mac-approval").await["result"],
            json!({"decision": "accept"})
        );
    }

    #[tokio::test]
    async fn an_agent_cannot_address_threads_of_another_environment() {
        let mut f = Fixture::new().await;
        f.frame(f.sandbox_epoch, approval("approval", "mac")).await;
        f.frame(
            f.sandbox_epoch,
            json!({"id": "question", "method": "item/tool/requestUserInput", "params": {"threadId": "mac", "turnId": "mac-turn", "itemId": "item", "questions": [{"id": "scope", "header": "Scope", "question": "Continue?", "isOther": true, "isSecret": false, "options": [{"label": "Continue", "description": "Continue"}]}]}}),
        )
        .await;
        f.frame(f.sandbox_epoch, tool_call("sandbox-call", "mac"))
            .await;
        f.frame(f.mac_epoch, tool_call("mac-call", "mac")).await;

        let mac = f.thread(&f.mac);
        assert!(mac.approvals.is_empty());
        assert!(mac.user_questions.is_empty());
        assert!(f.owner.callbacks.is_empty());
        assert_eq!(
            f.reply("sandbox", "approval").await["error"]["code"],
            -32601
        );
        assert_eq!(
            f.reply("sandbox", "question").await["error"]["code"],
            -32601
        );
        assert_eq!(
            f.reply("sandbox", "sandbox-call").await["result"],
            json!({"success": false, "contentItems": [{"type": "inputText", "text": "This dynamic tool call is outside its registered live thread and turn."}]})
        );
        assert_eq!(f.reply("mac", "mac-call").await["result"]["success"], true);
        assert!(
            f.received("mac")
                .iter()
                .all(|line| line["id"] != "approval" && line["id"] != "sandbox-call")
        );
        f.mac_intact();
    }

    #[tokio::test]
    async fn only_the_mac_agent_reports_usage_limits() {
        let mut f = Fixture::new().await;
        f.until_completed(|done| matches!(done, Completion::Limits { .. }))
            .await;
        let before = f.owner.limits.borrow().clone();
        let update = |percent: u8| json!({"method": "account/rateLimits/updated", "params": {"rateLimits": {"limitId": "codex", "planType": "pro", "primary": {"usedPercent": percent, "windowDurationMins": 10080, "resetsAt": 1791580401}, "secondary": null}}});
        f.frame(f.sandbox_epoch, update(91)).await;
        assert_eq!(*f.owner.limits.borrow(), before);
        f.frame(f.mac_epoch, update(12)).await;
        assert_ne!(*f.owner.limits.borrow(), before);
    }

    #[tokio::test]
    async fn failed_sandbox_launches_back_off_without_touching_mac_threads() {
        let mut f = Fixture::new().await;
        let (_, agent) = f.owner.providers.client(&sandbox()).unwrap();
        agent.terminate().await.unwrap();
        f.until_exited(f.sandbox_epoch).await;
        for _ in 0..2 {
            f.resume(&f.sandboxed.clone()).await;
            f.until_completed(|done| matches!(done, Completion::Launched { .. }))
                .await;
        }
        assert_eq!(
            f.thread(&f.sandboxed).session,
            SessionState::Unavailable {
                reason: "Sign in to Codex on this Mac first.".into()
            },
            "credentials are checked before any Docker work"
        );
        f.resume(&f.sandboxed.clone()).await;
        assert_eq!(
            f.thread(&f.sandboxed).diagnostic.as_deref(),
            Some("Codex stopped 3 times in a row. Bot Code restarts it in 2 seconds.")
        );
        assert_eq!(f.owner.providers.notice(&EnvKey::Mac, Instant::now()), None);
        f.mac_intact();
    }

    fn replies(f: &Fixture, name: &str, id: &str) -> Vec<Value> {
        f.received(name)
            .into_iter()
            .filter(|line| line.get("id").and_then(Value::as_str) == Some(id))
            .collect()
    }
    async fn reply_within(f: &Fixture, name: &str, id: &str) -> Value {
        for _ in 0..500 {
            if let Some(reply) = replies(f, name, id).pop() {
                return reply;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!(
            "{name} never received a reply to {id}: {:?}",
            f.received(name)
        );
    }
    fn host_refreshes(f: &Fixture, name: &str) -> usize {
        f.received(name)
            .iter()
            .filter(|line| {
                line["method"] == "account/read" && line["params"]["refreshToken"] == json!(true)
            })
            .count()
    }
    fn refresh_request(id: &str, previous: Option<&str>) -> Value {
        json!({
            "id": id,
            "method": "account/chatgptAuthTokens/refresh",
            "params": {"reason": "unauthorized", "previousAccountId": previous},
        })
    }
    fn sign_in(f: &Fixture, account: &str) {
        let home = f.dir.path().join("codex-home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join("auth.json"),
            json!({
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": null,
                "tokens": {"access_token": "at-fresh", "account_id": account, "id_token": null},
            })
            .to_string(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn a_sandbox_token_refresh_is_answered_through_the_mac_agent_off_the_loop() {
        let mut f = Fixture::new().await;
        sign_in(&f, SANDBOX_ACCOUNT);
        f.frame(f.sandbox_epoch, refresh_request("refresh-1", None))
            .await;
        let reply = reply_within(&f, "sandbox", "refresh-1").await;
        assert_eq!(
            reply["result"],
            json!({"accessToken": "at-fresh", "chatgptAccountId": SANDBOX_ACCOUNT, "chatgptPlanType": null}),
            "{reply}"
        );
        assert_eq!(host_refreshes(&f, "mac"), 1, "{:?}", f.received("mac"));
        assert_eq!(
            host_refreshes(&f, "sandbox"),
            0,
            "the sandbox agent never refreshes itself"
        );
        f.mac_intact();
    }

    #[tokio::test]
    async fn a_refresh_after_a_mac_account_switch_is_refused_whatever_the_request_says() {
        let mut f = Fixture::new().await;
        sign_in(&f, "acct-2");
        for (id, previous) in [("omitted", None), ("lying", Some("acct-2"))] {
            f.frame(f.sandbox_epoch, refresh_request(id, previous))
                .await;
            let refused = reply_within(&f, "sandbox", id).await;
            assert_eq!(refused["error"]["code"], json!(-32000), "{id}: {refused}");
            assert!(refused["result"].is_null(), "{id}: {refused}");
            assert!(
                !refused.to_string().contains("at-fresh"),
                "{id}: the other account's token left the Mac: {refused}"
            );
        }
        f.mac_intact();
    }

    #[tokio::test]
    async fn the_mac_agent_cannot_ask_bot_code_for_tokens() {
        let mut f = Fixture::new().await;
        sign_in(&f, SANDBOX_ACCOUNT);
        f.frame(
            f.mac_epoch,
            refresh_request("refresh-mac", Some(SANDBOX_ACCOUNT)),
        )
        .await;
        let reply = reply_within(&f, "mac", "refresh-mac").await;
        assert_eq!(reply["error"]["code"], json!(-32601), "{reply}");
        assert_eq!(host_refreshes(&f, "mac"), 0, "no refresh was attempted");
    }

    #[tokio::test]
    async fn a_failed_tool_reply_loses_only_the_slot_it_answers() {
        let mut f = Fixture::new().await;
        f.frame(f.mac_epoch, approval("mac-approval", "mac")).await;
        assert_eq!(f.owner.callbacks.len(), 1);
        let (_, agent) = f.owner.providers.client(&sandbox()).unwrap();
        agent.terminate().await.unwrap();

        let turn = f.thread(&f.sandboxed).turns[0].id.clone();
        let completion = tools::ToolCompletion {
            context: crate::tools::ToolContext {
                thread_id: f.sandboxed.clone(),
                turn_id: turn,
                session_epoch: f.sandbox_epoch,
                call_id: "sandbox-call".into(),
            },
            caller: crate::codex::tools::Caller {
                native_thread: "sandbox".into(),
                native_turn: "sandbox-turn".into(),
                call_id: "sandbox-call".into(),
            },
            reply: tools::ToolReply::Dynamic {
                epoch: f.sandbox_epoch,
                request: json!("sandbox-call"),
            },
            result: crate::tools::ToolResult::text("done"),
        };
        f.owner.finish_tool(Ok(completion)).await;

        f.mac_intact();
        assert_eq!(f.owner.callbacks.len(), 1, "the Mac approval route stays");
        let sandboxed = f.thread(&f.sandboxed);
        assert!(matches!(
            sandboxed.session,
            SessionState::Unavailable { .. }
        ));
        assert!(matches!(
            sandboxed.turns[0].execution,
            Execution::Lost { .. }
        ));
        assert!(f.owner.providers.client(&sandbox()).is_none());
    }

    #[tokio::test]
    async fn a_stop_during_a_launch_drops_the_launch_and_terminates_its_agent() {
        let mut f = Fixture::new().await;
        f.owner.stop_providers(Some(&sandbox())).await.unwrap();
        f.until_exited(f.sandbox_epoch).await;
        let launch = f
            .owner
            .providers
            .begin_launch(&sandbox(), Instant::now())
            .unwrap();
        assert!(f.owner.providers.stop(&sandbox()).is_none());

        let late = f.peer_for("late", launch.epoch).await;
        let session = collaboration::discover(late).await;
        f.owner
            .complete(Completion::Launched {
                epoch: launch.epoch,
                result: Ok(session),
            })
            .await
            .unwrap();
        assert!(
            f.owner.providers.client(&sandbox()).is_none(),
            "a launch stopped before it completed never goes live"
        );
        f.until_exited(launch.epoch).await;
        f.mac_intact();
    }

    #[tokio::test]
    async fn a_wake_during_the_agent_stop_waits_for_the_container_to_stop_too() {
        let mut f = Fixture::new().await;
        f.settle_sandbox_thread();
        let handle = f.sandbox_handle();
        handle.request_stop(STOPPED_SETTLED);

        let (_, woken) = tokio::join!(f.owner.sandbox_lifecycle(), handle.wake());
        woken.unwrap();
        f.until_exited(f.sandbox_epoch).await;
        f.until_sandbox_work_done(&handle).await;

        let verbs = f.docker_verbs();
        assert!(
            f.owner.providers.client(&sandbox()).is_none(),
            "the agent slot was stopped"
        );
        let stopped = verbs.iter().position(|v| v == "stop").unwrap_or_else(|| {
            panic!("the agent was stopped but the container kept running: {verbs:?}")
        });
        assert!(
            verbs[stopped..].contains(&"start".to_string()),
            "the wake restarted the stopped container: {verbs:?}"
        );
        assert_eq!(handle.phase(), Phase::Running);
        assert_eq!(f.container_status().as_deref(), Some("running"));
        let sandboxed = f.thread(&f.sandboxed);
        assert_eq!(
            sandboxed.session,
            SessionState::Unavailable {
                reason: STOPPED_SETTLED.into()
            },
            "the next message relaunches the agent"
        );
        assert_eq!(sandboxed.diagnostic, None);
        f.mac_intact();
    }

    #[tokio::test]
    async fn a_requested_stop_with_no_wake_stops_the_agent_and_then_the_container() {
        let mut f = Fixture::new().await;
        f.settle_sandbox_thread();
        let handle = f.sandbox_handle();
        handle.request_stop(STOPPED_SETTLED);

        f.owner.sandbox_lifecycle().await;
        f.until_exited(f.sandbox_epoch).await;
        f.until_sandbox_work_done(&handle).await;

        assert!(f.owner.providers.client(&sandbox()).is_none());
        let verbs = f.docker_verbs();
        let stopped = verbs
            .iter()
            .position(|v| v == "stop")
            .unwrap_or_else(|| panic!("the container was not stopped: {verbs:?}"));
        assert!(
            verbs[..stopped].contains(&"exec sync capture".to_string()),
            "the mirror is pulled before the stop: {verbs:?}"
        );
        assert_eq!(handle.phase(), Phase::Stopped);
        assert_eq!(f.container_status().as_deref(), Some("exited"));
        let sandboxed = f.thread(&f.sandboxed);
        assert_eq!(
            sandboxed.session,
            SessionState::Unavailable {
                reason: STOPPED_SETTLED.into()
            }
        );
        assert_eq!(sandboxed.diagnostic, None);
        f.mac_intact();
    }

    #[tokio::test]
    async fn a_planned_stop_counts_no_failure_and_marks_no_loss() {
        let mut f = Fixture::new().await;
        let reason = "Sandbox stopped while idle. Your next message restarts it.";
        f.settle_sandbox_thread();

        f.owner.stop_providers(Some(&sandbox())).await.unwrap();
        f.owner.lose_env(&sandbox(), reason, reason).await;
        f.until_exited(f.sandbox_epoch).await;

        let sandboxed = f.thread(&f.sandboxed);
        assert_eq!(
            sandboxed.session,
            SessionState::Unavailable {
                reason: reason.into()
            }
        );
        assert_eq!(sandboxed.diagnostic, None);
        assert_eq!(sandboxed.turns[0].execution, Execution::Completed);
        let relaunch = f
            .owner
            .providers
            .begin_launch(&sandbox(), Instant::now())
            .unwrap();
        assert_eq!((relaunch.failures, relaunch.delay), (0, Duration::ZERO));
        f.mac_intact();
    }
}
