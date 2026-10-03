use crate::{
    codex::{self, Codex, Signal},
    domain::*,
    repo,
    store::Store,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::Duration,
};
use tokio::sync::{broadcast, mpsc, oneshot};

#[derive(Clone)]
pub struct RuntimeConfig {
    pub data_dir: PathBuf,
    pub codex_binary: PathBuf,
}
impl RuntimeConfig {
    pub fn from_environment() -> Result<Self> {
        let data_dir = std::env::var_os("Z1_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .unwrap_or_default()
                    .join("Library/Application Support/Z1 Code")
            });
        Ok(Self {
            data_dir,
            codex_binary: codex::installed_binary(),
        })
    }
}
type Reply<T> = oneshot::Sender<Result<T>>;
enum Command {
    List(Reply<Vec<Workspace>>),
    OpenWorkspace(PathBuf, Reply<Workspace>),
    Workspace(WorkspaceId, Reply<Workspace>),
    Threads(WorkspaceId, Reply<Vec<ThreadSummary>>),
    Create(WorkspaceId, Reply<ThreadSnapshot>),
    Snapshot(ThreadId, bool, Reply<ThreadSnapshot>),
    Submit(ThreadId, String, String, Reply<Receipt>),
    Approval(ApprovalId, ApprovalDecision, Reply<()>),
    Interrupt(ThreadId, Reply<()>),
    Shutdown(Reply<()>),
}
#[derive(Clone)]
pub struct App {
    commands: mpsc::Sender<Command>,
    changes: broadcast::Sender<ChangeHint>,
}
impl App {
    pub async fn open(config: RuntimeConfig) -> Result<Self> {
        let store = Store::open(&config.data_dir)?;
        let workspaces = store
            .workspaces()?
            .into_iter()
            .map(|w| (w.id.clone(), w))
            .collect();
        let mut threads: HashMap<ThreadId, ThreadSnapshot> = store
            .threads()?
            .into_iter()
            .map(|t| (t.id.clone(), t))
            .collect();
        let mut store = store;
        for thread in threads.values_mut() {
            thread.session = if thread.native_thread_id.is_some() {
                SessionState::Dormant
            } else {
                SessionState::Draft
            };
            for turn in &mut thread.turns {
                if turn.execution.active() {
                    turn.execution=Execution::Lost{reason:"The application closed before execution completed. Resume checks native history; this prompt will not be sent again.".into()};
                    if matches!(turn.delivery, Delivery::Sending) {
                        turn.delivery = Delivery::Uncertain {
                            reason: "Codex acceptance was not recorded before shutdown.".into(),
                        }
                    } else if matches!(turn.delivery, Delivery::Preparing) {
                        turn.delivery = Delivery::NotSent {
                            reason: "Application closed before this prompt was dispatched.".into(),
                        }
                    }
                }
            }
            for approval in &mut thread.approvals {
                if matches!(
                    approval.state,
                    ApprovalState::Pending | ApprovalState::Answering
                ) {
                    approval.state = ApprovalState::Expired
                }
            }
            thread.revision += 1;
            store.save(thread)?;
        }
        let (commands, rx) = mpsc::channel(128);
        let (changes, _) = broadcast::channel(256);
        let (provider_events, signals) = mpsc::channel(512);
        let (done, completions) = mpsc::channel(128);
        tokio::spawn(
            Owner {
                config,
                store,
                workspaces,
                threads,
                leases: HashMap::new(),
                routes: HashMap::new(),
                provider: None,
                epoch: 0,
                launching: false,
                pending: vec![],
                dirty: HashSet::new(),
                changes: changes.clone(),
                provider_events,
                done,
            }
            .run(rx, signals, completions),
        );
        Ok(Self { commands, changes })
    }
    async fn call<T>(&self, build: impl FnOnce(Reply<T>) -> Command) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(build(tx))
            .await
            .map_err(|_| AppError::new("closed", "Z1 runtime is closed."))?;
        rx.await
            .map_err(|_| AppError::new("closed", "Z1 runtime is closed."))?
    }
    pub fn subscribe(&self) -> broadcast::Receiver<ChangeHint> {
        self.changes.subscribe()
    }
    pub async fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        self.call(Command::List).await
    }
    pub async fn open_workspace(&self, path: PathBuf) -> Result<Workspace> {
        let root = tokio::task::spawn_blocking(move || repo::open(&path))
            .await
            .map_err(|e| AppError::new("repository", e))??;
        self.call(|r| Command::OpenWorkspace(root, r)).await
    }
    async fn workspace(&self, id: WorkspaceId) -> Result<Workspace> {
        self.call(|r| Command::Workspace(id, r)).await
    }
    pub async fn workspace_view(&self, id: WorkspaceId) -> Result<WorkspaceView> {
        let w = self.workspace(id.clone()).await?;
        let threads = self.call(|r| Command::Threads(id, r)).await?;
        tokio::task::spawn_blocking(move || repo::inspect(w, threads))
            .await
            .map_err(|e| AppError::new("repository", e))?
    }
    pub async fn read_file(&self, id: WorkspaceId, path: String) -> Result<FileView> {
        let w = self.workspace(id).await?;
        tokio::task::spawn_blocking(move || repo::read_file(&w.root, &path))
            .await
            .map_err(|e| AppError::new("repository", e))?
    }
    pub async fn read_diff(
        &self,
        id: WorkspaceId,
        path: String,
        basis: DiffBasis,
    ) -> Result<DiffView> {
        let w = self.workspace(id).await?;
        tokio::task::spawn_blocking(move || repo::diff(&w.root, &path, basis))
            .await
            .map_err(|e| AppError::new("repository", e))?
    }
    pub async fn create_thread(&self, id: WorkspaceId) -> Result<ThreadSnapshot> {
        self.call(|r| Command::Create(id, r)).await
    }
    pub async fn thread(&self, id: ThreadId) -> Result<ThreadSnapshot> {
        self.call(|r| Command::Snapshot(id, false, r)).await
    }
    pub async fn open_thread(&self, id: ThreadId) -> Result<ThreadSnapshot> {
        self.call(|r| Command::Snapshot(id, true, r)).await
    }
    pub async fn submit(&self, id: ThreadId, request_id: String, text: String) -> Result<Receipt> {
        self.call(|r| Command::Submit(id, request_id, text, r))
            .await
    }
    pub async fn answer_approval(&self, id: ApprovalId, decision: ApprovalDecision) -> Result<()> {
        self.call(|r| Command::Approval(id, decision, r)).await
    }
    pub async fn interrupt(&self, id: ThreadId) -> Result<()> {
        self.call(|r| Command::Interrupt(id, r)).await
    }
    pub async fn shutdown(&self) -> Result<()> {
        self.call(Command::Shutdown).await
    }
}
#[derive(Clone)]
enum Prepare {
    Resume(ThreadId),
    Submit(ThreadId, TurnId),
}
impl Prepare {
    fn thread(&self) -> &ThreadId {
        match self {
            Self::Resume(id) | Self::Submit(id, _) => id,
        }
    }
}
enum Completion {
    Launched {
        epoch: u64,
        result: Result<Codex>,
    },
    Prepared {
        epoch: u64,
        job: Prepare,
        result: Result<Value>,
    },
    Started {
        epoch: u64,
        thread: ThreadId,
        turn: TurnId,
        result: Result<Value>,
    },
    Answered {
        epoch: u64,
        id: ApprovalId,
        result: Result<()>,
    },
    Interrupted {
        epoch: u64,
        thread: ThreadId,
        result: Result<Value>,
    },
}
#[derive(Clone)]
struct Route {
    thread: ThreadId,
    request: Value,
    item_id: String,
    epoch: u64,
}
struct Owner {
    config: RuntimeConfig,
    store: Store,
    workspaces: HashMap<WorkspaceId, Workspace>,
    threads: HashMap<ThreadId, ThreadSnapshot>,
    leases: HashMap<WorkspaceId, ThreadId>,
    routes: HashMap<ApprovalId, Route>,
    provider: Option<Codex>,
    epoch: u64,
    launching: bool,
    pending: Vec<Prepare>,
    dirty: HashSet<ThreadId>,
    changes: broadcast::Sender<ChangeHint>,
    provider_events: mpsc::Sender<Signal>,
    done: mpsc::Sender<Completion>,
}
impl Owner {
    fn thread(&self, id: &ThreadId) -> Result<&ThreadSnapshot> {
        self.threads
            .get(id)
            .ok_or_else(|| AppError::new("missing_thread", "Conversation not found."))
    }
    fn commit(&mut self, id: &ThreadId) -> Result<()> {
        let t = self
            .threads
            .get_mut(id)
            .ok_or_else(|| AppError::new("missing_thread", "Conversation not found."))?;
        t.stamp_completions();
        t.revision += 1;
        self.store.save(t)?;
        self.dirty.remove(id);
        let _ = self.changes.send(ChangeHint::from(&*t));
        Ok(())
    }
    fn install(&mut self, mut next: ThreadSnapshot) -> Result<()> {
        next.stamp_completions();
        next.revision += 1;
        self.store.save(&next)?;
        let hint = ChangeHint::from(&next);
        self.dirty.remove(&next.id);
        self.threads.insert(next.id.clone(), next);
        let _ = self.changes.send(hint);
        Ok(())
    }
    async fn run(
        mut self,
        mut commands: mpsc::Receiver<Command>,
        mut signals: mpsc::Receiver<Signal>,
        mut completions: mpsc::Receiver<Completion>,
    ) {
        let mut tick = tokio::time::interval(Duration::from_millis(90));
        let mut shutdown = None;
        loop {
            tokio::select! {
                command=commands.recv()=>{
                    let Some(command)=command else {
                        self.lose("Z1 runtime handles were released.").await;
                        break;
                    };
                    if let Command::Shutdown(reply)=command {
                        let result=if let Some(provider)=self.provider.take(){provider.terminate().await}else{Ok(())};
                        self.lose("Z1 Code closed. Native execution stopped.").await;
                        shutdown=Some((reply,result));
                        break;
                    }
                    self.command(command).await;
                }
                Some(signal)=signals.recv()=>{
                    match signal {
                        Signal::Frame{epoch,value} if epoch==self.epoch=>{
                            if let Err(error)=self.frame(value).await {self.lose(&error.message).await;}
                        }
                        Signal::Exited{epoch,reason} if epoch==self.epoch=>self.lose(&reason).await,
                        _=>{}
                    }
                }
                Some(done)=completions.recv()=>{
                    if let Err(error)=self.complete(done).await {self.lose(&error.message).await;}
                }
                _=tick.tick()=>{
                    for id in self.dirty.clone(){
                        if let Err(error)=self.commit(&id){
                            self.lose(&format!("Could not save progress: {}",error.message)).await;
                            break;
                        }
                    }
                }
                else=>break,
            }
        }
        if let Some(provider) = self.provider.take() {
            let _ = provider.terminate().await;
        }
        drop(self);
        if let Some((reply, result)) = shutdown {
            let _ = reply.send(result);
        }
    }
    async fn command(&mut self, command: Command) {
        match command {
            Command::List(reply) => {
                let mut rows: Vec<_> = self.workspaces.values().cloned().collect();
                rows.sort_by(|a, b| a.label.cmp(&b.label));
                let _ = reply.send(Ok(rows));
            }
            Command::OpenWorkspace(path, reply) => {
                let result = (|| -> Result<Workspace> {
                    let root = path;
                    if let Some(w) = self.workspaces.values().find(|w| w.root == root) {
                        return Ok(w.clone());
                    }
                    let w = Workspace {
                        id: WorkspaceId::default(),
                        label: root
                            .file_name()
                            .map(|v| v.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "Repository".into()),
                        root,
                    };
                    self.store.workspace(&w)?;
                    self.workspaces.insert(w.id.clone(), w.clone());
                    Ok(w)
                })();
                let _ = reply.send(result);
            }
            Command::Workspace(id, reply) => {
                let _ =
                    reply.send(self.workspaces.get(&id).cloned().ok_or_else(|| {
                        AppError::new("missing_workspace", "Repository not found.")
                    }));
            }
            Command::Threads(id, reply) => {
                let rows = self
                    .threads
                    .values()
                    .filter(|t| t.workspace_id == id)
                    .map(ThreadSnapshot::summary)
                    .collect();
                let _ = reply.send(Ok(rows));
            }
            Command::Create(workspace_id, reply) => {
                let result = (|| {
                    if !self.workspaces.contains_key(&workspace_id) {
                        return Err(AppError::new("missing_workspace", "Repository not found."));
                    }
                    let t = ThreadSnapshot {
                        id: ThreadId::default(),
                        workspace_id,
                        title: "New conversation".into(),
                        native_thread_id: None,
                        revision: 1,
                        session: SessionState::Draft,
                        turns: vec![],
                        approvals: vec![],
                        diagnostic: None,
                    };
                    self.store.save(&t)?;
                    self.threads.insert(t.id.clone(), t.clone());
                    Ok(t)
                })();
                let _ = reply.send(result);
            }
            Command::Snapshot(id, resume, reply) => {
                let should_resume = resume
                    && self.thread(&id).is_ok_and(|t| {
                        t.native_thread_id.is_some()
                            && matches!(
                                t.session,
                                SessionState::Dormant | SessionState::Unavailable { .. }
                            )
                    });
                if should_resume {
                    self.threads.get_mut(&id).unwrap().session = SessionState::Connecting;
                    let _ = self.commit(&id);
                    self.prepare(Prepare::Resume(id.clone()));
                }
                let result = if self.dirty.contains(&id) {
                    self.commit(&id).and_then(|_| self.thread(&id).cloned())
                } else {
                    self.thread(&id).cloned()
                };
                let _ = reply.send(result);
            }
            Command::Submit(id, request_id, text, reply) => {
                let result = self.accept_submit(&id, &request_id, &text);
                if let Ok((receipt, true)) = &result {
                    self.prepare(Prepare::Submit(id, receipt.turn_id.clone()));
                }
                let _ = reply.send(result.map(|(receipt, _)| receipt));
            }
            Command::Approval(id, decision, reply) => {
                let result = (|| -> Result<()> {
                    let route = self.routes.get(&id).cloned().ok_or_else(|| {
                        AppError::new(
                            "approval_expired",
                            "This approval no longer has a live callback.",
                        )
                    })?;
                    if route.epoch != self.epoch {
                        return Err(AppError::new(
                            "approval_expired",
                            "Codex restarted. This approval expired.",
                        ));
                    }
                    let provider = self
                        .provider
                        .clone()
                        .ok_or_else(|| AppError::new("provider_lost", "Codex is unavailable."))?;
                    let mut thread = self.threads.get(&route.thread).cloned().ok_or_else(|| {
                        AppError::new("missing_thread", "Conversation not found.")
                    })?;
                    let approval = thread
                        .approvals
                        .iter_mut()
                        .find(|a| a.id == id)
                        .ok_or_else(|| AppError::new("approval_expired", "Approval not found."))?;
                    if matches!(decision, ApprovalDecision::Accept)
                        && (matches!(&approval.action,ApprovalAction::FileChange{text,..} if text.is_empty())
                            || matches!(&approval.action,ApprovalAction::Command{command,..} if command.is_empty()))
                    {
                        return Err(AppError::new(
                            "approval_details_missing",
                            "The provider has not supplied reviewable action details. Decline or cancel this turn.",
                        ));
                    }
                    approval.state = ApprovalState::Answering;
                    self.install(thread)?;
                    self.routes.remove(&id);
                    let done = self.done.clone();
                    let epoch = self.epoch;
                    tokio::spawn(async move {
                        let result = provider
                            .respond(route.request, json!({"decision":decision}))
                            .await;
                        let _ = done.send(Completion::Answered { epoch, id, result }).await;
                    });
                    Ok(())
                })();
                let _ = reply.send(result);
            }
            Command::Interrupt(id, reply) => {
                let result = (|| -> Result<()> {
                    let provider = self
                        .provider
                        .clone()
                        .ok_or_else(|| AppError::new("provider_lost", "Codex is unavailable."))?;
                    let t = self.thread(&id)?;
                    let native_thread = t.native_thread_id.clone().ok_or_else(|| {
                        AppError::new(
                            "not_started",
                            "Codex is still starting. Try Stop once the turn starts.",
                        )
                    })?;
                    let native_turn = t
                        .turns
                        .iter()
                        .rev()
                        .find(|t| t.execution.active())
                        .and_then(|t| t.native_turn_id.clone())
                        .ok_or_else(|| {
                            AppError::new(
                                "not_running",
                                "There is no acknowledged active turn to stop.",
                            )
                        })?;
                    let mut next = self.thread(&id)?.clone();
                    next.session = SessionState::Interrupting;
                    self.install(next)?;
                    let done = self.done.clone();
                    let epoch = self.epoch;
                    tokio::spawn(async move {
                        let result = provider
                            .request(
                                "turn/interrupt",
                                json!({"threadId":native_thread,"turnId":native_turn}),
                            )
                            .await;
                        let _ = done
                            .send(Completion::Interrupted {
                                epoch,
                                thread: id,
                                result,
                            })
                            .await;
                    });
                    Ok(())
                })();
                let _ = reply.send(result);
            }
            Command::Shutdown(_) => {}
        }
    }
    fn accept_submit(
        &mut self,
        id: &ThreadId,
        request_id: &str,
        text: &str,
    ) -> Result<(Receipt, bool)> {
        if request_id.is_empty() || request_id.len() > 200 {
            return Err(AppError::new(
                "invalid_request",
                "A bounded operation ID is required.",
            ));
        }
        let text = text.trim();
        if text.is_empty() || text.len() > 100_000 {
            return Err(AppError::new(
                "invalid_prompt",
                "Enter a prompt up to 100,000 bytes.",
            ));
        }
        let input = serde_json::to_string(&(id, text))?;
        if let Some(receipt) = self.store.receipt(request_id, &input)? {
            return Ok((receipt, false));
        }
        let thread = self.thread(id)?;
        if matches!(
            thread.session,
            SessionState::Connecting | SessionState::Running | SessionState::Interrupting
        ) {
            return Err(AppError::new(
                "busy",
                "Wait for the current operation to finish.",
            ));
        }
        if self.leases.contains_key(&thread.workspace_id) {
            return Err(AppError::new(
                "checkout_busy",
                "Another conversation is running in this checkout.",
            ));
        }
        let mut t = thread.clone();
        let turn = Turn {
            id: TurnId::default(),
            prompt: text.into(),
            native_turn_id: None,
            delivery: Delivery::Preparing,
            execution: Execution::NotStarted,
            items: vec![],
            started_at_ms: Some(now_ms()),
            completed_at_ms: None,
        };
        let receipt = Receipt {
            turn_id: turn.id.clone(),
        };
        t.turns.push(turn);
        t.session = SessionState::Connecting;
        t.diagnostic = None;
        if t.turns.len() == 1 {
            t.title = text.chars().take(54).collect()
        }
        t.revision += 1;
        self.store.accept(&t, request_id, &input, &receipt)?;
        self.leases.insert(t.workspace_id.clone(), t.id.clone());
        let _ = self.changes.send(ChangeHint::from(&t));
        self.threads.insert(t.id.clone(), t);
        Ok((receipt, true))
    }
    fn prepare(&mut self, job: Prepare) {
        if self.provider.is_none() {
            self.pending.push(job);
            if !self.launching {
                self.launching = true;
                self.epoch += 1;
                let epoch = self.epoch;
                let binary = self.config.codex_binary.clone();
                let signals = self.provider_events.clone();
                let done = self.done.clone();
                tokio::spawn(async move {
                    let result = match Codex::launch(binary, epoch, signals).await {
                        Ok(provider) => match provider.initialize().await {
                            Ok(()) => Ok(provider),
                            Err(e) => {
                                let _ = provider.terminate().await;
                                Err(e)
                            }
                        },
                        Err(e) => Err(e),
                    };
                    let _ = done.send(Completion::Launched { epoch, result }).await;
                });
            }
            return;
        }
        let t = match self.thread(job.thread()) {
            Ok(t) => t,
            Err(_) => return,
        };
        let root = self.workspaces[&t.workspace_id].root.clone();
        let native = t.native_thread_id.clone();
        let provider = self.provider.clone().unwrap();
        let done = self.done.clone();
        let epoch = self.epoch;
        tokio::spawn(async move {
            let result = if let Some(native) = native {
                provider.request("thread/resume",json!({"threadId":native,"cwd":root,"approvalPolicy":"untrusted","approvalsReviewer":"user","sandbox":"workspace-write","excludeTurns":false})).await
            } else {
                provider.request("thread/start",json!({"cwd":root,"approvalPolicy":"untrusted","approvalsReviewer":"user","sandbox":"workspace-write","ephemeral":false})).await
            };
            let _ = done.send(Completion::Prepared { epoch, job, result }).await;
        });
    }
    async fn complete(&mut self, done: Completion) -> Result<()> {
        match done {
            Completion::Launched { epoch, result } if epoch == self.epoch => {
                self.launching = false;
                match result {
                    Ok(provider) => {
                        self.provider = Some(provider);
                        for job in std::mem::take(&mut self.pending) {
                            self.prepare(job)
                        }
                    }
                    Err(e) => self.lose(&e.message).await,
                }
            }
            Completion::Prepared { epoch, job, result } if epoch == self.epoch => {
                let id = job.thread().clone();
                match result {
                    Ok(value) => {
                        let native = value
                            .pointer("/thread/id")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                AppError::new("protocol", "Codex did not return a thread ID.")
                            })?
                            .to_owned();
                        let t = self.threads.get_mut(&id).ok_or_else(|| {
                            AppError::new("missing_thread", "Conversation not found.")
                        })?;
                        t.native_thread_id = Some(native.clone());
                        t.session = SessionState::Ready;
                        t.diagnostic = None;
                        merge_history(t, value.pointer("/thread/turns"));
                        self.commit(&id)?;
                        if let Prepare::Submit(_, turn_id) = job {
                            let t = self.threads.get_mut(&id).unwrap();
                            t.session = SessionState::Connecting;
                            let turn = t
                                .turns
                                .iter_mut()
                                .find(|v| v.id == turn_id)
                                .ok_or_else(|| AppError::new("missing_turn", "Turn not found."))?;
                            turn.delivery = Delivery::Sending;
                            let prompt = turn.prompt.clone();
                            self.commit(&id)?;
                            let provider = self.provider.clone().ok_or_else(|| {
                                AppError::new("provider_lost", "Codex is unavailable.")
                            })?;
                            let done = self.done.clone();
                            tokio::spawn(async move {
                                let result=provider.request("turn/start",json!({"threadId":native,"clientUserMessageId":turn_id.to_string(),"input":[{"type":"text","text":prompt,"text_elements":[]}]})).await;
                                let _ = done
                                    .send(Completion::Started {
                                        epoch,
                                        thread: id,
                                        turn: turn_id,
                                        result,
                                    })
                                    .await;
                            });
                        }
                    }
                    Err(e) => {
                        let t = self.threads.get_mut(&id).unwrap();
                        t.session = SessionState::Unavailable {
                            reason: e.message.clone(),
                        };
                        t.diagnostic = Some(e.message.clone());
                        if let Prepare::Submit(_, turn_id) = job {
                            if let Some(turn) = t.turns.iter_mut().find(|t| t.id == turn_id) {
                                turn.delivery = Delivery::NotSent {
                                    reason: e.message.clone(),
                                };
                                turn.execution = Execution::Failed { reason: e.message };
                            }
                            self.leases.remove(&t.workspace_id);
                        }
                        self.commit(&id)?;
                    }
                }
            }
            Completion::Started {
                epoch,
                thread,
                turn,
                result,
            } if epoch == self.epoch => {
                let t = self.threads.get_mut(&thread).unwrap();
                let row = t.turns.iter_mut().find(|r| r.id == turn).unwrap();
                match result {
                    Ok(value) => {
                        row.native_turn_id = Some(
                            value
                                .pointer("/turn/id")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    AppError::new(
                                        "protocol",
                                        "Codex did not acknowledge a turn ID.",
                                    )
                                })?
                                .into(),
                        );
                        row.delivery = Delivery::Accepted;
                        if row.execution.active() {
                            row.execution = Execution::Running;
                            t.session = SessionState::Running;
                        }
                    }
                    Err(e) => {
                        if matches!(row.delivery, Delivery::Accepted) {
                            return Ok(());
                        }
                        row.delivery = Delivery::Uncertain {
                            reason: e.message.clone(),
                        };
                        row.execution=Execution::Lost{reason:"The request may have reached Codex. It will not be sent again automatically.".into()};
                        t.session = SessionState::Unavailable { reason: e.message };
                        self.commit(&thread)?;
                        self.lose("Codex turn delivery is uncertain. Managed execution was stopped; resume native history before sending another prompt.").await;
                        return Ok(());
                    }
                }
                self.commit(&thread)?;
            }
            Completion::Answered { epoch, id, result } if epoch == self.epoch => {
                if let Some(t) = self
                    .threads
                    .values_mut()
                    .find(|t| t.approvals.iter().any(|a| a.id == id))
                {
                    let a = t.approvals.iter_mut().find(|a| a.id == id).unwrap();
                    a.state = if result.is_ok() {
                        ApprovalState::Answered
                    } else {
                        ApprovalState::Uncertain
                    };
                    if let Err(e) = result {
                        t.diagnostic = Some(e.message)
                    }
                    let id = t.id.clone();
                    self.commit(&id)?;
                }
            }
            Completion::Interrupted {
                epoch,
                thread,
                result,
            } if epoch == self.epoch => {
                if let Err(e) = result {
                    let t = self.threads.get_mut(&thread).unwrap();
                    t.diagnostic = Some(format!("Stop was not confirmed: {}", e.message));
                    self.commit(&thread)?;
                    self.lose(
                        "Interruption could not be confirmed. Managed Codex execution was stopped.",
                    )
                    .await;
                }
            }
            _ => {}
        }
        Ok(())
    }
    async fn lose(&mut self, reason: &str) {
        if let Some(provider) = self.provider.take() {
            let _ = provider.terminate().await;
        }
        self.epoch += 1;
        self.launching = false;
        self.pending.clear();
        self.routes.clear();
        self.leases.clear();
        let ids: Vec<_> = self.threads.keys().cloned().collect();
        for id in ids {
            let t = self.threads.get_mut(&id).unwrap();
            let affected = matches!(
                t.session,
                SessionState::Connecting
                    | SessionState::Running
                    | SessionState::Interrupting
                    | SessionState::Ready
            );
            if !affected {
                continue;
            }
            t.session = SessionState::Unavailable {
                reason: reason.into(),
            };
            t.diagnostic = Some(reason.into());
            for turn in &mut t.turns {
                if turn.execution.active() {
                    turn.execution = Execution::Lost {
                        reason: reason.into(),
                    };
                    if matches!(turn.delivery, Delivery::Preparing) {
                        turn.delivery = Delivery::NotSent {
                            reason: reason.into(),
                        }
                    } else if matches!(turn.delivery, Delivery::Sending) {
                        turn.delivery = Delivery::Uncertain {
                            reason: reason.into(),
                        }
                    }
                }
            }
            for approval in &mut t.approvals {
                if matches!(
                    approval.state,
                    ApprovalState::Pending | ApprovalState::Answering
                ) {
                    approval.state = ApprovalState::Expired
                }
            }
            let _ = self.commit(&id);
        }
    }
    async fn frame(&mut self, value: Value) -> Result<()> {
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::new("protocol", "Codex frame has no method."))?;
        let p = value.get("params").unwrap_or(&Value::Null);
        let native = p.get("threadId").and_then(Value::as_str);
        let id = native.and_then(|native| {
            self.threads
                .values()
                .find(|t| t.native_thread_id.as_deref() == Some(native))
                .map(|t| t.id.clone())
        });
        if let Some(request) = value.get("id") {
            let Some(id) = id else {
                if let Some(provider) = &self.provider {
                    provider.refuse(request.clone(), method).await?;
                }
                return Ok(());
            };
            let t = self.threads.get_mut(&id).unwrap();
            let Some(turn) = t.turns.iter().rev().find(|turn| turn.execution.active()) else {
                if let Some(provider) = &self.provider {
                    provider.refuse(request.clone(), method).await?;
                }
                return Ok(());
            };
            let action = match method {
                "item/commandExecution/requestApproval" => Some(ApprovalAction::Command {
                    command: string(p, "command"),
                    cwd: string(p, "cwd"),
                    reason: string(p, "reason"),
                }),
                "item/fileChange/requestApproval" => {
                    let item_id = required_string(p, "itemId")?.to_owned();
                    let text = turn
                        .items
                        .iter()
                        .find_map(|i| match i {
                            Item::FileChange { id, text, .. } if *id == item_id => {
                                Some(text.clone())
                            }
                            _ => None,
                        })
                        .unwrap_or_default();
                    Some(ApprovalAction::FileChange {
                        text,
                        reason: string(p, "reason"),
                    })
                }
                _ => None,
            };
            if let Some(action) = action {
                let approval = Approval {
                    id: ApprovalId::default(),
                    turn_id: turn.id.clone(),
                    action,
                    state: ApprovalState::Pending,
                };
                self.routes.insert(
                    approval.id.clone(),
                    Route {
                        thread: id.clone(),
                        request: request.clone(),
                        item_id: string(p, "itemId"),
                        epoch: self.epoch,
                    },
                );
                t.approvals.push(approval);
                self.commit(&id)?;
            } else {
                t.diagnostic = Some(format!(
                    "Codex requested {method}, which this version cannot answer. The request was refused."
                ));
                self.commit(&id)?;
                if let Some(provider) = &self.provider {
                    provider.refuse(request.clone(), method).await?;
                }
            }
            return Ok(());
        }
        let Some(id) = id else { return Ok(()) };
        let t = self.threads.get_mut(&id).unwrap();
        let native_turn = p
            .get("turnId")
            .and_then(Value::as_str)
            .or_else(|| p.pointer("/turn/id").and_then(Value::as_str));
        let position = native_turn
            .and_then(|nt| {
                t.turns
                    .iter()
                    .position(|turn| turn.native_turn_id.as_deref() == Some(nt))
            })
            .or_else(|| t.turns.iter().rposition(|turn| turn.execution.active()));
        let Some(position) = position else {
            return Ok(());
        };
        let turn = &mut t.turns[position];
        if turn.native_turn_id.is_none() {
            turn.native_turn_id = native_turn.map(str::to_owned)
        }
        match method {
            "turn/started" => {
                turn.delivery = Delivery::Accepted;
                turn.execution = Execution::Running;
                t.session = SessionState::Running;
            }
            "item/agentMessage/delta" => {
                let item_id = required_string(p, "itemId")?.to_owned();
                let delta = string(p, "delta");
                if let Some(Item::Assistant { text, .. }) =
                    turn.items.iter_mut().find(|i| i.id() == item_id)
                {
                    text.push_str(&delta)
                } else {
                    turn.items.push(Item::Assistant {
                        id: item_id,
                        text: delta,
                        complete: false,
                    })
                }
            }
            "item/commandExecution/outputDelta" => {
                let item_id = required_string(p, "itemId")?.to_owned();
                if let Some(Item::Command { output, .. }) =
                    turn.items.iter_mut().find(|i| i.id() == item_id)
                {
                    output.push_str(&string(p, "delta"));
                }
            }
            "item/started" | "item/completed" => {
                if let Some(value) = p.get("item") {
                    required_string(value, "id")?;
                    if let Some(item) = normalize_item(value, method == "item/completed") {
                        if let Item::FileChange { text, .. } = &item {
                            for approval in &mut t.approvals {
                                if approval.turn_id == turn.id
                                    && self
                                        .routes
                                        .get(&approval.id)
                                        .is_some_and(|route| route.item_id == item.id())
                                    && approval.state == ApprovalState::Pending
                                {
                                    if let ApprovalAction::FileChange { text: details, .. } =
                                        &mut approval.action
                                    {
                                        if details.is_empty() {
                                            *details = text.clone()
                                        }
                                    }
                                }
                            }
                        }
                        upsert(&mut turn.items, item)
                    }
                }
            }
            "turn/completed" => {
                let status = p
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("failed");
                turn.delivery = Delivery::Accepted;
                turn.execution = execution(status, p.pointer("/turn/error"));
                if let Some(items) = p.pointer("/turn/items").and_then(Value::as_array) {
                    for item in items {
                        if let Some(item) = normalize_item(item, true) {
                            upsert(&mut turn.items, item)
                        }
                    }
                }
                t.session = SessionState::Ready;
                self.leases.remove(&t.workspace_id);
                for approval in &mut t.approvals {
                    if approval.turn_id == turn.id && approval.state == ApprovalState::Pending {
                        approval.state = ApprovalState::Expired;
                        self.routes.remove(&approval.id);
                    }
                }
                self.commit(&id)?;
                return Ok(());
            }
            "error" => {
                t.diagnostic = Some(
                    p.get("error")
                        .and_then(|v| v.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("Codex reported an error.")
                        .into(),
                )
            }
            _ => return Ok(()),
        }
        self.dirty.insert(id);
        Ok(())
    }
}
fn required_string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::new("protocol", format!("Codex frame is missing {key}.")))
}
fn string(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .into()
}
fn execution(status: &str, error: Option<&Value>) -> Execution {
    match status {
        "completed" => Execution::Completed,
        "interrupted" => Execution::Interrupted,
        "inProgress" => Execution::Running,
        _ => Execution::Failed {
            reason: error
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Codex turn failed.")
                .into(),
        },
    }
}
fn upsert(items: &mut Vec<Item>, item: Item) {
    if let Some(row) = items.iter_mut().find(|i| i.id() == item.id()) {
        *row = item
    } else {
        items.push(item)
    }
}
fn normalize_item(v: &Value, complete: bool) -> Option<Item> {
    let id = v.get("id")?.as_str()?.to_owned();
    let kind = v.get("type")?.as_str()?;
    Some(match kind {
        "userMessage" => return None,
        "agentMessage" => Item::Assistant {
            id,
            text: string(v, "text"),
            complete,
        },
        "commandExecution" => Item::Command {
            id,
            command: string(v, "command"),
            output: string(v, "aggregatedOutput"),
            status: string(v, "status"),
        },
        "fileChange" => Item::FileChange {
            id,
            text: v
                .get("changes")
                .and_then(Value::as_array)
                .map(|changes| {
                    changes
                        .iter()
                        .map(|change| {
                            format!("{}\n{}", string(change, "path"), string(change, "diff"))
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default(),
            status: string(v, "status"),
            paths: v
                .get("changes")
                .and_then(Value::as_array)
                .map(|changes| changes.iter().map(|change| string(change, "path")).collect())
                .unwrap_or_default(),
        },
        "reasoning" => Item::Other {
            id,
            label: "Reasoning".into(),
            text: v
                .get("summary")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default(),
        },
        _ => Item::Other {
            id,
            label: kind.into(),
            text: v
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
        },
    })
}
fn merge_history(thread: &mut ThreadSnapshot, value: Option<&Value>) {
    let Some(turns) = value.and_then(Value::as_array) else {
        return;
    };
    for native in turns {
        let native_id = string(native, "id");
        let items = native.get("items").and_then(Value::as_array);
        let client_id = items
            .and_then(|items| {
                items
                    .iter()
                    .find(|v| v.get("type").and_then(Value::as_str) == Some("userMessage"))
            })
            .and_then(|v| v.get("clientId"))
            .and_then(Value::as_str);
        let row = thread.turns.iter_mut().find(|turn| {
            turn.native_turn_id.as_deref() == Some(&native_id)
                || client_id == Some(&turn.id.to_string())
        });
        if let Some(turn) = row {
            turn.native_turn_id = Some(native_id);
            turn.delivery = Delivery::Accepted;
            let recovered = execution(&string(native, "status"), native.get("error"));
            if !matches!(recovered, Execution::Running) {
                turn.execution = recovered;
            }
            if let Some(items) = items {
                for item in items {
                    if let Some(item) = normalize_item(item, true) {
                        upsert(&mut turn.items, item)
                    }
                }
            }
        }
    }
    if thread
        .turns
        .iter()
        .any(|turn| matches!(turn.execution, Execution::Lost { .. }))
    {
        thread.diagnostic=Some("Some previous execution could not be confirmed from the returned native history. No prompt was replayed.".into());
    }
}
