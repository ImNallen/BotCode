use super::*;
use crate::pr_review::{self as host, *};
use tokio::{sync::watch, task::JoinSet};

#[cfg(test)]
mod tests;

type ReadWaiter = (WorkspaceId, Reply<PrReviewDetail>);
pub(super) enum ReviewCompletion {
    Checkout(Box<super::pr_checkout::Completion>),
    Lifecycle(
        PrReviewChange,
        Result<PrChangeResult>,
        Option<Result<crate::PrSnapshot>>,
        Reply<PrChangeResult>,
    ),
    Acknowledge {
        thread: ThreadId,
        generation: u64,
        epoch: u64,
        input: PrReviewChange,
        confirmation: Result<host::Confirmation>,
        reply: Reply<PrChangeResult>,
    },
    Read(PullRequestKey, Box<Result<PrReviewDetail>>),
    CommitFiles {
        thread: ThreadId,
        generation: u64,
        epoch: u64,
        input: PrCommitFilesRequest,
        result: Result<PrCommitFiles>,
        reply: Reply<PrCommitFiles>,
    },
    Change(
        PrReviewChange,
        Result<PrChangeResult>,
        Reply<PrChangeResult>,
    ),
}
pub(super) struct ReviewWork {
    pub(super) checkout_workspaces: HashMap<PathBuf, WorkspaceId>,
    pub(super) reads: BTreeMap<PullRequestKey, Vec<ReadWaiter>>,
    observed: BTreeMap<PullRequestKey, Vec<ReviewObservation>>,
    pub(super) changing: HashSet<PullRequestKey>,
    pub(super) pending: BTreeMap<String, PrOperation>,
    holds: BTreeMap<PullRequestKey, Vec<PathBuf>>,
    pub(super) cancel: watch::Sender<bool>,
    cleanup_failure: Option<AppError>,
    pub(super) active: JoinSet<ReviewCompletion>,
}
impl ReviewWork {
    pub(super) fn new() -> Self {
        Self {
            checkout_workspaces: HashMap::new(),
            reads: BTreeMap::new(),
            observed: BTreeMap::new(),
            changing: HashSet::new(),
            pending: BTreeMap::new(),
            holds: BTreeMap::new(),
            cancel: watch::channel(false).0,
            cleanup_failure: None,
            active: JoinSet::new(),
        }
    }
}
impl Owner {
    pub(super) fn review_member(
        &self,
        thread: &ThreadId,
        key: &PullRequestKey,
    ) -> Result<WorkspaceId> {
        let workspace = self.thread(thread)?.workspace_id.clone();
        if !self
            .pr_summary(thread)
            .links
            .iter()
            .any(|link| &link.pr.key == key)
        {
            return Err(AppError::new(
                "pr_not_linked",
                "Link this pull request to the conversation first.",
            ));
        }
        Ok(workspace)
    }
    pub(super) fn read_review(
        &mut self,
        thread: ThreadId,
        key: PullRequestKey,
        reply: Reply<PrReviewDetail>,
    ) {
        let workspace = match self.review_member(&thread, &key) {
            Ok(workspace) => workspace,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        if self.review_work.changing.contains(&key) {
            let _ = reply.send(Err(AppError::new(
                "pr_busy",
                "A pull request operation is already running. Wait for its result.",
            )));
            return;
        }
        if let Some(waiters) = self.review_work.reads.get_mut(&key) {
            if waiters.len() < 64 {
                waiters.push((workspace, reply));
            } else {
                let _ = reply.send(Err(AppError::new(
                    "pr_busy",
                    "Too many pending reads. Try again shortly.",
                )));
            }
            return;
        }
        if self.review_work.active.len() >= 4 {
            let _ = reply.send(Err(AppError::new(
                "pr_busy",
                "Pull request operations are busy. Try again shortly.",
            )));
            return;
        }
        self.review_work
            .reads
            .insert(key.clone(), vec![(workspace, reply)]);
        let program = self.config.gh_binary.clone();
        let timeout = self.config.network_timeout;
        let mut cancel = self.review_work.cancel.subscribe();
        self.review_work.active.spawn(async move {
            let result = host::read(&program, &key, timeout, &mut cancel).await;
            ReviewCompletion::Read(key, Box::new(result))
        });
    }
    pub(super) fn read_commit_files(
        &mut self,
        thread: ThreadId,
        input: PrCommitFilesRequest,
        reply: Reply<PrCommitFiles>,
    ) {
        let admission = (|| {
            self.review_member(&thread, &input.target.key)?;
            input.validate()?;
            if self.review_work.active.len() >= 4
                || self.review_work.changing.contains(&input.target.key)
            {
                return Err(AppError::new(
                    "pr_busy",
                    "Pull request operations are busy. Try again shortly.",
                ));
            }
            Ok(())
        })();
        if let Err(error) = admission {
            let _ = reply.send(Err(error));
            return;
        }
        let generation = self.pr_generation(&thread);
        let epoch = self.pr_read_epoch(&input.target.key);
        let program = self.config.gh_binary.clone();
        let timeout = self.config.network_timeout;
        let mut cancel = self.review_work.cancel.subscribe();
        self.review_work.active.spawn(async move {
            let result = host::read_commit_files(&program, &input, timeout, &mut cancel).await;
            ReviewCompletion::CommitFiles {
                thread,
                generation,
                epoch,
                input,
                result,
                reply,
            }
        });
    }
    pub(super) fn change_review(
        &mut self,
        thread: ThreadId,
        input: PrReviewChange,
        reply: Reply<PrChangeResult>,
    ) {
        let admission = (|| {
            self.review_member(&thread, &input.target.key)?;
            input.validate()?;
            if let Some(result) = self.store.pr_operation(&input)? {
                return Ok(Some(result));
            }
            if self.review_work.active.len() >= 4
                || self.review_work.changing.contains(&input.target.key)
                || self.review_work.reads.contains_key(&input.target.key)
            {
                return Err(AppError::new(
                    "pr_busy",
                    "A pull request operation is already running. Wait for its result.",
                ));
            }
            if input.action.is_lifecycle()
                && !matches!(input.action, PrReviewAction::DisableAutoMerge)
                && self
                    .review_work
                    .pending
                    .values()
                    .any(|operation| operation.input.target.key == input.target.key)
            {
                return Err(AppError::new(
                    "pr_pending",
                    "Reconcile the pending lifecycle operation before starting another.",
                ));
            }
            if input.action.is_lifecycle()
                && self
                    .review_work
                    .pending
                    .values()
                    .filter(|operation| operation.input.target.key == input.target.key)
                    .count()
                    >= 64
            {
                return Err(AppError::new(
                    "pr_pending",
                    "Reconcile the saved lifecycle operations before starting another.",
                ));
            }
            let paths = if input.action.holds_checkout() {
                self.pr_checkout_paths(&input.target.key)?
            } else {
                vec![]
            };
            self.store.start_pr_operation(&input)?;
            if input.action.is_lifecycle() {
                self.review_work.pending.insert(
                    input.request_id.clone(),
                    PrOperation {
                        input: input.clone(),
                        result: PrChangeResult::Uncertain {
                            message: "Operation is running. Reconcile after completion.".into(),
                        },
                    },
                );
                for path in &paths {
                    self.held.insert(path.clone(), Hold::PullRequest);
                }
                self.review_work
                    .holds
                    .insert(input.target.key.clone(), paths);
            }
            Ok(None)
        })();
        match admission {
            Ok(Some(result)) => {
                let _ = reply.send(Ok(result));
                return;
            }
            Err(error) => {
                let _ = reply.send(Ok(PrChangeResult::Refused {
                    message: error.message,
                }));
                return;
            }
            Ok(None) => {}
        }
        self.review_work.changing.insert(input.target.key.clone());
        self.invalidate_pr_reads(&input.target.key);
        if input.action.is_lifecycle() {
            let _ = self.mark_pr_stale(
                &input.target.key,
                "A lifecycle operation is awaiting host confirmation.",
            );
        }
        let program = self.config.gh_binary.clone();
        let timeout = self.config.network_timeout;
        let (lifetime, mut cancel) = watch::channel(false);
        self.review_work.active.spawn(async move {
            let result = host::change(&program, &input, timeout, &mut cancel).await;
            if input.action.is_lifecycle() {
                let mut result = result;
                let confirmation = if !matches!(result, Ok(PrChangeResult::Refused { .. }) | Err(_))
                {
                    let previous = match &result {
                        Ok(PrChangeResult::Applied { .. }) => PrChangeResult::Accepted {
                            progress: PrProgress::AwaitingConfirmation,
                        },
                        Ok(result) => result.clone(),
                        Err(_) => unreachable!(),
                    };
                    result = Ok(previous.clone());
                    Some(
                        match host::confirm(&program, &input, previous, timeout, &mut cancel).await
                        {
                            Ok(confirmed) => {
                                result = Ok(confirmed.result);
                                Ok(confirmed.snapshot)
                            }
                            Err(error) => {
                                if error.code == "process_cleanup" {
                                    result = Err(error.clone());
                                }
                                Err(error)
                            }
                        },
                    )
                } else {
                    None
                };
                drop(lifetime);
                ReviewCompletion::Lifecycle(input, result, confirmation, reply)
            } else {
                drop(lifetime);
                ReviewCompletion::Change(input, result, reply)
            }
        });
    }
    pub(super) fn finish_review(
        &mut self,
        done: std::result::Result<ReviewCompletion, tokio::task::JoinError>,
    ) -> Result<()> {
        let worker_error = match &done {
            Ok(ReviewCompletion::Checkout(done)) => done.result.as_ref().err(),
            Ok(ReviewCompletion::Read(_, result)) => result.as_ref().as_ref().err(),
            Ok(ReviewCompletion::CommitFiles { result, .. }) => result.as_ref().err(),
            Ok(ReviewCompletion::Acknowledge { confirmation, .. }) => confirmation.as_ref().err(),
            Ok(ReviewCompletion::Change(_, result, _))
            | Ok(ReviewCompletion::Lifecycle(_, result, _, _)) => result.as_ref().err(),
            Err(_) => None,
        };
        if let Some(error) = worker_error.filter(|error| error.code == "process_cleanup") {
            self.review_work
                .cleanup_failure
                .get_or_insert_with(|| error.clone());
        }
        self.accept_review_completion(done)
    }
    fn accept_review_completion(
        &mut self,
        done: std::result::Result<ReviewCompletion, tokio::task::JoinError>,
    ) -> Result<()> {
        match done.map_err(|_| {
            AppError::new(
                "pr_worker",
                "Pull request worker stopped. Pending operations require reconciliation.",
            )
        })? {
            ReviewCompletion::Checkout(done) => self.finish_pr_checkout(*done),
            ReviewCompletion::CommitFiles {
                thread,
                generation,
                epoch,
                input,
                result,
                reply,
            } => {
                let result = result.and_then(|files| {
                    self.review_member(&thread, &input.target.key)?;
                    if self.pr_generation(&thread) != generation
                        || self.pr_read_epoch(&input.target.key) != epoch
                    {
                        return Err(AppError::new(
                            "pr_review_stale",
                            "The pull request association changed. Refresh before continuing.",
                        ));
                    }
                    Ok(files)
                });
                let _ = reply.send(result);
            }
            ReviewCompletion::Lifecycle(input, mut result, confirmation, reply) => {
                let confirmation = confirmation.map(|observation| {
                    observation.and_then(|snapshot| {
                        self.validate_pr_snapshot(&input.target.key, &snapshot)?;
                        Ok(snapshot)
                    })
                });
                if matches!(&confirmation, Some(Err(_)))
                    && matches!(
                        &result,
                        Ok(PrChangeResult::Confirmed { .. } | PrChangeResult::Superseded { .. })
                    )
                {
                    result = if matches!(&result, Ok(PrChangeResult::Superseded { .. })) {
                        self.store.pr_operation(&input).and_then(|saved| {
                            saved.ok_or_else(|| {
                                AppError::new("pr_receipt_missing", "The saved receipt is missing.")
                            })
                        })
                    } else {
                        Ok(PrChangeResult::Accepted {
                            progress: PrProgress::AwaitingConfirmation,
                        })
                    };
                }
                self.review_work.changing.remove(&input.target.key);
                for path in self
                    .review_work
                    .holds
                    .remove(&input.target.key)
                    .unwrap_or_default()
                {
                    self.held.remove(&path);
                }
                let receipt = result
                    .clone()
                    .unwrap_or_else(|error| PrChangeResult::Uncertain {
                        message: error.message,
                    });
                let cancelled: Vec<_> = self
                    .review_work
                    .pending
                    .values()
                    .filter(|operation| {
                        matches!(
                            receipt,
                            PrChangeResult::Confirmed {
                                state: PrConfirmedState::AutoMergeDisabled
                            }
                        ) && operation.input.target.key == input.target.key
                            && matches!(
                                operation.input.action,
                                PrReviewAction::EnableAutoMerge { .. }
                            )
                    })
                    .cloned()
                    .collect();
                let mut completions = vec![(&input, &receipt)];
                completions.extend(
                    cancelled
                        .iter()
                        .map(|operation| (&operation.input, &receipt)),
                );
                let saved = self.store.finish_pr_operations(&completions);
                let receipt = if saved.is_ok() {
                    self.store.pr_operation(&input)?.unwrap_or(receipt)
                } else {
                    receipt
                };
                if result.is_ok() {
                    result = Ok(receipt.clone());
                }
                if saved.is_ok() {
                    for operation in cancelled {
                        self.review_work.pending.remove(&operation.input.request_id);
                    }
                }
                if saved.is_ok() {
                    if receipt.pending() {
                        self.review_work.pending.insert(
                            input.request_id.clone(),
                            PrOperation {
                                input: input.clone(),
                                result: receipt,
                            },
                        );
                    } else {
                        self.review_work.pending.remove(&input.request_id);
                    }
                }
                let observed = match confirmation {
                    Some(Ok(snapshot)) if saved.is_ok() => {
                        self.accept_review_snapshot(&input.target.key, &snapshot)
                    }
                    Some(Err(error)) => self.mark_pr_stale(&input.target.key, &error.message),
                    _ => self.mark_pr_stale(
                        &input.target.key,
                        "Refresh to confirm the pull request state.",
                    ),
                };
                if saved.is_ok() && observed.is_ok() && result.is_ok() {
                    result = self.store.pr_operation(&input).and_then(|saved| {
                        saved.ok_or_else(|| {
                            AppError::new("pr_receipt_missing", "The saved receipt is missing.")
                        })
                    });
                }
                let response = match (result, saved.and(observed)) {
                    (Err(mut error), Err(storage)) if error.code == "process_cleanup" => {
                        error.message.push_str(&format!(
                            " Receipt completion could not be saved ({}): {}",
                            storage.code, storage.message
                        ));
                        Err(error)
                    }
                    (result, saved) => saved.and(result),
                };
                let failure = response.as_ref().err().cloned();
                let _ = reply.send(response);
                if let Some(error) = failure {
                    return Err(error);
                }
            }
            ReviewCompletion::Acknowledge {
                thread,
                generation,
                epoch,
                input,
                confirmation,
                reply,
            } => {
                self.review_work.changing.remove(&input.target.key);
                let response = confirmation.and_then(|confirmed| {
                    self.review_member(&thread, &input.target.key)?;
                    if self.pr_generation(&thread) != generation
                        || self.pr_read_epoch(&input.target.key) != epoch
                    {
                        return Err(AppError::new(
                            "pr_review_stale",
                            "The pull request association changed. Refresh before continuing.",
                        ));
                    }
                    self.validate_pr_snapshot(&input.target.key, &confirmed.snapshot)?;
                    self.store.finish_pr_operation(&input, &confirmed.result)?;
                    let result = self.store.pr_operation(&input)?.ok_or_else(|| {
                        AppError::new("pr_receipt_missing", "The saved receipt is missing.")
                    })?;
                    if !result.pending() {
                        self.review_work.pending.remove(&input.request_id);
                    }
                    self.accept_review_snapshot(&input.target.key, &confirmed.snapshot)?;
                    Ok(result)
                });
                if let Err(error) = &response {
                    let _ = self.mark_pr_stale(&input.target.key, &error.message);
                }
                let cleanup = response
                    .as_ref()
                    .err()
                    .filter(|e| e.code == "process_cleanup")
                    .cloned();
                let _ = reply.send(response);
                if let Some(error) = cleanup {
                    return Err(error);
                }
            }
            ReviewCompletion::Read(key, result) => {
                let stale_result = match result.as_ref() {
                    Err(error) => self.mark_pr_stale(&key, &error.message),
                    Ok(_) => Ok(()),
                };
                let result = Box::new(result.and_then(|detail| {
                    self.accept_review_snapshot(&key, &detail.snapshot)?;
                    Ok(detail)
                }));
                let cleanup = result
                    .as_ref()
                    .as_ref()
                    .err()
                    .filter(|error| error.code == "process_cleanup")
                    .cloned();
                if let Ok(detail) = result.as_ref() {
                    self.review_work.observed.insert(
                        key.clone(),
                        detail
                            .findings
                            .iter()
                            .map(|entry| entry.finding.observation.clone())
                            .collect(),
                    );
                }
                for (workspace, reply) in self.review_work.reads.remove(&key).unwrap_or_default() {
                    let hydrated = result.as_ref().clone().and_then(|mut detail| {
                        detail.operations = self
                            .review_work
                            .pending
                            .values()
                            .filter(|operation| operation.input.target.key == key)
                            .cloned()
                            .collect();
                        for entry in &mut detail.findings {
                            entry.finding.saved = self
                                .store
                                .review_disposition(&workspace, &entry.finding.observation)?;
                        }
                        Ok(detail)
                    });
                    let _ = reply.send(hydrated);
                }
                if let Some(error) = cleanup {
                    return Err(error);
                }
                stale_result?;
            }
            ReviewCompletion::Change(input, result, reply) => {
                self.review_work.changing.remove(&input.target.key);
                let receipt = result
                    .clone()
                    .unwrap_or_else(|_| PrChangeResult::Uncertain {
                        message:
                            "Native process cleanup failed. Check GitHub before submitting again."
                                .into(),
                    });
                let saved = self.store.finish_pr_operation(&input, &receipt);
                let response = match (result, saved) {
                    (Err(mut error), Err(storage)) if error.code == "process_cleanup" => {
                        error.message.push_str(&format!(
                            " Receipt completion could not be saved ({}): {}",
                            storage.code, storage.message
                        ));
                        Err(error)
                    }
                    (result, saved) => saved.and(result),
                };
                let failure = response.as_ref().err().cloned();
                let _ = reply.send(response);
                if let Some(error) = failure {
                    return Err(error);
                }
            }
        }
        Ok(())
    }
    pub(super) fn pending_pr_operations(
        &self,
        thread: &ThreadId,
        key: &PullRequestKey,
    ) -> Result<Vec<PrOperation>> {
        self.review_member(thread, key)?;
        Ok(self
            .review_work
            .pending
            .values()
            .filter(|operation| &operation.input.target.key == key)
            .cloned()
            .collect())
    }
    fn pr_checkout_paths(&self, key: &PullRequestKey) -> Result<Vec<PathBuf>> {
        let mut paths = HashSet::new();
        for thread in self.threads.values().filter(|thread| {
            self.pr_summary(&thread.id)
                .links
                .iter()
                .any(|link| &link.pr.key == key)
        }) {
            let workspace = self.workspaces.get(&thread.workspace_id).ok_or_else(|| {
                AppError::new("workspace_missing", "The linked project is unavailable.")
            })?;
            if workspace.kind != WorkspaceKind::Repository {
                continue;
            }
            let path = thread.root(workspace);
            if !path.exists() {
                continue;
            }
            let queued = self.pending.iter().any(|job| {
                self.threads.get(job.thread()).is_some_and(|t| {
                    self.workspaces
                        .get(&t.workspace_id)
                        .is_some_and(|w| t.root(w) == path)
                })
            });
            if self.leases.contains_key(path) || self.held.contains_key(path) || queued {
                return Err(AppError::new(
                    "checkout_busy",
                    "A linked conversation is using this checkout. Wait for it to finish.",
                ));
            }
            paths.insert(path.to_owned());
        }
        Ok(paths.into_iter().collect())
    }
    pub(super) fn reconcile_pr(
        &mut self,
        thread: ThreadId,
        key: PullRequestKey,
        request_id: String,
        reply: Reply<PrChangeResult>,
    ) {
        let admission = (|| {
            self.review_member(&thread, &key)?;
            let operation = self.store.saved_pr_operation(&key, &request_id)?;
            if !operation.input.action.is_lifecycle() {
                return Err(AppError::new(
                    "pr_recovery_unavailable",
                    "Only lifecycle operations can be reconciled here.",
                ));
            }
            if !operation.result.pending() {
                return Ok(operation);
            }
            if self.review_work.changing.contains(&key)
                || self.review_work.reads.contains_key(&key)
                || self.review_work.active.len() >= 4
            {
                return Err(AppError::new(
                    "pr_busy",
                    "Wait for the current pull request operation to finish.",
                ));
            }
            Ok(operation)
        })();
        let operation = match admission {
            Ok(operation) => operation,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        if !operation.result.pending() {
            let _ = reply.send(Ok(operation.result));
            return;
        }
        self.review_work.changing.insert(key.clone());
        self.invalidate_pr_reads(&key);
        let program = self.config.gh_binary.clone();
        let timeout = self.config.network_timeout;
        let (lifetime, mut cancel) = watch::channel(false);
        self.review_work.active.spawn(async move {
            let (result, confirmation) = match host::confirm(
                &program,
                &operation.input,
                operation.result.clone(),
                timeout,
                &mut cancel,
            )
            .await
            {
                Ok(confirmed) => (Ok(confirmed.result), Some(Ok(confirmed.snapshot))),
                Err(error) if error.code == "process_cleanup" => {
                    (Err(error.clone()), Some(Err(error)))
                }
                Err(error) => (Ok(operation.result), Some(Err(error))),
            };
            drop(lifetime);
            ReviewCompletion::Lifecycle(operation.input, result, confirmation, reply)
        });
    }
    pub(super) fn acknowledge_update(
        &mut self,
        thread: ThreadId,
        acknowledgment: AcknowledgeUncertainUpdate,
        reply: Reply<PrChangeResult>,
    ) {
        let key = acknowledgment.key;
        let admission = (|| {
            self.review_member(&thread, &key)?;
            let operation = self
                .store
                .saved_pr_operation(&key, &acknowledgment.request_id)?;
            if !matches!(operation.input.action, PrReviewAction::UpdateBranch { .. }) {
                return Err(AppError::new(
                    "pr_recovery_unavailable",
                    "Only a branch update can be acknowledged here.",
                ));
            }
            if !operation.result.pending() {
                return Ok(operation);
            }
            if !operation.can_continue_update(&acknowledgment.inspected) {
                return Err(AppError::new(
                    "pr_recovery_unavailable",
                    "Only an uncertain branch update with a changed inspected head can continue.",
                ));
            }
            if self.review_work.changing.contains(&key)
                || self.review_work.reads.contains_key(&key)
                || self.review_work.active.len() >= 4
            {
                return Err(AppError::new(
                    "pr_busy",
                    "Wait for the current pull request operation to finish.",
                ));
            }
            Ok(operation)
        })();
        let operation = match admission {
            Ok(operation) => operation,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        if !operation.result.pending() {
            let _ = reply.send(Ok(operation.result));
            return;
        }
        self.review_work.changing.insert(key.clone());
        self.invalidate_pr_reads(&key);
        let epoch = self.pr_read_epoch(&key);
        let generation = self.pr_generation(&thread);
        let program = self.config.gh_binary.clone();
        let timeout = self.config.network_timeout;
        let mut cancel = self.review_work.cancel.subscribe();
        self.review_work.active.spawn(async move {
            let confirmation = host::acknowledge_update(
                &program,
                &operation,
                &acknowledgment.inspected,
                timeout,
                &mut cancel,
            )
            .await;
            ReviewCompletion::Acknowledge {
                thread,
                generation,
                epoch,
                input: operation.input,
                confirmation,
                reply,
            }
        });
    }
    pub(super) fn review_disposition(
        &mut self,
        thread: &ThreadId,
        key: &PullRequestKey,
        input: &SetReviewDisposition,
    ) -> Result<Option<SavedDisposition>> {
        let workspace = self.review_member(thread, key)?;
        input.validate()?;
        let found = self
            .review_work
            .observed
            .get(key)
            .is_some_and(|observations| observations.contains(&input.observation));
        if !found {
            return Err(AppError::new(
                "review_changed",
                "Refresh the finding before saving its local decision.",
            ));
        }
        self.store.set_review_disposition(&workspace, input)
    }
    pub(super) async fn stop_reviews(&mut self) -> Result<()> {
        self.review_work.cancel.send_replace(true);
        let mut result = Ok(());
        while let Some(done) = self.review_work.active.join_next().await {
            if let Err(error) = self.finish_review(done) {
                result = Err(error);
            }
        }
        self.review_work.cleanup_failure.clone().map_or(result, Err)
    }
}
