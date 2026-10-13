//! Where a checkout's authoritative files and its agent live. `Owner::workdir` resolves a
//! thread to one [`Workdir`], and every host-versus-sandbox difference below the runtime
//! dispatches on it: reads sync the mirror first, mutations run inside a write session, and
//! agent paths map both ways. `root()` is always the Mac path, so leases, holds, Files, Diff,
//! search and cleanup key on it unchanged.
use crate::{
    domain::*,
    log::RotatingLog,
    mirror::{Freshness, Mirror, Synced, WriteRoot, WriteSession},
    sandbox::{
        ATTACHMENTS, Container, ContainerState, DESKTOP, DESKTOP_PORT, Desired, Docker, Exec,
        Input, RunState, WORKSPACE,
    },
    terminal::Launch,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

#[cfg(test)]
mod docker_tests;
mod forward;
pub use forward::{Listeners, LocalNetwork, SandboxNetwork};
pub(crate) mod idle;
pub(crate) use idle::{Activity, Limits};

const COPY: Duration = Duration::from_secs(60);
const DESKTOP_START: Duration = Duration::from_secs(30);
/// Bounds a file fetched out of the container for display, which is also the largest image
/// the preview tools produce.
pub(crate) const FETCH_LIMIT: u64 = 4_400_000;

#[derive(Clone)]
pub(crate) enum Workdir {
    Mac {
        root: PathBuf,
    },
    Sandbox {
        root: PathBuf,
        handle: Arc<SandboxHandle>,
    },
}

/// What this process last made of the container. Docker stays the authority; this is what
/// the strip label shows and what decides whether reads pull and whether the idle rule
/// probes. `Stopped` is also the state of a container this process has not touched, and
/// `Starting` is a `ready` in flight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Starting,
    Running,
    Paused,
    Stopped,
}
impl Phase {
    fn after(desired: Desired) -> Self {
        match desired {
            Desired::Running => Self::Running,
            Desired::Paused => Self::Paused,
            Desired::Stopped | Desired::Removed => Self::Stopped,
        }
    }
}

/// One per sandbox id, shared by every thread on the same checkout. It serializes the
/// lifecycle steps that must not interleave: readying, retiring and reconciling.
pub(crate) struct SandboxHandle {
    pub id: SandboxId,
    pub container: Container,
    pub mirror: Mirror,
    docker: Docker,
    log: RotatingLog,
    /// The checkout's branch, which the mirror may move freely. `Owner::workdir` refreshes
    /// it from the checkout each time the handle is used.
    branch: Mutex<String>,
    flight: tokio::sync::Mutex<()>,
    /// `Running` only after a completed `ready`, until a `retire`. Otherwise the container is
    /// not running on this process's account, so the mirror is exact and reads skip the pull.
    phase: Mutex<Phase>,
    /// Every change of `phase`, for the owner, which tells each of the sandbox's threads to
    /// read `sandbox_state` again. Whoever changes the phase, a wake, a `ready` or a retire,
    /// the strip label follows.
    changed: mpsc::UnboundedSender<SandboxId>,
    /// What the idle rule reads. Entry points touch it; the owner tick folds in turns and
    /// probes and decides.
    activity: Mutex<Activity>,
    /// A settle or archive asked for a stop. The tick stops the container as soon as no
    /// thread of the sandbox is busy, with this reason; any use before that withdraws it.
    stop_requested: Mutex<Option<&'static str>>,
    /// The owner tick runs one piece of lifecycle work per sandbox at a time.
    working: AtomicBool,
    probe_due: Mutex<Instant>,
    probe_every: Duration,
    /// Made for each handle and kept only in memory. Every desktop start sets it again, so it
    /// also replaces the secret of a desktop that the agent or an earlier run started.
    desktop_secret: String,
    /// The gateway's token, made and kept like `desktop_secret`.
    gateway_secret: String,
    forwards: forward::Forwards,
}
impl SandboxHandle {
    pub(crate) fn new(
        docker: Docker,
        id: SandboxId,
        mirror_root: PathBuf,
        branch: String,
        probe_every: Duration,
        changed: mpsc::UnboundedSender<SandboxId>,
        log: RotatingLog,
    ) -> Arc<Self> {
        let container = docker.container(&id);
        Arc::new(Self {
            mirror: Mirror::new(container.clone(), mirror_root),
            container,
            id,
            docker,
            log,
            branch: Mutex::new(branch),
            flight: tokio::sync::Mutex::new(()),
            phase: Mutex::new(Phase::Stopped),
            changed,
            activity: Mutex::new(Activity::new(Instant::now())),
            stop_requested: Mutex::new(None),
            working: AtomicBool::new(false),
            probe_due: Mutex::new(Instant::now()),
            probe_every,
            desktop_secret: uuid::Uuid::new_v4().simple().to_string(),
            gateway_secret: uuid::Uuid::new_v4().simple().to_string(),
            forwards: Default::default(),
        })
    }
    /// Claims the handle for one piece of lifecycle work. `false` while another is in flight.
    pub(crate) fn begin_work(&self) -> bool {
        self.working
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
    pub(crate) fn end_work(&self) {
        self.working.store(false, Ordering::Release);
    }
    /// Whether the next probe is due, scheduling the one after it.
    pub(crate) fn probe_due(&self, now: Instant) -> bool {
        let mut due = self.probe_due.lock().unwrap();
        if now < *due {
            return false;
        }
        *due = now + self.probe_every;
        true
    }
    pub(crate) fn note(&self, line: &str) {
        self.log(line);
    }
    pub(crate) fn set_branch(&self, branch: &str) {
        let mut current = self.branch.lock().unwrap();
        if *current != branch {
            *current = branch.to_owned();
        }
    }
    pub(crate) fn branch(&self) -> String {
        self.branch.lock().unwrap().clone()
    }
    pub(crate) fn phase(&self) -> Phase {
        *self.phase.lock().unwrap()
    }
    fn set_phase(&self, phase: Phase) {
        {
            let mut current = self.phase.lock().unwrap();
            if *current == phase {
                return;
            }
            *current = phase;
        }
        let _ = self.changed.send(self.id.clone());
    }
    pub(crate) fn is_ready(&self) -> bool {
        self.phase() == Phase::Running
    }
    /// What a completed `ready` leaves behind, for owner tests whose fake agent stands in
    /// for a launch that readied the container.
    #[cfg(test)]
    pub(crate) fn mark_ready_for_tests(&self) {
        self.set_phase(Phase::Running);
    }
    /// Running or paused: a container this process started and has not stopped.
    pub(crate) fn is_started(&self) -> bool {
        matches!(self.phase(), Phase::Running | Phase::Paused)
    }
    pub(crate) fn activity(&self) -> Activity {
        self.activity.lock().unwrap().clone()
    }
    /// Someone used the sandbox through Bot Code just now, which withdraws a requested stop.
    pub(crate) fn touch(&self) {
        self.activity.lock().unwrap().touched = Instant::now();
        *self.stop_requested.lock().unwrap() = None;
    }
    pub(crate) fn request_stop(&self, reason: &'static str) {
        *self.stop_requested.lock().unwrap() = Some(reason);
    }
    pub(crate) fn stop_requested(&self) -> Option<&'static str> {
        *self.stop_requested.lock().unwrap()
    }
    /// A thread of this sandbox is busy at this tick.
    pub(crate) fn mark_busy(&self, now: Instant) {
        self.activity.lock().unwrap().busy = now;
    }
    fn log(&self, line: &str) {
        self.log.line(&format!("sandbox[{}]", self.id), line);
    }
    /// Converge to a running, seeded container on the current image. Idempotent, so thread
    /// creation warms it and every launch, write, terminal and message calls it again. A
    /// container built from an older image is pulled one last time and recreated.
    pub(crate) async fn ready(&self) -> Result<()> {
        let _flight = self.flight.lock().await;
        self.touch();
        let was = self.phase();
        if was != Phase::Running {
            self.set_phase(Phase::Starting);
        }
        let readied = self.start().await;
        match &readied {
            Ok(()) => {
                if was != Phase::Running {
                    self.activity.lock().unwrap().forget_probe();
                }
                self.set_phase(Phase::Running);
            }
            Err(_) => self.set_phase(was),
        }
        readied
    }
    /// The cheap wake for paths that run often, such as terminal input and every turn: it
    /// takes the lock, so it waits for a pause in flight and then undoes it, and it costs no
    /// Docker call while the container runs. `ready` re-converges every time instead.
    pub(crate) async fn wake(&self) -> Result<()> {
        let _flight = self.flight.lock().await;
        self.touch();
        if self.phase() == Phase::Running {
            return Ok(());
        }
        let was = self.phase();
        self.set_phase(Phase::Starting);
        let readied = self.start().await;
        match &readied {
            Ok(()) => {
                self.activity.lock().unwrap().forget_probe();
                self.set_phase(Phase::Running);
            }
            Err(_) => self.set_phase(was),
        }
        readied
    }
    async fn start(&self) -> Result<()> {
        let own = self.branch();
        let image = self.docker.image(&|line| self.log(line)).await?;
        if self.container.state().await?.stale(&image) {
            self.log("recreating the container for the current image");
            self.container.converge(Desired::Running).await?;
            self.mirror.pull(Freshness::Exact, &own).await?;
            self.container.converge(Desired::Removed).await?;
        }
        self.container.converge(Desired::Running).await?;
        self.mirror.seed(&own).await
    }
    /// Readies the container, starts whatever of its desktop is not running and returns where
    /// the Desktop tab connects.
    pub(crate) async fn desktop(&self) -> Result<SandboxDesktop> {
        self.ready().await?;
        {
            let mut activity = self.activity.lock().unwrap();
            activity.desktop_client = Instant::now();
            activity.desktop_running = true;
        }
        let output = self
            .container
            .run(
                &Exec {
                    argv: &[DESKTOP, "start", "--secret-stdin"],
                    workdir: WORKSPACE,
                    env: &[],
                },
                Input::Bytes(format!("{}\n", self.desktop_secret).as_bytes()),
                DESKTOP_START,
            )
            .await?;
        if output.code != Some(0) {
            let reason = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::new(
                "sandbox",
                format!("The sandbox desktop did not start. {}", reason.trim()),
            ));
        }
        Ok(SandboxDesktop {
            port: self.container.published(DESKTOP_PORT).await?,
            secret: self.desktop_secret.clone(),
        })
    }
    /// `ready` in the background, unless it is already running or done.
    pub(crate) fn warm(self: &Arc<Self>) {
        if self.is_ready() || self.flight.try_lock().is_err() {
            return;
        }
        let handle = self.clone();
        tokio::spawn(async move {
            if let Err(error) = handle.ready().await {
                handle.log(&format!("warm-up failed: {}", error.message));
            }
        });
    }
    /// Every transition away from running goes through here, so the mirror is exact whenever
    /// the container is not running. A paused or stopped container is started to pull before
    /// removal, because Docker Desktop can stop containers behind Bot Code's back. A failed
    /// pull leaves the container as it is, running if the pull started it, and never removes
    /// work that did not reach the Mac.
    pub(crate) async fn retire(&self, desired: Desired) -> Result<()> {
        let _flight = self.flight.lock().await;
        self.retire_locked(desired).await
    }
    /// The idle rule's retire. Under the lock it checks that nothing used the sandbox since
    /// the rule decided, because a wake that landed in between must win.
    pub(crate) async fn idle_retire(&self, desired: Desired, decided_at: Instant) -> Result<bool> {
        let _flight = self.flight.lock().await;
        if self.activity().touched > decided_at || !self.is_started() {
            return Ok(false);
        }
        self.retire_locked(desired).await.map(|()| true)
    }
    async fn retire_locked(&self, desired: Desired) -> Result<()> {
        let state = self.container.state().await?;
        let pull_first = match state {
            ContainerState::Absent => false,
            ContainerState::Present { run, .. } => {
                desired == Desired::Removed || matches!(run, RunState::Running | RunState::Paused)
            }
        };
        if pull_first {
            self.container.converge(Desired::Running).await?;
            self.set_phase(Phase::Running);
            self.mirror.pull(Freshness::Exact, &self.branch()).await?;
        }
        self.container.converge(desired).await?;
        self.set_phase(Phase::after(desired));
        if Phase::after(desired) == Phase::Stopped {
            self.close_forwards().await;
        }
        Ok(())
    }
    /// Reads the container's CPU time and desktop state into the activity record. Returns
    /// the interval's CPU share when there is one, for the log.
    pub(crate) async fn probe(&self) -> Result<Option<f64>> {
        let probe = self.container.probe().await?;
        self.observe_network(&probe).await;
        Ok(self
            .activity
            .lock()
            .unwrap()
            .observe(Instant::now(), &probe))
    }
    /// Stops the desktop and its windows. The Desktop tab or the agent's browser restarts it.
    pub(crate) async fn stop_desktop(&self) -> Result<()> {
        self.container.stop_desktop().await?;
        self.activity.lock().unwrap().desktop_running = false;
        Ok(())
    }
}

/// Paths as the agent sees them. Outbound mapping is total. Inbound mapping is the boundary:
/// an agent-supplied absolute path outside `/workspace` is never resolved on the Mac.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum AgentPaths {
    Mac { root: PathBuf },
    Sandbox { mirror: PathBuf },
}
/// Where a path the agent named is read from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Inbound {
    /// A Mac thread's path, resolved as before: absolute as is, relative inside the checkout.
    Host(String),
    /// A path inside `/workspace`, relative to the mirror.
    Mirror(String),
    /// A container path outside `/workspace`, fetched out of the container with a size cap.
    Container(String),
}
impl AgentPaths {
    /// `cwd` for thread/start, thread/resume and thread/fork.
    pub(crate) fn cwd(&self) -> String {
        match self {
            Self::Mac { root } => root.to_string_lossy().into_owned(),
            Self::Sandbox { .. } => WORKSPACE.into(),
        }
    }
    /// An attachment as the agent reads it: the Mac file, or its copy in the container.
    pub(crate) fn attachment(&self, host: &Path) -> String {
        match self {
            Self::Mac { .. } => host.to_string_lossy().into_owned(),
            Self::Sandbox { .. } => format!(
                "{ATTACHMENTS}/{}",
                host.file_name().unwrap_or_default().to_string_lossy()
            ),
        }
    }
    pub(crate) fn inbound(&self, agent: &str) -> Inbound {
        match self {
            Self::Mac { .. } => Inbound::Host(agent.into()),
            Self::Sandbox { .. } => {
                if let Some(rest) = agent.strip_prefix(WORKSPACE)
                    && (rest.is_empty() || rest.starts_with('/'))
                {
                    Inbound::Mirror(rest.trim_start_matches('/').into())
                } else if agent.starts_with('/') {
                    Inbound::Container(agent.into())
                } else {
                    Inbound::Mirror(agent.into())
                }
            }
        }
    }
    pub(crate) fn mirror(&self) -> &Path {
        match self {
            Self::Mac { root } | Self::Sandbox { mirror: root } => root,
        }
    }
}

/// The handle a mutation holds. Mac: the root itself.
pub(crate) enum Write {
    Mac(WriteRoot),
    Sandbox(WriteSession),
}
impl Write {
    pub(crate) fn root(&self) -> &WriteRoot {
        match self {
            Self::Mac(root) => root,
            Self::Sandbox(session) => session.root(),
        }
    }
    /// Mac: nothing. Sandbox: push the mirror into the container, refusing on drift.
    pub(crate) async fn finish(self) -> Result<()> {
        match self {
            Self::Mac(_) => Ok(()),
            Self::Sandbox(session) => session.finish().await.map_err(AppError::from),
        }
    }
}

impl Workdir {
    pub(crate) fn root(&self) -> &Path {
        match self {
            Self::Mac { root } | Self::Sandbox { root, .. } => root,
        }
    }
    pub(crate) fn environment(&self) -> crate::codex::Environment {
        match self {
            Self::Mac { .. } => crate::codex::Environment::Mac,
            Self::Sandbox { .. } => crate::codex::Environment::Container,
        }
    }
    pub(crate) fn agent_paths(&self) -> AgentPaths {
        match self {
            Self::Mac { root } => AgentPaths::Mac { root: root.clone() },
            Self::Sandbox { root, .. } => AgentPaths::Sandbox {
                mirror: root.clone(),
            },
        }
    }
    pub(crate) fn sandbox(&self) -> Option<&Arc<SandboxHandle>> {
        match self {
            Self::Mac { .. } => None,
            Self::Sandbox { handle, .. } => Some(handle),
        }
    }
    /// Where a new terminal's shell starts. A sandbox is readied first, since its container
    /// may be paused, stopped or not yet created, and `starting` runs when that has not
    /// happened in this process yet.
    pub(crate) async fn terminal(&self, starting: impl FnOnce()) -> Result<Launch> {
        match self {
            Self::Mac { root } => Ok(Launch::Mac { cwd: root.clone() }),
            Self::Sandbox { handle, .. } => {
                if !handle.is_ready() {
                    starting();
                }
                handle.ready().await?;
                Ok(Launch::Sandbox {
                    container: handle.container.clone(),
                })
            }
        }
    }
    /// Container to Mac. Mac: nothing. Sandbox: a pull, whose lock the caller holds while it
    /// reads or captures the mirror. A sandbox this process has not readied is not running,
    /// so its mirror is already exact. A `Recent` sync never waits for a busy mirror.
    pub(crate) async fn sync(&self, freshness: Freshness) -> Result<Option<Synced>> {
        match (self, freshness) {
            (Self::Mac { .. }, _) => Ok(None),
            (Self::Sandbox { handle, .. }, _) if !handle.is_ready() => Ok(None),
            (Self::Sandbox { handle, .. }, Freshness::Recent) => {
                handle.mirror.try_sync_recent(&handle.branch()).await
            }
            (Self::Sandbox { handle, .. }, Freshness::Exact) => handle
                .mirror
                .sync(freshness, &handle.branch())
                .await
                .map(Some),
        }
    }
    /// Mac: the root. Sandbox: a readied container and an exactly pulled, locked mirror.
    pub(crate) async fn begin_write(&self) -> Result<Write> {
        match self {
            Self::Mac { root } => Ok(Write::Mac(WriteRoot::mac(root.clone()))),
            Self::Sandbox { handle, .. } => {
                handle.ready().await?;
                Ok(Write::Sandbox(
                    handle.mirror.begin_write(&handle.branch()).await?,
                ))
            }
        }
    }
    /// One blocking mutation: begin, run `op` on a blocking thread, finish. A failed `op`
    /// still finishes, so a partial host write reaches the container and the sides agree.
    pub(crate) async fn write<T: Send + 'static>(
        &self,
        op: impl FnOnce(&WriteRoot) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let write = self.begin_write().await?;
        let root = write.root().clone();
        let result = tokio::task::spawn_blocking(move || op(&root))
            .await
            .map_err(|error| AppError::new("repository", error))
            .and_then(|result| result);
        let finished = write.finish().await;
        result.and_then(|value| finished.map(|()| value))
    }
    /// Copies a turn's attachments to `/botcode/attachments` before `turn/start`. Mac: nothing.
    /// The bytes go through the agent user's own `cat`, so the file is readable by Codex.
    pub(crate) async fn provide(&self, files: &[PathBuf]) -> Result<()> {
        let Self::Sandbox { handle, .. } = self else {
            return Ok(());
        };
        for file in files {
            let bytes = tokio::fs::read(file).await?;
            let target = AgentPaths::Sandbox {
                mirror: PathBuf::new(),
            }
            .attachment(file);
            let output = handle
                .container
                .run(
                    &Exec {
                        argv: &["sh", "-c", "cat > \"$1\"", "sh", &target],
                        workdir: WORKSPACE,
                        env: &[],
                    },
                    Input::Bytes(&bytes),
                    COPY,
                )
                .await?;
            if output.code != Some(0) {
                return Err(AppError::new(
                    "sandbox",
                    format!(
                        "Copying an attachment into the sandbox failed: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    ),
                ));
            }
        }
        Ok(())
    }
    /// A file outside `/workspace`, read out of the container. Larger than the cap is refused.
    pub(crate) async fn fetch(&self, container_path: &str) -> Option<Vec<u8>> {
        let Self::Sandbox { handle, .. } = self else {
            return None;
        };
        let limit = (FETCH_LIMIT + 1).to_string();
        let output = handle
            .container
            .run(
                &Exec {
                    argv: &["head", "-c", &limit, "--", container_path],
                    workdir: WORKSPACE,
                    env: &[],
                },
                Input::Lifeline,
                COPY,
            )
            .await
            .ok()?;
        (output.code == Some(0) && output.stdout.len() as u64 <= FETCH_LIMIT)
            .then_some(output.stdout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_paths_map_outbound_totally_and_inbound_only_inside_the_workspace() {
        let mirror = PathBuf::from("/Users/me/.z1/worktrees/repo/botcode-1");
        let paths = AgentPaths::Sandbox {
            mirror: mirror.clone(),
        };
        assert_eq!(paths.cwd(), "/workspace");
        assert_eq!(
            paths.attachment(Path::new("/Users/me/.z1/attachments/abc.png")),
            "/botcode/attachments/abc.png"
        );
        assert_eq!(
            paths.inbound("/workspace/src/main.rs"),
            Inbound::Mirror("src/main.rs".into())
        );
        assert_eq!(paths.inbound("/workspace"), Inbound::Mirror(String::new()));
        assert_eq!(
            paths.inbound("src/main.rs"),
            Inbound::Mirror("src/main.rs".into())
        );
        assert_eq!(
            paths.inbound("/workspaces/other"),
            Inbound::Container("/workspaces/other".into()),
            "a prefix match is not a workspace path"
        );
        assert_eq!(
            paths.inbound("/tmp/shot.png"),
            Inbound::Container("/tmp/shot.png".into())
        );
        assert_eq!(
            paths.inbound(mirror.join("src/main.rs").to_str().unwrap()),
            Inbound::Container(mirror.join("src/main.rs").to_string_lossy().into()),
            "a Mac path from a sandbox agent never resolves on the Mac"
        );
        assert_eq!(paths.mirror(), mirror.as_path());
    }

    #[test]
    fn mac_paths_are_the_identity() {
        let root = PathBuf::from("/Users/me/repo");
        let paths = AgentPaths::Mac { root: root.clone() };
        assert_eq!(paths.cwd(), "/Users/me/repo");
        assert_eq!(
            paths.attachment(Path::new("/Users/me/.z1/attachments/abc.png")),
            "/Users/me/.z1/attachments/abc.png"
        );
        assert_eq!(
            paths.inbound("/Users/me/repo/a.png"),
            Inbound::Host("/Users/me/repo/a.png".into())
        );
        assert_eq!(paths.inbound("a.png"), Inbound::Host("a.png".into()));
    }
}
