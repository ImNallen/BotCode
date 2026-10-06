mod naming;
mod pr_review;
mod pull_requests;
use crate::pr_review::*;
use crate::pull_requests::{PrLinkSource, PullRequestKey, ThreadPrSummary};
use crate::{
    cleanup::{self, Candidate, Sweep},
    codex::{Codex, Signal},
    domain::*,
    repo, settings,
    store::Store,
    terminal::{
        MAX_WRITE_BYTES, Sink, TerminalEvent, TerminalId, TerminalKey, TerminalSize, Terminals,
    },
    usage::{self, ContextUsage, UsageLimits},
    vcs,
};
use pr_review::ReviewWork;
use pull_requests::PrWork;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, Notify, broadcast, mpsc, oneshot, watch};

#[derive(Clone)]
pub struct RuntimeConfig {
    pub data_dir: PathBuf,
    pub codex_binary: PathBuf,
    pub gh_binary: PathBuf,
    pub network_timeout: Duration,
    /// The terminal shell. `None` tries `$SHELL`, then zsh, bash, and sh.
    pub shell: Option<PathBuf>,
}
impl RuntimeConfig {
    pub fn from_environment() -> Result<Self> {
        let data_dir = std::env::var_os("Z1_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .unwrap_or_default()
                    .join(".z1")
            });
        Ok(Self {
            data_dir,
            codex_binary: vcs::installed_binary("codex", "Z1_CODEX_BIN"),
            gh_binary: vcs::installed_binary("gh", "Z1_GH_BIN"),
            network_timeout: Duration::from_secs(180),
            shell: std::env::var_os("Z1_SHELL").map(PathBuf::from),
        })
    }
}
type Reply<T> = oneshot::Sender<Result<T>>;
enum Location {
    Repository(PathBuf),
    Folder(PathBuf),
    Unassigned,
    /// A worktree thread whose checkout no longer exists on disk. `root` is the workspace root.
    Removed {
        root: PathBuf,
        branch: String,
    },
}
impl Location {
    fn repository(self) -> Result<PathBuf> {
        match self {
            Self::Repository(root) => Ok(root),
            Self::Removed { .. } => Err(worktree_removed()),
            Self::Folder(_) | Self::Unassigned => Err(not_repository()),
        }
    }
}
/// Why a checkout path is temporarily closed to new turns and switches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hold {
    Switch,
    Cleanup,
    Restore,
    Git,
    PullRequest,
    Naming,
}
impl Hold {
    fn refusal(self) -> AppError {
        AppError::new(
            "checkout_busy",
            match self {
                Self::Naming => "Z1 is naming this worktree branch. Try again in a moment.",
                Self::PullRequest => {
                    "A pull request operation is using this checkout. Wait for its result."
                }
                Self::Switch => "Z1 is switching this checkout's branch. Try again in a moment.",
                Self::Cleanup => "Z1 is removing this inactive worktree. Try again in a moment.",
                Self::Restore => "Z1 is restoring this thread's worktree. Try again in a moment.",
                Self::Git => {
                    "A Git action is running in this checkout. Try again when it finishes."
                }
            },
        )
    }
    fn lease_refusal(self) -> AppError {
        match self {
            Self::Git => AppError::new(
                "checkout_busy",
                "Codex is working in this checkout. Git actions return when the turn finishes.",
            ),
            Self::Switch | Self::Cleanup | Self::Restore | Self::PullRequest | Self::Naming => {
                turn_running()
            }
        }
    }
}
fn turn_running() -> AppError {
    AppError::new(
        "checkout_busy",
        "Another conversation is running in this checkout.",
    )
}
fn worktree_removed() -> AppError {
    AppError::new(
        "worktree_removed",
        "Send a message to restore this thread's worktree first.",
    )
}
/// What `App::submit` recreates before the actor accepts the turn.
struct Restore {
    root: PathBuf,
    path: PathBuf,
    branch: String,
}
fn scratch_unavailable() -> AppError {
    AppError::new(
        "scratch_unavailable",
        "Threads without a project are unavailable while the data directory is inside a Git repository.",
    )
}
fn not_repository() -> AppError {
    AppError::new(
        "not_repository",
        "Threads without a project have no Git branches.",
    )
}
enum Command {
    List(Reply<Vec<Workspace>>),
    PrList(ThreadId, bool, Reply<ThreadPrSummary>),
    PrLink(ThreadId, PullRequestKey, Reply<ThreadPrSummary>),
    PrUnlink(ThreadId, PullRequestKey, Reply<ThreadPrSummary>),
    RunGit(
        WorkspaceId,
        Option<ThreadId>,
        GitAction,
        Box<dyn Fn(GitPhase) + Send + Sync>,
        Reply<GitOutcome>,
    ),
    OpenWorkspace(PathBuf, Reply<Workspace>),
    EnsureScratch(PathBuf, Reply<Workspace>),
    RenameWorkspace(WorkspaceId, String, Reply<Workspace>),
    RemoveWorkspace(WorkspaceId, Reply<()>),
    Checkout(WorkspaceId, Option<ThreadId>, Reply<(Workspace, Location)>),
    PrRead(ThreadId, PullRequestKey, Reply<PrReviewDetail>),
    PrChange(ThreadId, PrReviewChange, Reply<PrChangeResult>),
    PrReconcile(ThreadId, PullRequestKey, String, Reply<PrChangeResult>),
    PrAcknowledgeUpdate(ThreadId, AcknowledgeUncertainUpdate, Reply<PrChangeResult>),
    PrOperations(ThreadId, PullRequestKey, Reply<Vec<PrOperation>>),
    SetReviewDisposition(
        ThreadId,
        PullRequestKey,
        SetReviewDisposition,
        Reply<Option<SavedDisposition>>,
    ),
    Claim(WorkspaceId, Option<ThreadId>, Hold, Reply<PathBuf>),
    Release(PathBuf, Option<(ThreadId, String)>, Reply<()>),
    Threads(WorkspaceId, Reply<Vec<ThreadSummary>>),
    Create(WorkspaceId, Checkout, Reply<ThreadSnapshot>),
    Snapshot(ThreadId, bool, Reply<ThreadSnapshot>),
    Models(Reply<Vec<ModelOption>>),
    UsageLimits(bool, Reply<UsageLimits>),
    Settings(ThreadId, SessionSettings, Reply<ThreadSnapshot>),
    /// The path carries a `Hold::Restore` to release in the same step as acceptance.
    Submit(ThreadId, String, String, Option<PathBuf>, Reply<Receipt>),
    Approval(ApprovalId, ApprovalDecision, Reply<()>),
    Interrupt(ThreadId, Reply<()>),
    Arrange(ThreadId, Arrange, Reply<()>),
    AutoSettle(settings::AutoSettle, Reply<()>),
    UiState(Reply<BTreeMap<String, String>>),
    SetUiState(String, Option<String>, Reply<()>),
    CleanupCandidates(Reply<(Vec<Candidate>, Vec<PathBuf>)>),
    ClaimCleanup(Candidate, Reply<()>),
    ReleaseCleanup(Candidate, bool, Reply<()>),
    ClaimRestore(ThreadId, Reply<Option<Restore>>),
    ReleaseRestore(PathBuf, Reply<()>),
    Shutdown(Reply<()>),
}
#[derive(Clone)]
pub struct App {
    commands: mpsc::Sender<Command>,
    changes: broadcast::Sender<ChangeHint>,
    limits: watch::Receiver<Option<UsageLimits>>,
    worktrees: PathBuf,
    scratch: Option<PathBuf>,
    settings: PathBuf,
    sweeps: Arc<Mutex<()>>,
    wake: Arc<Notify>,
    gh: PathBuf,
    terminals: Terminals,
}
impl App {
    pub async fn open(config: RuntimeConfig) -> Result<Self> {
        let store = Store::open(&config.data_dir)?;
        let workspaces = store
            .workspaces()?
            .into_iter()
            .map(|w| (w.id.clone(), w))
            .collect();
        // A scratch folder inside a work tree would inherit that repository's status.
        let scratch = if repo::inside_work_tree(&config.data_dir) {
            None
        } else {
            Some(config.data_dir.canonicalize()?.join("scratch"))
        };
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
        let worktrees = config.data_dir.join("worktrees");
        let gh = config.gh_binary.clone();
        let terminals = Terminals::new(config.shell.clone());
        let settings = config.data_dir.join("settings.json");
        let auto_settle = settings::auto_settle(&settings);
        let (commands, rx) = mpsc::channel(128);
        let (changes, _) = broadcast::channel(256);
        let (limits, limits_rx) = watch::channel(None);
        let (provider_events, signals) = mpsc::channel(512);
        let (done, completions) = mpsc::channel(128);
        let prs = PrWork::load(&mut store)?;
        tokio::spawn(
            Owner {
                prs,
                review_work: {
                    let mut work = ReviewWork::new();
                    work.pending = store
                        .pending_lifecycle_operations()?
                        .into_iter()
                        .map(|operation| (operation.input.request_id.clone(), operation))
                        .collect();
                    work
                },
                naming: naming::Naming::default(),
                git_jobs: tokio::task::JoinSet::new(),
                config,
                store,
                workspaces,
                threads,
                auto_settle,
                leases: HashMap::new(),
                held: HashMap::new(),
                routes: HashMap::new(),
                provider: None,
                epoch: 0,
                launching: false,
                pending: vec![],
                models: None,
                model_waiters: vec![],
                listing_models: false,
                limits,
                limit_waiters: vec![],
                reading_limits: false,
                dirty: HashSet::new(),
                changes: changes.clone(),
                provider_events,
                done,
            }
            .run(rx, signals, completions),
        );
        let app = Self {
            commands,
            changes,
            limits: limits_rx,
            worktrees,
            scratch,
            settings,
            sweeps: Arc::new(Mutex::new(())),
            wake: Arc::new(Notify::new()),
            gh,
            terminals,
        };
        tokio::spawn(Sweeper::from(&app).run(
            app.commands.downgrade(),
            app.sweeps.clone(),
            app.wake.clone(),
        ));
        Ok(app)
    }
    async fn call<T>(&self, build: impl FnOnce(Reply<T>) -> Command) -> Result<T> {
        call(&self.commands, build).await
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
    pub fn scratch_available(&self) -> bool {
        self.scratch.is_some()
    }
    pub async fn ensure_scratch(&self) -> Result<Workspace> {
        let root = self.scratch.clone().ok_or_else(scratch_unavailable)?;
        self.call(|r| Command::EnsureScratch(root, r)).await
    }
    pub async fn rename_workspace(&self, id: WorkspaceId, label: String) -> Result<Workspace> {
        self.call(|r| Command::RenameWorkspace(id, label, r)).await
    }
    /// Deletes the project entry and its threads and closes its terminals. Files on disk are left alone.
    pub async fn remove_workspace(&self, id: WorkspaceId) -> Result<()> {
        self.call(|r| Command::RemoveWorkspace(id.clone(), r))
            .await?;
        self.close_terminals(move |key| key.workspace == id).await
    }
    async fn checkout(
        &self,
        id: WorkspaceId,
        thread: Option<ThreadId>,
    ) -> Result<(Workspace, Location)> {
        self.call(|r| Command::Checkout(id, thread, r)).await
    }
    pub async fn workspace_view(
        &self,
        id: WorkspaceId,
        thread: Option<ThreadId>,
    ) -> Result<WorkspaceView> {
        let (w, location) = self.checkout(id.clone(), thread).await?;
        let threads = self.call(|r| Command::Threads(id, r)).await?;
        tokio::task::spawn_blocking(move || match location {
            Location::Repository(root) => repo::inspect(Workspace { root, ..w }, threads),
            Location::Folder(root) => repo::inspect_folder(Workspace { root, ..w }, threads),
            Location::Unassigned => Ok(WorkspaceView {
                workspace: w,
                branch: String::new(),
                files: vec![],
                changes: vec![],
                threads,
                unavailable: None,
            }),
            Location::Removed { branch, .. } => Ok(WorkspaceView {
                workspace: w,
                branch,
                files: vec![],
                changes: vec![],
                threads,
                unavailable: Some(WORKTREE_REMOVED.into()),
            }),
        })
        .await
        .map_err(|e| AppError::new("repository", e))?
    }
    pub async fn read_file(
        &self,
        id: WorkspaceId,
        thread: Option<ThreadId>,
        path: String,
    ) -> Result<FileView> {
        let root = match self.checkout(id, thread).await?.1 {
            Location::Repository(root) | Location::Folder(root) => root,
            Location::Unassigned => {
                return Err(AppError::new(
                    "missing_folder",
                    "Start a thread to see its files.",
                ));
            }
            Location::Removed { .. } => {
                return Ok(FileView::Unavailable {
                    reason: WORKTREE_REMOVED.into(),
                });
            }
        };
        tokio::task::spawn_blocking(move || repo::read_file(&root, &path))
            .await
            .map_err(|e| AppError::new("repository", e))?
    }
    pub async fn read_diff(
        &self,
        id: WorkspaceId,
        thread: Option<ThreadId>,
        path: String,
        basis: DiffBasis,
    ) -> Result<DiffView> {
        let root = match self.checkout(id, thread).await?.1 {
            Location::Repository(root) => root,
            Location::Removed { .. } => {
                return Ok(DiffView::Unavailable {
                    reason: WORKTREE_REMOVED.into(),
                });
            }
            Location::Folder(_) | Location::Unassigned => {
                return Ok(DiffView::Unavailable {
                    reason: "Threads without a project have no Git diff.".into(),
                });
            }
        };
        tokio::task::spawn_blocking(move || repo::diff(&root, &path, basis))
            .await
            .map_err(|e| AppError::new("repository", e))?
    }
    pub async fn list_branches(
        &self,
        id: WorkspaceId,
        thread: Option<ThreadId>,
    ) -> Result<Branches> {
        let (root, removed) = match self.checkout(id, thread).await?.1 {
            Location::Repository(root) => (root, None),
            Location::Removed { root, branch } => (root, Some(branch)),
            Location::Folder(_) | Location::Unassigned => return Err(not_repository()),
        };
        let mut branches = tokio::task::spawn_blocking(move || repo::branches(&root))
            .await
            .map_err(|e| AppError::new("repository", e))??;
        if let Some(branch) = removed {
            for b in &mut branches.branches {
                b.current = !b.remote && b.name == branch;
            }
        }
        Ok(branches)
    }
    pub async fn switch_branch(
        &self,
        id: WorkspaceId,
        thread: Option<ThreadId>,
        branch: String,
        create: bool,
    ) -> Result<()> {
        let root = self
            .call(|r| Command::Claim(id, thread.clone(), Hold::Switch, r))
            .await?;
        let path = root.clone();
        let switched =
            tokio::task::spawn_blocking(move || repo::switch_branch(&path, &branch, create))
                .await
                .map_err(|e| AppError::new("repository", e))
                .and_then(|r| r);
        let current = switched.as_ref().ok().cloned();
        self.call(|r| Command::Release(root, thread.zip(current), r))
            .await?;
        switched.map(drop)
    }
    pub async fn git_status(&self, id: WorkspaceId, thread: Option<ThreadId>) -> Result<GitStatus> {
        let root = self.checkout(id, thread).await?.1.repository()?;
        vcs::status(&root).await
    }
    pub async fn read_pull_request(
        &self,
        thread: ThreadId,
        key: PullRequestKey,
    ) -> Result<PrReviewDetail> {
        self.call(|reply| Command::PrRead(thread, key, reply)).await
    }
    pub async fn change_pull_request(
        &self,
        thread: ThreadId,
        input: PrReviewChange,
    ) -> Result<PrChangeResult> {
        self.call(|reply| Command::PrChange(thread, input, reply))
            .await
    }
    pub async fn pull_request_operations(
        &self,
        thread: ThreadId,
        key: PullRequestKey,
    ) -> Result<Vec<PrOperation>> {
        self.call(|reply| Command::PrOperations(thread, key, reply))
            .await
    }
    pub async fn acknowledge_uncertain_update(
        &self,
        thread: ThreadId,
        input: AcknowledgeUncertainUpdate,
    ) -> Result<PrChangeResult> {
        self.call(|reply| Command::PrAcknowledgeUpdate(thread, input, reply))
            .await
    }
    pub async fn reconcile_pull_request(
        &self,
        thread: ThreadId,
        key: PullRequestKey,
        request_id: String,
    ) -> Result<PrChangeResult> {
        self.call(|reply| Command::PrReconcile(thread, key, request_id, reply))
            .await
    }
    pub async fn set_review_disposition(
        &self,
        thread: ThreadId,
        key: PullRequestKey,
        input: SetReviewDisposition,
    ) -> Result<Option<SavedDisposition>> {
        self.call(|reply| Command::SetReviewDisposition(thread, key, input, reply))
            .await
    }
    /// The open pull request for `branch`. gh problems come back as `PrLookup::Unavailable`.
    pub async fn current_branch_pull_request(
        &self,
        id: WorkspaceId,
        thread: Option<ThreadId>,
        branch: String,
    ) -> Result<PrLookup> {
        let root = self.checkout(id, thread).await?.1.repository()?;
        let (path, name) = (root.clone(), branch.clone());
        tokio::task::spawn_blocking(move || repo::branch_name(&path, &name))
            .await
            .map_err(|e| AppError::new("repository", e))??;
        Ok(crate::pull_requests::current_branch(&self.gh, &root, &branch).await)
    }
    /// Runs a Git action on a thread's checkout, holding it against turns and other mutations.
    /// `Err` means the action never started. `progress` hears each step as it starts.
    pub async fn run_git_action(
        &self,
        id: WorkspaceId,
        thread: Option<ThreadId>,
        action: GitAction,
        progress: impl Fn(GitPhase) + Send + Sync + 'static,
    ) -> Result<GitOutcome> {
        self.call(|reply| Command::RunGit(id, thread, action, Box::new(progress), reply))
            .await
    }

    pub async fn list_thread_pull_requests(
        &self,
        id: ThreadId,
        refresh: bool,
    ) -> Result<ThreadPrSummary> {
        self.call(|r| Command::PrList(id, refresh, r)).await
    }
    pub async fn link_pull_request(&self, id: ThreadId, url: String) -> Result<ThreadPrSummary> {
        let key = PullRequestKey::from_url(&url)?;
        self.call(|r| Command::PrLink(id, key, r)).await
    }
    pub async fn unlink_pull_request(
        &self,
        id: ThreadId,
        key: PullRequestKey,
    ) -> Result<ThreadPrSummary> {
        self.call(|r| Command::PrUnlink(id, key, r)).await
    }
    pub async fn create_thread(
        &self,
        id: WorkspaceId,
        checkout: NewCheckout,
    ) -> Result<ThreadSnapshot> {
        let (w, _) = self.checkout(id.clone(), None).await?;
        let checkout = match (w.kind, checkout) {
            (WorkspaceKind::Repository, NewCheckout::Local) => Checkout::Local,
            (WorkspaceKind::Repository, NewCheckout::Worktree { base, from_origin }) => {
                let worktrees = self.worktrees.join(&w.label);
                tokio::task::spawn_blocking(move || {
                    repo::add_worktree(&w.root, &worktrees, &base, from_origin)
                })
                .await
                .map_err(|e| AppError::new("repository", e))??
            }
            (WorkspaceKind::Scratch, NewCheckout::Folder { prompt }) => {
                if self.scratch.is_none() {
                    return Err(scratch_unavailable());
                }
                tokio::task::spawn_blocking(move || repo::add_folder(&w.root, &prompt))
                    .await
                    .map_err(|e| AppError::new("repository", e))??
            }
            (WorkspaceKind::Repository, NewCheckout::Folder { .. })
            | (WorkspaceKind::Scratch, NewCheckout::Local | NewCheckout::Worktree { .. }) => {
                return Err(AppError::new(
                    "invalid_checkout",
                    "This checkout does not belong to this workspace.",
                ));
            }
        };
        self.call(|r| Command::Create(id, checkout, r)).await
    }
    pub async fn thread(&self, id: ThreadId) -> Result<ThreadSnapshot> {
        self.call(|r| Command::Snapshot(id, false, r)).await
    }
    pub async fn open_thread(&self, id: ThreadId) -> Result<ThreadSnapshot> {
        self.call(|r| Command::Snapshot(id, true, r)).await
    }
    pub async fn models(&self) -> Result<Vec<ModelOption>> {
        self.call(Command::Models).await
    }
    pub async fn usage_limits(&self, refresh: bool) -> Result<UsageLimits> {
        self.call(|r| Command::UsageLimits(refresh, r)).await
    }
    pub fn watch_usage_limits(&self) -> watch::Receiver<Option<UsageLimits>> {
        self.limits.clone()
    }
    pub async fn update_settings(
        &self,
        id: ThreadId,
        settings: SessionSettings,
    ) -> Result<ThreadSnapshot> {
        self.call(|r| Command::Settings(id, settings, r)).await
    }
    pub async fn submit(&self, id: ThreadId, request_id: String, text: String) -> Result<Receipt> {
        let restored = match self.call(|r| Command::ClaimRestore(id.clone(), r)).await? {
            Some(Restore { root, path, branch }) => {
                let target = path.clone();
                let restored =
                    tokio::task::spawn_blocking(move || cleanup::restore(&root, &target, &branch))
                        .await
                        .map_err(|e| AppError::new("worktree_restore", e))
                        .and_then(|r| r);
                if let Err(e) = restored {
                    let _ = self.call(|r| Command::ReleaseRestore(path, r)).await;
                    return Err(e);
                }
                Some(path)
            }
            None => None,
        };
        self.call(|r| Command::Submit(id, request_id, text, restored, r))
            .await
    }
    pub async fn answer_approval(&self, id: ApprovalId, decision: ApprovalDecision) -> Result<()> {
        self.call(|r| Command::Approval(id, decision, r)).await
    }
    pub async fn interrupt(&self, id: ThreadId) -> Result<()> {
        self.call(|r| Command::Interrupt(id, r)).await
    }
    pub async fn arrange(&self, id: ThreadId, action: Arrange) -> Result<()> {
        self.call(|r| Command::Arrange(id, action, r)).await
    }
    pub async fn ui_state(&self) -> Result<BTreeMap<String, String>> {
        self.call(Command::UiState).await
    }
    pub async fn set_ui_state(&self, key: String, value: Option<String>) -> Result<()> {
        self.call(|r| Command::SetUiState(key, value, r)).await
    }
    pub fn settings(&self) -> Result<Option<String>> {
        settings::read(&self.settings)
    }
    pub async fn save_settings(&self, text: &str) -> Result<()> {
        settings::write(&self.settings, text)?;
        self.wake.notify_one();
        let rules = settings::auto_settle(&self.settings);
        self.call(|r| Command::AutoSettle(rules, r)).await
    }
    pub async fn shutdown(&self) -> Result<()> {
        self.close_terminals(|_| true).await?;
        self.call(Command::Shutdown).await
    }
    /// Subscribes `on_event` to a terminal, starting its shell in the checkout when none runs.
    /// The first event is a history snapshot. Returns the subscription for `terminal_detach`.
    pub async fn terminal_attach(
        &self,
        workspace_id: WorkspaceId,
        thread_id: Option<ThreadId>,
        terminal_id: TerminalId,
        cols: u16,
        rows: u16,
        on_event: impl Fn(TerminalEvent) + Send + Sync + 'static,
    ) -> Result<u64> {
        let size = TerminalSize::new(cols, rows)?;
        let key = TerminalKey {
            workspace: workspace_id.clone(),
            thread: thread_id.clone(),
            terminal: terminal_id,
        };
        let sink: Sink = Arc::new(on_event);
        let terminals = self.terminals.clone();
        let attach = move |cwd: Option<PathBuf>| {
            let (terminals, key, sink) = (terminals.clone(), key.clone(), sink.clone());
            async move {
                tokio::task::spawn_blocking(move || {
                    terminals.attach(key, cwd.as_deref(), size, sink)
                })
                .await
                .map_err(|e| AppError::new("terminal", e))?
            }
        };
        if let Some(subscription) = attach(None).await? {
            return Ok(subscription);
        }
        let cwd = match self.checkout(workspace_id, thread_id).await?.1 {
            Location::Repository(root) | Location::Folder(root) => root,
            Location::Removed { .. } => return Err(worktree_removed()),
            Location::Unassigned => {
                return Err(AppError::new(
                    "terminal_unavailable",
                    "Start a thread to open a terminal.",
                ));
            }
        };
        attach(Some(cwd))
            .await?
            .ok_or_else(|| AppError::new("terminal", "The terminal did not start."))
    }
    /// Stops sending events to a subscription. The shell keeps running.
    pub fn terminal_detach(&self, subscription: u64) {
        self.terminals.detach(subscription);
    }
    /// Writes input to a terminal. Writing to a terminal that is not running does nothing.
    pub async fn terminal_write(
        &self,
        workspace_id: WorkspaceId,
        thread_id: Option<ThreadId>,
        terminal_id: TerminalId,
        data: String,
    ) -> Result<()> {
        if data.is_empty() || data.len() > MAX_WRITE_BYTES {
            return Err(AppError::new(
                "invalid_terminal_input",
                format!("Terminal input is 1 to {MAX_WRITE_BYTES} bytes."),
            ));
        }
        let key = TerminalKey {
            workspace: workspace_id,
            thread: thread_id,
            terminal: terminal_id,
        };
        let terminals = self.terminals.clone();
        tokio::task::spawn_blocking(move || terminals.write(&key, data.as_bytes()))
            .await
            .map_err(|e| AppError::new("terminal", e))?
    }
    pub fn terminal_resize(
        &self,
        workspace_id: WorkspaceId,
        thread_id: Option<ThreadId>,
        terminal_id: TerminalId,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        let size = TerminalSize::new(cols, rows)?;
        self.terminals.resize(
            &TerminalKey {
                workspace: workspace_id,
                thread: thread_id,
                terminal: terminal_id,
            },
            size,
        )
    }
    /// Kills the terminal's shell and forgets its history. Closing a missing terminal does nothing.
    pub async fn terminal_close(
        &self,
        workspace_id: WorkspaceId,
        thread_id: Option<ThreadId>,
        terminal_id: TerminalId,
    ) -> Result<()> {
        let key = TerminalKey {
            workspace: workspace_id,
            thread: thread_id,
            terminal: terminal_id,
        };
        self.close_terminals(move |k| *k == key).await
    }
    async fn close_terminals(
        &self,
        matches: impl Fn(&TerminalKey) -> bool + Send + 'static,
    ) -> Result<()> {
        let terminals = self.terminals.clone();
        tokio::task::spawn_blocking(move || terminals.close(matches))
            .await
            .map_err(|e| AppError::new("terminal", e))
    }
    /// Runs one worktree cleanup sweep as if the clock read `now_ms`.
    #[doc(hidden)]
    pub async fn sweep_worktrees_at(&self, now_ms: u64) {
        let _serialized = self.sweeps.lock().await;
        let _ = Sweeper::from(self).sweep(&self.commands, now_ms).await;
    }
}
/// Worktree cleanup: once at startup, hourly, and after every settings save.
struct Sweeper {
    worktrees: PathBuf,
    settings: PathBuf,
}
impl From<&App> for Sweeper {
    fn from(app: &App) -> Self {
        Self {
            worktrees: app.worktrees.clone(),
            settings: app.settings.clone(),
        }
    }
}
impl Sweeper {
    /// Holds only a weak command sender so the loop never keeps the actor alive.
    async fn run(
        self,
        commands: mpsc::WeakSender<Command>,
        sweeps: Arc<Mutex<()>>,
        wake: Arc<Notify>,
    ) {
        let mut hourly = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tokio::select! {
                _ = hourly.tick() => {}
                _ = wake.notified() => {}
            }
            let Some(commands) = commands.upgrade() else {
                return;
            };
            let _serialized = sweeps.lock().await;
            if self.sweep(&commands, now_ms()).await.is_err() {
                return;
            }
        }
    }
    /// Errors only when the runtime is closed. Every other failure is logged and skipped.
    async fn sweep(&self, commands: &mpsc::Sender<Command>, now: u64) -> Result<()> {
        let rules = settings::cleanup_rules(&self.settings);
        if !rules.enabled() {
            return Ok(());
        }
        let (candidates, roots) = call(commands, Command::CleanupCandidates).await?;
        if candidates.is_empty() {
            return Ok(());
        }
        let (worktrees, roots) = (Arc::new(self.worktrees.clone()), Arc::new(roots));
        let eligible = {
            let (worktrees, roots) = (worktrees.clone(), roots.clone());
            tokio::task::spawn_blocking(move || {
                Sweep {
                    worktrees: &worktrees,
                    roots: &roots,
                    rules,
                    now,
                }
                .evaluate(candidates)
            })
            .await
            .unwrap_or_default()
        };
        for eligible in eligible {
            let candidate = eligible.candidate.clone();
            if let Err(e) = call(commands, |r| Command::ClaimCleanup(candidate.clone(), r)).await {
                if e.code == "closed" {
                    return Err(e);
                }
                eprintln!(
                    "z1 storage cleanup: skipped {} ({})",
                    candidate.path.display(),
                    e.message
                );
                continue;
            }
            let (worktrees, roots, settings) =
                (worktrees.clone(), roots.clone(), self.settings.clone());
            let removed = tokio::task::spawn_blocking(move || {
                Sweep {
                    worktrees: &worktrees,
                    roots: &roots,
                    rules: settings::cleanup_rules(&settings),
                    now,
                }
                .remove(&eligible)
            })
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
            match &removed {
                Ok(()) => eprintln!(
                    "z1 storage cleanup: removed {} for thread {}",
                    candidate.path.display(),
                    candidate.thread
                ),
                Err(reason) => eprintln!(
                    "z1 storage cleanup: kept {} ({reason})",
                    candidate.path.display()
                ),
            }
            call(commands, |r| {
                Command::ReleaseCleanup(candidate, removed.is_ok(), r)
            })
            .await?;
        }
        Ok(())
    }
}
async fn call<T>(
    commands: &mpsc::Sender<Command>,
    build: impl FnOnce(Reply<T>) -> Command,
) -> Result<T> {
    let (tx, rx) = oneshot::channel();
    commands
        .send(build(tx))
        .await
        .map_err(|_| AppError::new("closed", "Z1 runtime is closed."))?;
    rx.await
        .map_err(|_| AppError::new("closed", "Z1 runtime is closed."))?
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
    Models {
        epoch: u64,
        result: Result<Vec<ModelOption>>,
    },
    Limits {
        epoch: u64,
        result: Result<UsageLimits>,
    },
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
struct GitCompletion {
    root: PathBuf,
    origin: Option<(ThreadId, u64)>,
    result: Result<GitOutcome>,
    reply: Reply<GitOutcome>,
}
struct Owner {
    naming: naming::Naming,
    prs: PrWork,
    review_work: ReviewWork,
    git_jobs: tokio::task::JoinSet<GitCompletion>,
    config: RuntimeConfig,
    store: Store,
    workspaces: HashMap<WorkspaceId, Workspace>,
    threads: HashMap<ThreadId, ThreadSnapshot>,
    auto_settle: settings::AutoSettle,
    leases: HashMap<PathBuf, ThreadId>,
    held: HashMap<PathBuf, Hold>,
    routes: HashMap<ApprovalId, Route>,
    provider: Option<Codex>,
    epoch: u64,
    launching: bool,
    pending: Vec<Prepare>,
    models: Option<Vec<ModelOption>>,
    model_waiters: Vec<Reply<Vec<ModelOption>>>,
    listing_models: bool,
    limits: watch::Sender<Option<UsageLimits>>,
    limit_waiters: Vec<Reply<UsageLimits>>,
    reading_limits: bool,
    dirty: HashSet<ThreadId>,
    changes: broadcast::Sender<ChangeHint>,
    provider_events: mpsc::Sender<Signal>,
    done: mpsc::Sender<Completion>,
}
impl Owner {
    fn finish_git_job(
        &mut self,
        completion: std::result::Result<GitCompletion, tokio::task::JoinError>,
        refresh: bool,
    ) -> Result<()> {
        let GitCompletion {
            root,
            origin,
            mut result,
            reply,
        } = completion.map_err(|error| AppError::new("git_worker", error))?;
        let mut saved = Ok(());
        if let (Some((id, generation)), Ok(outcome)) = (&origin, &mut result)
            && self.pr_generation(id) == *generation
            && let Some(opened) = &outcome.pr
        {
            let source = if opened.created {
                PrLinkSource::GitCreated
            } else {
                PrLinkSource::GitReused
            };
            if let Err(error) = PullRequestKey::from_url(&opened.pr.url)
                .and_then(|key| self.pr_membership(id, key, Some(source)))
            {
                saved = Err(error.clone());
                outcome.failure = Some(GitFailure {
                    phase: GitPhase::Pr,
                    error,
                });
            }
        }
        self.held.remove(&root);
        if refresh && let Some((id, _)) = origin {
            let _ = self.refresh_prs(&id, true, PrLinkSource::BranchDiscovery);
        }
        let _ = reply.send(result);
        saved
    }
    fn claim_checkout(
        &mut self,
        id: &WorkspaceId,
        thread: Option<ThreadId>,
        hold: Hold,
    ) -> Result<PathBuf> {
        self.checkout(id, thread).and_then(|(_, location)| {
            let root = location.repository()?;
            if let Some(held) = self.held.get(&root) {
                return Err(held.refusal());
            }
            if self.leases.contains_key(&root) {
                return Err(hold.lease_refusal());
            }
            self.invalidate_names(&root);
            self.held.insert(root.clone(), hold);
            Ok(root)
        })
    }
    fn workspace(&self, id: &WorkspaceId) -> Result<&Workspace> {
        self.workspaces
            .get(id)
            .ok_or_else(|| AppError::new("missing_workspace", "Repository not found."))
    }
    fn rename_workspace(&mut self, id: &WorkspaceId, label: &str) -> Result<Workspace> {
        let mut w = self.workspace(id)?.clone();
        if w.kind == WorkspaceKind::Scratch {
            return Err(AppError::new(
                "invalid_workspace",
                "Threads without a project cannot be renamed.",
            ));
        }
        let label = label.trim();
        if label.is_empty() {
            return Err(AppError::new(
                "invalid_label",
                "Project name cannot be empty.",
            ));
        }
        w.label = label.into();
        self.store.update_workspace(&w)?;
        self.workspaces.insert(w.id.clone(), w.clone());
        Ok(w)
    }
    fn remove_workspace(&mut self, id: &WorkspaceId) -> Result<()> {
        let w = self.workspace(id)?;
        let threads: Vec<&ThreadSnapshot> = self
            .threads
            .values()
            .filter(|t| &t.workspace_id == id)
            .collect();
        let owns = |thread: &ThreadId| threads.iter().any(|t| &t.id == thread);
        let busy = threads.iter().any(|t| {
            matches!(
                t.session,
                SessionState::Connecting | SessionState::Running | SessionState::Interrupting
            ) || self.held.contains_key(t.root(w))
        }) || self.held.contains_key(&w.root)
            || self.leases.values().any(owns)
            || self.pending.iter().any(|job| owns(job.thread()));
        if busy {
            return Err(AppError::new(
                "busy",
                "Stop this project's running conversations before removing it.",
            ));
        }
        let removed: HashSet<ThreadId> = threads.iter().map(|t| t.id.clone()).collect();
        self.store.remove_workspace(id)?;
        for id in &removed {
            self.cancel_name(id);
        }
        self.forget_pr_threads(&removed);
        self.threads.retain(|id, _| !removed.contains(id));
        self.dirty.retain(|id| !removed.contains(id));
        self.routes
            .retain(|_, route| !removed.contains(&route.thread));
        self.workspaces.remove(id);
        Ok(())
    }
    fn thread(&self, id: &ThreadId) -> Result<&ThreadSnapshot> {
        self.threads
            .get(id)
            .ok_or_else(|| AppError::new("missing_thread", "Conversation not found."))
    }
    fn checkout(
        &self,
        id: &WorkspaceId,
        thread: Option<ThreadId>,
    ) -> Result<(Workspace, Location)> {
        let w = self.workspace(id)?;
        let location = match thread {
            None if w.kind == WorkspaceKind::Scratch => Location::Unassigned,
            None => Location::Repository(w.root.clone()),
            Some(thread) => {
                let t = self.thread(&thread)?;
                if &t.workspace_id != id {
                    return Err(AppError::new(
                        "missing_thread",
                        "Conversation not found in this repository.",
                    ));
                }
                match &t.checkout {
                    Checkout::Folder { path } => Location::Folder(path.clone()),
                    Checkout::Worktree { path, branch } if !path.exists() => Location::Removed {
                        root: w.root.clone(),
                        branch: branch.clone(),
                    },
                    Checkout::Local | Checkout::Worktree { .. } => {
                        Location::Repository(t.root(w).to_path_buf())
                    }
                }
            }
        };
        Ok((w.clone(), location))
    }
    /// A thread with no running turn, no open approval, and no job or hold on its checkout.
    fn idle(&self, t: &ThreadSnapshot, root: &Path) -> bool {
        !matches!(
            t.session,
            SessionState::Connecting | SessionState::Running | SessionState::Interrupting
        ) && !t
            .approvals
            .iter()
            .any(|a| matches!(a.state, ApprovalState::Pending | ApprovalState::Answering))
            && !self.leases.contains_key(root)
            && !self.pending.iter().any(|job| job.thread() == &t.id)
            && !self.held.contains_key(root)
    }
    fn owners(&self, path: &Path) -> usize {
        self.threads
            .values()
            .filter(|t| t.root(&self.workspaces[&t.workspace_id]) == path)
            .count()
    }
    /// The thread as a cleanup candidate, or `None` when it is not an idle, sole-owner worktree thread.
    fn candidate(&self, t: &ThreadSnapshot) -> Option<Candidate> {
        let Checkout::Worktree { path, branch } = &t.checkout else {
            return None;
        };
        let w = &self.workspaces[&t.workspace_id];
        (self.owners(path) == 1 && self.idle(t, path)).then(|| Candidate {
            thread: t.id.clone(),
            workspace_root: w.root.clone(),
            path: path.clone(),
            branch: branch.clone(),
            activity: t
                .turns
                .iter()
                .flat_map(|turn| [turn.started_at_ms, turn.completed_at_ms])
                .flatten()
                .max(),
        })
    }
    fn claim_cleanup(&mut self, candidate: &Candidate) -> Result<()> {
        let t = self.thread(&candidate.thread)?;
        if self.candidate(t).as_ref() != Some(candidate) {
            return Err(AppError::new(
                "cleanup_refused",
                "the thread changed since the sweep began",
            ));
        }
        self.invalidate_names(&candidate.path);
        self.held.insert(candidate.path.clone(), Hold::Cleanup);
        Ok(())
    }
    fn release_cleanup(&mut self, candidate: &Candidate, removed: bool) {
        self.held.remove(&candidate.path);
        if removed && let Ok(t) = self.thread(&candidate.thread) {
            let _ = self.changes.send(ChangeHint {
                refresh_workspace: true,
                ..self.thread_hint(t)
            });
        }
    }
    fn claim_restore(&mut self, id: &ThreadId) -> Result<Option<Restore>> {
        let t = self.thread(id)?;
        let Checkout::Worktree { path, branch } = &t.checkout else {
            return Ok(None);
        };
        if path.exists() {
            return Ok(None);
        }
        match self.held.get(path) {
            Some(Hold::Cleanup) => return Err(Hold::Cleanup.refusal()),
            Some(_) => return Ok(None),
            None => {}
        }
        let busy = self.leases.contains_key(path)
            || matches!(
                t.session,
                SessionState::Connecting | SessionState::Running | SessionState::Interrupting
            );
        if busy {
            return Ok(None);
        }
        let restore = Restore {
            root: self.workspaces[&t.workspace_id].root.clone(),
            path: path.clone(),
            branch: branch.clone(),
        };
        self.invalidate_names(&restore.path);
        self.held.insert(restore.path.clone(), Hold::Restore);
        Ok(Some(restore))
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
        let hint = self.thread_hint(&self.threads[id]);
        let _ = self.changes.send(hint);
        Ok(())
    }
    fn install(&mut self, mut next: ThreadSnapshot) -> Result<()> {
        next.stamp_completions();
        next.revision += 1;
        self.store.save(&next)?;
        let hint = self.thread_hint(&next);
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
        let ids: Vec<_> = self.threads.keys().cloned().collect();
        for id in ids {
            self.schedule_discovery(&id, PrLinkSource::BranchDiscovery);
        }
        self.poll_prs();
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
                        commands.close();
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
                Some(done)=self.naming.active.join_next(), if !self.naming.active.is_empty()=>{
                    self.finish_name(done);
                }
                Some(done)=self.git_jobs.join_next(), if !self.git_jobs.is_empty()=>{
                    if let Err(error)=self.finish_git_job(done, true) { eprintln!("Git completion failed: {}", error.message); }
                }
                Some(done)=self.review_work.active.join_next(), if !self.review_work.active.is_empty()=>{
                    if let Err(error)=self.finish_review(done) { eprintln!("Review completion failed: {}",error.code); }
                }
                Some(done)=self.prs.active.join_next(), if !self.prs.active.is_empty()=>{
                    match done {
                        Ok(done) => { if let Err(error)=self.finish_pr_job(done) { eprintln!("Pull request state could not be saved: {}", error.message); } }
                        Err(error) => { eprintln!("Pull request worker stopped: {error}"); }
                    }
                }
                Some(done)=completions.recv()=>{
                    if let Err(error)=self.complete(done).await {self.lose(&error.message).await;}
                }
                _=tick.tick()=>{
                    self.apply_ready_names();
                    self.poll_prs();
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
        commands.close();
        let mut git_shutdown = Ok(());
        while let Some(completion) = self.git_jobs.join_next().await {
            if let Err(error) = self.finish_git_job(completion, false) {
                git_shutdown = Err(error);
            }
        }
        self.stop_names().await;
        let review_shutdown = self.stop_reviews().await;
        let pr_shutdown = self.stop_pr_jobs().await;
        let store_shutdown = self.store.close();
        if let Some((reply, result)) = shutdown {
            let _ = reply.send(
                result
                    .and(git_shutdown)
                    .and(review_shutdown)
                    .and(pr_shutdown)
                    .and(store_shutdown),
            );
        }
    }
    async fn command(&mut self, command: Command) {
        match command {
            Command::PrList(id, refresh, reply) => {
                let result = if refresh {
                    self.refresh_prs(&id, true, PrLinkSource::BranchDiscovery)
                } else {
                    self.thread(&id).map(|_| self.pr_summary(&id))
                };
                let _ = reply.send(result);
            }
            Command::PrLink(id, key, reply) => {
                let result = self.pr_membership(&id, key, Some(PrLinkSource::Manual));
                self.poll_prs();
                let _ = reply.send(result);
            }
            Command::PrUnlink(id, key, reply) => {
                let result = self.pr_membership(&id, key, None);
                let _ = reply.send(result);
            }
            Command::RunGit(id, thread, action, progress, reply) => {
                match self.claim_checkout(&id, thread.clone(), Hold::Git) {
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                    Ok(root) => {
                        let origin = thread.map(|id| {
                            let generation = self.pr_generation(&id);
                            (id, generation)
                        });
                        let cx = vcs::Context {
                            root: root.clone(),
                            gh: self.config.gh_binary.clone(),
                            network: self.config.network_timeout,
                            progress,
                        };
                        self.git_jobs.spawn(async move {
                            let result = tokio::spawn(async move { vcs::run(&cx, action).await })
                                .await
                                .map_err(|error| AppError::new("repository", error))
                                .and_then(|result| result);
                            GitCompletion {
                                root,
                                origin,
                                result,
                                reply,
                            }
                        });
                    }
                }
            }
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
                        kind: WorkspaceKind::Repository,
                    };
                    self.store.workspace(&w)?;
                    self.workspaces.insert(w.id.clone(), w.clone());
                    Ok(w)
                })();
                let _ = reply.send(result);
            }
            Command::EnsureScratch(root, reply) => {
                let result = (|| -> Result<Workspace> {
                    if let Some(w) = self
                        .workspaces
                        .values()
                        .find(|w| w.kind == WorkspaceKind::Scratch)
                    {
                        return Ok(w.clone());
                    }
                    let w = Workspace {
                        id: WorkspaceId::default(),
                        root,
                        label: "No project".into(),
                        kind: WorkspaceKind::Scratch,
                    };
                    self.store.workspace(&w)?;
                    self.workspaces.insert(w.id.clone(), w.clone());
                    Ok(w)
                })();
                let _ = reply.send(result);
            }
            Command::RenameWorkspace(id, label, reply) => {
                let _ = reply.send(self.rename_workspace(&id, &label));
            }
            Command::RemoveWorkspace(id, reply) => {
                let _ = reply.send(self.remove_workspace(&id));
            }
            Command::Checkout(id, thread, reply) => {
                let _ = reply.send(self.checkout(&id, thread));
            }
            Command::PrRead(thread, key, reply) => self.read_review(thread, key, reply),
            Command::PrOperations(thread, key, reply) => {
                let result = self.pending_pr_operations(&thread, &key);
                let _ = reply.send(result);
            }
            Command::PrReconcile(thread, key, request_id, reply) => {
                self.reconcile_pr(thread, key, request_id, reply)
            }
            Command::PrChange(thread, input, reply) => self.change_review(thread, input, reply),
            Command::PrAcknowledgeUpdate(thread, input, reply) => {
                self.acknowledge_update(thread, input, reply)
            }
            Command::SetReviewDisposition(thread, key, input, reply) => {
                let result = self.review_disposition(&thread, &key, &input);
                let _ = reply.send(result);
            }
            Command::Claim(id, thread, hold, reply) => {
                let result = self.claim_checkout(&id, thread, hold);
                let _ = reply.send(result);
            }
            Command::Release(root, switched, reply) => {
                self.held.remove(&root);
                self.checkout_changed(&root);
                let result = match switched {
                    Some((id, current)) => match self.threads.get_mut(&id) {
                        Some(ThreadSnapshot {
                            checkout: Checkout::Worktree { branch, .. },
                            ..
                        }) => {
                            *branch = current;
                            self.commit(&id)
                        }
                        _ => Ok(()),
                    },
                    None => Ok(()),
                };
                let _ = reply.send(result);
            }
            Command::Threads(id, reply) => {
                let rows = self
                    .threads
                    .values()
                    .filter(|t| t.workspace_id == id)
                    .map(|t| self.thread_summary(t))
                    .collect();
                let _ = reply.send(Ok(rows));
            }
            Command::Create(workspace_id, checkout, reply) => {
                let result = (|| {
                    self.workspace(&workspace_id)?;
                    let t = ThreadSnapshot {
                        created_at_ms: Some(now_ms()),
                        latest_user_activity_at_ms: None,
                        id: ThreadId::default(),
                        workspace_id,
                        title: "New conversation".into(),
                        native_thread_id: None,
                        revision: 1,
                        session: SessionState::Draft,
                        settings: SessionSettings::default(),
                        checkout,
                        turns: vec![],
                        approvals: vec![],
                        diagnostic: None,
                        placement: Placement::Auto,
                        snooze: None,
                        context: None,
                    };
                    self.store.save(&t)?;
                    self.threads.insert(t.id.clone(), t.clone());
                    self.schedule_discovery(&t.id, PrLinkSource::BranchDiscovery);
                    Ok(t)
                })();
                let _ = reply.send(result);
            }
            Command::Snapshot(id, resume, reply) => {
                // A removed worktree is restored by the next submit, which resumes as usual.
                let should_resume = resume && self.thread(&id).is_ok_and(|t| {
                    t.native_thread_id.is_some()
                        && matches!(
                            t.session,
                            SessionState::Dormant | SessionState::Unavailable { .. }
                        )
                        && !matches!(&t.checkout, Checkout::Worktree { path, .. } if !path.exists())
                });
                if should_resume {
                    self.threads.get_mut(&id).unwrap().session = SessionState::Connecting;
                    let _ = self.commit(&id);
                    self.prepare(Prepare::Resume(id.clone()));
                } else if resume
                    && let Some(t) = self.threads.get_mut(&id)
                    && matches!(&t.checkout, Checkout::Worktree { path, .. } if !path.exists())
                    && t.diagnostic.take().is_some()
                {
                    // A resume would have cleared this notice about the previous session.
                    let _ = self.commit(&id);
                }
                let result = if self.dirty.contains(&id) {
                    self.commit(&id).and_then(|_| self.thread(&id).cloned())
                } else {
                    self.thread(&id).cloned()
                };
                let _ = reply.send(result);
            }
            Command::Models(reply) => {
                self.model_waiters.push(reply);
                if self.provider.is_none() {
                    self.launch();
                } else {
                    self.list_models();
                }
            }
            Command::UsageLimits(refresh, reply) => {
                let cached = self.limits.borrow().clone().filter(|_| !refresh);
                if let Some(limits) = cached {
                    let _ = reply.send(Ok(limits));
                } else {
                    self.limit_waiters.push(reply);
                    if self.provider.is_none() {
                        self.launch();
                    } else {
                        self.read_limits();
                    }
                }
            }
            Command::Settings(id, settings, reply) => {
                let result = (|| -> Result<ThreadSnapshot> {
                    let thread = self.thread(&id)?;
                    if matches!(
                        thread.session,
                        SessionState::Connecting
                            | SessionState::Running
                            | SessionState::Interrupting
                    ) || self
                        .leases
                        .contains_key(thread.root(&self.workspaces[&thread.workspace_id]))
                    {
                        return Err(AppError::new(
                            "busy",
                            "Wait for the current operation to finish.",
                        ));
                    }
                    if self.models.is_none()
                        && (thread.settings.model != settings.model
                            || thread.settings.effort != settings.effort)
                    {
                        return Err(AppError::new(
                            "models_unavailable",
                            "Load the model list before changing model or effort.",
                        ));
                    }
                    self.validate_settings(&settings)?;
                    let mut next = thread.clone();
                    next.settings = settings;
                    self.install(next)?;
                    self.thread(&id).cloned()
                })();
                let _ = reply.send(result);
            }
            Command::Submit(id, request_id, text, restored, reply) => {
                if let Some(path) = restored {
                    self.held.remove(&path);
                }
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
            Command::Arrange(id, action, reply) => {
                let result = (|| -> Result<()> {
                    self.thread(&id)?;
                    let current = self.thread(&id)?;
                    let settled = self.settlement(
                        current,
                        self.auto_settle.rules(&current.workspace_id),
                        now_ms(),
                    );
                    let thread = self.threads.get_mut(&id).unwrap();
                    let before = (thread.placement, thread.snooze);
                    let arranged = thread.arrange(action, now_ms(), settled);
                    if (thread.placement, thread.snooze) != before {
                        self.commit(&id)?;
                    }
                    arranged
                })();
                let _ = reply.send(result);
            }
            Command::AutoSettle(rules, reply) => {
                let now = now_ms();
                let previous = std::mem::replace(&mut self.auto_settle, rules);
                for t in self.threads.values() {
                    let before = previous.rules(&t.workspace_id);
                    let after = self.auto_settle.rules(&t.workspace_id);
                    if self.settlement(t, before, now) != self.settlement(t, after, now) {
                        let _ = self.changes.send(self.thread_hint(t));
                    }
                }
                let _ = reply.send(Ok(()));
            }
            Command::UiState(reply) => {
                let _ = reply.send(self.store.ui_state());
            }
            Command::SetUiState(key, value, reply) => {
                let _ = reply.send(self.store.set_ui_state(&key, value.as_deref()));
            }
            Command::CleanupCandidates(reply) => {
                let candidates = self
                    .threads
                    .values()
                    .filter_map(|t| self.candidate(t))
                    .collect();
                let roots = self.workspaces.values().map(|w| w.root.clone()).collect();
                let _ = reply.send(Ok((candidates, roots)));
            }
            Command::ClaimCleanup(candidate, reply) => {
                let _ = reply.send(self.claim_cleanup(&candidate));
            }
            Command::ReleaseCleanup(candidate, removed, reply) => {
                self.release_cleanup(&candidate, removed);
                let _ = reply.send(Ok(()));
            }
            Command::ClaimRestore(id, reply) => {
                let _ = reply.send(self.claim_restore(&id));
            }
            Command::ReleaseRestore(path, reply) => {
                self.held.remove(&path);
                let _ = reply.send(Ok(()));
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
        let previous_overrides = thread.turns.iter().any(|turn| {
            turn.settings
                .as_ref()
                .is_some_and(|settings| settings.model.is_some() || settings.effort.is_some())
        });
        if self.models.is_some() {
            self.validate_settings(&thread.settings)?;
        }
        if thread.native_thread_id.is_some()
            && previous_overrides
            && (self.resolve_model(&thread.settings).is_none()
                || self.resolve_effort(&thread.settings).is_none())
        {
            return Err(AppError::new(
                "models_unavailable",
                "Load the model list before continuing this conversation.",
            ));
        }
        let root = thread
            .root(&self.workspaces[&thread.workspace_id])
            .to_path_buf();
        if let Some(hold) = self.held.get(&root) {
            return Err(hold.refusal());
        }
        if self.leases.contains_key(&root) {
            return Err(turn_running());
        }
        let mut t = thread.clone();
        t.record_activity(self.settlement(&t, self.auto_settle.rules(&t.workspace_id), now_ms()));
        t.latest_user_activity_at_ms = Some(now_ms());
        let turn = Turn {
            id: TurnId::default(),
            prompt: text.into(),
            native_turn_id: None,
            delivery: Delivery::Preparing,
            execution: Execution::NotStarted,
            items: vec![],
            settings: Some(t.settings.clone()),
            started_at_ms: Some(now_ms()),
            completed_at_ms: None,
        };
        let receipt = Receipt {
            turn_id: turn.id.clone(),
        };
        t.turns.push(turn);
        t.session = SessionState::Connecting;
        t.diagnostic = None;
        t.snooze = None;
        if t.turns.len() == 1 {
            t.title = text.chars().take(54).collect()
        }
        t.revision += 1;
        self.store.accept(&t, request_id, &input, &receipt)?;
        self.leases.insert(root, t.id.clone());
        let hint = self.thread_hint(&t);
        let _ = self.changes.send(hint);
        self.threads.insert(t.id.clone(), t);
        self.start_name(id);
        Ok((receipt, true))
    }
    fn validate_settings(&self, settings: &SessionSettings) -> Result<()> {
        for value in [&settings.model, &settings.effort].into_iter().flatten() {
            if value.trim().is_empty() || value.len() > 128 {
                return Err(AppError::new(
                    "invalid_settings",
                    "Model and effort must be nonempty and under 129 bytes.",
                ));
            }
        }
        if settings.model.is_some() || settings.effort.is_some() {
            let models = self.models.as_ref().ok_or_else(|| {
                AppError::new(
                    "models_unavailable",
                    "Load the model list before choosing a model or effort.",
                )
            })?;
            let model = models
                .iter()
                .find(|item| Some(&item.model) == settings.model.as_ref())
                .or_else(|| {
                    if settings.model.is_none() {
                        models.iter().find(|item| item.is_default)
                    } else {
                        None
                    }
                })
                .ok_or_else(|| AppError::new("invalid_model", "Selected model is unavailable."))?;
            if let Some(effort) = &settings.effort
                && !model
                    .supported_reasoning_efforts
                    .iter()
                    .any(|item| &item.reasoning_effort == effort)
            {
                return Err(AppError::new(
                    "invalid_effort",
                    "Selected effort is unavailable for this model.",
                ));
            }
        }
        Ok(())
    }
    fn resolve_model<'a>(&'a self, settings: &'a SessionSettings) -> Option<&'a str> {
        settings.model.as_deref().or_else(|| {
            self.models
                .as_ref()?
                .iter()
                .find(|model| model.is_default)
                .map(|model| model.model.as_str())
        })
    }
    fn resolve_effort<'a>(&'a self, settings: &'a SessionSettings) -> Option<&'a str> {
        settings.effort.as_deref().or_else(|| {
            let model = self.resolve_model(settings)?;
            self.models
                .as_ref()?
                .iter()
                .find(|option| option.model == model)
                .map(|option| option.default_reasoning_effort.as_str())
        })
    }
    fn launch(&mut self) {
        if self.launching || self.provider.is_some() {
            return;
        }
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
    fn list_models(&mut self) {
        if self.listing_models || self.model_waiters.is_empty() {
            return;
        }
        let Some(provider) = self.provider.clone() else {
            return;
        };
        self.listing_models = true;
        let epoch = self.epoch;
        let done = self.done.clone();
        tokio::spawn(async move {
            let result = async {
                let mut models = Vec::new();
                let mut cursor: Option<String> = None;
                let mut seen = HashSet::new();
                loop {
                    let value = provider
                        .request("model/list", json!({"cursor":cursor,"includeHidden":false}))
                        .await?;
                    let page: ModelPage = serde_json::from_value(value)?;
                    models.extend(
                        page.data
                            .into_iter()
                            .filter(|model| !model.hidden)
                            .map(|model| model.option),
                    );
                    match page.next_cursor {
                        Some(next) if seen.insert(next.clone()) => cursor = Some(next),
                        Some(_) => {
                            return Err(AppError::new(
                                "protocol",
                                "Codex repeated a model cursor.",
                            ));
                        }
                        None => return Ok(models),
                    }
                }
            }
            .await;
            let _ = done.send(Completion::Models { epoch, result }).await;
        });
    }
    fn read_limits(&mut self) {
        if self.reading_limits {
            return;
        }
        let Some(provider) = self.provider.clone() else {
            return;
        };
        self.reading_limits = true;
        let epoch = self.epoch;
        let done = self.done.clone();
        tokio::spawn(async move {
            let result = usage::read(&provider).await;
            let _ = done.send(Completion::Limits { epoch, result }).await;
        });
    }
    fn settle_limits(&mut self, result: Result<UsageLimits>) {
        self.reading_limits = false;
        self.limits.send_if_modified(|current| match result {
            Ok(limits) => {
                let changed = current.as_ref() != Some(&limits);
                *current = Some(limits);
                changed
            }
            Err(e) => UsageLimits::after_failure(current, &e.message),
        });
        let limits = self.limits.borrow().clone();
        for reply in std::mem::take(&mut self.limit_waiters) {
            let _ =
                reply.send(limits.clone().ok_or_else(|| {
                    AppError::new("provider", "Codex usage limits are unavailable.")
                }));
        }
    }
    fn prepare(&mut self, job: Prepare) {
        if self.provider.is_none() {
            self.pending.push(job);
            self.launch();
            return;
        }
        let t = match self.thread(job.thread()) {
            Ok(t) => t,
            Err(_) => return,
        };
        let root = t.root(&self.workspaces[&t.workspace_id]).to_path_buf();
        let native = t.native_thread_id.clone();
        let provider = self.provider.clone().unwrap();
        let settings = t.settings.clone();
        let (approval_policy, approvals_reviewer, sandbox) = settings.permission_mode.protocol();
        let model = self.resolve_model(&settings).map(str::to_owned);
        let done = self.done.clone();
        let epoch = self.epoch;
        tokio::spawn(async move {
            let result = if let Some(native) = native {
                provider.request("thread/resume",json!({"threadId":native,"cwd":root,"approvalPolicy":approval_policy,"approvalsReviewer":approvals_reviewer,"sandbox":sandbox,"model":model,"excludeTurns":false})).await
            } else {
                provider.request("thread/start",json!({"cwd":root,"approvalPolicy":approval_policy,"approvalsReviewer":approvals_reviewer,"sandbox":sandbox,"model":model,"ephemeral":false})).await
            };
            let _ = done.send(Completion::Prepared { epoch, job, result }).await;
        });
    }
    async fn complete(&mut self, done: Completion) -> Result<()> {
        match done {
            Completion::Models { epoch, result } if epoch == self.epoch => {
                self.listing_models = false;
                if let Ok(models) = &result {
                    self.models = Some(models.clone());
                }
                for reply in std::mem::take(&mut self.model_waiters) {
                    let _ = reply.send(result.clone());
                }
            }
            Completion::Limits { epoch, result } if epoch == self.epoch => {
                self.settle_limits(result);
            }
            Completion::Launched { epoch, result } if epoch == self.epoch => {
                self.launching = false;
                match result {
                    Ok(provider) => {
                        self.provider = Some(provider);
                        self.read_limits();
                        if !self.model_waiters.is_empty() {
                            self.list_models();
                        }
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
                            let settings = turn.settings.clone().unwrap_or_default();
                            let (approval_policy, approvals_reviewer, _) =
                                settings.permission_mode.protocol();
                            let sandbox_policy = settings.permission_mode.sandbox_policy();
                            let model = self.resolve_model(&settings).map(str::to_owned);
                            let effort = self.resolve_effort(&settings).map(str::to_owned);
                            self.commit(&id)?;
                            let provider = self.provider.clone().ok_or_else(|| {
                                AppError::new("provider_lost", "Codex is unavailable.")
                            })?;
                            let done = self.done.clone();
                            tokio::spawn(async move {
                                let result=provider.request("turn/start",json!({"threadId":native,"clientUserMessageId":turn_id.to_string(),"input":[{"type":"text","text":prompt,"text_elements":[]}],"model":model,"effort":effort,"approvalPolicy":approval_policy,"approvalsReviewer":approvals_reviewer,"sandboxPolicy":sandbox_policy})).await;
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
                            self.leases
                                .remove(t.root(&self.workspaces[&t.workspace_id]));
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
                result: Err(e),
            } if epoch == self.epoch => {
                // The turn can finish before this reply arrives, and the project can be removed in between.
                let Some(t) = self.threads.get_mut(&thread) else {
                    return Ok(());
                };
                t.diagnostic = Some(format!("Stop was not confirmed: {}", e.message));
                self.commit(&thread)?;
                self.lose(
                    "Interruption could not be confirmed. Managed Codex execution was stopped.",
                )
                .await;
            }
            _ => {}
        }
        Ok(())
    }
    async fn lose(&mut self, reason: &str) {
        self.cancel_names();
        if let Some(provider) = self.provider.take() {
            let _ = provider.terminate().await;
        }
        self.epoch += 1;
        self.launching = false;
        self.pending.clear();
        self.models = None;
        self.listing_models = false;
        for reply in std::mem::take(&mut self.model_waiters) {
            let _ = reply.send(Err(AppError::new("provider_lost", reason)));
        }
        self.reading_limits = false;
        if !self.limit_waiters.is_empty() {
            self.settle_limits(Err(AppError::new("provider_lost", reason)));
        }
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
        let settled_before_approval = id
            .as_ref()
            .and_then(|id| self.threads.get(id))
            .and_then(|t| self.settlement(t, self.auto_settle.rules(&t.workspace_id), now_ms()));
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
                t.record_activity(settled_before_approval);
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
        if method == "account/rateLimits/updated" {
            self.limits
                .send_if_modified(|limits| UsageLimits::apply_update(limits, p));
            return Ok(());
        }
        let Some(id) = id else { return Ok(()) };
        let t = self.threads.get_mut(&id).unwrap();
        if method == "thread/tokenUsage/updated" {
            if let Some(context) = ContextUsage::from_update(p)
                && t.context.as_ref() != Some(&context)
            {
                t.context = Some(context);
                self.dirty.insert(id);
            }
            return Ok(());
        }
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
                                    && let ApprovalAction::FileChange { text: details, .. } =
                                        &mut approval.action
                                    && details.is_empty()
                                {
                                    *details = text.clone()
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
                for approval in &mut t.approvals {
                    if approval.turn_id == turn.id && approval.state == ApprovalState::Pending {
                        approval.state = ApprovalState::Expired;
                        self.routes.remove(&approval.id);
                    }
                }
                self.leases
                    .remove(t.root(&self.workspaces[&t.workspace_id]));
                self.commit(&id)?;
                let _ = self.refresh_prs(&id, true, PrLinkSource::AgentDiscovered);
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
                .map(|changes| {
                    changes
                        .iter()
                        .map(|change| string(change, "path"))
                        .collect()
                })
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelPage {
    data: Vec<ModelRow>,
    next_cursor: Option<String>,
}
#[derive(serde::Deserialize)]
struct ModelRow {
    #[serde(flatten)]
    option: ModelOption,
    hidden: bool,
}
