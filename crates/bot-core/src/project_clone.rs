// Ports T3 Code v0.0.45 ProjectCloneTracker.ts and gitCloneProgress.ts (MIT).
use crate::{AppError, GitOutputStream, GitProgress, Result, Workspace, WorkspaceId, now_ms, vcs};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{sync::watch, task::JoinHandle};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectClonePhase {
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectCloneStage {
    Connecting,
    Counting,
    Receiving,
    Resolving,
    Checkout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCloneSnapshot {
    pub workspace_id: WorkspaceId,
    pub remote_url: String,
    pub destination_path: String,
    pub phase: ProjectClonePhase,
    pub stage: ProjectCloneStage,
    pub percent: Option<u8>,
    pub detail: Option<String>,
    pub error: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCloneStartResult {
    pub workspace: Workspace,
    pub snapshot: ProjectCloneSnapshot,
}

struct TrackedClone {
    snapshot: ProjectCloneSnapshot,
    remote: String,
    destination: PathBuf,
    identity: DirectoryIdentity,
    cancel: Option<watch::Sender<bool>>,
    job: Option<JoinHandle<()>>,
    safe_to_clean: bool,
}

#[derive(Default)]
struct CloneState {
    entries: HashMap<WorkspaceId, TrackedClone>,
    sequence: u64,
    closed: bool,
}

#[derive(Clone, Default)]
pub(crate) struct ProjectClones {
    pub actions: Arc<tokio::sync::Mutex<()>>,
    state: Arc<Mutex<CloneState>>,
}

impl ProjectClones {
    pub fn list(&self) -> Vec<ProjectCloneSnapshot> {
        let mut state = self.state.lock().unwrap();
        state.entries.retain(|_, entry| {
            entry.snapshot.phase != ProjectClonePhase::Done
                || entry
                    .snapshot
                    .ended_at_ms
                    .is_none_or(|at| now_ms().saturating_sub(at) < 30_000)
        });
        let mut snapshots: Vec<_> = state
            .entries
            .values()
            .map(|entry| entry.snapshot.clone())
            .collect();
        snapshots.sort_by_key(|snapshot| snapshot.sequence);
        snapshots
    }

    pub fn snapshot(&self, id: &WorkspaceId) -> Option<ProjectCloneSnapshot> {
        self.state
            .lock()
            .unwrap()
            .entries
            .get(id)
            .map(|entry| entry.snapshot.clone())
    }

    pub fn reject_incomplete(&self, id: &WorkspaceId) -> Result<()> {
        if let Some(snapshot) = self.snapshot(id)
            && snapshot.phase != ProjectClonePhase::Done
        {
            return Err(AppError::new(
                "project_clone",
                if snapshot.phase == ProjectClonePhase::Running {
                    "The repository is still being cloned."
                } else {
                    "The repository was not cloned. Retry the clone first."
                },
            ));
        }
        Ok(())
    }

    pub fn claim(&self, remote: String, destination: PathBuf) -> Result<ProjectCloneSnapshot> {
        let remote = remote.trim().to_owned();
        if remote.is_empty() || remote.starts_with('-') || remote.contains('\0') {
            return Err(AppError::new(
                "project_clone",
                "Enter a repository path or clone URL before cloning.",
            ));
        }
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(AppError::new("runtime_closed", "Bot Code has closed."));
        }
        let destination = destination_path(&destination)?;
        if state
            .entries
            .values()
            .any(|entry| entry.destination == destination)
        {
            return Err(AppError::new(
                "project_clone",
                "A clone into this destination is already in progress.",
            ));
        }
        if let Ok(metadata) = std::fs::symlink_metadata(&destination) {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(AppError::new(
                    "project_clone",
                    "Destination path already exists and is not a directory.",
                ));
            }
            if std::fs::read_dir(&destination)?.next().is_some() {
                return Err(AppError::new(
                    "project_clone",
                    "Destination path already exists and is not empty.",
                ));
            }
        } else {
            std::fs::create_dir(&destination)?;
        }
        let identity = DirectoryIdentity::read(&destination)?;
        state.sequence += 1;
        let snapshot = ProjectCloneSnapshot {
            workspace_id: WorkspaceId::default(),
            remote_url: redact_credentials(&remote),
            destination_path: destination.to_string_lossy().into_owned(),
            phase: ProjectClonePhase::Running,
            stage: ProjectCloneStage::Connecting,
            percent: None,
            detail: None,
            error: None,
            started_at_ms: now_ms(),
            ended_at_ms: None,
            sequence: state.sequence,
        };
        state.entries.insert(
            snapshot.workspace_id.clone(),
            TrackedClone {
                snapshot: snapshot.clone(),
                remote,
                destination,
                identity,
                cancel: None,
                job: None,
                safe_to_clean: true,
            },
        );
        Ok(snapshot)
    }

    pub fn launch(&self, id: &WorkspaceId, search: crate::project_search::ProjectSearch) {
        let mut state = self.state.lock().unwrap();
        let entry = state.entries.get_mut(id).unwrap();
        let (cancel, mut cancelled) = watch::channel(false);
        entry.cancel = Some(cancel);
        let remote = entry.remote.clone();
        let destination = entry.destination.clone();
        let tracker = self.clone();
        let id = id.clone();
        entry.job = Some(tokio::spawn(async move {
            let tail = Mutex::new(VecDeque::new());
            let observe = |update| {
                if let GitProgress::Output {
                    stream: GitOutputStream::Stderr,
                    line,
                } = update
                {
                    if let Some((stage, percent, detail)) = parse_progress(&line) {
                        tracker.update(&id, |entry| {
                            entry.snapshot.stage = stage;
                            entry.snapshot.percent = percent;
                            entry.snapshot.detail = detail;
                        });
                    } else if !line.trim().is_empty() && !line.starts_with("Cloning into") {
                        let mut tail = tail.lock().unwrap();
                        tail.push_back(clamp(&redact_credentials(line.trim()), 1000));
                        while tail.len() > 4 {
                            tail.pop_front();
                        }
                    }
                }
            };
            let destination_name = destination.file_name().unwrap().to_string_lossy();
            let outcome = vcs::Tool {
                program: Path::new("git"),
                cwd: destination.parent().unwrap(),
            }
            .clone_progress(
                &["clone", "--progress", "--", &remote, &destination_name],
                &mut cancelled,
                &observe,
            )
            .await;
            let (phase, error, safe) = match outcome {
                Ok(output) if output.code == Some(0) => (ProjectClonePhase::Done, None, true),
                Err(error) if error.code == "cancelled" => {
                    (ProjectClonePhase::Cancelled, None, true)
                }
                outcome => {
                    let (fallback, safe) = match outcome {
                        Err(error) => (
                            redact_credentials(&error.message),
                            error.code != "process_cleanup",
                        ),
                        Ok(_) => ("The repository could not be cloned.".into(), true),
                    };
                    let tail = tail.into_inner().unwrap();
                    let error = if tail.is_empty() {
                        fallback
                    } else {
                        tail.into_iter().collect::<Vec<_>>().join(" ")
                    };
                    (ProjectClonePhase::Failed, Some(clamp(&error, 1000)), safe)
                }
            };
            tracker.update(&id, |entry| {
                entry.snapshot.phase = phase;
                entry.snapshot.error = error;
                entry.snapshot.ended_at_ms = Some(now_ms());
                entry.safe_to_clean = safe;
                if phase == ProjectClonePhase::Done {
                    entry.snapshot.percent = Some(100);
                }
            });
            if phase == ProjectClonePhase::Done {
                search.invalidate();
            }
        }));
    }

    fn update(&self, id: &WorkspaceId, change: impl FnOnce(&mut TrackedClone)) {
        let mut state = self.state.lock().unwrap();
        state.sequence += 1;
        let sequence = state.sequence;
        if let Some(entry) = state.entries.get_mut(id) {
            change(entry);
            entry.snapshot.sequence = sequence;
        }
    }

    async fn join(&self, id: &WorkspaceId, cancel: bool) -> Result<()> {
        let job = {
            let mut state = self.state.lock().unwrap();
            let Some(entry) = state.entries.get_mut(id) else {
                return Ok(());
            };
            if cancel
                && entry.snapshot.phase == ProjectClonePhase::Running
                && let Some(sender) = &entry.cancel
            {
                let _ = sender.send(true);
            }
            entry.job.take()
        };
        if let Some(job) = job {
            job.await
                .map_err(|error| AppError::new("project_clone", error))?;
        }
        Ok(())
    }

    fn clean(&self, id: &WorkspaceId) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let Some(entry) = state.entries.get_mut(id) else {
            return Ok(());
        };
        if entry.snapshot.phase == ProjectClonePhase::Done {
            return Ok(());
        }
        if !entry.safe_to_clean {
            return Err(AppError::new(
                "process_cleanup",
                "The clone process did not stop. Its files were kept.",
            ));
        }
        entry.identity.clean(&entry.destination)
    }

    pub async fn cancel(&self, id: &WorkspaceId) -> Result<bool> {
        let _guard = self.actions.lock().await;
        if self
            .snapshot(id)
            .is_none_or(|snapshot| snapshot.phase != ProjectClonePhase::Running)
        {
            return Ok(false);
        }
        self.join(id, true).await?;
        self.clean(id)?;
        Ok(true)
    }

    pub async fn retry(
        &self,
        id: &WorkspaceId,
        search: crate::project_search::ProjectSearch,
    ) -> Result<bool> {
        let _guard = self.actions.lock().await;
        if self.snapshot(id).is_none_or(|snapshot| {
            !matches!(
                snapshot.phase,
                ProjectClonePhase::Failed | ProjectClonePhase::Cancelled
            )
        }) {
            return Ok(false);
        }
        self.join(id, false).await?;
        self.clean(id)?;
        self.update(id, |entry| {
            entry.snapshot.phase = ProjectClonePhase::Running;
            entry.snapshot.stage = ProjectCloneStage::Connecting;
            entry.snapshot.percent = None;
            entry.snapshot.detail = None;
            entry.snapshot.error = None;
            entry.snapshot.started_at_ms = now_ms();
            entry.snapshot.ended_at_ms = None;
        });
        self.launch(id, search);
        Ok(true)
    }

    pub async fn discard_locked(&self, id: &WorkspaceId) -> Result<()> {
        self.join(id, true).await?;
        self.clean(id)?;
        self.state.lock().unwrap().entries.remove(id);
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<()> {
        let _guard = self.actions.lock().await;
        let ids = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            state.entries.keys().cloned().collect::<Vec<_>>()
        };
        let mut failure = None;
        for id in ids {
            if let Err(error) = self.discard_locked(&id).await {
                failure = Some(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

fn destination_path(path: &Path) -> Result<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(AppError::new(
            "project_clone",
            "Choose a destination path before cloning.",
        ));
    }
    let text = path.to_string_lossy();
    let path = if let Some(tail) = text.strip_prefix("~/") {
        std::env::home_dir()
            .ok_or_else(|| AppError::new("project_clone", "Home directory is unavailable."))?
            .join(tail)
    } else if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let name = path
        .file_name()
        .ok_or_else(|| AppError::new("project_clone", "Choose a project folder before cloning."))?;
    let parent = path.parent().unwrap();
    std::fs::create_dir_all(parent)?;
    Ok(dunce::canonicalize(parent)?.join(name))
}

struct DirectoryIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    created_at: u64,
}
impl DirectoryIdentity {
    fn read(path: &Path) -> Result<Self> {
        let metadata = std::fs::symlink_metadata(path)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(AppError::new(
                "project_clone",
                "The clone destination is no longer the claimed directory.",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            })
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            Ok(Self {
                created_at: metadata.creation_time(),
            })
        }
    }
    fn clean(&mut self, path: &Path) -> Result<()> {
        if !path.try_exists()? {
            std::fs::create_dir(path)?;
            *self = Self::read(path)?;
            return Ok(());
        }
        let current = Self::read(path)?;
        #[cfg(unix)]
        let matches = self.device == current.device && self.inode == current.inode;
        #[cfg(windows)]
        let matches = self.created_at == current.created_at;
        if !matches {
            return Err(AppError::new(
                "project_clone",
                "The clone destination was replaced. Its files were kept.",
            ));
        }
        let entries = std::fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        if !entries.is_empty() && !path.join(".git").is_dir() {
            return Err(AppError::new(
                "project_clone",
                "Destination path contains files that are not from the clone.",
            ));
        }
        for entry in entries {
            if entry.file_type()?.is_dir() {
                std::fs::remove_dir_all(entry.path())?;
            } else {
                std::fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}

fn clamp(text: &str, max: usize) -> String {
    if text.encode_utf16().count() <= max {
        return text.into();
    }
    let mut units = 0;
    text.chars()
        .take_while(|character| {
            units += character.len_utf16();
            units < max
        })
        .chain(['…'])
        .collect()
}

fn redact_credentials(text: &str) -> String {
    let mut result = text.to_owned();
    let mut offset = 0;
    while let Some(scheme) = result[offset..].find("://") {
        let start = offset + scheme + 3;
        let end = result[start..]
            .find(['/', ' ', '\'', '"', '\n', '\r'])
            .map_or(result.len(), |end| start + end);
        if let Some(at) = result[start..end].rfind('@') {
            result.replace_range(start..start + at, "***");
            offset = start + 4;
        } else {
            offset = end;
        }
        if offset >= result.len() {
            break;
        }
    }
    result
}

fn parse_progress(line: &str) -> Option<(ProjectCloneStage, Option<u8>, Option<String>)> {
    let line = line.trim();
    let stage = [
        ("remote: Enumerating objects", ProjectCloneStage::Counting),
        ("remote: Counting objects", ProjectCloneStage::Counting),
        ("remote: Compressing objects", ProjectCloneStage::Counting),
        ("Receiving objects", ProjectCloneStage::Receiving),
        ("Resolving deltas", ProjectCloneStage::Resolving),
        ("Updating files", ProjectCloneStage::Checkout),
        ("Checking out files", ProjectCloneStage::Checkout),
    ]
    .into_iter()
    .find_map(|(prefix, stage)| line.starts_with(prefix).then_some(stage))?;
    let percent = line
        .split_once('%')
        .and_then(|(counter, _)| counter.rsplit_once(':'))
        .and_then(|(_, value)| value.trim().parse::<u16>().ok())
        .map(|value| value.min(100) as u8);
    let detail = line.split_once(')').and_then(|(_, suffix)| {
        let detail = suffix
            .trim()
            .trim_start_matches(',')
            .trim()
            .trim_end_matches(", done.");
        (!detail.is_empty() && detail != "done.").then(|| clamp(detail, 200))
    });
    Some((stage, percent, detail))
}

#[cfg(test)]
mod tests;
