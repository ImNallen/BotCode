// Source-control refresh adapts T3 Code v0.0.45 automatic fetch and pull to native checkout claims (MIT).
use super::*;
use tokio::sync::watch;

pub(super) struct RefreshCompletion {
    workspace: WorkspaceId,
    root: PathBuf,
    result: Result<bool>,
}
#[derive(Default)]
pub(super) struct RefreshWork {
    pub deadlines: HashMap<PathBuf, tokio::time::Instant>,
    started: HashSet<PathBuf>,
    running: HashSet<WorkspaceId>,
    cancels: HashMap<PathBuf, watch::Sender<bool>>,
    pub active: tokio::task::JoinSet<RefreshCompletion>,
}
impl Owner {
    pub(super) fn poll_source_control(&mut self) {
        if self.closing || self.source_control.active.len() >= 4 {
            return;
        }
        let now = tokio::time::Instant::now();
        let interval = self.source_control_settings.fetch_interval();
        let mut checkouts = HashMap::new();
        for workspace in self
            .workspaces
            .values()
            .filter(|workspace| workspace.kind == WorkspaceKind::Repository)
        {
            if let Ok(root) = dunce::canonicalize(&workspace.root) {
                checkouts
                    .entry(root)
                    .or_insert_with(|| workspace.id.clone());
            }
        }
        for thread in self.threads.values() {
            if let Checkout::Worktree { path, .. } = &thread.checkout
                && let Some(workspace) = self.workspaces.get(&thread.workspace_id)
                && workspace.kind == WorkspaceKind::Repository
                && let Ok(root) = dunce::canonicalize(path)
            {
                checkouts
                    .entry(root)
                    .or_insert_with(|| workspace.id.clone());
            }
        }
        self.source_control
            .deadlines
            .retain(|root, _| checkouts.contains_key(root));
        self.source_control
            .started
            .retain(|root| checkouts.contains_key(root));
        for (root, workspace) in checkouts {
            if self.source_control.active.len() >= 4 {
                break;
            }
            if self.source_control.running.contains(&workspace) {
                continue;
            }
            let startup = !self.source_control.started.contains(&root);
            let auto_pull = self
                .source_control_settings
                .for_project(&workspace)
                .auto_pull;
            let periodic = interval.is_some_and(|period| {
                let Some(next) = now.checked_add(period) else {
                    return false;
                };
                let deadline = self
                    .source_control
                    .deadlines
                    .entry(root.clone())
                    .or_insert(next);
                if now < *deadline || self.changes.receiver_count() == 0 {
                    return false;
                }
                true
            });
            if !(periodic || startup && auto_pull) || self.source_control.active.len() >= 4 {
                continue;
            }
            if self.writing.has_preview(&root)
                || self.source_control.cancels.contains_key(&root)
                || self.claim_path(root.clone(), Hold::SourceControl).is_err()
            {
                continue;
            }
            self.source_control.started.insert(root.clone());
            self.source_control.running.insert(workspace.clone());
            if periodic && let Some(next) = interval.and_then(|period| now.checked_add(period)) {
                self.source_control.deadlines.insert(root.clone(), next);
            }
            let (cancel, mut receiver) = watch::channel(false);
            self.source_control.cancels.insert(root.clone(), cancel);
            let network = self.config.network_timeout;
            self.source_control.active.spawn(async move {
                let path = root.clone();
                let result = tokio::spawn(async move {
                    vcs::automatic_refresh(&path, auto_pull, periodic, network, &mut receiver).await
                })
                .await
                .map_err(|error| AppError::new("git_worker", error))
                .and_then(|result| result);
                RefreshCompletion {
                    workspace,
                    root,
                    result,
                }
            });
        }
    }
    pub(super) fn finish_source_control_refresh(
        &mut self,
        done: std::result::Result<RefreshCompletion, tokio::task::JoinError>,
    ) {
        let Ok(done) = done else {
            return;
        };
        self.source_control.cancels.remove(&done.root);
        self.source_control.running.remove(&done.workspace);
        if self.held.get(&done.root) == Some(&Hold::SourceControl) {
            self.held.remove(&done.root);
        }
        match done.result {
            Ok(updated) => {
                self.project_search.invalidate();
                let threads: Vec<_> = self
                    .threads
                    .values()
                    .filter(|thread| thread.workspace_id == done.workspace)
                    .map(|thread| thread.id.clone())
                    .collect();
                for id in threads {
                    if let Some(thread) = self.threads.get(&id) {
                        let mut hint = self.thread_hint(thread);
                        hint.refresh_workspace = true;
                        let _ = self.changes.send(hint);
                    }
                    if updated
                        && !self.closing
                        && self.threads.get(&id).is_some_and(|thread| {
                            thread.root(&self.workspaces[&thread.workspace_id]) == done.root
                        })
                    {
                        let _ = self.refresh_prs(&id, true, PrLinkSource::BranchDiscovery);
                    }
                }
            }
            Err(error) if error.code != "cancelled" => eprintln!(
                "Automatic Git refresh failed for {}: {}",
                done.root.display(),
                error.message
            ),
            Err(_) => {}
        }
    }
    pub(super) async fn stop_source_control(&mut self) {
        for cancel in self.source_control.cancels.values() {
            let _ = cancel.send(true);
        }
        while let Some(done) = self.source_control.active.join_next().await {
            self.finish_source_control_refresh(done);
        }
    }
}
