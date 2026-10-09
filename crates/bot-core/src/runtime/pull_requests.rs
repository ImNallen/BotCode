use super::*;
use crate::pull_requests::{self as host, *};
use std::{cell::Cell, collections::VecDeque};
use tokio::{sync::watch, task::JoinSet};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum JobKey {
    Read(PullRequestKey),
    Discover(PathBuf),
}
struct DiscoveryMember {
    thread: ThreadId,
    generation: u64,
}
enum Job {
    Read(PullRequestKey),
    Discover {
        root: PathBuf,
        generation: u64,
        members: Vec<DiscoveryMember>,
        source: PrLinkSource,
    },
}
impl Job {
    fn key(&self) -> JobKey {
        match self {
            Self::Read(key) => JobKey::Read(key.clone()),
            Self::Discover { root, .. } => JobKey::Discover(root.clone()),
        }
    }
}
pub(super) struct PrCompletion {
    epoch: u64,
    job: Job,
    result: Result<Option<(PullRequestKey, PrSnapshot)>>,
}
pub(super) struct PrWork {
    sequence: Cell<u64>,
    epoch: u64,
    read_epochs: BTreeMap<PullRequestKey, u64>,
    records: BTreeMap<PullRequestKey, CachedPr>,
    memberships: HashMap<ThreadId, BTreeMap<PullRequestKey, Membership>>,
    threads_by_pr: BTreeMap<PullRequestKey, HashSet<ThreadId>>,
    generations: HashMap<ThreadId, u64>,
    checkout_generations: HashMap<PathBuf, u64>,
    errors: HashMap<ThreadId, String>,
    ready: VecDeque<Job>,
    running: HashSet<JobKey>,
    rerun: HashMap<JobKey, Job>,
    due: BTreeMap<PullRequestKey, u64>,
    failures: BTreeMap<PullRequestKey, u32>,
    cancel: watch::Sender<bool>,
    pub(super) active: JoinSet<PrCompletion>,
}
impl PrWork {
    pub(super) fn load(store: &mut Store) -> Result<Self> {
        let mut records = BTreeMap::new();
        for mut record in store.pull_requests()? {
            if let PrFreshness::Current { fetched_at } = record.freshness {
                record.freshness = PrFreshness::Stale {
                    last_success: Some(fetched_at),
                    message: "Waiting for GitHub confirmation after restart.".into(),
                };
                store.save_pull_request(&record, None)?;
            }
            records.insert(record.key.clone(), record);
        }
        let mut work = Self {
            sequence: Cell::new(0),
            epoch: 0,
            read_epochs: BTreeMap::new(),
            records,
            memberships: HashMap::new(),
            threads_by_pr: BTreeMap::new(),
            generations: store.pr_generations()?.into_iter().collect(),
            checkout_generations: HashMap::new(),
            errors: HashMap::new(),
            ready: VecDeque::new(),
            running: HashSet::new(),
            rerun: HashMap::new(),
            due: BTreeMap::new(),
            failures: BTreeMap::new(),
            cancel: watch::channel(false).0,
            active: JoinSet::new(),
        };
        for membership in store.pr_memberships()? {
            work.index(membership);
        }
        Ok(work)
    }
    fn index(&mut self, member: Membership) {
        let threads = self.threads_by_pr.entry(member.key.clone()).or_default();
        if member.source.is_some() {
            threads.insert(member.thread.clone());
        } else {
            threads.remove(&member.thread);
        }
        self.generations
            .entry(member.thread.clone())
            .and_modify(|generation| *generation = (*generation).max(member.generation))
            .or_insert(member.generation);
        self.memberships
            .entry(member.thread.clone())
            .or_default()
            .insert(member.key.clone(), member);
    }
    fn enqueue(&mut self, job: Job) -> Result<()> {
        let key = job.key();
        if self.running.contains(&key) {
            self.rerun.insert(key, job);
            return Ok(());
        }
        if let Some(queued) = self.ready.iter_mut().find(|j| j.key() == key) {
            *queued = job;
            return Ok(());
        }
        if self.ready.len() >= 128 {
            return Err(AppError::new(
                "pr_busy",
                "Pull request refresh queue is full. Try again shortly.",
            ));
        }
        self.ready.push_back(job);
        Ok(())
    }
}
impl Owner {
    pub(super) fn pr_read_epoch(&self, key: &PullRequestKey) -> u64 {
        self.prs.read_epochs.get(key).copied().unwrap_or(0)
    }
    pub(super) fn invalidate_pr_reads(&mut self, key: &PullRequestKey) {
        self.prs.epoch += 1;
        self.prs.read_epochs.insert(key.clone(), self.prs.epoch);
    }

    pub(super) fn forget_pr_threads(&mut self, removed: &HashSet<ThreadId>) {
        self.prs.memberships.retain(|id, _| !removed.contains(id));
        self.prs.generations.retain(|id, _| !removed.contains(id));
        self.prs.errors.retain(|id, _| !removed.contains(id));
        self.prs.threads_by_pr.retain(|_, ids| {
            ids.retain(|id| !removed.contains(id));
            !ids.is_empty()
        });
        let linked = &self.prs.threads_by_pr;
        let retain_job = |job: &mut Job| match job {
            Job::Read(key) => linked.contains_key(key),
            Job::Discover { members, .. } => {
                members.retain(|m| !removed.contains(&m.thread));
                !members.is_empty()
            }
        };
        self.prs.ready.retain_mut(retain_job);
        self.prs.rerun.retain(|_, job| retain_job(job));
        self.prs.due.retain(|key, _| linked.contains_key(key));
        self.prs.failures.retain(|key, _| linked.contains_key(key));
    }
    pub(super) fn pr_summary(&self, id: &ThreadId) -> ThreadPrSummary {
        let links = self
            .prs
            .memberships
            .get(id)
            .into_iter()
            .flat_map(|rows| rows.values())
            .filter_map(|row| {
                Some(LinkedPrSummary {
                    pr: self.prs.records.get(&row.key)?.clone(),
                    source: row.source?,
                    linked_at: row.at,
                })
            })
            .collect();
        let root = self.threads.get(id).and_then(|t| {
            self.workspaces
                .get(&t.workspace_id)
                .map(|w| t.root(w).to_owned())
        });
        let discovering = root.is_some_and(|root| {
            self.prs.running.contains(&JobKey::Discover(root.clone()))
                || self
                    .prs
                    .ready
                    .iter()
                    .any(|j| j.key() == JobKey::Discover(root.clone()))
        });
        let sequence = self.prs.sequence.get() + 1;
        self.prs.sequence.set(sequence);
        ThreadPrSummary {
            sequence,
            links,
            discovering,
            discovery_error: self.prs.errors.get(id).cloned(),
        }
    }
    pub(super) fn settlement(
        &self,
        thread: &ThreadSnapshot,
        rules: crate::SettlementRules,
        now: u64,
    ) -> Option<u64> {
        let root = self
            .workspaces
            .get(&thread.workspace_id)
            .map(|w| thread.root(w));
        let links = self.pr_summary(&thread.id).links;
        let blocked = root
            .is_some_and(|root| self.leases.contains_key(root) || self.held.contains_key(root))
            || self.pending.iter().any(|job| {
                job.thread() == &thread.id
                    || root.is_some_and(|root| {
                        self.threads.get(job.thread()).is_some_and(|pending| {
                            self.workspaces
                                .get(&pending.workspace_id)
                                .is_some_and(|workspace| pending.root(workspace) == root)
                        })
                    })
            })
            || links.iter().any(|link| {
                self.review_work
                    .pending
                    .values()
                    .any(|operation| operation.input.target.key == link.pr.key)
            });
        crate::settlement_at(crate::SettlementInput {
            thread,
            links: &links,
            rules,
            blocked,
            now,
        })
    }
    pub(super) fn thread_summary(&self, thread: &ThreadSnapshot) -> ThreadSummary {
        let settled = self.settlement(
            thread,
            self.auto_settle.rules(&thread.workspace_id),
            now_ms(),
        );
        let mut summary = thread.summary(settled);
        summary.pull_requests = self.pr_summary(&thread.id);
        summary
    }
    pub(super) fn thread_hint(&self, thread: &ThreadSnapshot) -> ChangeHint {
        ChangeHint::new(thread, self.thread_summary(thread))
    }
    fn pr_hint(&self, id: &ThreadId) {
        if let Some(thread) = self.threads.get(id) {
            let _ = self.changes.send(self.thread_hint(thread));
        }
    }
    pub(super) fn pr_generation(&self, id: &ThreadId) -> u64 {
        self.prs.generations.get(id).copied().unwrap_or(0)
    }
    pub(super) fn pr_membership(
        &mut self,
        id: &ThreadId,
        key: PullRequestKey,
        source: Option<PrLinkSource>,
    ) -> Result<ThreadPrSummary> {
        self.thread(id)?;
        if let Some(member) = self.prs.memberships.get(id).and_then(|rows| rows.get(&key))
            && member.source.is_some()
            && (source == member.source || source == Some(PrLinkSource::Manual))
        {
            self.prs.due.insert(key, 0);
            return Ok(self.pr_summary(id));
        }
        let record = self
            .prs
            .records
            .get(&key)
            .cloned()
            .unwrap_or_else(|| CachedPr::unknown(key.clone()));
        let member = Membership {
            thread: id.clone(),
            key: key.clone(),
            generation: self.pr_generation(id) + 1,
            source,
            at: now_ms(),
        };
        self.store.save_pull_request(&record, Some(&member))?;
        self.prs.records.insert(key.clone(), record);
        self.prs.index(member);
        if source.is_some() {
            self.prs.due.insert(key, 0);
        }
        self.pr_hint(id);
        Ok(self.pr_summary(id))
    }
    pub(super) fn refresh_prs(
        &mut self,
        id: &ThreadId,
        discover: bool,
        source: PrLinkSource,
    ) -> Result<ThreadPrSummary> {
        self.thread(id)?;
        for link in self.pr_summary(id).links {
            self.prs.enqueue(Job::Read(link.pr.key))?;
        }
        if discover {
            self.schedule_discovery(id, source);
        }
        self.start_pr_jobs();
        Ok(self.pr_summary(id))
    }
    pub(super) fn mark_pr_stale(&mut self, key: &PullRequestKey, message: &str) -> Result<()> {
        let Some(mut record) = self.prs.records.get(key).cloned() else {
            return Ok(());
        };
        let last_success = match record.freshness {
            PrFreshness::Current { fetched_at } => Some(fetched_at),
            PrFreshness::Stale { last_success, .. } => last_success,
            PrFreshness::NeverLoaded => None,
        };
        record.freshness = PrFreshness::Stale {
            last_success,
            message: message.into(),
        };
        self.store.save_pull_request(&record, None)?;
        self.prs.records.insert(key.clone(), record);
        let failures = self.prs.failures.entry(key.clone()).or_default();
        *failures = (*failures + 1).min(5);
        self.prs.due.insert(
            key.clone(),
            now_ms().saturating_add((60_000_u64 << (*failures - 1)).min(900_000)),
        );
        if let Some(threads) = self.prs.threads_by_pr.get(key) {
            for id in threads {
                self.pr_hint(id);
            }
        }
        Ok(())
    }
    pub(super) fn validate_pr_snapshot(
        &self,
        key: &PullRequestKey,
        snapshot: &PrSnapshot,
    ) -> Result<()> {
        if self
            .prs
            .records
            .get(key)
            .and_then(|record| record.snapshot.as_ref())
            .is_some_and(|old| snapshot_is_older(snapshot, old))
        {
            return Err(AppError::new(
                "pr_review_stale",
                "A newer PR observation arrived. Refresh detail.",
            ));
        }
        Ok(())
    }
    fn confirm_terminal_operations(
        &mut self,
        key: &PullRequestKey,
        snapshot: &PrSnapshot,
    ) -> Result<()> {
        if !matches!(snapshot.lifecycle, PrLifecycle::Merged { .. }) {
            return Ok(());
        }
        let confirmed: Vec<_> = self
            .review_work
            .pending
            .values()
            .filter_map(|operation| {
                operation
                    .merged_result(key, snapshot)
                    .map(|result| (operation.input.clone(), result))
            })
            .collect();
        if confirmed.is_empty() {
            return Ok(());
        }
        let completions: Vec<_> = confirmed
            .iter()
            .map(|(input, result)| (input, result))
            .collect();
        self.store.finish_pr_operations(&completions)?;
        for (input, _) in confirmed {
            self.review_work.pending.remove(&input.request_id);
        }
        Ok(())
    }
    pub(super) fn accept_review_snapshot(
        &mut self,
        key: &PullRequestKey,
        snapshot: &PrSnapshot,
    ) -> Result<()> {
        {
            let mut record = self
                .prs
                .records
                .get(key)
                .cloned()
                .unwrap_or_else(|| CachedPr::unknown(key.clone()));
            self.validate_pr_snapshot(key, snapshot)?;
            self.confirm_terminal_operations(key, snapshot)?;
            if record.snapshot.as_ref() != Some(snapshot) {
                record.revision += 1;
            }
            record.snapshot = Some(snapshot.clone());
            record.freshness = PrFreshness::Current {
                fetched_at: now_ms(),
            };
            self.store.save_pull_request(&record, None)?;
            self.prs.records.insert(key.clone(), record);
            if let Some(threads) = self.prs.threads_by_pr.get(key) {
                for id in threads {
                    self.pr_hint(id);
                }
            }
        }
        Ok(())
    }
    pub(super) fn checkout_generation(&self, root: &Path) -> u64 {
        self.prs
            .checkout_generations
            .get(root)
            .copied()
            .unwrap_or(0)
    }
    pub(super) fn checkout_changed(&mut self, root: &Path) {
        self.project_search.invalidate();
        self.invalidate_names(root);
        *self
            .prs
            .checkout_generations
            .entry(root.to_owned())
            .or_default() += 1;
        let ids: Vec<_> = self
            .threads
            .values()
            .filter(|t| {
                self.workspaces
                    .get(&t.workspace_id)
                    .is_some_and(|w| t.root(w) == root)
            })
            .map(|t| t.id.clone())
            .collect();
        for id in ids {
            self.schedule_discovery(&id, PrLinkSource::BranchDiscovery);
        }
    }
    pub(super) fn schedule_discovery(&mut self, id: &ThreadId, source: PrLinkSource) {
        let Some(thread) = self.threads.get(id) else {
            return;
        };
        let Some(workspace) = self.workspaces.get(&thread.workspace_id) else {
            return;
        };
        if workspace.kind != WorkspaceKind::Repository {
            return;
        }
        let root = thread.root(workspace).to_owned();
        if !root.exists() || self.held.contains_key(&root) || self.leases.contains_key(&root) {
            return;
        }
        let members = self
            .threads
            .values()
            .filter(|t| {
                self.workspaces
                    .get(&t.workspace_id)
                    .is_some_and(|w| t.root(w) == root)
            })
            .map(|t| DiscoveryMember {
                thread: t.id.clone(),
                generation: self.pr_generation(&t.id),
            })
            .collect();
        let generation = self
            .prs
            .checkout_generations
            .get(&root)
            .copied()
            .unwrap_or(0);
        if let Err(error) = self.prs.enqueue(Job::Discover {
            root,
            generation,
            members,
            source,
        }) {
            self.prs.errors.insert(id.clone(), error.message);
        }
        self.pr_hint(id);
    }
    pub(super) fn poll_prs(&mut self) {
        let now = now_ms();
        let due: Vec<_> = self
            .prs
            .threads_by_pr
            .iter()
            .filter(|(key, threads)| {
                !threads.is_empty() && self.prs.due.get(*key).copied().unwrap_or(0) <= now
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in due {
            if self.prs.running.contains(&JobKey::Read(key.clone())) {
                continue;
            }
            if self.prs.enqueue(Job::Read(key.clone())).is_ok() {
                self.prs.due.insert(key, now + 60_000);
            }
        }
        self.start_pr_jobs();
    }
    pub(super) fn start_pr_jobs(&mut self) {
        while self.prs.active.len() < 2 {
            let Some(job) = self.prs.ready.pop_front() else {
                break;
            };
            if let Job::Read(key) = &job
                && self.review_work.changing.contains(key)
            {
                self.prs
                    .due
                    .insert(key.clone(), now_ms().saturating_add(1_000));
                continue;
            }
            let epoch = match &job {
                Job::Read(key) => self.prs.read_epochs.get(key).copied().unwrap_or(0),
                Job::Discover { .. } => self.prs.epoch,
            };
            self.prs.running.insert(job.key());
            let gh = self.config.gh_binary.clone();
            let timeout = self.config.network_timeout.min(Duration::from_secs(30));
            let mut cancel = self.prs.cancel.subscribe();
            self.prs.active.spawn(async move {
                let result =
                    match &job {
                        Job::Read(key) => host::fetch(&gh, key, timeout, &mut cancel)
                            .await
                            .map(|s| Some((key.clone(), s))),
                        Job::Discover { root, .. } => async {
                            let before = host::checkout(root, &mut cancel).await?;
                            let result = host::discover(&gh, &before, timeout, &mut cancel).await?;
                            let after = host::checkout(root, &mut cancel).await?;
                            if before != after {
                                return Err(AppError::new(
                                    "pr_context_changed",
                                    "Checkout changed during PR discovery. Refresh to try again.",
                                ));
                            }
                            Ok(result)
                        }
                        .await,
                    };
                PrCompletion { job, result, epoch }
            });
        }
    }
    pub(super) fn finish_pr_job(&mut self, completion: PrCompletion) -> Result<()> {
        let key = completion.job.key();
        self.prs.running.remove(&key);
        let rerun = self.prs.rerun.remove(&key);
        let epoch = match &completion.job {
            Job::Read(key) => self.prs.read_epochs.get(key).copied().unwrap_or(0),
            Job::Discover { .. } => match &completion.result {
                Ok(Some((key, _))) => self.prs.read_epochs.get(key).copied().unwrap_or(0),
                _ => 0,
            },
        };
        if epoch > completion.epoch {
            if let Some(job) = rerun {
                self.prs.enqueue(job)?;
            }
            self.start_pr_jobs();
            return match completion.result {
                Err(error) if error.code == "process_cleanup" => Err(error),
                _ => Ok(()),
            };
        }
        match completion.job {
            Job::Read(key) => {
                if let Some(mut record) = self.prs.records.get(&key).cloned() {
                    match completion.result {
                        Ok(Some((_, snapshot))) => {
                            if record
                                .snapshot
                                .as_ref()
                                .is_none_or(|old| !snapshot_is_older(&snapshot, old))
                            {
                                self.confirm_terminal_operations(&key, &snapshot)?;
                                if record.snapshot.as_ref() != Some(&snapshot) {
                                    record.revision += 1;
                                }
                                record.snapshot = Some(snapshot);
                                record.freshness = PrFreshness::Current {
                                    fetched_at: now_ms(),
                                };
                            }
                        }
                        Err(error) => {
                            self.mark_pr_stale(&key, &error.message)?;
                            if let Some(job) = rerun {
                                self.prs.enqueue(job)?;
                            }
                            self.start_pr_jobs();
                            return if error.code == "process_cleanup" {
                                Err(error)
                            } else {
                                Ok(())
                            };
                        }
                        Ok(None) => unreachable!(),
                    }
                    self.store.save_pull_request(&record, None)?;
                    let all_settled = self.prs.threads_by_pr.get(&key).is_some_and(|ids| {
                        ids.iter().all(|id| {
                            self.threads.get(id).is_none_or(|t| {
                                self.settlement(
                                    t,
                                    self.auto_settle.rules(&t.workspace_id),
                                    now_ms(),
                                )
                                .is_some()
                            })
                        })
                    });
                    let failures = self.prs.failures.entry(key.clone()).or_default();
                    let delay = {
                        *failures = 0;
                        match record.snapshot.as_ref().map(|s| &s.lifecycle) {
                            Some(PrLifecycle::Merged { .. }) => u64::MAX,
                            Some(PrLifecycle::Closed { .. }) => 900_000,
                            _ if all_settled => 900_000,
                            _ => 60_000,
                        }
                    };
                    self.prs
                        .due
                        .insert(key.clone(), now_ms().saturating_add(delay));
                    self.prs.records.insert(key.clone(), record);
                    if let Some(threads) = self.prs.threads_by_pr.get(&key) {
                        for id in threads {
                            self.pr_hint(id);
                        }
                    }
                }
            }
            Job::Discover {
                root,
                generation,
                members,
                source,
            } => {
                let current = self
                    .prs
                    .checkout_generations
                    .get(&root)
                    .copied()
                    .unwrap_or(0)
                    == generation
                    && !self.held.contains_key(&root)
                    && !self.leases.contains_key(&root);
                for member in members {
                    let valid = current
                        && self.pr_generation(&member.thread) == member.generation
                        && self.threads.get(&member.thread).is_some_and(|t| {
                            self.workspaces
                                .get(&t.workspace_id)
                                .is_some_and(|w| t.root(w) == root)
                        });
                    if valid {
                        match &completion.result {
                            Ok(Some((key, snapshot))) => {
                                self.prs.errors.remove(&member.thread);
                                if !self
                                    .prs
                                    .memberships
                                    .get(&member.thread)
                                    .is_some_and(|rows| rows.contains_key(key))
                                {
                                    let mut record = self
                                        .prs
                                        .records
                                        .get(key)
                                        .cloned()
                                        .unwrap_or_else(|| CachedPr::unknown(key.clone()));
                                    if record.snapshot.is_none() {
                                        record.snapshot = Some(snapshot.clone());
                                        record.revision += 1;
                                        record.freshness = PrFreshness::Current {
                                            fetched_at: now_ms(),
                                        };
                                    }
                                    let membership = Membership {
                                        thread: member.thread.clone(),
                                        key: key.clone(),
                                        generation: member.generation + 1,
                                        source: Some(source),
                                        at: now_ms(),
                                    };
                                    self.store.save_pull_request(&record, Some(&membership))?;
                                    self.prs.records.insert(key.clone(), record);
                                    self.prs.index(membership);
                                }
                            }
                            Ok(None) => {
                                self.prs.errors.remove(&member.thread);
                            }
                            Err(error) => {
                                self.prs
                                    .errors
                                    .insert(member.thread.clone(), error.message.clone());
                            }
                        }
                    }
                    self.pr_hint(&member.thread);
                }
            }
        }
        if let Some(job) = rerun {
            self.prs.enqueue(job)?;
        }
        self.start_pr_jobs();
        Ok(())
    }
    pub(super) async fn stop_pr_jobs(&mut self) -> Result<()> {
        self.prs.ready.clear();
        let _ = self.prs.cancel.send(true);
        let mut result = Ok(());
        while let Some(completion) = self.prs.active.join_next().await {
            match completion {
                Ok(PrCompletion {
                    result: Err(error), ..
                }) if error.code == "process_cleanup" => result = Err(error),
                Err(error) => result = Err(AppError::new("pr_worker", error)),
                _ => {}
            }
        }
        result
    }
}
