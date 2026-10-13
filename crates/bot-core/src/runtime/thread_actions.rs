use super::*;

pub(super) struct DeleteCompletion {
    id: ThreadId,
    root: PathBuf,
    committed: bool,
    outcome: Result<DeletedWorktree>,
    reply: Reply<DeletedWorktree>,
}
struct SandboxRetirement {
    handle: Arc<SandboxHandle>,
    agent: Option<Codex>,
}

impl Owner {
    fn commit_thread_deletion(&mut self, id: &ThreadId) -> Result<()> {
        let thread = self
            .threads
            .get(id)
            .ok_or_else(|| AppError::new("missing_thread", "Conversation not found."))?
            .clone();
        self.store.delete_thread(&thread)?;
        self.forget_pr_threads(&HashSet::from([id.clone()]));
        self.callbacks.retain(|_, route| &route.thread != id);
        self.dirty.remove(id);
        self.threads.remove(id);
        let mut hint = self.thread_hint(&thread);
        hint.refresh_workspace = true;
        let _ = self.changes.send(hint);
        Ok(())
    }
    pub(super) fn finish_delete(&mut self, completion: DeleteCompletion) {
        let DeleteCompletion {
            id,
            root,
            committed,
            outcome,
            reply,
        } = completion;
        let result = outcome.and_then(|outcome| {
            if !committed {
                self.commit_thread_deletion(&id)?;
            }
            Ok(outcome)
        });
        self.held.remove(&root);
        self.deleting.remove(&id);
        if result.is_err() {
            self.terminals.unblock_thread(&id);
        }
        let _ = reply.send(result);
    }
    pub(super) fn begin_delete(
        &mut self,
        id: ThreadId,
        delete_worktree: bool,
        reply: Reply<DeletedWorktree>,
    ) {
        let plan = (|| {
            let Some(thread) = self.threads.get(&id) else {
                return Ok(None);
            };
            let workspace = self.workspace(&thread.workspace_id)?;
            let root = thread.root(workspace).to_path_buf();
            let another_active = self.threads.values().any(|other| {
                other.root(&self.workspaces[&other.workspace_id]) == root
                    && matches!(
                        other.session,
                        SessionState::Connecting
                            | SessionState::Running
                            | SessionState::Interrupting
                    )
            });
            let pending = self.providers.pending().any(|job| {
                self.threads
                    .get(job.thread())
                    .is_some_and(|other| other.root(&self.workspaces[&other.workspace_id]) == root)
            });
            let another_setup = self.threads.values().any(|other| {
                other.id != id
                    && other
                        .worktree_setup
                        .as_ref()
                        .is_some_and(|setup| setup.active() && Path::new(&setup.cwd) == root)
            });
            if !self.idle_except_setup(thread, &root) || another_setup || another_active || pending
            {
                return Err(AppError::new(
                    "busy",
                    "Stop running conversations and wait for checkout operations before deleting this thread.",
                ));
            }
            if let Some(setup) = &thread.worktree_setup {
                self.stop_setup(setup)?;
                if setup.active() {
                    let mut thread = thread.clone();
                    let setup = thread.worktree_setup.as_mut().unwrap();
                    setup.state = crate::project::SetupState::Interrupted {
                        reason: "Setup was canceled to delete the thread.".into(),
                    };
                    setup.completed_at_ms = Some(now_ms());
                    self.install(thread)?;
                }
            }
            let thread = self.thread(&id)?;
            let candidate = self.candidate(thread);
            let retention =
                if matches!(thread.checkout, Checkout::Worktree { .. }) && candidate.is_none() {
                    Some("Another thread owns this worktree.".to_owned())
                } else {
                    None
                };
            Ok(Some((
                thread.workspace_id.clone(),
                root,
                candidate,
                retention,
            )))
        })();
        let (workspace, root, candidate, retention) = match plan {
            Ok(Some(plan)) => plan,
            Ok(None) => {
                let _ = reply.send(Ok(DeletedWorktree::NotRequested));
                return;
            }
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        let sandbox = (self.owners(&root) == 1)
            .then(|| self.workdir(&self.threads[&id]).sandbox().cloned())
            .flatten()
            .map(|handle| SandboxRetirement {
                agent: self.providers.stop(&EnvKey::Sandbox(handle.id.clone())),
                handle,
            });
        let committed = delete_worktree && sandbox.is_none();
        if committed && let Err(error) = self.commit_thread_deletion(&id) {
            let _ = reply.send(Err(error));
            return;
        }
        self.invalidate_names(&root);
        self.cancel_name(&id);
        self.supersede_title(&id);
        self.held.insert(root.clone(), Hold::Delete);
        self.deleting.insert(id.clone());
        self.terminals.block_thread(&id);
        let policy = settings::storage_policy(&self.config.data_dir.join("settings.json"));
        let on_delete = policy.rules(&workspace).worktree_on_delete;
        let terminals = self.terminals.clone();
        let scope = CloseScope::Thread {
            workspace,
            thread: id.clone(),
        };
        let worktrees = self.config.data_dir.join("worktrees");
        let roots = self
            .workspaces
            .values()
            .map(|w| w.root.clone())
            .collect::<Vec<_>>();
        self.delete_jobs.spawn(async move {
            let retired = match sandbox {
                Some(SandboxRetirement { handle, agent }) => {
                    if let Some(agent) = agent {
                        let _ = agent.terminate().await;
                    }
                    let codex_home = handle.container.codex_home();
                    handle
                        .retire(Desired::Removed)
                        .await
                        .map(|()| {
                            if let Some(dir) = codex_home.parent() {
                                let _ = std::fs::remove_dir_all(dir);
                            }
                        })
                        .map_err(|error| {
                            AppError::new(
                                "sandbox_kept",
                                format!(
                                    "The sandbox was not deleted, because its work could not be synced to this Mac: {}",
                                    error.message
                                ),
                            )
                        })
                }
                None => Ok(()),
            };
            if let Err(error) = retired {
                return DeleteCompletion {
                    id,
                    root,
                    committed,
                    outcome: Err(error),
                    reply,
                };
            }
            let outcome = tokio::task::spawn_blocking(move || {
                terminals.close(&scope);
                if !delete_worktree && !on_delete {
                    return DeletedWorktree::NotRequested;
                }
                if let Some(reason) = retention {
                    return DeletedWorktree::Retained { reason };
                }
                let Some(candidate) = candidate else {
                    return DeletedWorktree::NotRequested;
                };
                if delete_worktree {
                    return match cleanup::remove_explicit(&candidate, &roots) {
                        Ok(()) => DeletedWorktree::Removed,
                        Err(reason) => DeletedWorktree::Retained { reason },
                    };
                }
                match (cleanup::Sweep {
                    worktrees: &worktrees,
                    roots: &roots,
                    policy,
                    now: now_ms(),
                })
                .remove_deleted(&candidate)
                {
                    Ok(()) => DeletedWorktree::Removed,
                    Err(reason) => DeletedWorktree::Retained { reason },
                }
            })
            .await
            .map_err(|e| AppError::new("delete_worker", e));
            DeleteCompletion {
                id,
                root,
                committed,
                outcome,
                reply,
            }
        });
    }
}
