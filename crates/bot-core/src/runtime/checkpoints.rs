// Ported from T3 Code v0.0.45 checkpointing/CheckpointStore.ts and ChatView.tsx timeline revert.
use super::*;

pub(super) enum CheckpointJob {
    Before(ThreadId, TurnId, PathBuf, Result<Checkpoint>),
    After(
        ThreadId,
        TurnId,
        PathBuf,
        Result<(Checkpoint, Vec<TurnDiffFile>)>,
    ),
    Preflight(ThreadId, Result<()>),
    Fork(ThreadId, Result<Option<String>>),
    Restore(ThreadId, Result<()>),
    Diff(Reply<TurnDiffView>, Result<TurnDiffView>),
}
pub(super) struct CheckpointWork {
    pub active: tokio::task::JoinSet<CheckpointJob>,
    running_reverts: HashSet<ThreadId>,
    replies: HashMap<ThreadId, Vec<Reply<ThreadSnapshot>>>,
    provider_waiters: HashSet<ThreadId>,
    completed_captures: HashMap<ThreadId, CompletedCapture>,
    completed_restores: HashMap<ThreadId, Option<String>>,
    refused_preflights: HashMap<ThreadId, AppError>,
}
#[derive(Clone)]
enum CaptureOutcome {
    WithoutRepository,
    Before(Result<Checkpoint>),
    After(Result<(Checkpoint, Vec<TurnDiffFile>)>),
}
#[derive(Clone)]
struct CompletedCapture {
    turn: TurnId,
    root: PathBuf,
    outcome: CaptureOutcome,
}
impl CheckpointWork {
    pub fn new() -> Self {
        Self {
            active: tokio::task::JoinSet::new(),
            running_reverts: HashSet::new(),
            replies: HashMap::new(),
            provider_waiters: HashSet::new(),
            completed_captures: HashMap::new(),
            completed_restores: HashMap::new(),
            refused_preflights: HashMap::new(),
        }
    }
}
fn worker_error(error: tokio::task::JoinError) -> AppError {
    AppError::new("checkpoint_worker", error)
}
fn revert_input(thread: &ThreadId, intent: &RevertIntent) -> Result<String> {
    Ok(serde_json::to_string(&(
        "revert",
        thread,
        &intent.turn_id,
        intent.files,
    ))?)
}
impl Owner {
    pub(super) fn capture_before(&mut self, id: ThreadId, turn: TurnId) {
        let t = &self.threads[&id];
        let root = t.root(&self.workspaces[&t.workspace_id]).to_path_buf();
        self.held.insert(root.clone(), Hold::Checkpoint);
        if !matches!(t.checkout, Checkout::Local | Checkout::Worktree { .. }) {
            self.checkpoint_work.completed_captures.insert(
                id.clone(),
                CompletedCapture {
                    turn,
                    root,
                    outcome: CaptureOutcome::WithoutRepository,
                },
            );
            let _ = self.save_capture(&id);
            return;
        }
        let reference = format!("refs/botcode/checkpoints/{id}/{turn}/before");
        self.checkpoint_work.active.spawn(async move {
            let path = root.clone();
            let result =
                tokio::task::spawn_blocking(move || crate::checkpoints::capture(&path, &reference))
                    .await
                    .map_err(worker_error)
                    .and_then(|r| r);
            CheckpointJob::Before(id, turn, root, result)
        });
    }
    pub(super) fn capture_after(&mut self, id: &ThreadId, turn: TurnId) -> Result<()> {
        let t = &self.threads[id];
        let row = t
            .turns
            .iter()
            .find(|row| row.id == turn)
            .ok_or_else(|| AppError::new("missing_turn", "Turn not found."))?;
        let before = row.checkpoint.before().cloned();
        let root = t.root(&self.workspaces[&t.workspace_id]).to_path_buf();
        if self.held.get(&root) == Some(&Hold::Checkpoint) {
            return Ok(());
        }
        self.commit(id)?;
        let Some(before) = before else {
            self.leases.remove(&root);
            let _ = self.refresh_prs(id, true, PrLinkSource::AgentDiscovered);
            return Ok(());
        };
        self.held.insert(root.clone(), Hold::Checkpoint);
        let id = id.clone();
        let reference = format!("refs/botcode/checkpoints/{id}/{turn}/after");
        self.checkpoint_work.active.spawn(async move {
            let path = root.clone();
            let result = tokio::task::spawn_blocking(move || {
                let after = crate::checkpoints::capture(&path, &reference)?;
                let files = crate::checkpoints::files(&path, &before, &after)?;
                Ok((after, files))
            })
            .await
            .map_err(worker_error)
            .and_then(|r| r);
            CheckpointJob::After(id, turn, root, result)
        });
        Ok(())
    }
    pub(super) fn read_turn_diff(
        &mut self,
        thread: ThreadId,
        turn: TurnId,
        path: String,
        reply: Reply<TurnDiffView>,
    ) {
        let values = (|| {
            let t = self.thread(&thread)?;
            let row = t
                .turns
                .iter()
                .find(|row| row.id == turn)
                .ok_or_else(|| AppError::new("missing_turn", "Turn not found."))?;
            let TurnCheckpoint::Complete {
                before,
                after,
                files,
            } = &row.checkpoint
            else {
                return Err(AppError::new(
                    "checkpoint_unavailable",
                    "This turn's diff is unavailable.",
                ));
            };
            if !files.iter().any(|file| file.path == path) {
                return Err(AppError::new(
                    "invalid_path",
                    "This file is not in the selected turn's diff.",
                ));
            }
            let root = self.workspaces[&t.workspace_id].root.clone();
            Ok((root, before.clone(), after.clone()))
        })();
        match values {
            Err(error) => {
                let _ = reply.send(Err(error));
            }
            Ok((root, before, after)) => {
                self.checkpoint_work.active.spawn(async move {
                    let result = tokio::task::spawn_blocking(move || {
                        crate::checkpoints::view(&root, &before, &after, &path)
                    })
                    .await
                    .map_err(worker_error)
                    .and_then(|r| r);
                    CheckpointJob::Diff(reply, result)
                });
            }
        }
    }
    pub(super) fn begin_revert(
        &mut self,
        thread: ThreadId,
        request: String,
        turn: TurnId,
        files: bool,
        reply: Reply<ThreadSnapshot>,
    ) {
        let result = (|| -> Result<bool> {
            if request.is_empty() || request.len() > 256 {
                return Err(AppError::new(
                    "invalid_request",
                    "A revert operation ID must contain 1 to 256 bytes.",
                ));
            }
            let input = serde_json::to_string(&("revert", &thread, &turn, files))?;
            if self.store.receipt(&request, &input)?.is_some() {
                return Ok(false);
            }
            let t = self.thread(&thread)?;
            if let Some(intent) = &t.pending_revert {
                if intent.request_id != request || intent.turn_id != turn || intent.files != files {
                    return Err(AppError::new(
                        "revert_pending",
                        "Retry the saved revert before starting another.",
                    ));
                }
                return Ok(true);
            }
            let root = t.root(&self.workspaces[&t.workspace_id]).to_path_buf();
            if let Some(held) = self.held.get(&root) {
                return Err(held.refusal());
            }
            if !self.idle(t, &root) {
                return Err(turn_running());
            }
            if t.turns.iter().any(|row| row.execution.active()) {
                return Err(turn_running());
            }
            let position = t
                .turns
                .iter()
                .position(|row| row.id == turn)
                .ok_or_else(|| AppError::new("missing_turn", "Turn not found."))?;
            if matches!(t.turns[position].checkpoint, TurnCheckpoint::Pending) {
                return Err(AppError::new(
                    "checkpoint_unavailable",
                    "Wait for checkpoint capture to finish.",
                ));
            }
            let before = t.turns[position].checkpoint.before().cloned();
            if files && before.is_none() {
                return Err(AppError::new(
                    "checkpoint_unavailable",
                    "This turn has no before checkpoint to restore.",
                ));
            }
            if files && !root.exists() {
                return Err(worktree_removed());
            }
            let boundary = t.turns[position..]
                .iter()
                .find_map(|row| row.native_turn_id.clone());
            if position > 0
                && boundary.is_none()
                && t.turns[position..].iter().any(|row| {
                    !matches!(row.delivery, Delivery::NotSent { .. } | Delivery::Preparing)
                })
            {
                return Err(AppError::new(
                    "native_history_unconfirmed",
                    "Resume this conversation to confirm native history before reverting it.",
                ));
            }
            let mut next = t.clone();
            next.pending_revert = Some(RevertIntent {
                request_id: request.clone(),
                turn_id: turn.clone(),
                files,
                source_native_thread_id: next.native_thread_id.clone(),
                before_native_turn_id: boundary,
                before,
                checkout_root: root.clone(),
                phase: RevertPhase::Preparing,
                retained_native_turn_ids: next.turns[..position]
                    .iter()
                    .filter_map(|row| row.native_turn_id.clone())
                    .collect(),
            });
            next.diagnostic = None;
            self.install(next)?;
            self.invalidate_names(&root);
            self.held.insert(root, Hold::Revert);
            Ok(true)
        })();
        match result {
            Err(error) => {
                let _ = reply.send(Err(error));
            }
            Ok(false) => {
                let _ = reply.send(self.thread(&thread).cloned());
            }
            Ok(true) => {
                self.checkpoint_work
                    .replies
                    .entry(thread.clone())
                    .or_default()
                    .push(reply);
                if self.checkpoint_work.running_reverts.insert(thread.clone())
                    && let Err(error) = self.continue_revert(&thread)
                {
                    self.fail_revert(&thread, error);
                }
            }
        }
    }
    fn continue_revert(&mut self, id: &ThreadId) -> Result<()> {
        let t = self.thread(id)?;
        let intent = t
            .pending_revert
            .clone()
            .ok_or_else(|| AppError::new("revert_missing", "The saved revert is unavailable."))?;
        match intent.phase.clone() {
            RevertPhase::Preparing => {
                let id = id.clone();
                self.checkpoint_work.active.spawn(async move {
                    let result = if intent.files {
                        tokio::task::spawn_blocking(move || {
                            crate::checkpoints::preflight_restore(
                                &intent.checkout_root,
                                intent.before.as_ref().unwrap(),
                            )
                        })
                        .await
                        .map_err(worker_error)
                        .and_then(|r| r)
                    } else {
                        Ok(())
                    };
                    CheckpointJob::Preflight(id, result)
                });
            }
            RevertPhase::ConversationReady { native_thread_id } => {
                if intent.files {
                    let mut next = t.clone();
                    next.pending_revert.as_mut().unwrap().phase =
                        RevertPhase::RestoringFiles { native_thread_id };
                    self.install(next)?;
                    self.restore_revert(id.clone(), intent);
                } else {
                    self.commit_revert(id, native_thread_id)?;
                }
            }
            RevertPhase::RestoringFiles { .. } => self.restore_revert(id.clone(), intent),
            RevertPhase::FilesRestored { native_thread_id } => {
                self.commit_revert(id, native_thread_id)?
            }
        }
        Ok(())
    }
    pub(super) fn fork_revert(&mut self, id: ThreadId) {
        self.checkpoint_work.provider_waiters.remove(&id);
        let t = &self.threads[&id];
        let Some(intent) = t.pending_revert.clone() else {
            return;
        };
        let position = t
            .turns
            .iter()
            .position(|row| row.id == intent.turn_id)
            .unwrap();
        let native = if position == 0 {
            None
        } else {
            intent.source_native_thread_id.clone()
        };
        if position == 0 || native.is_none() || intent.before_native_turn_id.is_none() {
            if let Err(error) = self.conversation_reverted(&id, native) {
                self.fail_revert(&id, error);
            }
            return;
        }
        let provider = self.provider.clone().unwrap();
        let cwd = if intent.checkout_root.exists() {
            intent.checkout_root.clone()
        } else {
            self.workspaces[&t.workspace_id].root.clone()
        };
        self.checkpoint_work.active.spawn(async move {
            let result = provider.request("thread/fork", json!({"threadId": native.unwrap(), "beforeTurnId": intent.before_native_turn_id.unwrap(), "cwd": cwd, "excludeTurns": false})).await.and_then(|value| {
                let thread = value.get("thread").unwrap_or(&Value::Null);
                let ids: Vec<_> = thread.get("turns").and_then(Value::as_array).ok_or_else(|| AppError::new("native_history_unconfirmed", "Codex did not return the forked conversation history."))?.iter().map(|row| required_string(row, "id").map(str::to_owned)).collect::<Result<_>>()?;
                if ids != intent.retained_native_turn_ids {
                    return Err(AppError::new("native_history_unconfirmed", "The forked native history does not match the retained local conversation."));
                }
                required_string(thread, "id").map(|id| Some(id.to_owned()))
            });
            CheckpointJob::Fork(id, result)
        });
    }
    fn conversation_reverted(
        &mut self,
        id: &ThreadId,
        native_thread_id: Option<String>,
    ) -> Result<()> {
        let mut next = self.thread(id)?.clone();
        next.pending_revert.as_mut().unwrap().phase =
            RevertPhase::ConversationReady { native_thread_id };
        self.install(next)?;
        self.continue_revert(id)
    }
    fn restore_revert(&mut self, id: ThreadId, intent: RevertIntent) {
        self.checkpoint_work.active.spawn(async move {
            let result = tokio::task::spawn_blocking(move || {
                crate::checkpoints::restore(&intent.checkout_root, intent.before.as_ref().unwrap())
            })
            .await
            .map_err(worker_error)
            .and_then(|r| r);
            CheckpointJob::Restore(id, result)
        });
    }
    fn commit_revert(&mut self, id: &ThreadId, native: Option<String>) -> Result<()> {
        let mut next = self.thread(id)?.clone();
        let intent = next.pending_revert.clone().unwrap();
        let position = next
            .turns
            .iter()
            .position(|row| row.id == intent.turn_id)
            .ok_or_else(|| {
                AppError::new("revert_conflict", "The saved revert boundary changed.")
            })?;
        next.last_revert = Some(RevertResult {
            request_id: intent.request_id.clone(),
            turn_id: intent.turn_id.clone(),
            prompt: next.turns[position].prompt.clone(),
            attachments: next.turns[position].attachments.clone(),
            turn_count: position,
        });
        next.turns.truncate(position);
        let retained: HashSet<_> = next.turns.iter().map(|row| row.id.clone()).collect();
        let removed_approvals: HashSet<_> = next
            .approvals
            .iter()
            .filter(|a| !retained.contains(&a.turn_id))
            .map(|a| a.id.clone())
            .collect();
        next.approvals.retain(|a| retained.contains(&a.turn_id));
        next.native_thread_id = native;
        next.session = if next.native_thread_id.is_some() {
            SessionState::Dormant
        } else {
            SessionState::Draft
        };
        next.pending_revert = None;
        next.context = None;
        next.diagnostic = None;
        next.latest_user_activity_at_ms = Some(now_ms());
        next.revision += 1;
        let input = revert_input(id, &intent)?;
        self.store.accept(
            &next,
            &intent.request_id,
            &input,
            &Receipt {
                turn_id: intent.turn_id,
            },
        )?;
        self.routes
            .retain(|approval, _| !removed_approvals.contains(approval));
        self.dirty.remove(id);
        self.held.remove(&intent.checkout_root);
        self.checkout_changed(&intent.checkout_root);
        let hint = self.thread_hint(&next);
        self.threads.insert(id.clone(), next.clone());
        let _ = self.changes.send(ChangeHint {
            refresh_workspace: true,
            ..hint
        });
        self.checkpoint_work.running_reverts.remove(id);
        for reply in self.checkpoint_work.replies.remove(id).unwrap_or_default() {
            let _ = reply.send(Ok(next.clone()));
        }
        Ok(())
    }
    fn fail_revert(&mut self, id: &ThreadId, error: AppError) {
        self.checkpoint_work.running_reverts.remove(id);
        self.notify_revert_failure(id, error);
    }
    fn notify_revert_failure(&mut self, id: &ThreadId, error: AppError) {
        if let Ok(t) = self.thread(id) {
            let mut next = t.clone();
            next.diagnostic = Some(format!(
                "Revert is pending. Retry the saved operation. {}",
                error.message
            ));
            let _ = self.install(next);
        }
        for reply in self.checkpoint_work.replies.remove(id).unwrap_or_default() {
            let _ = reply.send(Err(error.clone()));
        }
    }
    pub(super) fn fail_reverts(&mut self, reason: &str) {
        let ids: Vec<_> = self
            .checkpoint_work
            .running_reverts
            .iter()
            .cloned()
            .collect();
        for id in ids {
            if self.checkpoint_work.provider_waiters.remove(&id) {
                self.checkpoint_work.running_reverts.remove(&id);
            }
            self.notify_revert_failure(&id, AppError::new("provider_lost", reason));
        }
    }
    pub(super) fn waiting_revert_provider(&mut self, id: ThreadId) {
        self.checkpoint_work.provider_waiters.insert(id);
    }
    pub(super) fn retry_checkpoint_saves(&mut self) {
        let ids: Vec<_> = self
            .checkpoint_work
            .completed_captures
            .keys()
            .cloned()
            .collect();
        for id in ids {
            let _ = self.save_capture(&id);
        }
        let refusals: Vec<_> = self
            .checkpoint_work
            .refused_preflights
            .iter()
            .map(|(id, error)| (id.clone(), error.clone()))
            .collect();
        for (id, error) in refusals {
            let _ = self.clear_refused_revert(&id, error);
        }
        let ids: Vec<_> = self
            .checkpoint_work
            .completed_restores
            .keys()
            .cloned()
            .collect();
        for id in ids {
            if let Err(error) = self.save_restored(&id) {
                if self.checkpoint_work.completed_restores.contains_key(&id) {
                    self.notify_revert_failure(&id, error);
                } else {
                    self.fail_revert(&id, error);
                }
            }
        }
    }
    fn save_restored(&mut self, id: &ThreadId) -> Result<()> {
        let native = self.checkpoint_work.completed_restores[id].clone();
        let mut next = self.thread(id)?.clone();
        next.pending_revert.as_mut().unwrap().phase = RevertPhase::FilesRestored {
            native_thread_id: native.clone(),
        };
        self.install(next)?;
        self.checkpoint_work.completed_restores.remove(id);
        self.commit_revert(id, native)
    }
    fn save_capture(&mut self, id: &ThreadId) -> Result<()> {
        let capture = self.checkpoint_work.completed_captures[id].clone();
        let mut next = self.thread(id)?.clone();
        let row = next
            .turns
            .iter_mut()
            .find(|row| row.id == capture.turn)
            .ok_or_else(|| AppError::new("missing_turn", "Turn not found."))?;
        let mut dispatch = false;
        match capture.outcome {
            CaptureOutcome::WithoutRepository => {
                dispatch = row.execution.active() && !self.closing;
                row.checkpoint = TurnCheckpoint::Unavailable {
                    before: None,
                    reason: "Checkpoints require a Git repository.".into(),
                };
            }
            CaptureOutcome::Before(result) => {
                dispatch = row.execution.active() && result.is_ok() && !self.closing;
                match result {
                    Ok(before) => {
                        row.checkpoint = if dispatch {
                            TurnCheckpoint::Before { before }
                        } else {
                            TurnCheckpoint::Unavailable {
                                before: Some(before),
                                reason: "Execution stopped before this turn was dispatched.".into(),
                            }
                        }
                    }
                    Err(error) => {
                        row.checkpoint = TurnCheckpoint::Unavailable {
                            before: None,
                            reason: error.message.clone(),
                        };
                        row.delivery = Delivery::NotSent {
                            reason: error.message.clone(),
                        };
                        row.execution = Execution::Failed {
                            reason: error.message.clone(),
                        };
                        next.session = SessionState::Unavailable {
                            reason: error.message,
                        };
                    }
                }
            }
            CaptureOutcome::After(result) => {
                let before = row.checkpoint.before().cloned();
                row.checkpoint = match result {
                    Ok((after, files)) => TurnCheckpoint::Complete {
                        before: before.ok_or_else(|| {
                            AppError::new(
                                "checkpoint_unavailable",
                                "The before checkpoint is unavailable.",
                            )
                        })?,
                        after,
                        files,
                    },
                    Err(error) => TurnCheckpoint::Unavailable {
                        before,
                        reason: error.message,
                    },
                };
            }
        }
        self.install(next)?;
        self.checkpoint_work.completed_captures.remove(id);
        self.held.remove(&capture.root);
        if dispatch {
            self.prepare(Prepare::Submit(id.clone(), capture.turn));
        } else {
            self.leases.remove(&capture.root);
            let _ = self.refresh_prs(id, true, PrLinkSource::AgentDiscovered);
        }
        Ok(())
    }
    fn clear_refused_revert(&mut self, id: &ThreadId, error: AppError) -> Result<()> {
        let mut next = self.thread(id)?.clone();
        let intent = next.pending_revert.take().unwrap();
        next.diagnostic = Some(error.message.clone());
        self.install(next)?;
        self.held.remove(&intent.checkout_root);
        self.checkpoint_work.running_reverts.remove(id);
        self.checkpoint_work.refused_preflights.remove(id);
        for reply in self.checkpoint_work.replies.remove(id).unwrap_or_default() {
            let _ = reply.send(Err(error.clone()));
        }
        Ok(())
    }
    pub(super) fn finish_checkpoint_job(
        &mut self,
        completion: std::result::Result<CheckpointJob, tokio::task::JoinError>,
    ) -> Result<()> {
        match completion.map_err(worker_error)? {
            CheckpointJob::Diff(reply, result) => {
                let _ = reply.send(result);
            }
            CheckpointJob::Before(id, turn, root, result) => {
                self.checkpoint_work.completed_captures.insert(
                    id.clone(),
                    CompletedCapture {
                        turn,
                        root,
                        outcome: CaptureOutcome::Before(result),
                    },
                );
                self.save_capture(&id)?;
            }
            CheckpointJob::After(id, turn, root, result) => {
                self.checkpoint_work.completed_captures.insert(
                    id.clone(),
                    CompletedCapture {
                        turn,
                        root,
                        outcome: CaptureOutcome::After(result),
                    },
                );
                self.save_capture(&id)?;
            }
            CheckpointJob::Preflight(id, result) => match result {
                Ok(()) => self.prepare(Prepare::Revert(id)),
                Err(error) => {
                    self.checkpoint_work
                        .refused_preflights
                        .insert(id.clone(), error.clone());
                    if let Err(storage) = self.clear_refused_revert(&id, error) {
                        self.notify_revert_failure(&id, storage);
                    }
                }
            },
            CheckpointJob::Fork(id, result) => {
                let result = result.and_then(|native| self.conversation_reverted(&id, native));
                if let Err(error) = result {
                    self.fail_revert(&id, error);
                }
            }
            CheckpointJob::Restore(id, result) => {
                let result = result.and_then(|_| {
                    let intent = self.thread(&id)?.pending_revert.as_ref().unwrap();
                    let RevertPhase::RestoringFiles { native_thread_id } = &intent.phase else {
                        return Err(AppError::new(
                            "revert_conflict",
                            "The saved revert phase changed.",
                        ));
                    };
                    self.checkpoint_work
                        .completed_restores
                        .insert(id.clone(), native_thread_id.clone());
                    self.save_restored(&id)
                });
                if let Err(error) = result {
                    if self.checkpoint_work.completed_restores.contains_key(&id) {
                        self.notify_revert_failure(&id, error);
                    } else {
                        self.fail_revert(&id, error);
                    }
                }
            }
        }
        Ok(())
    }
}
