mod checkpoints;
mod collaboration;
mod naming;
mod restarts;
mod thread_actions;
use thread_actions::DeleteCompletion;
mod pr_review;
mod pull_requests;
mod writing;
use crate::pr_review::*;
use crate::pull_requests::{PrLinkSource, PullRequestKey, ThreadPrSummary};
use crate::{
    attachments::{self, Attachments},
    cleanup::{self, Candidate, Sweep},
    codex::{Codex, Signal},
    domain::*,
    editors::{self, EditorId, OpenTarget, Position},
    log::RotatingLog,
    repo, settings, skills,
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
    time::{Duration, Instant},
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
        let data_dir = std::env::var_os("BOT_CODE_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .unwrap_or_default()
                    // The Z1 Code directory, kept so existing threads survive the rename.
                    .join(".z1")
            });
        Ok(Self {
            data_dir,
            codex_binary: vcs::installed_binary("codex", "BOT_CODE_CODEX_BIN"),
            gh_binary: vcs::installed_binary("gh", "BOT_CODE_GH_BIN"),
            network_timeout: Duration::from_secs(180),
            shell: std::env::var_os("BOT_CODE_SHELL").map(PathBuf::from),
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
    Delete,
    Switch,
    Cleanup,
    Restore,
    Git,
    PullRequest,
    Naming,
    Checkpoint,
    Revert,
}
impl Hold {
    fn refusal(self) -> AppError {
        AppError::new(
            "checkout_busy",
            match self {
                Self::Delete => "Bot Code is deleting a thread in this checkout.",
                Self::Checkpoint => {
                    "Bot Code is capturing this turn's checkpoint. Wait for it to finish."
                }
                Self::Revert => {
                    "A conversation revert is using this checkout. Finish or retry it first."
                }
                Self::Naming => "Bot Code is naming this worktree branch. Try again in a moment.",
                Self::PullRequest => {
                    "A pull request operation is using this checkout. Wait for its result."
                }
                Self::Switch => {
                    "Bot Code is switching this checkout's branch. Try again in a moment."
                }
                Self::Cleanup => {
                    "Bot Code is removing this inactive worktree. Try again in a moment."
                }
                Self::Restore => {
                    "Bot Code is restoring this thread's worktree. Try again in a moment."
                }
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
            Self::Delete
            | Self::Switch
            | Self::Cleanup
            | Self::Restore
            | Self::PullRequest
            | Self::Naming
            | Self::Checkpoint
            | Self::Revert => turn_running(),
        }
    }
}
/// T3's PROVIDER_SEND_TURN_MAX_ATTACHMENTS.
const MAX_ATTACHMENTS: usize = 100;
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
    BeginCommitPreview(ThreadId, Reply<String>),
    AwaitCommitPreview(String, Reply<String>),
    CancelCommitPreview(String, Reply<()>),
    TurnDiff(ThreadId, TurnId, String, Reply<TurnDiffView>),
    Revert(ThreadId, String, TurnId, bool, Reply<ThreadSnapshot>),
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
    Create(
        WorkspaceId,
        Checkout,
        SessionSettings,
        Reply<ThreadSnapshot>,
    ),
    CreateExisting(WorkspaceId, ThreadId, Reply<ThreadSnapshot>),
    Snapshot(ThreadId, bool, Reply<ThreadSnapshot>),
    Models(Reply<Vec<ModelOption>>),
    CollaborationModes(Reply<Vec<InteractionMode>>),
    UserQuestions(UserQuestionRequestId, UserQuestionAnswers, Reply<()>),
    UsageLimits(bool, Reply<UsageLimits>),
    Settings(ThreadId, SessionSettings, Reply<ThreadSnapshot>),
    /// The path carries a `Hold::Restore` to release in the same step as acceptance.
    Submit(
        ThreadId,
        String,
        String,
        Vec<ImageAttachment>,
        Option<PathBuf>,
        Option<TurnId>,
        Reply<Receipt>,
    ),
    Approval(ApprovalId, ApprovalDecision, Reply<()>),
    Interrupt(ThreadId, Reply<()>),
    Arrange(ThreadId, Arrange, Reply<()>),
    Rename(ThreadId, String, Reply<ThreadSnapshot>),
    Delete(ThreadId, Reply<DeletedWorktree>),
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
    codex: PathBuf,
    log: RotatingLog,
    terminals: Terminals,
    attachments: Attachments,
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
                settle_user_inputs(
                    turn,
                    "The application closed before follow-up delivery was confirmed.",
                );
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
                if matches!(turn.checkpoint, TurnCheckpoint::Pending) {
                    turn.checkpoint = TurnCheckpoint::Unavailable {
                        before: None,
                        reason: "The application closed before checkpoint capture completed."
                            .into(),
                    };
                } else if let TurnCheckpoint::Before { before } = &turn.checkpoint {
                    turn.checkpoint = TurnCheckpoint::Unavailable { before: Some(before.clone()), reason: "The application closed before this turn's final checkpoint was recorded.".into() };
                }
            }
            thread.expire_open_requests();
            thread.revision += 1;
            store.save(thread)?;
        }
        // Codex reads images by absolute path.
        let attachments = Attachments::new(&config.data_dir.canonicalize()?);
        let referenced = threads
            .values()
            .flat_map(|thread| {
                thread
                    .turns
                    .iter()
                    .flat_map(|turn| {
                        turn.attachments.iter().chain(turn.items.iter().flat_map(
                            |item| match item {
                                Item::UserInput { attachments, .. } => attachments.as_slice(),
                                _ => &[],
                            },
                        ))
                    })
                    .chain(
                        thread
                            .last_revert
                            .iter()
                            .flat_map(|result| &result.attachments),
                    )
            })
            .map(|a| a.id.clone())
            .collect();
        if let Err(e) = attachments.sweep(&referenced, std::time::SystemTime::now()) {
            eprintln!("Attachment sweep failed: {}", e.message);
        }
        let worktrees = config.data_dir.join("worktrees");
        let gh = config.gh_binary.clone();
        let codex = config.codex_binary.clone();
        let terminals = Terminals::new(config.shell.clone());
        let settings = config.data_dir.join("settings.json");
        let auto_settle = settings::auto_settle(&settings);
        let (commands, rx) = mpsc::channel(128);
        let (changes, _) = broadcast::channel(256);
        let (limits, limits_rx) = watch::channel(None);
        let (provider_events, signals) = mpsc::channel(512);
        let (done, completions) = mpsc::channel(128);
        let prs = PrWork::load(&mut store)?;
        let log = RotatingLog::open(config.data_dir.join("logs").join("codex.log"));
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
                writing: writing::Writing::default(),
                checkpoint_work: checkpoints::CheckpointWork::new(),
                closing: false,
                git_jobs: tokio::task::JoinSet::new(),
                attachments: attachments.clone(),
                delete_jobs: tokio::task::JoinSet::new(),
                deleting: HashSet::new(),
                terminals: terminals.clone(),
                config,
                store,
                workspaces,
                threads,
                auto_settle,
                leases: HashMap::new(),
                held: HashMap::new(),
                callbacks: HashMap::new(),
                collaboration_modes: vec![],
                collaboration_waiters: vec![],
                provider: None,
                epoch: 0,
                launching: false,
                restarts: restarts::Restarts::default(),
                log: log.clone(),
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
            codex,
            log,
            terminals,
            attachments,
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
    pub async fn list_thread_summaries(
        &self,
        workspace: WorkspaceId,
    ) -> Result<Vec<ThreadSummary>> {
        self.call(|r| Command::Threads(workspace, r)).await
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
    pub async fn write_file(
        &self,
        id: WorkspaceId,
        thread: Option<ThreadId>,
        path: String,
        contents: String,
    ) -> Result<()> {
        let root = match self.checkout(id, thread).await?.1 {
            Location::Repository(root) | Location::Folder(root) => root,
            Location::Unassigned => {
                return Err(AppError::new(
                    "missing_folder",
                    "Start a thread to see its files.",
                ));
            }
            Location::Removed { .. } => return Err(worktree_removed()),
        };
        tokio::task::spawn_blocking(move || repo::write_file(&root, &path, &contents))
            .await
            .map_err(|e| AppError::new("repository", e))?
    }
    /// The canonical existing path a target names, refusing anything outside its checkout
    /// or, for chat links, not named in the thread.
    pub async fn open_target_path(&self, target: OpenTarget) -> Result<PathBuf> {
        let resolve = match target {
            OpenTarget::Workspace {
                workspace_id,
                thread_id,
                path,
            } => {
                let root = match self.checkout(workspace_id, thread_id).await?.1 {
                    Location::Repository(root) | Location::Folder(root) => root,
                    Location::Unassigned => {
                        return Err(AppError::new(
                            "missing_folder",
                            "Start a thread to see its files.",
                        ));
                    }
                    Location::Removed { .. } => return Err(worktree_removed()),
                };
                tokio::task::spawn_blocking(move || editors::checkout_path(&root, &path))
            }
            OpenTarget::ChatLink { thread_id, path } => {
                let thread = self.thread(thread_id).await?;
                tokio::task::spawn_blocking(move || editors::chat_link_path(&thread, &path))
            }
        };
        resolve.await.map_err(|e| AppError::new("repository", e))?
    }
    pub async fn open_in_editor(
        &self,
        target: OpenTarget,
        editor: EditorId,
        position: Option<Position>,
    ) -> Result<()> {
        let path = self.open_target_path(target).await?;
        tokio::task::spawn_blocking(move || editors::launch(editor, &path, position))
            .await
            .map_err(|e| AppError::new("editor_launch", e))?
    }
    pub async fn reveal_in_finder(&self, target: OpenTarget) -> Result<()> {
        editors::reveal(&self.open_target_path(target).await?).await
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
    pub async fn begin_commit_message(&self, thread: ThreadId) -> Result<String> {
        self.call(|reply| Command::BeginCommitPreview(thread, reply))
            .await
    }
    pub async fn await_commit_message(&self, job: String) -> Result<String> {
        self.call(|reply| Command::AwaitCommitPreview(job, reply))
            .await
    }
    pub async fn cancel_commit_message(&self, job: String) -> Result<()> {
        self.call(|reply| Command::CancelCommitPreview(job, reply))
            .await
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
        if let NewCheckout::Existing { thread_id } = checkout {
            return self
                .call(|r| Command::CreateExisting(id, thread_id, r))
                .await;
        }
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
            (_, NewCheckout::Existing { .. }) => unreachable!(),
            (WorkspaceKind::Repository, NewCheckout::Folder { .. })
            | (WorkspaceKind::Scratch, NewCheckout::Local | NewCheckout::Worktree { .. }) => {
                return Err(AppError::new(
                    "invalid_checkout",
                    "This checkout does not belong to this workspace.",
                ));
            }
        };
        self.call(|r| Command::Create(id, checkout, SessionSettings::default(), r))
            .await
    }
    pub async fn thread(&self, id: ThreadId) -> Result<ThreadSnapshot> {
        self.call(|r| Command::Snapshot(id, false, r)).await
    }
    pub async fn read_turn_diff(
        &self,
        thread: ThreadId,
        turn: TurnId,
        path: String,
    ) -> Result<TurnDiffView> {
        self.call(|r| Command::TurnDiff(thread, turn, path, r))
            .await
    }
    pub async fn revert_thread(
        &self,
        thread: ThreadId,
        request_id: String,
        turn: TurnId,
        files: bool,
    ) -> Result<ThreadSnapshot> {
        self.call(|r| Command::Revert(thread, request_id, turn, files, r))
            .await
    }
    pub async fn open_thread(&self, id: ThreadId) -> Result<ThreadSnapshot> {
        self.call(|r| Command::Snapshot(id, true, r)).await
    }
    pub async fn models(&self) -> Result<Vec<ModelOption>> {
        self.call(Command::Models).await
    }
    pub async fn list_skills(&self, cwd: PathBuf) -> Vec<skills::Skill> {
        skills::list(&self.codex, &cwd, self.log.clone()).await
    }
    pub async fn collaboration_modes(&self) -> Result<Vec<InteractionMode>> {
        self.call(Command::CollaborationModes).await
    }
    pub async fn answer_user_questions(
        &self,
        id: UserQuestionRequestId,
        answers: UserQuestionAnswers,
    ) -> Result<()> {
        self.call(|r| Command::UserQuestions(id, answers, r)).await
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
    pub async fn stage_attachment(&self, name: String, bytes: Vec<u8>) -> Result<ImageAttachment> {
        let attachments = self.attachments.clone();
        tokio::task::spawn_blocking(move || attachments.stage(&name, &bytes))
            .await
            .map_err(|e| AppError::new("attachment", e))?
    }
    pub fn read_attachment(&self, file: &str) -> Result<(Vec<u8>, ImageMime)> {
        self.attachments.read(file)
    }
    pub async fn submit(
        &self,
        id: ThreadId,
        request_id: String,
        text: String,
        attachments: Vec<ImageAttachment>,
    ) -> Result<Receipt> {
        self.submit_to(id, request_id, text, attachments, None)
            .await
    }
    pub async fn submit_to(
        &self,
        id: ThreadId,
        request_id: String,
        text: String,
        attachments: Vec<ImageAttachment>,
        expected_turn_id: Option<TurnId>,
    ) -> Result<Receipt> {
        if expected_turn_id.is_some() {
            return self
                .call(|r| {
                    Command::Submit(id, request_id, text, attachments, None, expected_turn_id, r)
                })
                .await;
        }
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
        self.call(|r| Command::Submit(id, request_id, text, attachments, restored, None, r))
            .await
    }
    pub async fn answer_approval(&self, id: ApprovalId, decision: ApprovalDecision) -> Result<()> {
        self.call(|r| Command::Approval(id, decision, r)).await
    }
    pub async fn interrupt(&self, id: ThreadId) -> Result<()> {
        self.call(|r| Command::Interrupt(id, r)).await
    }
    pub async fn rename_thread(&self, id: ThreadId, title: String) -> Result<ThreadSnapshot> {
        self.call(|r| Command::Rename(id, title, r)).await
    }
    pub async fn delete_thread(&self, id: ThreadId) -> Result<DeletedWorktree> {
        self.call(|r| Command::Delete(id, r)).await
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
                    "bot-code storage cleanup: skipped {} ({})",
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
                    "bot-code storage cleanup: removed {} for thread {}",
                    candidate.path.display(),
                    candidate.thread
                ),
                Err(reason) => eprintln!(
                    "bot-code storage cleanup: kept {} ({reason})",
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
        .map_err(|_| AppError::new("closed", "Bot Code runtime is closed."))?;
    rx.await
        .map_err(|_| AppError::new("closed", "Bot Code runtime is closed."))?
}
#[derive(Clone)]
enum Prepare {
    Resume(ThreadId),
    Submit(ThreadId, TurnId),
    Revert(ThreadId),
}
impl Prepare {
    fn thread(&self) -> &ThreadId {
        match self {
            Self::Resume(id) | Self::Submit(id, _) | Self::Revert(id) => id,
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
        result: Result<collaboration::ProviderSession>,
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
    Steered {
        epoch: u64,
        thread: ThreadId,
        turn: TurnId,
        operation: String,
        result: Result<Value>,
    },
    Answered {
        epoch: u64,
        id: ApprovalId,
        result: Result<()>,
    },
    UserQuestionsAnswered {
        epoch: u64,
        id: UserQuestionRequestId,
        result: Result<()>,
    },
    Interrupted {
        epoch: u64,
        thread: ThreadId,
        result: Result<Value>,
    },
}
impl Completion {
    fn process_died(&self) -> bool {
        let error = match self {
            Self::Models { result, .. } => result.as_ref().err(),
            Self::Limits { result, .. } => result.as_ref().err(),
            Self::Launched { result, .. } => result.as_ref().err(),
            Self::Prepared { result, .. }
            | Self::Started { result, .. }
            | Self::Steered { result, .. }
            | Self::Interrupted { result, .. } => result.as_ref().err(),
            Self::Answered { result, .. } | Self::UserQuestionsAnswered { result, .. } => {
                result.as_ref().err()
            }
        };
        error.is_some_and(|error| error.code == "provider_lost")
    }
}
#[derive(Clone, PartialEq, Eq, Hash)]
enum Callback {
    Approval(ApprovalId),
    UserInput(UserQuestionRequestId),
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
    closing: bool,
    checkpoint_work: checkpoints::CheckpointWork,
    naming: naming::Naming,
    writing: writing::Writing,
    prs: PrWork,
    review_work: ReviewWork,
    git_jobs: tokio::task::JoinSet<GitCompletion>,
    attachments: Attachments,
    delete_jobs: tokio::task::JoinSet<DeleteCompletion>,
    deleting: HashSet<ThreadId>,
    terminals: Terminals,
    config: RuntimeConfig,
    store: Store,
    workspaces: HashMap<WorkspaceId, Workspace>,
    threads: HashMap<ThreadId, ThreadSnapshot>,
    auto_settle: settings::AutoSettle,
    leases: HashMap<PathBuf, ThreadId>,
    held: HashMap<PathBuf, Hold>,
    callbacks: HashMap<Callback, Route>,
    collaboration_modes: Vec<collaboration::ModePreset>,
    collaboration_waiters: Vec<Reply<Vec<InteractionMode>>>,
    provider: Option<Codex>,
    epoch: u64,
    launching: bool,
    restarts: restarts::Restarts,
    log: RotatingLog,
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
    fn new_thread(
        &mut self,
        workspace_id: WorkspaceId,
        checkout: Checkout,
        settings: SessionSettings,
    ) -> Result<ThreadSnapshot> {
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
            settings,
            checkout,
            turns: vec![],
            approvals: vec![],
            user_questions: vec![],
            diagnostic: None,
            placement: Placement::Auto,
            snooze: None,
            context: None,
            pending_revert: None,
            last_revert: None,
        };
        self.store.save(&t)?;
        self.threads.insert(t.id.clone(), t.clone());
        self.schedule_discovery(&t.id, PrLinkSource::BranchDiscovery);
        Ok(t)
    }
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
            self.cancel_commit_previews(Some(&root));
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
        self.cancel_thread_commit_previews(&removed);
        for id in &removed {
            self.cancel_name(id);
        }
        self.forget_pr_threads(&removed);
        self.threads.retain(|id, _| !removed.contains(id));
        self.dirty.retain(|id| !removed.contains(id));
        self.callbacks
            .retain(|_, route| !removed.contains(&route.thread));
        self.workspaces.remove(id);
        Ok(())
    }
    fn thread(&self, id: &ThreadId) -> Result<&ThreadSnapshot> {
        if self.deleting.contains(id) {
            return Err(AppError::new("busy", "This thread is being deleted."));
        }
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
        ) && !t.input_open()
            && t.pending_revert.is_none()
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
        self.cancel_commit_previews(Some(&candidate.path));
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
        for thread in self.threads.values() {
            if let Some(intent) = &thread.pending_revert {
                self.held.insert(intent.checkout_root.clone(), Hold::Revert);
            }
        }
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
                        self.closing = true;
                        self.lose("Bot Code runtime handles were released.").await;
                        break;
                    };
                    if let Command::Shutdown(reply)=command {
                        self.closing = true;
                        commands.close();
                        let result=if let Some(provider)=self.provider.take(){provider.terminate().await}else{Ok(())};
                        self.lose("Bot Code closed. Native execution stopped.").await;
                        shutdown=Some((reply,result));
                        break;
                    }
                    self.command(command).await;
                }
                Some(signal)=signals.recv()=>{
                    match signal {
                        Signal::Frame{epoch,value} if epoch==self.epoch=>{
                            if let Err(error)=self.frame(value).await && error.code!="provider_lost" {self.lose(&error.message).await;}
                        }
                        Signal::Exited{epoch,exit} if epoch==self.epoch=>self.lose_with(&exit.headline(),&exit.reason()).await,
                        _=>{}
                    }
                }
                Some(done)=self.writing.active.join_next(), if !self.writing.active.is_empty()=>{
                    self.finish_commit_preview(done);
                }
                Some(done)=self.naming.active.join_next(), if !self.naming.active.is_empty()=>{
                    self.finish_name(done);
                }
                Some(Ok(done))=self.delete_jobs.join_next(), if !self.delete_jobs.is_empty()=>{
                    self.finish_delete(done);
                }
                Some(done)=self.git_jobs.join_next(), if !self.git_jobs.is_empty()=>{
                    if let Err(error)=self.finish_git_job(done, true) { eprintln!("Git completion failed: {}", error.message); }
                }
                Some(done)=self.checkpoint_work.active.join_next(), if !self.checkpoint_work.active.is_empty()=>{
                    if let Err(error)=self.finish_checkpoint_job(done) { eprintln!("Checkpoint completion failed: {}", error.message); }
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
                    self.expire_commit_previews();
                    self.retry_checkpoint_saves();
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
        while let Some(Ok(done)) = self.delete_jobs.join_next().await {
            self.finish_delete(done);
        }
        let mut git_shutdown = Ok(());
        while let Some(completion) = self.git_jobs.join_next().await {
            if let Err(error) = self.finish_git_job(completion, false) {
                git_shutdown = Err(error);
            }
        }
        self.stop_commit_previews().await;
        self.stop_names().await;
        while let Some(completion) = self.checkpoint_work.active.join_next().await {
            if let Err(error) = self.finish_checkpoint_job(completion) {
                git_shutdown = Err(error);
            }
        }
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
            Command::BeginCommitPreview(thread, reply) => {
                let result = self.begin_commit_preview(thread);
                let _ = reply.send(result);
            }
            Command::AwaitCommitPreview(job, reply) => self.await_commit_preview(job, reply),
            Command::CancelCommitPreview(job, reply) => {
                self.cancel_commit_preview(&job);
                let _ = reply.send(Ok(()));
            }
            Command::TurnDiff(thread, turn, path, reply) => {
                self.read_turn_diff(thread, turn, path, reply)
            }
            Command::Revert(thread, request, turn, files, reply) => {
                self.begin_revert(thread, request, turn, files, reply)
            }
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
                        let model = thread
                            .as_ref()
                            .and_then(|id| self.threads.get(id))
                            .and_then(|t| self.resolve_model(&t.settings))
                            .map(str::to_owned);
                        let origin = thread.map(|id| {
                            let generation = self.pr_generation(&id);
                            (id, generation)
                        });
                        let cx = vcs::Context {
                            root: root.clone(),
                            gh: self.config.gh_binary.clone(),
                            network: self.config.network_timeout,
                            codex: self.config.codex_binary.clone(),
                            model,
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
                let result = (|| {
                    if let Some((_, current)) = switched {
                        let owners: Vec<_> = self.threads.values()
                            .filter(|thread| matches!(&thread.checkout, Checkout::Worktree { path, .. } if *path == root))
                            .map(|thread| thread.id.clone()).collect();
                        for id in owners {
                            if let Checkout::Worktree { branch, .. } =
                                &mut self.threads.get_mut(&id).unwrap().checkout
                            {
                                *branch = current.clone();
                            }
                            self.commit(&id)?;
                        }
                    }
                    Ok(())
                })();
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
            Command::CreateExisting(workspace_id, source_id, reply) => {
                let result = (|| {
                    let source = self.thread(&source_id)?;
                    if source.workspace_id != workspace_id {
                        return Err(AppError::new(
                            "invalid_checkout",
                            "This checkout belongs to a different workspace.",
                        ));
                    }
                    let root = source.root(self.workspace(&workspace_id)?);
                    if !root.is_dir() {
                        return Err(AppError::new(
                            "missing_checkout",
                            "Restore the source thread checkout before implementing its plan.",
                        ));
                    }
                    if !self.idle(source, root) {
                        return Err(AppError::new(
                            "busy",
                            "Wait for the source thread and its checkout operations to finish.",
                        ));
                    }
                    self.new_thread(
                        workspace_id,
                        source.checkout.clone(),
                        source.settings.clone(),
                    )
                })();
                let _ = reply.send(result);
            }
            Command::Create(workspace_id, checkout, settings, reply) => {
                let _ = reply.send(self.new_thread(workspace_id, checkout, settings));
            }
            Command::Snapshot(id, resume, reply) => {
                if resume && self.thread(&id).is_ok_and(|thread| thread.archived()) {
                    let _ = reply.send(Err(AppError::new(
                        "thread_archived",
                        "Unarchive this thread first.",
                    )));
                    return;
                }

                // A removed worktree is restored by the next submit, which resumes as usual.
                let should_resume = resume && self.thread(&id).is_ok_and(|t| {
                    t.native_thread_id.is_some()
                        && t.pending_revert.is_none()
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
            Command::CollaborationModes(reply) => {
                if self.provider.is_some() {
                    let _ = reply.send(Ok(self
                        .collaboration_modes
                        .iter()
                        .filter_map(|preset| preset.mode)
                        .collect()));
                } else {
                    self.collaboration_waiters.push(reply);
                    self.launch();
                }
            }
            Command::UserQuestions(id, answers, reply) => {
                let result = self.answer_questions(id, answers);
                let _ = reply.send(result);
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
            Command::Submit(id, request_id, text, attachments, restored, expected, reply) => {
                if let Some(path) = restored {
                    self.held.remove(&path);
                }
                let result =
                    self.accept_submit(&id, &request_id, &text, attachments, expected.as_ref());
                if let Ok((receipt, true)) = &result {
                    if expected.is_some() {
                        self.dispatch_steer(&id, &receipt.turn_id, &request_id);
                    } else {
                        self.capture_before(id, receipt.turn_id.clone());
                    }
                }
                let _ = reply.send(result.map(|(receipt, _)| receipt));
            }
            Command::Approval(id, decision, reply) => {
                let result = (|| -> Result<()> {
                    let callback = Callback::Approval(id.clone());
                    let route = self.callbacks.get(&callback).cloned().ok_or_else(|| {
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
                    self.callbacks.remove(&callback);
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
            Command::Delete(id, reply) => self.begin_delete(id, reply),
            Command::Rename(id, title, reply) => {
                let result = (|| {
                    let mut thread = self.thread(&id)?.clone();
                    thread.rename(&title)?;
                    self.install(thread)?;
                    self.thread(&id).cloned()
                })();
                let _ = reply.send(result);
            }
            Command::Arrange(id, action, reply) => {
                let result = (|| -> Result<()> {
                    let mut thread = self.thread(&id)?.clone();
                    if matches!(action, Arrange::Archive)
                        && !self.idle(&thread, thread.root(self.workspace(&thread.workspace_id)?))
                    {
                        return Err(AppError::new(
                            "busy",
                            "Stop this thread and wait for checkout operations before archiving it.",
                        ));
                    }
                    let settled = self.settlement(
                        &thread,
                        self.auto_settle.rules(&thread.workspace_id),
                        now_ms(),
                    );
                    thread.arrange(action, now_ms(), settled)?;
                    self.install(thread)
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
                if self.thread(&id).is_ok_and(|thread| thread.archived()) {
                    let _ = reply.send(Err(AppError::new(
                        "thread_archived",
                        "Unarchive this thread first.",
                    )));
                    return;
                }

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
        attachments: Vec<ImageAttachment>,
        expected: Option<&TurnId>,
    ) -> Result<(Receipt, bool)> {
        if request_id.is_empty() || request_id.len() > 200 {
            return Err(AppError::new(
                "invalid_request",
                "A bounded operation ID is required.",
            ));
        }
        let text = text.trim();
        if (text.is_empty() && attachments.is_empty()) || text.len() > 100_000 {
            return Err(AppError::new(
                "invalid_prompt",
                "Enter a prompt up to 100,000 bytes.",
            ));
        }
        if attachments.len() > MAX_ATTACHMENTS {
            return Err(AppError::new(
                "invalid_attachments",
                format!("You can attach up to {MAX_ATTACHMENTS} images per message."),
            ));
        }
        let input = match expected {
            Some(turn) => serde_json::to_string(&(id, text, &attachments, turn))?,
            None => serde_json::to_string(&(id, text, &attachments))?,
        };
        if let Some(receipt) = self.store.receipt(request_id, &input)? {
            return Ok((receipt, false));
        }
        let thread = self.thread(id)?;
        if thread.archived() {
            return Err(AppError::new(
                "thread_archived",
                "Unarchive this thread first.",
            ));
        }
        for attachment in &attachments {
            let name = attachment.name.trim();
            if name.is_empty() || name.chars().count() > attachments::MAX_NAME_CHARS {
                return Err(AppError::new(
                    "invalid_attachments",
                    "Image names must be 1 to 255 characters.",
                ));
            }
            let staged = std::fs::metadata(self.attachments.path(attachment))
                .is_ok_and(|m| m.is_file() && m.len() == attachment.size_bytes);
            if !staged {
                return Err(AppError::new(
                    "missing_attachment",
                    format!("'{name}' is no longer available. Attach the image again."),
                ));
            }
        }
        if let Some(expected) = expected {
            return self.accept_steer(id, expected, request_id, text, attachments, &input);
        }
        if matches!(
            thread.session,
            SessionState::Connecting | SessionState::Running | SessionState::Interrupting
        ) {
            return Err(AppError::new(
                "busy",
                "Wait for the current operation to finish.",
            ));
        }
        // Without a provider the catalogs are unknown; turn start checks them after the relaunch.
        if self.provider.is_some() {
            self.startable(
                &thread.settings,
                thread.native_thread_id.is_some(),
                &thread.turns,
            )?;
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
            attachments,
            checkpoint: TurnCheckpoint::Pending,
        };
        let receipt = Receipt {
            turn_id: turn.id.clone(),
        };
        t.turns.push(turn);
        t.last_revert = None;
        t.session = SessionState::Connecting;
        t.diagnostic = None;
        t.snooze = None;
        if t.turns.len() == 1 && t.title == "New conversation" {
            let first = &t.turns[0];
            t.title = match first.attachments.first() {
                Some(image) if text.is_empty() => format!("Image: {}", image.name),
                _ => text.into(),
            }
            .chars()
            .take(54)
            .collect()
        }
        t.revision += 1;
        self.store.accept(&t, request_id, &input, &receipt)?;
        self.cancel_commit_previews(Some(&root));
        self.leases.insert(root, t.id.clone());
        let hint = self.thread_hint(&t);
        let _ = self.changes.send(hint);
        self.threads.insert(t.id.clone(), t);
        self.start_name(id);
        Ok((receipt, true))
    }
    fn accept_steer(
        &mut self,
        id: &ThreadId,
        expected: &TurnId,
        operation: &str,
        text: &str,
        attachments: Vec<ImageAttachment>,
        input: &str,
    ) -> Result<(Receipt, bool)> {
        let thread = self.thread(id)?;
        let turn = thread
            .turns
            .last()
            .ok_or_else(|| AppError::new("stale_turn", "The targeted turn has ended."))?;
        if turn.id != *expected
            || !matches!(turn.execution, Execution::Running)
            || !matches!(turn.delivery, Delivery::Accepted)
            || !matches!(thread.session, SessionState::Running)
            || turn.native_turn_id.is_none()
            || thread.native_thread_id.is_none()
        {
            return Err(AppError::new(
                "stale_turn",
                "The targeted turn is no longer running. This message was not sent.",
            ));
        }
        if thread.pending_revert.is_some() || thread.input_open() {
            return Err(AppError::new(
                "busy",
                "Resolve the pending approval or revert before sending now.",
            ));
        }
        if thread
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .any(|item| {
                matches!(
                    item,
                    Item::UserInput {
                        delivery: Delivery::Preparing
                            | Delivery::Sending
                            | Delivery::Uncertain { .. },
                        ..
                    }
                )
            })
        {
            return Err(AppError::new(
                "steer_pending",
                "A previous follow-up still needs delivery confirmation.",
            ));
        }
        if self.provider.is_none() {
            return Err(AppError::new("provider_lost", "Codex is unavailable."));
        }
        let root = thread.root(&self.workspaces[&thread.workspace_id]);
        if self.leases.get(root) != Some(id) || self.held.contains_key(root) {
            return Err(AppError::new(
                "checkout_busy",
                "The running turn no longer owns this checkout.",
            ));
        }
        let mut next = thread.clone();
        next.turns.last_mut().unwrap().items.push(Item::UserInput {
            id: operation.into(),
            text: text.into(),
            attachments,
            delivery: Delivery::Preparing,
        });
        next.record_activity(self.settlement(
            &next,
            self.auto_settle.rules(&next.workspace_id),
            now_ms(),
        ));
        next.latest_user_activity_at_ms = Some(now_ms());
        next.last_revert = None;
        next.snooze = None;
        next.revision += 1;
        let receipt = Receipt {
            turn_id: expected.clone(),
        };
        self.store.accept(&next, operation, input, &receipt)?;
        self.dirty.remove(id);
        let _ = self.changes.send(self.thread_hint(&next));
        self.threads.insert(id.clone(), next);
        self.cancel_name(id);
        Ok((receipt, true))
    }
    fn dispatch_steer(&mut self, id: &ThreadId, turn_id: &TurnId, operation: &str) {
        let mut next = self.threads[id].clone();
        let turn = next
            .turns
            .iter_mut()
            .find(|turn| &turn.id == turn_id)
            .unwrap();
        let native_turn = turn.native_turn_id.clone().unwrap();
        let item = turn
            .items
            .iter_mut()
            .find(|item| item.id() == operation)
            .unwrap();
        let Item::UserInput {
            text,
            attachments,
            delivery,
            ..
        } = item
        else {
            return;
        };
        let mut input = Vec::new();
        if !text.is_empty() {
            input.push(json!({"type":"text","text":text,"text_elements":[]}));
        }
        input.extend(attachments.iter().map(
            |attachment| json!({"type":"localImage","path":self.attachments.path(attachment)}),
        ));
        *delivery = Delivery::Sending;
        if let Err(error) = self.install(next) {
            let t = self.threads.get_mut(id).unwrap();
            if let Some(Item::UserInput { delivery, .. }) = t
                .turns
                .iter_mut()
                .flat_map(|turn| &mut turn.items)
                .find(|item| item.id() == operation)
            {
                *delivery = Delivery::NotSent {
                    reason: format!("Follow-up was not dispatched. {}", error.message),
                };
            }
            self.dirty.insert(id.clone());
            return;
        }
        let provider = self.provider.clone().unwrap();
        let native = self.threads[id].native_thread_id.clone().unwrap();
        let done = self.done.clone();
        let epoch = self.epoch;
        let thread = id.clone();
        let turn = turn_id.clone();
        let operation = operation.to_owned();
        tokio::spawn(async move {
            let result = provider.request("turn/steer", json!({"threadId":native,"expectedTurnId":native_turn,"clientUserMessageId":operation,"input":input})).await;
            let _ = done
                .send(Completion::Steered {
                    epoch,
                    thread,
                    turn,
                    operation,
                    result,
                })
                .await;
        });
    }
    fn validate_settings(&self, settings: &SessionSettings) -> Result<()> {
        if settings.interaction_mode == InteractionMode::Plan
            && !self
                .collaboration_modes
                .iter()
                .any(|preset| preset.mode == Some(InteractionMode::Plan))
        {
            return Err(AppError::new(
                "plan_unavailable",
                "This Codex app-server does not support Plan mode.",
            ));
        }
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
    fn startable(&self, settings: &SessionSettings, native: bool, previous: &[Turn]) -> Result<()> {
        if self.models.is_some() || settings.interaction_mode == InteractionMode::Plan {
            self.validate_settings(settings)?;
        }
        let previous_overrides = previous.iter().any(|turn| {
            turn.settings
                .as_ref()
                .is_some_and(|settings| settings.model.is_some() || settings.effort.is_some())
        });
        if native
            && previous_overrides
            && (self.resolve_model(settings).is_none() || self.resolve_effort(settings).is_none())
        {
            return Err(AppError::new(
                "models_unavailable",
                "Load the model list before continuing this conversation.",
            ));
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
        let delay = self.restarts.delay(Instant::now());
        if !delay.is_zero() {
            self.log.line(
                "bot-code",
                &format!(
                    "restarting Codex in {}s after {} consecutive failures",
                    restarts::whole_seconds(delay),
                    self.restarts.failures()
                ),
            );
        }
        let log = self.log.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if done.is_closed() {
                return;
            }
            let result = match Codex::launch(binary, epoch, signals, log).await {
                Ok(provider) => match provider.initialize().await {
                    Ok(()) => Ok(collaboration::discover(provider).await),
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
            let result = collaboration::read_models(&provider).await;
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
        if self.closing {
            return;
        }
        if let Prepare::Revert(id) = &job {
            let t = &self.threads[id];
            let intent = t.pending_revert.as_ref().unwrap();
            if t.turns
                .first()
                .is_some_and(|turn| turn.id == intent.turn_id)
                || intent.source_native_thread_id.is_none()
                || intent.before_native_turn_id.is_none()
            {
                self.fork_revert(id.clone());
                return;
            }
        }
        if self.provider.is_none() {
            if let Prepare::Revert(id) = &job {
                self.waiting_revert_provider(id.clone());
            }
            self.launch();
            if let Prepare::Submit(id, _) | Prepare::Resume(id) = &job
                && let Some(notice) = self.restarts.notice(Instant::now())
                && let Some(t) = self.threads.get_mut(id)
            {
                t.diagnostic = Some(notice);
                self.dirty.insert(id.clone());
            }
            self.pending.push(job);
            return;
        }
        if let Prepare::Revert(id) = job {
            self.fork_revert(id);
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
        // The dead process's Exited signal follows and reports the loss with its status and stderr.
        if done.process_died() {
            return Ok(());
        }
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
            Completion::Launched { epoch, result } if epoch == self.epoch => match result {
                Ok(session) => {
                    self.launching = false;
                    self.restarts.ready(Instant::now());
                    self.collaboration_modes = session.modes;
                    self.models = session.models;
                    self.provider = Some(session.provider);
                    let modes = self
                        .collaboration_modes
                        .iter()
                        .filter_map(|preset| preset.mode)
                        .collect::<Vec<_>>();
                    for reply in std::mem::take(&mut self.collaboration_waiters) {
                        let _ = reply.send(Ok(modes.clone()));
                    }
                    self.read_limits();
                    if !self.model_waiters.is_empty() {
                        self.list_models();
                    }
                    for job in std::mem::take(&mut self.pending) {
                        self.prepare(job)
                    }
                }
                Err(e) => self.lose(&e.message).await,
            },
            Completion::Launched {
                result: Ok(session),
                ..
            } => {
                tokio::spawn(async move { session.provider.terminate().await });
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
                            let mut input = Vec::new();
                            if !turn.prompt.is_empty() {
                                input.push(
                                    json!({"type":"text","text":turn.prompt,"text_elements":[]}),
                                );
                            }
                            input.extend(turn.attachments.iter().map(
                                |a| json!({"type":"localImage","path":self.attachments.path(a)}),
                            ));
                            let settings = turn.settings.clone().unwrap_or_default();
                            let (approval_policy, approvals_reviewer, _) =
                                settings.permission_mode.protocol();
                            let sandbox_policy = settings.permission_mode.sandbox_policy();
                            let model = self.resolve_model(&settings).map(str::to_owned);
                            let effort = self.resolve_effort(&settings).map(str::to_owned);
                            let t = &self.threads[&id];
                            let previous = t.turns.iter().position(|v| v.id == turn_id);
                            let collaboration = self
                                .startable(&settings, true, &t.turns[..previous.unwrap_or(0)])
                                .and_then(|()| {
                                    collaboration::turn_mode(
                                        &self.collaboration_modes,
                                        &settings,
                                        model.as_deref(),
                                        effort.as_deref(),
                                    )
                                });
                            self.commit(&id)?;
                            let provider = self.provider.clone().ok_or_else(|| {
                                AppError::new("provider_lost", "Codex is unavailable.")
                            })?;
                            let done = self.done.clone();
                            tokio::spawn(async move {
                                let result = match collaboration {
                                    Ok(mode) => {
                                        let mut params = json!({"threadId":native,"clientUserMessageId":turn_id.to_string(),"input":input,"model":model,"effort":effort,"approvalPolicy":approval_policy,"approvalsReviewer":approvals_reviewer,"sandboxPolicy":sandbox_policy});
                                        if let Some(mode) = mode {
                                            params["collaborationMode"] = mode;
                                        }
                                        provider.request("turn/start", params).await
                                    }
                                    Err(error) => Err(error),
                                };
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
                                turn.checkpoint = TurnCheckpoint::Unavailable {
                                    before: turn.checkpoint.before().cloned(),
                                    reason: e.message.clone(),
                                };
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
                    Err(e)
                        if matches!(
                            e.code.as_str(),
                            "plan_unavailable"
                                | "models_unavailable"
                                | "invalid_model"
                                | "invalid_effort"
                                | "invalid_settings"
                        ) =>
                    {
                        row.delivery = Delivery::NotSent {
                            reason: e.message.clone(),
                        };
                        row.execution = Execution::Failed {
                            reason: e.message.clone(),
                        };
                        t.diagnostic = Some(e.message);
                        t.session = SessionState::Ready;
                        self.capture_after(&thread, turn)?;
                        return Ok(());
                    }
                    Err(e) => {
                        if matches!(row.delivery, Delivery::Accepted) {
                            return Ok(());
                        }
                        row.delivery = Delivery::Uncertain {
                            reason: e.message.clone(),
                        };
                        row.checkpoint = TurnCheckpoint::Unavailable {
                            before: row.checkpoint.before().cloned(),
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
            Completion::Steered {
                epoch,
                thread,
                turn,
                operation,
                result,
            } if epoch == self.epoch => {
                let Some(t) = self.threads.get_mut(&thread) else {
                    return Ok(());
                };
                let Some(row) = t.turns.iter_mut().find(|row| row.id == turn) else {
                    return Ok(());
                };
                let Some(Item::UserInput { delivery, .. }) =
                    row.items.iter_mut().find(|item| item.id() == operation)
                else {
                    return Ok(());
                };
                if matches!(delivery, Delivery::Accepted) {
                    return Ok(());
                }
                let native_turn = row.native_turn_id.clone();
                let uncertain = match result {
                    Ok(value)
                        if value.get("turnId").and_then(Value::as_str)
                            == native_turn.as_deref() =>
                    {
                        *delivery = Delivery::Accepted;
                        false
                    }
                    Ok(_) => {
                        *delivery = Delivery::Uncertain {
                            reason: "Codex did not acknowledge the targeted turn.".into(),
                        };
                        true
                    }
                    Err(error) if error.code == "provider" => {
                        *delivery = Delivery::NotSent {
                            reason: error.message,
                        };
                        false
                    }
                    Err(error) => {
                        *delivery = Delivery::Uncertain {
                            reason: error.message,
                        };
                        true
                    }
                };
                self.commit(&thread)?;
                if uncertain {
                    self.lose(
                        "Follow-up delivery is uncertain. It will not be sent again automatically.",
                    )
                    .await;
                }
            }
            Completion::UserQuestionsAnswered { epoch, id, result } if epoch == self.epoch => {
                if let Some(t) = self
                    .threads
                    .values_mut()
                    .find(|t| t.user_questions.iter().any(|request| request.id == id))
                {
                    let request = t
                        .user_questions
                        .iter_mut()
                        .find(|request| request.id == id)
                        .unwrap();
                    if request.state == UserQuestionState::Answering {
                        request.state = if result.is_ok() {
                            UserQuestionState::Answered
                        } else {
                            UserQuestionState::Uncertain
                        };
                    }
                    if let Err(error) = result {
                        t.diagnostic = Some(error.message);
                    }
                    let thread = t.id.clone();
                    self.commit(&thread)?;
                }
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
        self.lose_with(reason, reason).await
    }
    /// `headline` is the short banner text; `reason` is recorded on the work that was lost.
    async fn lose_with(&mut self, headline: &str, reason: &str) {
        if self.provider.is_some() || self.launching {
            if !self.closing {
                self.restarts.lost(Instant::now());
            }
            self.log.line(
                "bot-code",
                &format!(
                    "provider lost: {}",
                    reason.lines().next().unwrap_or_default()
                ),
            );
        }
        self.cancel_names();
        self.cancel_commit_previews(None);
        if let Some(provider) = self.provider.take() {
            let _ = provider.terminate().await;
        }
        self.epoch += 1;
        self.launching = false;
        self.pending.clear();
        self.fail_reverts(headline);
        self.models = None;
        self.listing_models = false;
        for reply in std::mem::take(&mut self.model_waiters) {
            let _ = reply.send(Err(AppError::new("provider_lost", headline)));
        }
        self.reading_limits = false;
        if !self.limit_waiters.is_empty() {
            self.settle_limits(Err(AppError::new("provider_lost", headline)));
        }
        self.callbacks.clear();
        self.collaboration_modes.clear();
        for reply in std::mem::take(&mut self.collaboration_waiters) {
            let _ = reply.send(Err(AppError::new("provider_lost", headline)));
        }
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
            let lost_work = t.expire_open_requests()
                || t.turns.iter().any(|turn| {
                    turn.execution.active()
                        || turn.items.iter().any(|item| {
                            matches!(
                                item,
                                Item::UserInput {
                                    delivery: Delivery::Preparing | Delivery::Sending,
                                    ..
                                }
                            )
                        })
                });
            t.session = SessionState::Unavailable {
                reason: headline.into(),
            };
            if lost_work {
                t.diagnostic = Some(headline.into());
            }
            for turn in &mut t.turns {
                settle_user_inputs(
                    turn,
                    "Codex stopped before follow-up delivery was confirmed.",
                );
                if matches!(
                    turn.checkpoint,
                    TurnCheckpoint::Pending | TurnCheckpoint::Before { .. }
                ) {
                    turn.checkpoint = TurnCheckpoint::Unavailable {
                        before: turn.checkpoint.before().cloned(),
                        reason: format!("Checkpoint capture did not finish. {headline}"),
                    };
                }
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
            if method == "item/tool/requestUserInput" {
                let native_turn = required_string(p, "turnId")?;
                if turn.native_turn_id.as_deref() != Some(native_turn) {
                    if let Some(provider) = &self.provider {
                        provider.refuse(request.clone(), method).await?;
                    }
                    return Ok(());
                }
                let questions: Vec<UserQuestion> =
                    serde_json::from_value(p.get("questions").cloned().unwrap_or(Value::Null))?;
                collaboration::validate_questions(&questions)?;
                let pending = UserQuestionRequest {
                    id: UserQuestionRequestId::default(),
                    turn_id: turn.id.clone(),
                    item_id: required_string(p, "itemId")?.into(),
                    questions,
                    state: UserQuestionState::Pending,
                };
                self.callbacks.insert(
                    Callback::UserInput(pending.id.clone()),
                    Route {
                        thread: id.clone(),
                        request: request.clone(),
                        item_id: pending.item_id.clone(),
                        epoch: self.epoch,
                    },
                );
                t.record_activity(settled_before_approval);
                t.user_questions.push(pending);
                self.commit(&id)?;
                return Ok(());
            }
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
                self.callbacks.insert(
                    Callback::Approval(approval.id.clone()),
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
        let current_turn = position + 1 == t.turns.len();
        let turn = &mut t.turns[position];
        if turn.native_turn_id.is_none() {
            turn.native_turn_id = native_turn.map(str::to_owned)
        }
        let input_matches_turn =
            native_turn.is_some() && native_turn == turn.native_turn_id.as_deref();
        match method {
            "turn/started" => {
                if !current_turn || !turn.execution.active() {
                    return Ok(());
                }
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
            "item/reasoning/summaryPartAdded"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta" => {
                let item_id = required_string(p, "itemId")?;
                if !turn.items.iter().any(|item| item.id() == item_id) {
                    turn.items.push(Item::Reasoning {
                        id: item_id.to_owned(),
                        text: String::new(),
                        complete: false,
                    });
                }
                if let Some(Item::Reasoning { text, .. }) =
                    turn.items.iter_mut().find(|item| item.id() == item_id)
                {
                    if method != "item/reasoning/summaryPartAdded" {
                        text.push_str(&string(p, "delta"));
                    } else if !text.is_empty() && !text.ends_with("\n\n") {
                        text.push_str("\n\n");
                    }
                }
            }
            "item/plan/delta" => {
                let item_id = required_string(p, "itemId")?.to_owned();
                let delta = string(p, "delta");
                if let Some(Item::Plan { text, .. }) =
                    turn.items.iter_mut().find(|item| item.id() == item_id)
                {
                    text.push_str(&delta);
                } else {
                    turn.items.push(Item::Plan {
                        id: item_id,
                        text: delta,
                        complete: false,
                    });
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
                    if input_matches_turn {
                        reconcile_user_input(turn, value);
                    }
                    if let Some(item) = normalize_item(value, method == "item/completed") {
                        if let Item::FileChange { text, .. } = &item {
                            for approval in &mut t.approvals {
                                if approval.turn_id == turn.id
                                    && self
                                        .callbacks
                                        .get(&Callback::Approval(approval.id.clone()))
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
                        let end = turn.items.len();
                        upsert(&mut turn.items, item, end);
                    }
                }
            }
            "turn/completed" => {
                if !current_turn || !turn.execution.active() {
                    return Ok(());
                }
                let completed_turn = turn.id.clone();
                let status = p
                    .pointer("/turn/status")
                    .and_then(Value::as_str)
                    .unwrap_or("failed");
                turn.delivery = Delivery::Accepted;
                turn.execution = execution(status, p.pointer("/turn/error"));
                if let Some(items) = p.pointer("/turn/items").and_then(Value::as_array) {
                    merge_native_items(turn, items, input_matches_turn);
                }
                t.session = SessionState::Ready;
                for approval in &mut t.approvals {
                    if approval.turn_id == turn.id && approval.state == ApprovalState::Pending {
                        approval.state = ApprovalState::Expired;
                        self.callbacks
                            .remove(&Callback::Approval(approval.id.clone()));
                    }
                }
                for request in &mut t.user_questions {
                    if request.turn_id == turn.id && request.state == UserQuestionState::Pending {
                        request.state = UserQuestionState::Expired;
                        self.callbacks
                            .remove(&Callback::UserInput(request.id.clone()));
                    }
                }
                self.capture_after(&id, completed_turn)?;
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
fn merge_native_items(turn: &mut Turn, items: &[Value], reconcile_inputs: bool) {
    let mut cursor = 0;
    for native in items {
        if reconcile_inputs && let Some(at) = reconcile_user_input(turn, native) {
            cursor = at + 1;
        }
        if let Some(item) = normalize_item(native, true) {
            cursor = upsert(&mut turn.items, item, cursor) + 1;
        }
    }
}
fn upsert(items: &mut Vec<Item>, item: Item, at: usize) -> usize {
    let Some(position) = items.iter().position(|i| i.id() == item.id()) else {
        items.insert(at, item);
        return at;
    };
    match (&mut items[position], item) {
        (
            Item::Reasoning { complete, .. },
            Item::Reasoning {
                text,
                complete: done,
                ..
            },
        ) if text.is_empty() => *complete = done,
        (row, item) => *row = item,
    }
    position
}
fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
// T3 CodexAdapter.ts:1028-1035
fn tool_status(v: &Value, complete: bool) -> ToolStatus {
    if !complete {
        return ToolStatus::InProgress;
    }
    match v.get("status").and_then(Value::as_str) {
        Some("failed" | "interrupted") => ToolStatus::Failed,
        Some("declined") => ToolStatus::Declined,
        _ => ToolStatus::Completed,
    }
}
fn normalize_item(v: &Value, complete: bool) -> Option<Item> {
    let id = v.get("id")?.as_str()?.to_owned();
    let kind = v.get("type")?.as_str()?;
    Some(match kind {
        "agentMessage" => Item::Assistant {
            id,
            text: string(v, "text"),
            complete,
        },
        "plan" => Item::Plan {
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
        "fileChange" => {
            let changes = v.get("changes").and_then(Value::as_array);
            let changes = changes.map(Vec::as_slice).unwrap_or_default();
            Item::FileChange {
                id,
                text: changes
                    .iter()
                    .map(|change| format!("{}\n{}", string(change, "path"), string(change, "diff")))
                    .collect::<Vec<_>>()
                    .join("\n"),
                status: string(v, "status"),
                paths: changes
                    .iter()
                    .map(|change| string(change, "path"))
                    .collect(),
            }
        }
        "reasoning" => {
            let summary = strings(v, "summary");
            let parts = if summary.is_empty() {
                strings(v, "content")
            } else {
                summary
            };
            Item::Reasoning {
                id,
                text: parts.join("\n\n"),
                complete,
            }
        }
        "mcpToolCall" => Item::McpToolCall {
            title: mcp_title(v),
            server: string(v, "server"),
            tool: string(v, "tool"),
            status: tool_status(v, complete),
            arguments: v.get("arguments").cloned().unwrap_or_default(),
            result: v.get("result").filter(|r| !r.is_null()).map(|r| {
                r.get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
                    .map(|c| string(c, "text"))
                    .collect::<Vec<_>>()
                    .join("\n")
            }),
            error: v
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_owned),
            duration_ms: v.get("durationMs").and_then(Value::as_u64),
            id,
        },
        "dynamicToolCall" => Item::DynamicToolCall {
            id,
            tool: string(v, "tool"),
            status: tool_status(v, complete),
        },
        "collabAgentToolCall" => Item::CollabAgentToolCall {
            id,
            tool: string(v, "tool"),
            prompt: v.get("prompt").and_then(Value::as_str).map(str::to_owned),
            status: tool_status(v, complete),
        },
        "subAgentActivity" => Item::SubAgentActivity {
            id,
            activity: serde_json::from_value(v.get("kind")?.clone()).ok()?,
            agent_path: string(v, "agentPath"),
            agent_thread_id: string(v, "agentThreadId"),
        },
        // T3 CodexAdapter.ts:782-804
        "webSearch" => Item::WebSearch {
            id,
            query: [v.get("query"), v.pointer("/action/query")]
                .into_iter()
                .chain(
                    v.pointer("/action/queries")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .map(Some),
                )
                .chain([v.pointer("/action/pattern"), v.pointer("/action/url")])
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .find(|q| !q.is_empty())
                .unwrap_or_default()
                .to_owned(),
            status: tool_status(v, complete),
        },
        "imageView" => Item::ImageView {
            id,
            path: string(v, "path"),
        },
        "imageGeneration" => Item::ImageGeneration {
            id,
            status: tool_status(v, complete),
        },
        "contextCompaction" => Item::ContextCompaction { id, complete },
        "hookPrompt" => Item::HookPrompt {
            id,
            text: v
                .get("fragments")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|f| string(f, "text"))
                .collect::<Vec<_>>()
                .join("\n"),
        },
        "functionCallOutput" => Item::FunctionCallOutput {
            id,
            name: string(v, "name"),
        },
        "sleep" => Item::Sleep {
            id,
            duration_ms: v
                .get("durationMs")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
        },
        "enteredReviewMode" | "exitedReviewMode" => Item::ReviewMode {
            id,
            entered: kind == "enteredReviewMode",
            review: string(v, "review"),
        },
        _ => return None,
    })
}
// T3 CodexAdapter.ts itemTitle (740-780)
fn mcp_title(v: &Value) -> String {
    let (server, tool) = (string(v, "server"), string(v, "tool"));
    let name = tool
        .split(['.', '/', ':'])
        .next_back()
        .and_then(|part| part.split("__").last())
        .unwrap_or_default()
        .trim();
    let args = v.get("arguments");
    let intent = (name == "js")
        .then(|| args.and_then(|a| a.get("title")).and_then(Value::as_str))
        .flatten()
        .and_then(|title| bounded(title, 80));
    intent
        .or_else(|| computer_use_title(v, name))
        .unwrap_or_else(|| format!("{server} · {tool}"))
}
// T3 CodexAdapter.ts computerUseToolTitle (691-738) and mcpToolPresentation's app name.
fn computer_use_title(v: &Value, tool: &str) -> Option<String> {
    let status = v.get("status").and_then(Value::as_str);
    if item_type_words(&string(v, "server")) != "computer use" || status == Some("failed") {
        return None;
    }
    let args = v.get("arguments");
    let argument_app = ["appName", "application", "app"]
        .into_iter()
        .find_map(|key| display_name(args?.get(key)?.as_str()?));
    let surface = v
        .pointer("/result/_meta/codex~1toolSurface")
        .filter(|s| s.get("kind").and_then(Value::as_str) == Some("computerUse"));
    let surface_app = surface.and_then(|s| {
        let app = s.get("app")?;
        match app.get("kind")?.as_str()? {
            "displayName" => display_name(app.get("displayName")?.as_str()?),
            "appId" => {
                let name = match app.get("appId")?.as_str()?.trim().to_lowercase().as_str() {
                    "com.apple.finder" => "Finder",
                    "com.apple.safari" => "Safari",
                    "com.google.chrome" => "Chrome",
                    "com.microsoft.edgemac" => "Microsoft Edge",
                    "org.mozilla.firefox" => "Firefox",
                    "company.thebrowser.browser" => "Arc",
                    _ => return None,
                };
                Some(name.to_owned())
            }
            _ => None,
        }
    });
    let source = surface
        .and_then(|_| {
            v.pointer("/appContext/appName")
                .and_then(Value::as_str)
                .and_then(display_name)
                .or_else(|| argument_app.clone())
                .or(surface_app)
        })
        .filter(|name| name != "Computer Use");
    let app = source.or(argument_app);
    let in_progress = status == Some("inProgress");
    let verb = |now: &str, done: &str| {
        let label = if in_progress { now } else { done };
        match &app {
            Some(app) => format!("{label} in {app}"),
            None => label.to_owned(),
        }
    };
    Some(match item_type_words(tool).replace(' ', "_").as_str() {
        "list_apps" => if in_progress {
            "Listing apps"
        } else {
            "Listed apps"
        }
        .to_owned(),
        "click" => verb("Clicking", "Clicked"),
        "drag" => verb("Dragging", "Dragged"),
        "get_app_state" | "get_state" => match (&app, in_progress) {
            (Some(app), true) => format!("Looking at {app}"),
            (Some(app), false) => format!("Looked at {app}"),
            (None, true) => "Looking at the screen".into(),
            (None, false) => "Looked at the screen".into(),
        },
        "perform_accessibility_action" | "perform_secondary_action" => if in_progress {
            "Performing accessibility action"
        } else {
            "Performed accessibility action"
        }
        .to_owned(),
        "press_key" => verb("Pressing key", "Pressed key"),
        "scroll" => {
            let direction = args
                .and_then(|a| a.get("direction"))
                .and_then(Value::as_str)
                .and_then(|d| bounded(d, 48))
                .map(|d| format!(" {}", d.to_lowercase()))
                .unwrap_or_default();
            verb(
                &format!("Scrolling{direction}"),
                &format!("Scrolled{direction}"),
            )
        }
        "set_value" => verb("Setting value", "Set value"),
        "type_text" => verb("Typing text", "Typed text"),
        _ => return None,
    })
}
// T3 normalizeItemType
fn item_type_words(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return "item".into();
    }
    let mut words = String::new();
    let mut previous = None::<char>;
    for c in raw.chars() {
        if c.is_ascii_uppercase()
            && previous.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
        {
            words.push(' ');
        }
        words.push(if matches!(c, '.' | '_' | '/' | '-') {
            ' '
        } else {
            c
        });
        previous = Some(c);
    }
    words
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn display_name(value: &str) -> Option<String> {
    let name = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!name.is_empty() && name.chars().count() <= 160).then_some(name)
}
fn bounded(value: &str, max: usize) -> Option<String> {
    let text = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    Some(if text.chars().count() <= max {
        text
    } else {
        format!("{}…", text.chars().take(max - 1).collect::<String>())
    })
}
fn reconcile_user_input(turn: &mut Turn, native: &Value) -> Option<usize> {
    if native.get("type").and_then(Value::as_str) != Some("userMessage") {
        return None;
    }
    let client = native.get("clientId").and_then(Value::as_str)?;
    let position = turn.items.iter().position(|item| item.id() == client)?;
    if let Item::UserInput { delivery, .. } = &mut turn.items[position] {
        *delivery = Delivery::Accepted;
        return Some(position);
    }
    None
}
fn settle_user_inputs(turn: &mut Turn, reason: &str) {
    for item in &mut turn.items {
        if let Item::UserInput { delivery, .. } = item {
            match delivery {
                Delivery::Preparing => {
                    *delivery = Delivery::NotSent {
                        reason: reason.into(),
                    }
                }
                Delivery::Sending => {
                    *delivery = Delivery::Uncertain {
                        reason: reason.into(),
                    }
                }
                _ => {}
            }
        }
    }
}
fn merge_history(thread: &mut ThreadSnapshot, value: Option<&Value>) {
    let Some(turns) = value.and_then(Value::as_array) else {
        return;
    };
    let mut confirmed = HashSet::new();
    for native in turns {
        let native_id = string(native, "id");
        let items = native.get("items").and_then(Value::as_array);
        let row = thread.turns.iter_mut().find(|turn| {
            turn.native_turn_id.as_deref() == Some(&native_id)
                || items.is_some_and(|items| {
                    items.iter().any(|item| {
                        item.get("type").and_then(Value::as_str) == Some("userMessage")
                            && item.get("clientId").and_then(Value::as_str)
                                == Some(&turn.id.to_string())
                    })
                })
        });
        if let Some(turn) = row {
            confirmed.insert(turn.id.clone());
            turn.native_turn_id = Some(native_id);
            turn.delivery = Delivery::Accepted;
            let recovered = execution(&string(native, "status"), native.get("error"));
            // Codex reloads a turn whose process died as interrupted; the local loss reason is the truth.
            let crashed = matches!(turn.execution, Execution::Lost { .. })
                && recovered == Execution::Interrupted;
            if !matches!(recovered, Execution::Running) && !crashed {
                turn.execution = recovered;
            }
            if let Some(items) = items {
                merge_native_items(turn, items, true);
            }
        }
    }
    if thread.turns.iter().any(|turn| {
        matches!(turn.execution, Execution::Lost { .. }) && !confirmed.contains(&turn.id)
    }) {
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
