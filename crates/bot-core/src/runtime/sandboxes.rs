//! The registry of sandbox handles, shared by the App and the owner loop, plus startup
//! reconciliation, shutdown, and mirror pulls after terminal commands.
use super::{Command, Location, call};
use crate::{
    codex::auth::TokenBroker,
    domain::*,
    log::RotatingLog,
    mirror::{Freshness, RECENT},
    sandbox::{self, CodexSource, Desired, Docker, DockerStatus, Reconcile, SandboxConfig},
    terminal::TerminalKey,
    workdir::{SandboxHandle, Workdir},
};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{sync::mpsc, time::Instant};

const LOW_MEMORY_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// What a reconciled sandbox needs besides its id: where its mirror is and which branch it
/// may move.
pub(crate) struct Referenced {
    pub mirror_root: PathBuf,
    pub branch: String,
}

pub(crate) struct Sandboxes {
    docker: Docker,
    pub broker: TokenBroker,
    log: RotatingLog,
    handles: Mutex<HashMap<SandboxId, Arc<SandboxHandle>>>,
}
impl Sandboxes {
    pub(crate) fn new(
        data_dir: &Path,
        codex_binary: &Path,
        codex_home: &Path,
        log: RotatingLog,
    ) -> Self {
        Self {
            docker: Docker::new(SandboxConfig {
                docker: sandbox::docker_binary(),
                data_dir: data_dir.to_path_buf(),
                codex: CodexSource::Binary(codex_binary.to_path_buf()),
            }),
            broker: TokenBroker::new(codex_home, codex_binary.to_path_buf()),
            log,
            handles: Mutex::new(HashMap::new()),
        }
    }
    /// The one match from a checkout to where it lives.
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
                    self.log.clone(),
                )
            })
            .clone();
        handle.set_branch(branch);
        handle
    }
    /// Handles whose container this process started.
    fn live(&self) -> Vec<Arc<SandboxHandle>> {
        self.handles
            .lock()
            .unwrap()
            .values()
            .filter(|handle| handle.is_ready())
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
    /// Startup repair. A referenced container left running or paused by a crash is pulled and
    /// stopped; a container no checkout names is removed with its Codex home. Nothing here
    /// touches a sandbox this process already readied.
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
                    if handle.is_ready() {
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
    }
    /// Pulls and stops every container this process started. The agents are already gone.
    pub(crate) async fn stop_all(&self) {
        for handle in self.live() {
            if let Err(error) = handle.retire(Desired::Stopped).await {
                self.log.line(
                    &format!("sandbox[{}]", handle.id),
                    &format!("stop at shutdown failed: {}", error.message),
                );
            }
        }
    }
}

/// Pulls a sandbox thread's mirror after a command in its terminal finishes, which the shell
/// signals by showing a prompt, so Files and Diff show what the command changed. Each thread
/// waits until its terminals have been quiet for `RECENT`: a pull from before the command's
/// edits is then old enough that the Recent pull runs instead of reusing it.
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

    fn sandboxes(dir: &Path) -> Sandboxes {
        Sandboxes::new(
            dir,
            Path::new("/no/codex"),
            &dir.join("codex-home"),
            RotatingLog::silent(),
        )
    }

    #[test]
    fn only_a_sandbox_worktree_resolves_to_a_sandbox_workdir_and_threads_share_its_handle() {
        let dir = tempfile::tempdir().unwrap();
        let sandboxes = sandboxes(dir.path());
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
        let first = sandboxes.workdir(&sandboxed, &root);
        let handle = first.sandbox().expect("a sandbox workdir");
        assert_eq!(handle.id, id);
        assert_eq!(handle.branch(), "botcode/one");
        assert_eq!(handle.mirror.root(), root.as_path());
        assert_eq!(first.root(), root.as_path());
        assert!(!handle.is_ready(), "nothing has started the container");

        // A second thread on the same checkout, after a branch rename, shares the handle and
        // refreshes the branch the mirror may move.
        let renamed = Checkout::Worktree {
            path: root.clone(),
            branch: "botcode/renamed".into(),
            sandbox: Some(Sandbox::Docker { id: id.clone() }),
        };
        let second = sandboxes.workdir(&renamed, &root);
        assert!(Arc::ptr_eq(handle, second.sandbox().unwrap()));
        assert_eq!(handle.branch(), "botcode/renamed");
        assert_eq!(sandboxes.handles.lock().unwrap().len(), 1);
        assert!(sandboxes.live().is_empty());
    }
}
