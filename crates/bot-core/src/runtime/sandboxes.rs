use super::{Command, Location, Owner, call, providers::EnvKey};
use crate::{
    codex::auth::TokenBroker,
    domain::*,
    log::RotatingLog,
    mirror::{Freshness, RECENT},
    sandbox::{self, Desired, Docker, DockerStatus, Reconcile, SandboxConfig},
    terminal::{TerminalKey, Terminals},
    workdir::{Limits, Phase, SandboxHandle, Workdir, idle::CPU_BUSY_PERCENT},
};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{sync::mpsc, time::Instant};

const LOW_MEMORY_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub(super) const STOPPED_IDLE: &str = "Sandbox stopped while idle. Your next message restarts it.";
pub(super) const STOPPED_SETTLED: &str = "Sandbox stopped. Your next message restarts it.";

pub(crate) struct Referenced {
    pub mirror_root: PathBuf,
    pub branch: String,
}

pub(crate) struct Sandboxes {
    docker: Docker,
    pub broker: TokenBroker,
    log: RotatingLog,
    pub limits: Limits,
    next_tick: Mutex<Instant>,
    handles: Mutex<HashMap<SandboxId, Arc<SandboxHandle>>>,
    changed: mpsc::UnboundedSender<SandboxId>,
}
impl Sandboxes {
    pub(crate) fn new(
        config: SandboxConfig,
        broker: TokenBroker,
        limits: Limits,
        changed: mpsc::UnboundedSender<SandboxId>,
        log: RotatingLog,
    ) -> Self {
        Self {
            docker: Docker::new(config),
            broker,
            log,
            limits,
            next_tick: Mutex::new(Instant::now()),
            handles: Mutex::new(HashMap::new()),
            changed,
        }
    }
    #[cfg(test)]
    pub(crate) fn for_tests(dir: &Path) -> Self {
        Self::new(
            SandboxConfig {
                docker: "/no/docker".into(),
                data_dir: dir.to_path_buf(),
                codex: sandbox::CodexSource::Binary("/no/codex".into()),
            },
            TokenBroker::new(&dir.join("codex-home"), "/no/codex".into()),
            Limits::DEFAULT,
            mpsc::unbounded_channel().0,
            RotatingLog::silent(),
        )
    }
    pub(crate) fn workdir(&self, checkout: &Checkout, root: &Path) -> Workdir {
        match checkout {
            Checkout::Worktree {
                branch,
                sandbox: Some(Sandbox::Docker { id }),
                ..
            } => Workdir::Sandbox {
                root: root.to_path_buf(),
                handle: self.handle(id, root, branch),
            },
            Checkout::Local | Checkout::Worktree { .. } | Checkout::Folder { .. } => Workdir::Mac {
                root: root.to_path_buf(),
            },
        }
    }
    fn handle(&self, id: &SandboxId, mirror_root: &Path, branch: &str) -> Arc<SandboxHandle> {
        let handle = self
            .handles
            .lock()
            .unwrap()
            .entry(id.clone())
            .or_insert_with(|| {
                SandboxHandle::new(
                    self.docker.clone(),
                    id.clone(),
                    mirror_root.to_path_buf(),
                    branch.to_owned(),
                    self.limits.probe_every(),
                    self.changed.clone(),
                    self.log.clone(),
                )
            })
            .clone();
        handle.set_branch(branch);
        handle
    }
    pub(crate) fn existing(&self, id: &SandboxId) -> Option<Arc<SandboxHandle>> {
        self.handles.lock().unwrap().get(id).cloned()
    }
    pub(crate) fn forwarder_ports(&self) -> std::collections::BTreeSet<u16> {
        let handles = self.handles.lock().unwrap();
        handles
            .values()
            .flat_map(|handle| handle.forwarder_ports())
            .collect()
    }
    fn started(&self) -> Vec<Arc<SandboxHandle>> {
        self.handles
            .lock()
            .unwrap()
            .values()
            .filter(|handle| handle.is_started())
            .cloned()
            .collect()
    }
    pub(crate) async fn availability(&self) -> SandboxAvailability {
        let unavailable = |reason: &str| SandboxAvailability::Unavailable {
            reason: reason.into(),
        };
        let memory_bytes = match self.docker.status().await {
            DockerStatus::Ready { memory_bytes, .. } => memory_bytes,
            DockerStatus::NotInstalled => {
                return unavailable(
                    "Docker is not installed. Install Docker Desktop to use sandboxes.",
                );
            }
            DockerStatus::NotRunning { .. } => {
                return unavailable(
                    "Docker Desktop is not running. Start Docker Desktop to use sandboxes.",
                );
            }
        };
        if let Err(error) = self.broker.read() {
            return unavailable(&error.message);
        }
        SandboxAvailability::Ready {
            memory_bytes,
            low_memory: memory_bytes < LOW_MEMORY_BYTES,
        }
    }
    pub(crate) async fn wake_terminal(
        &self,
        terminals: &Terminals,
        key: &TerminalKey,
    ) -> Result<()> {
        let handle = terminals.sandbox_of(key).and_then(|id| self.existing(&id));
        match handle {
            Some(handle) => handle.wake().await,
            None => Ok(()),
        }
    }
    pub(crate) async fn reconcile(&self, referenced: HashMap<SandboxId, Referenced>) {
        let observed = match self.docker.list().await {
            Ok(observed) => observed,
            Err(error) => {
                self.log.line(
                    "sandbox",
                    &format!("reconciliation skipped: {}", error.message),
                );
                return;
            }
        };
        let ids: HashSet<SandboxId> = referenced.keys().cloned().collect();
        for step in sandbox::reconcile_plan(&observed, &ids) {
            let result = match step {
                Reconcile::PullThenStop(id) => {
                    let reference = &referenced[&id];
                    let handle = self.handle(&id, &reference.mirror_root, &reference.branch);
                    if handle.is_started() {
                        continue;
                    }
                    self.log.line(
                        &format!("sandbox[{id}]"),
                        "left running by a previous run: pulling and stopping",
                    );
                    handle.retire(Desired::Stopped).await
                }
                Reconcile::Remove(id) => {
                    self.log.line(
                        &format!("sandbox[{id}]"),
                        "no thread references it: removing",
                    );
                    let container = self.docker.container(&id);
                    let removed = container.converge(Desired::Removed).await.map(drop);
                    if removed.is_ok()
                        && let Some(dir) = container.codex_home().parent()
                    {
                        let _ = std::fs::remove_dir_all(dir);
                    }
                    removed
                }
            };
            if let Err(error) = result {
                self.log.line(
                    "sandbox",
                    &format!("reconciliation failed: {}", error.message),
                );
            }
        }
        match self.docker.prune_images().await {
            Ok(removed) => {
                for tag in removed {
                    self.log
                        .line("sandbox", &format!("removed old image {tag}"));
                }
            }
            Err(error) => self.log.line(
                "sandbox",
                &format!("old sandbox images kept: {}", error.message),
            ),
        }
    }
    pub(crate) async fn stop_all(&self) {
        for handle in self.started() {
            if let Err(error) = handle.retire(Desired::Stopped).await {
                self.log.line(
                    &format!("sandbox[{}]", handle.id),
                    &format!("stop at shutdown failed: {}", error.message),
                );
            }
        }
    }
    fn tick_due(&self, now: Instant) -> bool {
        let mut next = self.next_tick.lock().unwrap();
        if now < *next {
            return false;
        }
        *next = now + self.limits.tick();
        true
    }
}

enum Work {
    Probe,
    StopDesktop,
    Retire(Desired, &'static str),
}

impl Owner {
    pub(super) async fn sandbox_lifecycle(&mut self) {
        let now = Instant::now();
        if self.closing || !self.sandboxes.tick_due(now) {
            return;
        }
        let limits = self.sandboxes.limits;
        for handle in self.sandboxes.started() {
            let key = EnvKey::Sandbox(handle.id.clone());
            let busy = self.threads.values().any(|t| {
                EnvKey::of(&t.checkout) == key
                    && !self.idle(t, t.root(&self.workspaces[&t.workspace_id]))
            });
            if busy {
                handle.mark_busy(now.into_std());
            }
            if !handle.begin_work() {
                continue;
            }
            let activity = handle.activity();
            let requested = handle.stop_requested().filter(|_| !busy);
            let desired = match requested {
                Some(_) => Desired::Stopped,
                None => activity.desired(now.into_std(), &limits),
            };
            let work = match (handle.phase(), desired) {
                (Phase::Running, Desired::Running)
                    if activity.desktop_idle(now.into_std(), &limits) =>
                {
                    Work::StopDesktop
                }
                (Phase::Running, Desired::Running) if handle.probe_due(now.into_std()) => {
                    Work::Probe
                }
                (Phase::Running, Desired::Paused) => Work::Retire(Desired::Paused, "idle"),
                (Phase::Running | Phase::Paused, Desired::Stopped) => Work::Retire(
                    Desired::Stopped,
                    if requested.is_some() {
                        "settled"
                    } else {
                        "idle"
                    },
                ),
                _ => {
                    handle.end_work();
                    continue;
                }
            };
            if let Work::Retire(Desired::Stopped, _) = work {
                let reason = requested.unwrap_or(STOPPED_IDLE);
                let _ = self.stop_providers(Some(&key)).await;
                self.lose_env(&key, reason, reason).await;
            }
            tokio::spawn(async move {
                handle.lifecycle(work, now.into_std()).await;
                handle.end_work();
            });
        }
    }
    pub(super) fn stop_sandbox_of(&self, id: &ThreadId) {
        let Some(thread) = self.threads.get(id) else {
            return;
        };
        if let Workdir::Sandbox { handle, .. } = self.workdir(thread)
            && handle.is_started()
        {
            handle.request_stop(STOPPED_SETTLED);
        }
    }
    pub(super) fn sandbox_changed(&self, id: &SandboxId) {
        let key = EnvKey::Sandbox(id.clone());
        for thread in self.threads.values() {
            if EnvKey::of(&thread.checkout) == key {
                let _ = self.changes.send(self.thread_hint(thread));
            }
        }
    }
}

impl SandboxHandle {
    async fn lifecycle(&self, work: Work, decided_at: std::time::Instant) {
        match work {
            Work::Probe => match self.probe().await {
                Ok(Some(percent)) if percent >= CPU_BUSY_PERCENT => {
                    self.note(&format!("busy: {percent:.1}% CPU"));
                }
                Ok(_) => {}
                Err(error) => self.note(&format!("probe failed: {}", error.message)),
            },
            Work::StopDesktop => match self.stop_desktop().await {
                Ok(()) => self.note("desktop stopped: no Desktop tab and no turn"),
                Err(error) => self.note(&format!("desktop stop failed: {}", error.message)),
            },
            Work::Retire(desired, why) => match self.idle_retire(desired, decided_at).await {
                Ok(true) => self.note(&format!("{desired:?}: {why}").to_lowercase()),
                Ok(false) => {}
                Err(error) => {
                    self.note(&format!("{desired:?} ({why}) failed: {}", error.message));
                    self.touch();
                }
            },
        }
    }
}

pub(super) async fn pull_after_commands(
    commands: mpsc::WeakSender<Command>,
    mut prompts: mpsc::UnboundedReceiver<TerminalKey>,
) {
    let mut due: HashMap<(WorkspaceId, ThreadId), Instant> = HashMap::new();
    loop {
        let next = due.values().min().copied();
        tokio::select! {
            key = prompts.recv() => {
                let Some(key) = key else { return };
                if let Some(thread) = key.thread {
                    due.insert((key.workspace, thread), Instant::now() + RECENT);
                }
            }
            () = tokio::time::sleep_until(next.unwrap_or_else(Instant::now)), if next.is_some() => {
                let now = Instant::now();
                let mut settled = Vec::new();
                due.retain(|thread, at| {
                    let waiting = *at > now;
                    if !waiting {
                        settled.push(thread.clone());
                    }
                    waiting
                });
                for (workspace, thread) in settled {
                    let Some(commands) = commands.upgrade() else { return };
                    tokio::spawn(async move {
                        let location = call(&commands, |r| {
                            Command::Checkout(workspace, Some(thread.clone()), r)
                        })
                        .await;
                        let Ok((_, Location::Repository(workdir))) = location else { return };
                        if matches!(workdir.sync(Freshness::Recent).await, Ok(Some(_))) {
                            let _ = commands.send(Command::CheckoutPulled(thread)).await;
                        }
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_sandbox_worktree_resolves_to_a_sandbox_workdir_and_threads_share_its_handle() {
        let dir = tempfile::tempdir().unwrap();
        let sandboxes = Sandboxes::for_tests(dir.path());
        let root = dir.path().join("mirror");
        let id: SandboxId = "0123456789ab".parse().unwrap();
        let sandboxed = Checkout::Worktree {
            path: root.clone(),
            branch: "botcode/one".into(),
            sandbox: Some(Sandbox::Docker { id: id.clone() }),
        };
        for checkout in [
            Checkout::Local,
            Checkout::Worktree {
                path: root.clone(),
                branch: "botcode/one".into(),
                sandbox: None,
            },
            Checkout::Folder { path: root.clone() },
        ] {
            let workdir = sandboxes.workdir(&checkout, &root);
            assert!(workdir.sandbox().is_none(), "{checkout:?}");
            assert_eq!(workdir.root(), root.as_path());
        }
        assert!(sandboxes.existing(&id).is_none());
        let first = sandboxes.workdir(&sandboxed, &root);
        let handle = first.sandbox().expect("a sandbox workdir");
        assert_eq!(handle.id, id);
        assert_eq!(handle.branch(), "botcode/one");
        assert_eq!(handle.mirror.root(), root.as_path());
        assert_eq!(first.root(), root.as_path());
        assert!(!handle.is_ready(), "nothing has started the container");
        assert_eq!(handle.phase(), Phase::Stopped);

        let renamed = Checkout::Worktree {
            path: root.clone(),
            branch: "botcode/renamed".into(),
            sandbox: Some(Sandbox::Docker { id: id.clone() }),
        };
        let second = sandboxes.workdir(&renamed, &root);
        assert!(Arc::ptr_eq(handle, second.sandbox().unwrap()));
        assert!(Arc::ptr_eq(handle, &sandboxes.existing(&id).unwrap()));
        assert_eq!(handle.branch(), "botcode/renamed");
        assert_eq!(sandboxes.handles.lock().unwrap().len(), 1);
        assert!(sandboxes.started().is_empty());
    }
}
