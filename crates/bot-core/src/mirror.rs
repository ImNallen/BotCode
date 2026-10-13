//! Git-level sync between a sandbox container's `/workspace` and its Mac mirror worktree.
//!
//! The container is authoritative. Only git objects cross the boundary, over the `ext::`
//! transport, so host git never reads the container repository's config or hooks. A
//! [`SyncPoint`] is one commit with the same shape on both sides (see the in-image `sync`
//! script), which makes pull and push mirror images of each other, and the last state both
//! sides agreed on lives in git refs that are written last.
//!
//! One [`Mirror`] per sandbox is the single writer of the mirror worktree, its HEAD and index,
//! and the sync refs. Every operation holds the mirror's own lock; there is no cross-sandbox
//! lock. Host functions that mutate the mirror take a [`WriteRoot`], which only a
//! [`WriteSession`] can produce, so a mutation that forgets the push does not compile.
mod host;
#[cfg(test)]
mod tests;

use crate::domain::{AppError, Result, SandboxId};
use crate::sandbox::{Container, ContainerState, Exec, Input, RunState, WORKSPACE};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, OwnedMutexGuard};

const SYNC: &str = "/opt/botcode/bin/sync";
const SEED_BUNDLE: &str = "/botcode/seed.bundle";
const SEEDED: &str = "/workspace/.git/botcode-seeded";
const CONTAINER_OUTGOING: &str = "refs/botcode/sync/outgoing";
const CONTAINER_INCOMING: &str = "refs/botcode/sync/incoming";
/// A pull that started this recently satisfies [`Freshness::Recent`].
pub(crate) const RECENT: Duration = Duration::from_secs(1);
const CAPTURE: Duration = Duration::from_secs(120);
const SEED: Duration = Duration::from_secs(600);
const MARK: Duration = Duration::from_secs(30);
/// Commit hooks run the repository's own toolchain inside the container.
pub const COMMIT_LIMIT: Duration = Duration::from_secs(600);
const DIVERGED_EXIT: i32 = 3;
const BLOCKED_EXIT: i32 = 4;

/// The complete Bot Code-visible state of a checkout, as one commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncPoint {
    pub commit: String,
    pub head: Head,
    pub index_tree: String,
    pub worktree_tree: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Head {
    Branch { name: String, commit: String },
    Detached { commit: String },
    Unborn { name: String },
}
impl Head {
    pub fn commit(&self) -> Option<&str> {
        match self {
            Self::Branch { commit, .. } | Self::Detached { commit } => Some(commit),
            Self::Unborn { .. } => None,
        }
    }
    /// The `head:` line of a sync commit message.
    fn spec(&self) -> String {
        match self {
            Self::Branch { name, .. } => format!("branch {name}"),
            Self::Detached { .. } => "detached".into(),
            Self::Unborn { name } => format!("unborn {name}"),
        }
    }
    /// Inverse of [`Head::spec`], given the sync commit's parent.
    fn parse(spec: &str, parent: Option<&str>) -> Option<Self> {
        match (spec.split_once(' '), spec, parent) {
            (Some(("branch", name)), _, Some(commit)) => Some(Self::Branch {
                name: name.into(),
                commit: commit.into(),
            }),
            (None, "detached", Some(commit)) => Some(Self::Detached {
                commit: commit.into(),
            }),
            (Some(("unborn", name)), _, None) => Some(Self::Unborn { name: name.into() }),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freshness {
    /// UI reads. A pull that started within the last second satisfies it.
    Recent,
    /// Checkpoints and writes. A pull that starts after this call.
    Exact,
}

/// Branches on the Mac that constrain where the mirror's HEAD may go.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MacBranches {
    /// Every local branch and its commit.
    pub existing: BTreeMap<String, String>,
    /// Checked out by a Mac worktree other than this mirror. Moving one would corrupt that
    /// checkout.
    pub elsewhere: BTreeSet<String>,
}

/// What the host does with the container's HEAD.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostHead {
    Branch {
        name: String,
        commit: String,
    },
    /// `refused_branch` names a Mac branch the container may not move: one another Mac
    /// worktree has checked out, or one the pull would rewrite without fast-forwarding. The
    /// mirror detaches at the commit instead and the thread shows a diagnostic.
    Detached {
        commit: String,
        refused_branch: Option<String>,
    },
    Unborn {
        name: String,
    },
    /// The container is on an unborn branch whose name a Mac branch already has. The mirror
    /// keeps its HEAD.
    Unmoved {
        refused_branch: String,
    },
}
impl HostHead {
    pub fn refused_branch(&self) -> Option<&str> {
        match self {
            Self::Detached { refused_branch, .. } => refused_branch.as_deref(),
            Self::Unmoved { refused_branch } => Some(refused_branch),
            Self::Branch { .. } | Self::Unborn { .. } => None,
        }
    }
}
/// HEAD policy. The thread's own sandbox branch, `own`, follows the container anywhere. Any
/// other Mac branch moves only by fast-forward, judged by `is_ancestor(old, new)`, and never
/// while another Mac worktree has it checked out.
pub fn host_head(
    container: &Head,
    mac: &MacBranches,
    own: &str,
    is_ancestor: impl Fn(&str, &str) -> bool,
) -> HostHead {
    match container {
        Head::Branch { name, commit } if name != own => {
            let refused = mac.elsewhere.contains(name)
                || mac
                    .existing
                    .get(name)
                    .is_some_and(|old| old != commit && !is_ancestor(old, commit));
            if refused {
                HostHead::Detached {
                    commit: commit.clone(),
                    refused_branch: Some(name.clone()),
                }
            } else {
                HostHead::Branch {
                    name: name.clone(),
                    commit: commit.clone(),
                }
            }
        }
        Head::Branch { name, commit } => HostHead::Branch {
            name: name.clone(),
            commit: commit.clone(),
        },
        Head::Detached { commit } => HostHead::Detached {
            commit: commit.clone(),
            refused_branch: None,
        },
        Head::Unborn { name } if mac.existing.contains_key(name) => HostHead::Unmoved {
            refused_branch: name.clone(),
        },
        Head::Unborn { name } => HostHead::Unborn { name: name.clone() },
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Timing {
    pub capture: Duration,
    pub fetch: Duration,
    pub apply: Duration,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pulled {
    pub point: SyncPoint,
    pub host_head: HostHead,
    pub timing: Timing,
}

/// Why a push did not happen. The mirror has been pulled back to the container's state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PushRefusal {
    /// The container moved on since the base: it changed a worktree path the host also
    /// changed, staged something, or moved HEAD. The caller reports "Files changed in the
    /// sandbox. Try again."
    Diverged {
        paths: Vec<String>,
        head_moved: bool,
    },
    /// An ignored file in the container is in the way of a path the host wrote. Mirrors the
    /// collision rule of `checkpoints::restore`.
    Blocked { path: String },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PushError {
    Refused(PushRefusal),
    Failed(AppError),
}
impl From<AppError> for PushError {
    fn from(error: AppError) -> Self {
        Self::Failed(error)
    }
}
impl From<PushError> for AppError {
    fn from(error: PushError) -> Self {
        match error {
            PushError::Failed(error) => error,
            PushError::Refused(PushRefusal::Diverged { .. }) => AppError::new(
                "sandbox_diverged",
                "Files changed in the sandbox. Try again.",
            ),
            PushError::Refused(PushRefusal::Blocked { path }) => AppError::new(
                "sandbox_blocked",
                format!("{path} in the sandbox is in the way. Move it before retrying."),
            ),
        }
    }
}
/// The `sync apply` script's exit 3 output: `<kind>\t<path>\0` records. A path in the way
/// outranks divergence, because moving it is the user's only remedy.
fn refusal(stdout: &[u8]) -> PushRefusal {
    let mut paths = Vec::new();
    let mut head_moved = false;
    for record in stdout.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let record = String::from_utf8_lossy(record);
        match record.split_once('\t') {
            Some(("head", _)) => head_moved = true,
            Some(("blocked", path)) => return PushRefusal::Blocked { path: path.into() },
            Some((_, path)) => paths.push(path.to_owned()),
            None => {}
        }
    }
    paths.sort();
    paths.dedup();
    PushRefusal::Diverged { paths, head_moved }
}
/// Git's `read-tree -m -u` refusal, quoted from the container's stderr.
fn blocked(stderr: &str) -> Option<PushRefusal> {
    stderr.lines().find_map(|line| {
        let path = line.split('\'').nth(1)?.to_owned();
        let blocked = [
            "would be overwritten",
            "would lose untracked",
            "overlaps with",
        ]
        .iter()
        .any(|marker| line.contains(marker));
        blocked.then_some(PushRefusal::Blocked { path })
    })
}

#[derive(Default)]
struct SyncState {
    /// When the last successful pull started.
    pulled_at: Option<Instant>,
}

/// Cheap to clone. Clones share the lock.
#[derive(Clone)]
pub struct Mirror {
    container: Container,
    root: Arc<PathBuf>,
    state: Arc<Mutex<SyncState>>,
}

/// The mirror lock, held until dropped. A checkpoint capture or a revert restore on the mirror
/// runs under it, so a UI read's pull cannot rewrite the worktree underneath.
pub struct Synced {
    pub pulled: Option<Pulled>,
    _hold: OwnedMutexGuard<SyncState>,
}

/// Proof that the mirror was freshly pulled and is held for writing.
pub struct WriteRoot(PathBuf);
impl std::ops::Deref for WriteRoot {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}
impl WriteRoot {
    /// Mac checkouts: no sync, the root is the authority. The Mac `Workdir` is its caller.
    pub fn mac(root: PathBuf) -> Self {
        Self(root)
    }
}
/// A clone is still proof: it only exists while the session that produced it does, and the
/// blocking thread that runs a mutation needs an owned value.
impl Clone for WriteRoot {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

pub struct WriteSession {
    mirror: Mirror,
    hold: OwnedMutexGuard<SyncState>,
    root: WriteRoot,
    own: String,
}
#[derive(Debug)]
pub struct CommitRun {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

impl Mirror {
    pub fn new(container: Container, root: PathBuf) -> Self {
        Self {
            container,
            root: Arc::new(root),
            state: Default::default(),
        }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn container(&self) -> &Container {
        &self.container
    }
    fn id(&self) -> &SandboxId {
        self.container.id()
    }

    /// Make `/workspace` a clone of the mirror if it is not one yet, then push the mirror's
    /// uncommitted state so a recreated container matches it. Idempotent through a marker
    /// written last: a crash mid-seed leaves no marker and the next call starts over.
    pub async fn seed(&self, own: &str) -> Result<()> {
        let mut hold = self.state.clone().lock_owned().await;
        if self.exec(&["test", "-f", SEEDED], MARK).await?.code == Some(0) {
            return Ok(());
        }
        let root = self.root.clone();
        let scratch = tempfile::tempdir()?;
        let bundle = scratch.path().join("seed.bundle");
        let (head, identity) = {
            let bundle = bundle.clone();
            self.blocking(move || {
                let head = host::bundle(&root, &bundle)?;
                Ok((head, host::identity(&root)))
            })
            .await?
        };
        let source = if head.commit().is_some() {
            self.container.copy_in(&bundle, SEED_BUNDLE).await?;
            SEED_BUNDLE
        } else {
            "-"
        };
        let spec = head.spec();
        let mut argv = vec![SYNC, "seed", source];
        argv.extend(spec.split(' '));
        let env: Vec<(&str, &str)> = [
            ("BOTCODE_USER_NAME", identity.0.as_deref()),
            ("BOTCODE_USER_EMAIL", identity.1.as_deref()),
        ]
        .into_iter()
        .filter_map(|(key, value)| Some((key, value?)))
        .collect();
        let output = self
            .container
            .run(
                &Exec {
                    argv: &argv,
                    workdir: WORKSPACE,
                    env: &env,
                },
                Input::Lifeline,
                SEED,
            )
            .await?;
        if output.code != Some(0) {
            return Err(failure("Seeding the sandbox failed", &output.stderr));
        }
        let outgoing = self.capture_in_container(None).await?;
        let (root, id, transport) = self.host();
        self.blocking(move || {
            host::fetch(&root, &id, &transport, &outgoing)?;
            host::set_base(&root, &id, &outgoing)
        })
        .await?;
        self.push_locked(&mut hold, own)
            .await
            .map_err(AppError::from)?;
        let marked = self.exec(&["touch", SEEDED], MARK).await?;
        if marked.code != Some(0) {
            return Err(failure("Seeding the sandbox failed", &marked.stderr));
        }
        hold.pulled_at = Some(Instant::now());
        Ok(())
    }

    /// Container to Mac. Mac-side drift in the mirror is overwritten. `own` is the thread's
    /// sandbox branch, which [`host_head`] lets the container move freely. Returns the lock,
    /// which the caller holds while it reads or captures the mirror. A pull while the
    /// container is not running does nothing, because every transition away from running
    /// pulls first.
    pub async fn sync(&self, freshness: Freshness, own: &str) -> Result<Synced> {
        let hold = self.state.clone().lock_owned().await;
        self.synced(hold, freshness, own).await
    }
    /// A recent pull that does not wait: `None` while a session, a capture or another pull
    /// holds the mirror, so a UI read during a long commit serves the stale mirror instead
    /// of blocking on it.
    pub async fn try_sync_recent(&self, own: &str) -> Result<Option<Synced>> {
        match self.state.clone().try_lock_owned() {
            Ok(hold) => self.synced(hold, Freshness::Recent, own).await.map(Some),
            Err(_) => Ok(None),
        }
    }
    async fn synced(
        &self,
        mut hold: OwnedMutexGuard<SyncState>,
        freshness: Freshness,
        own: &str,
    ) -> Result<Synced> {
        let recent = hold.pulled_at.is_some_and(|at| at.elapsed() < RECENT);
        let pulled = if freshness == Freshness::Recent && recent {
            None
        } else {
            self.pull_locked(&mut hold, own).await?
        };
        Ok(Synced {
            pulled,
            _hold: hold,
        })
    }
    pub async fn pull(&self, freshness: Freshness, own: &str) -> Result<Option<Pulled>> {
        Ok(self.sync(freshness, own).await?.pulled)
    }
    /// Pull exactly, then hand out the mirror for host-side mutation. While the session lives,
    /// no pull or other session runs for this sandbox.
    pub async fn begin_write(&self, own: &str) -> Result<WriteSession> {
        let mut hold = self.state.clone().lock_owned().await;
        self.pull_locked(&mut hold, own).await?;
        Ok(WriteSession {
            mirror: self.clone(),
            hold,
            root: WriteRoot(self.root.to_path_buf()),
            own: own.to_owned(),
        })
    }

    async fn pull_locked(&self, state: &mut SyncState, own: &str) -> Result<Option<Pulled>> {
        let started = Instant::now();
        let (root, id, _) = self.host();
        let (base, outgoing) = self
            .blocking(move || Ok((host::base(&root, &id)?, host::outgoing(&root, &id)?)))
            .await?;
        let captured = match self.capture_in_container(base.as_deref()).await {
            Ok(commit) => commit,
            Err(error) if !self.running().await? => return Ok(None),
            Err(error) => return Err(error),
        };
        let capture = started.elapsed();
        let pulled = if base.as_deref() == Some(&captured) && outgoing == base {
            None
        } else {
            self.adopt(captured, base, capture, own).await?
        };
        state.pulled_at = Some(started);
        Ok(pulled)
    }
    /// Fetches the container's sync point, checks it, and applies it to the mirror. Only the
    /// base ref moving last makes this restartable.
    async fn adopt(
        &self,
        captured: String,
        base: Option<String>,
        capture: Duration,
        own: &str,
    ) -> Result<Option<Pulled>> {
        let (root, id, transport) = self.host();
        let own = own.to_owned();
        self.blocking(move || {
            let started = Instant::now();
            if base.as_deref() != Some(&captured) {
                host::fetch(&root, &id, &transport, &captured)?;
            }
            let fetch = started.elapsed();
            let started = Instant::now();
            let point = host::point(&root, &captured)?;
            host::validate_tree(&root, &point.worktree_tree)?;
            let head = host_head(
                &point.head,
                &host::mac_branches(&root)?,
                &own,
                |old, new| host::is_ancestor(&root, old, new),
            );
            host::apply(&root, &id, &point, &head, base.as_deref())?;
            Ok(Some(Pulled {
                point,
                host_head: head,
                timing: Timing {
                    capture,
                    fetch,
                    apply: started.elapsed(),
                },
            }))
        })
        .await
    }

    /// Mac to container, fast-forward only. On refusal the mirror is pulled back to the
    /// container's state, so the two sides never stay apart.
    async fn push_locked(
        &self,
        state: &mut SyncState,
        own: &str,
    ) -> std::result::Result<(), PushError> {
        let (root, id, transport) = self.host();
        let (base, point) = self
            .blocking(move || {
                let base = host::base(&root, &id)?
                    .ok_or_else(|| AppError::new("mirror", "The sandbox has not been seeded."))?;
                let point = host::capture(&root, &id)?;
                if point.commit != base {
                    host::push(&root, &id, &transport)?;
                }
                Ok((base, point))
            })
            .await?;
        if point.commit == base {
            return Ok(());
        }
        let output = self
            .exec(&[SYNC, "apply", &base, &point.commit], CAPTURE)
            .await?;
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let refusal = match output.code {
            Some(0) => {
                let (root, id, _) = self.host();
                let commit = point.commit.clone();
                return self
                    .blocking(move || host::set_base(&root, &id, &commit))
                    .await
                    .map_err(PushError::from);
            }
            Some(DIVERGED_EXIT) => refusal(&output.stdout),
            Some(BLOCKED_EXIT) => blocked(&stderr).ok_or_else(|| {
                PushError::Failed(failure("The sandbox refused the update", &output.stderr))
            })?,
            _ => {
                return Err(PushError::Failed(failure(
                    "Updating the sandbox failed",
                    &output.stderr,
                )));
            }
        };
        self.pull_locked(state, own).await?;
        Err(PushError::Refused(refusal))
    }

    async fn capture_in_container(&self, base: Option<&str>) -> Result<String> {
        let mut argv = vec![SYNC, "capture"];
        argv.extend(base);
        let output = self.exec(&argv, CAPTURE).await?;
        if output.code != Some(0) {
            return Err(failure("Capturing the sandbox failed", &output.stderr));
        }
        let commit = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if commit.len() != 40 || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AppError::new(
                "mirror",
                "The sandbox returned an invalid sync point.",
            ));
        }
        Ok(commit)
    }
    async fn running(&self) -> Result<bool> {
        Ok(matches!(
            self.container.state().await?,
            ContainerState::Present {
                run: RunState::Running,
                ..
            }
        ))
    }
    async fn exec(&self, argv: &[&str], limit: Duration) -> Result<crate::sandbox::Output> {
        self.container
            .run(
                &Exec {
                    argv,
                    workdir: WORKSPACE,
                    env: &[],
                },
                Input::Lifeline,
                limit,
            )
            .await
    }
    fn host(&self) -> (Arc<PathBuf>, SandboxId, String) {
        (
            self.root.clone(),
            self.id().clone(),
            self.container.git_transport(),
        )
    }
    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        tokio::task::spawn_blocking(work)
            .await
            .map_err(|error| AppError::new("mirror", error))?
    }
}

impl WriteSession {
    pub fn root(&self) -> &WriteRoot {
        &self.root
    }
    /// Push, run `git commit -m <message>` in the container (repository hooks need the
    /// container toolchain), then pull, all under the same lock. The pushed index is exactly
    /// what host-side staging selected.
    pub async fn commit(
        &mut self,
        message: &str,
        limit: Duration,
    ) -> std::result::Result<CommitRun, PushError> {
        self.mirror.push_locked(&mut self.hold, &self.own).await?;
        let output = self
            .mirror
            .container
            .run(
                &Exec {
                    argv: &["git", "commit", "-m", message],
                    workdir: WORKSPACE,
                    env: &[("GIT_TERMINAL_PROMPT", "0"), ("GIT_EDITOR", "true")],
                },
                Input::Lifeline,
                limit,
            )
            .await?;
        self.mirror.pull_locked(&mut self.hold, &self.own).await?;
        Ok(CommitRun {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            code: output.code,
        })
    }
    /// Mac to container. Fast-forward only: never overwrites container changes.
    pub async fn finish(mut self) -> std::result::Result<(), PushError> {
        self.mirror.push_locked(&mut self.hold, &self.own).await
    }
    /// `git branch -m <old> <new>` in the container, matching the same rename on the mirror.
    /// The session then ends with [`WriteSession::pull`], because a push would see the
    /// container's own HEAD move as divergence.
    pub async fn rename_branch(&mut self, old: &str, new: &str) -> Result<()> {
        let output = self
            .mirror
            .exec(&["git", "branch", "-m", old, new], MARK)
            .await?;
        if output.code != Some(0) {
            return Err(failure(
                "Renaming the branch in the sandbox failed",
                &output.stderr,
            ));
        }
        self.own = new.to_owned();
        Ok(())
    }
    /// Ends the session by adopting the container's state, for a change made on both sides.
    pub async fn pull(mut self) -> Result<()> {
        self.mirror
            .pull_locked(&mut self.hold, &self.own)
            .await
            .map(drop)
    }
}

fn failure(what: &str, stderr: &[u8]) -> AppError {
    let stderr = String::from_utf8_lossy(stderr);
    let detail = stderr.trim();
    AppError::new(
        "mirror",
        if detail.is_empty() {
            format!("{what}.")
        } else {
            format!("{what}: {detail}")
        },
    )
}
