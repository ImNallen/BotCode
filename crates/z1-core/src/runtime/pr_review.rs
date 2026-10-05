use super::*;
use crate::pr_review::{self as host, *};
use tokio::{sync::watch, task::JoinSet};

#[cfg(test)]
mod tests;

type ReadWaiter = (WorkspaceId, Reply<PrReviewDetail>);
pub(super) enum ReviewCompletion {
    Read(PullRequestKey, Box<Result<PrReviewDetail>>),
    Change(
        PrReviewChange,
        Result<PrChangeResult>,
        Reply<PrChangeResult>,
    ),
}
pub(super) struct ReviewWork {
    reads: BTreeMap<PullRequestKey, Vec<ReadWaiter>>,
    observed: BTreeMap<PullRequestKey, Vec<ReviewObservation>>,
    changing: HashSet<PullRequestKey>,
    cancel: watch::Sender<bool>,
    cleanup_failure: Option<AppError>,
    pub(super) active: JoinSet<ReviewCompletion>,
}
impl ReviewWork {
    pub(super) fn new() -> Self {
        Self {
            reads: BTreeMap::new(),
            observed: BTreeMap::new(),
            changing: HashSet::new(),
            cancel: watch::channel(false).0,
            cleanup_failure: None,
            active: JoinSet::new(),
        }
    }
}
impl Owner {
    fn review_member(&self, thread: &ThreadId, key: &PullRequestKey) -> Result<WorkspaceId> {
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
            self.store.start_pr_operation(&input)?;
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
        let program = self.config.gh_binary.clone();
        let timeout = self.config.network_timeout;
        let (lifetime, mut cancel) = watch::channel(false);
        self.review_work.active.spawn(async move {
            let result = host::change(&program, &input, timeout, &mut cancel).await;
            drop(lifetime);
            ReviewCompletion::Change(input, result, reply)
        });
    }
    pub(super) fn finish_review(
        &mut self,
        done: std::result::Result<ReviewCompletion, tokio::task::JoinError>,
    ) -> Result<()> {
        let worker_error = match &done {
            Ok(ReviewCompletion::Read(_, result)) => result.as_ref().as_ref().err(),
            Ok(ReviewCompletion::Change(_, result, _)) => result.as_ref().err(),
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
