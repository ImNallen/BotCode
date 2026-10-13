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
        ATTACHMENTS, Container, ContainerState, Desired, Docker, Exec, Input, RunState, WORKSPACE,
    },
};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const COPY: Duration = Duration::from_secs(60);
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
    branch: std::sync::Mutex<String>,
    flight: tokio::sync::Mutex<()>,
    /// Set by a completed `ready`, cleared by `retire`. While clear, the container is not
    /// running on this process's account, so the mirror is exact and reads skip the pull.
    ready: AtomicBool,
}
impl SandboxHandle {
    pub(crate) fn new(
        docker: Docker,
        id: SandboxId,
        mirror_root: PathBuf,
        branch: String,
        log: RotatingLog,
    ) -> Arc<Self> {
        let container = docker.container(&id);
        Arc::new(Self {
            mirror: Mirror::new(container.clone(), mirror_root),
            container,
            id,
            docker,
            log,
            branch: std::sync::Mutex::new(branch),
            flight: tokio::sync::Mutex::new(()),
            ready: AtomicBool::new(false),
        })
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
    pub(crate) fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }
    fn log(&self, line: &str) {
        self.log.line(&format!("sandbox[{}]", self.id), line);
    }
    /// Converge to a running, seeded container on the current image. Idempotent, so thread
    /// creation warms it and every launch and write calls it again. A container built from an
    /// older image is pulled one last time and recreated.
    pub(crate) async fn ready(&self) -> Result<()> {
        let _flight = self.flight.lock().await;
        let own = self.branch();
        let image = self.docker.image(&|line| self.log(line)).await?;
        if self.container.state().await?.stale(&image) {
            self.log("recreating the container for the current image");
            self.container.converge(Desired::Running).await?;
            self.mirror.pull(Freshness::Exact, &own).await?;
            self.container.converge(Desired::Removed).await?;
        }
        self.container.converge(Desired::Running).await?;
        self.mirror.seed(&own).await?;
        self.ready.store(true, Ordering::Release);
        Ok(())
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
    /// removal, because Docker Desktop can stop containers behind Bot Code's back.
    pub(crate) async fn retire(&self, desired: Desired) -> Result<()> {
        let _flight = self.flight.lock().await;
        self.ready.store(false, Ordering::Release);
        let state = self.container.state().await?;
        let pull_first = match state {
            ContainerState::Absent => false,
            ContainerState::Present { run, .. } => {
                desired == Desired::Removed || matches!(run, RunState::Running | RunState::Paused)
            }
        };
        if pull_first {
            self.container.converge(Desired::Running).await?;
            self.mirror.pull(Freshness::Exact, &self.branch()).await?;
        }
        self.container.converge(desired).await?;
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
