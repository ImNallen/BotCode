use super::*;
use crate::PrStack;
pub(super) struct Completion {
    access: PrAccess,
    workspace: WorkspaceId,
    generation: u64,
    epoch: u64,
    key: PullRequestKey,
    pub(super) result: Result<Option<PrStack>>,
    reply: Reply<Option<PrStack>>,
}
impl Owner {
    pub(super) fn read_pr_stack(
        &mut self,
        access: PrAccess,
        key: PullRequestKey,
        reply: Reply<Option<PrStack>>,
    ) {
        let workspace = match self.review_member(&access, &key) {
            Ok(workspace) => workspace,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        if self.review_work.active.len() >= 4 || self.review_work.changing.contains(&key) {
            let _ = reply.send(Err(AppError::new(
                "pr_busy",
                "Pull request operations are busy. Try again shortly.",
            )));
            return;
        }
        let generation = self.review_generation(&access);
        let epoch = self.pr_read_epoch(&key);
        let program = self.config.gh_binary.clone();
        let timeout = self.config.network_timeout;
        let mut cancel = self.review_work.cancel.subscribe();
        self.review_work.active.spawn(async move {
            let result = crate::pr_stack::read(&program, &key, timeout, &mut cancel).await;
            pr_review::ReviewCompletion::Stack(Box::new(Completion {
                access,
                workspace,
                generation,
                epoch,
                key,
                result,
                reply,
            }))
        });
    }
    pub(super) fn finish_pr_stack(&mut self, done: Completion) -> Result<()> {
        let result = done.result.and_then(|stack| {
            if self.review_member(&done.access, &done.key)? != done.workspace
                || self.review_generation(&done.access) != done.generation
                || self.pr_read_epoch(&done.key) != done.epoch
            {
                return Err(AppError::new(
                    "pr_stack_stale",
                    "The pull request association changed. Refresh before continuing.",
                ));
            }
            self.save_pr_stack(&done.key, stack.as_ref())?;
            Ok(stack)
        });
        let _ = done.reply.send(result);
        Ok(())
    }
}

use crate::{PrStackChange, PrStackOperation, PrStackResult};
pub(super) struct ActionCompletion {
    operation: PrStackOperation,
    error: Option<AppError>,
    reply: Reply<PrStackOperation>,
}
impl Owner {
    pub(super) fn stack_pending_key(&self, key: &PullRequestKey) -> bool {
        self.review_work
            .stack_pending
            .values()
            .any(|op| op.affected_keys.contains(key))
    }
    pub(super) fn stack_operations(
        &self,
        access: &PrAccess,
        key: &PullRequestKey,
    ) -> Result<Vec<PrStackOperation>> {
        self.review_member(access, key)?;
        Ok(self
            .review_work
            .stack_pending
            .values()
            .filter(|op| op.affected_keys.contains(key))
            .cloned()
            .collect())
    }
    pub(super) fn persist_stack_progress(
        &mut self,
        access: &PrAccess,
        generation: u64,
        operation: &PrStackOperation,
    ) -> Result<()> {
        self.review_member(access, &operation.input.target.key)?;
        if self.review_generation(access) != generation {
            return Err(AppError::new(
                "pr_stack_stale",
                "The pull request association changed. Refresh before continuing.",
            ));
        }
        let previous = self
            .review_work
            .stack_pending
            .get(&operation.input.request_id)
            .ok_or_else(|| AppError::new("pr_receipt_missing", "The stack receipt is missing."))?;
        let new_keys: Vec<_> = operation
            .affected_keys
            .iter()
            .filter(|key| !previous.affected_keys.contains(key))
            .cloned()
            .collect();
        let mut paths = HashSet::new();
        for key in &new_keys {
            if self.review_work.changing.contains(key)
                || self.review_work.reads.contains_key(key)
                || self
                    .review_work
                    .pending
                    .values()
                    .any(|op| &op.input.target.key == key)
                || self.review_work.stack_pending.values().any(|op| {
                    op.input.request_id != operation.input.request_id
                        && op.affected_keys.contains(key)
                })
            {
                return Err(AppError::new(
                    "pr_busy",
                    "A pull request operation is already running. Wait for its result.",
                ));
            }
            paths.extend(
                self.pr_checkout_paths_except(
                    key,
                    self.review_work
                        .stack_holds
                        .get(&operation.input.request_id)
                        .map(Vec::as_slice)
                        .unwrap_or(&[]),
                )?,
            );
        }
        self.store.save_stack_operation(operation)?;
        for key in new_keys {
            self.review_work.changing.insert(key.clone());
            self.invalidate_pr_reads(&key);
        }
        for path in &paths {
            self.held.insert(path.clone(), Hold::PullRequest);
        }
        self.review_work
            .stack_holds
            .entry(operation.input.request_id.clone())
            .or_default()
            .extend(paths);
        self.review_work
            .stack_pending
            .insert(operation.input.request_id.clone(), operation.clone());
        Ok(())
    }
    pub(super) fn change_pr_stack(
        &mut self,
        access: PrAccess,
        input: PrStackChange,
        reply: Reply<PrStackOperation>,
    ) {
        let admission = (|| {
            self.review_member(&access, &input.target.key)?;
            input.validate()?;
            if let Some(saved) = self.store.stack_operation(&input.request_id)? {
                if saved.input != input {
                    return Err(AppError::new(
                        "pr_request_conflict",
                        "This request ID was used for a different stack command.",
                    ));
                }
                return Ok(Some(saved));
            }
            if self.review_work.active.len() >= 4
                || self.review_work.changing.contains(&input.target.key)
                || self.review_work.reads.contains_key(&input.target.key)
                || self.stack_pending_key(&input.target.key)
                || self
                    .review_work
                    .pending
                    .values()
                    .any(|op| op.input.target.key == input.target.key)
            {
                return Err(AppError::new(
                    "pr_busy",
                    "A pull request operation is already running. Wait for its result.",
                ));
            }
            Ok(None)
        })();
        match admission {
            Ok(Some(saved)) => {
                let _ = reply.send(Ok(saved));
                return;
            }
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
            Ok(None) => {}
        }
        let paths = match self.pr_checkout_paths(&input.target.key) {
            Ok(paths) => paths,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        let operation=PrStackOperation {affected_keys:vec![input.target.key.clone()],input,progress:vec![],dispatched_layer:None,merge_uuid:None,result:PrStackResult::Uncertain {message:"This operation started without a confirmed result. Check GitHub before submitting again.".into()}};
        if let Err(error) = self.store.save_stack_operation(&operation) {
            let _ = reply.send(Err(error));
            return;
        }
        for path in &paths {
            self.held.insert(path.clone(), Hold::PullRequest);
        }
        self.review_work
            .stack_holds
            .insert(operation.input.request_id.clone(), paths);
        self.review_work
            .changing
            .insert(operation.input.target.key.clone());
        self.review_work
            .stack_pending
            .insert(operation.input.request_id.clone(), operation.clone());
        self.spawn_stack_action(access, operation, false, reply);
    }
    pub(super) fn reconcile_pr_stack(
        &mut self,
        access: PrAccess,
        key: PullRequestKey,
        id: String,
        reply: Reply<PrStackOperation>,
    ) {
        let admission = (|| {
            self.review_member(&access, &key)?;
            let operation = self
                .review_work
                .stack_pending
                .get(&id)
                .cloned()
                .or(self.store.stack_operation(&id)?)
                .ok_or_else(|| {
                    AppError::new("pr_receipt_missing", "The stack receipt is missing.")
                })?;
            if !operation.affected_keys.contains(&key) && operation.input.target.key != key {
                return Err(AppError::new(
                    "pr_receipt_missing",
                    "The stack receipt does not belong to this pull request.",
                ));
            }
            if self.review_work.active.len() >= 4
                || operation
                    .affected_keys
                    .iter()
                    .any(|key| self.review_work.changing.contains(key))
            {
                return Err(AppError::new(
                    "pr_busy",
                    "A stack operation is already running.",
                ));
            }
            Ok(operation)
        })();
        match admission {
            Ok(op) => {
                if !op.result.unresolved() {
                    let _ = reply.send(Ok(op));
                    return;
                }
                for key in &op.affected_keys {
                    self.review_work.changing.insert(key.clone());
                }
                self.spawn_stack_action(access, op, true, reply);
            }
            Err(e) => {
                let _ = reply.send(Err(e));
            }
        }
    }
    fn spawn_stack_action(
        &mut self,
        access: PrAccess,
        mut operation: PrStackOperation,
        reconcile: bool,
        reply: Reply<PrStackOperation>,
    ) {
        let generation = self.review_generation(&access);
        let program = self.config.gh_binary.clone();
        let timeout = self.config.network_timeout;
        let done = self.done.clone();
        let mut cancel = self.review_work.cancel.subscribe();
        self.review_work.active.spawn(async move {
            let (sink, mut receiver) = mpsc::channel(1);
            let forward = tokio::spawn(async move {
                while let Some((operation, reply)) = receiver.recv().await {
                    let progress = super::Completion::StackProgress {
                        access: access.clone(), generation, operation, reply,
                    };
                    if done.send(progress).await.is_err() {
                        break;
                    }
                }
            });
            let result = if reconcile {
                crate::pr_stack::actions::reconcile(
                    &program, &mut operation, Instant::now() + timeout, &mut cancel,
                ).await
            } else {
                crate::pr_stack::actions::run(
                    &program, &mut operation, timeout, &mut cancel, &sink,
                ).await
            };
            let mut completion_error = None;
            if let Err(error) = result {
                if reconcile || matches!(operation.result,
                    PrStackResult::Accepted { .. } | PrStackResult::Completed { .. }
                ) {
                    completion_error = Some(error);
                } else {
                    if error.code == "pr_stack_rejected" {
                        operation.dispatched_layer = None;
                    }
                    let message = if operation.progress.is_empty() {
                        error.message
                    } else {
                        format!("Stack rebase stopped after {} layers. Earlier updates remain on GitHub. {}", operation.progress.len(), error.message)
                    };
                    operation.result = if operation.dispatched_layer.is_some() || operation.merge_uuid.is_some() {
                        PrStackResult::Uncertain { message }
                    } else {
                        PrStackResult::Refused { message }
                    };
                }
            }
            drop(sink);
            let _ = forward.await;
            pr_review::ReviewCompletion::StackAction(Box::new(ActionCompletion {
                operation, error: completion_error, reply,
            }))
        });
    }
    pub(super) fn finish_stack_action(&mut self, done: ActionCompletion) -> Result<()> {
        let mut operation = done.operation;
        let reserved = self
            .review_work
            .stack_pending
            .get(&operation.input.request_id)
            .map(|op| op.affected_keys.clone())
            .unwrap_or_default();
        operation.affected_keys = reserved.clone();
        let saved = self.store.save_stack_operation(&operation);
        if saved.is_err() && !matches!(operation.result, PrStackResult::Accepted { .. }) {
            operation.result = PrStackResult::Uncertain {
                message:
                    "The stack receipt could not be saved. Check GitHub before submitting again."
                        .into(),
            };
        }
        self.review_work
            .changing
            .remove(&operation.input.target.key);
        for key in &reserved {
            self.review_work.changing.remove(key);
            self.invalidate_pr_reads(key);
            let _ = self.mark_pr_stale(
                key,
                "A stack operation changed or may have changed this pull request.",
            );
        }
        if !operation.result.unresolved() && saved.is_ok() {
            self.review_work
                .stack_pending
                .remove(&operation.input.request_id);
            if let Some(paths) = self
                .review_work
                .stack_holds
                .remove(&operation.input.request_id)
            {
                for path in paths {
                    self.held.remove(&path);
                }
            }
        } else {
            self.review_work
                .stack_pending
                .insert(operation.input.request_id.clone(), operation.clone());
        }
        let _ = done.reply.send(saved.and_then(|_| match done.error {
            Some(error) => Err(error),
            None => Ok(operation),
        }));
        Ok(())
    }
}

impl Owner {
    pub(super) fn restore_stack_holds(&mut self) {
        let pending: Vec<_> = self.review_work.stack_pending.values().cloned().collect();
        for operation in pending {
            let mut paths = HashSet::new();
            for thread in self.threads.values().filter(|t| {
                self.pr_summary(&t.id)
                    .links
                    .iter()
                    .any(|link| operation.affected_keys.contains(&link.pr.key))
            }) {
                if let Some(workspace) = self.workspaces.get(&thread.workspace_id) {
                    paths.insert(thread.root(workspace).to_owned());
                }
            }
            for path in &paths {
                self.held.insert(path.clone(), Hold::PullRequest);
            }
            self.review_work
                .stack_holds
                .insert(operation.input.request_id, paths.into_iter().collect());
        }
    }
}
