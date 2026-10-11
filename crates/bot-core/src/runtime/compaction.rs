// Context compaction adapts pingdotgg/t3code v0.0.45 ProviderCommandReactor.ts, ProviderService.compactThread and CodexSessionRuntime.restoreAdditionalContext to Bot Code's runtime owner (MIT).
use super::*;

pub(super) const COMPACT_COMMAND: &str = "/compact";
const TIMEOUT_REASON: &str =
    "Provider did not report completed context compaction within 10 minutes.";

/// T3 treats a message as the compaction command when its whole text is `/compact`, in any case, with nothing attached.
pub(super) fn is_command(
    text: &str,
    attachments: &[Attachment],
    context: Option<&MessageContext>,
) -> bool {
    attachments.is_empty() && context.is_none() && text.trim().eq_ignore_ascii_case(COMPACT_COMMAND)
}

pub(super) fn admit(t: &ThreadSnapshot, steering: bool) -> Result<()> {
    let conversation = t.native_thread_id.is_some()
        && t.turns.iter().any(|turn| {
            turn.kind == TurnKind::Prompt
                && turn.delivery == Delivery::Accepted
                && !turn.execution.active()
        });
    if !conversation {
        return Err(AppError::new(
            "compaction_unavailable",
            "Context compaction requires an existing conversation.",
        ));
    }
    let running = steering
        || matches!(
            t.session,
            SessionState::Connecting | SessionState::Running | SessionState::Interrupting
        )
        || t.turns.iter().any(|turn| turn.execution.active())
        || t.input_open()
        || t.pending_revert.is_some();
    if running {
        return Err(AppError::new(
            "busy",
            "Context compaction is unavailable while a provider turn is running.",
        ));
    }
    Ok(())
}

impl Owner {
    /// Codex acknowledges `thread/compact/start` with an empty result, then runs the compaction as its own turn.
    pub(super) fn dispatch_compaction(&mut self, thread: ThreadId, turn: TurnId, native: String) {
        let Some(provider) = self.provider.clone() else {
            return;
        };
        let done = self.done.clone();
        let epoch = self.epoch;
        let ceiling = self.config.compaction_timeout;
        tokio::spawn(async move {
            let result = provider
                .request("thread/compact/start", json!({"threadId": native}))
                .await;
            let accepted = result.is_ok();
            let _ = done
                .send(Completion::Started {
                    epoch,
                    thread: thread.clone(),
                    turn: turn.clone(),
                    result,
                })
                .await;
            if accepted {
                tokio::time::sleep(ceiling).await;
                let _ = done
                    .send(Completion::CompactionExpired {
                        epoch,
                        thread,
                        turn,
                    })
                    .await;
            }
        });
    }
    /// T3's ceiling: a compaction that never completes stops blocking the thread.
    pub(super) fn compaction_expired(&mut self, thread: &ThreadId, turn: &TurnId) -> Result<()> {
        let Some(t) = self.threads.get_mut(thread) else {
            return Ok(());
        };
        let Some(row) = t.turns.iter_mut().find(|row| &row.id == turn) else {
            return Ok(());
        };
        if !row.execution.active() {
            return Ok(());
        }
        row.execution = Execution::Lost {
            reason: TIMEOUT_REASON.into(),
        };
        let interrupt = t
            .native_thread_id
            .clone()
            .zip(row.native_turn_id.clone())
            .zip(self.provider.clone());
        t.session = SessionState::Ready;
        t.diagnostic = Some(TIMEOUT_REASON.into());
        // Stop the stalled compaction so the next prompt does not start beside it.
        if let Some(((native_thread, native_turn), provider)) = interrupt {
            tokio::spawn(async move {
                let _ = provider
                    .request(
                        "turn/interrupt",
                        json!({"threadId": native_thread, "turnId": native_turn}),
                    )
                    .await;
            });
        }
        self.tools.cancel_turn(thread, turn);
        self.capture_after(thread, turn.clone())
    }
    /// Compaction drops `additionalContext`, and Codex resends an entry only when its value changes.
    pub(super) fn restore_context(&self, native: &str) {
        let (Some(provider), Some(guidance)) = (self.provider.clone(), self.tools.guidance(native))
        else {
            return;
        };
        let log = self.log.clone();
        let params = json!({
            "threadId": native,
            "items": [{
                "type": "message",
                "role": "developer",
                "content": [{"type": "input_text", "text": format!("<botcode_tools>{guidance}</botcode_tools>")}],
            }],
        });
        tokio::spawn(async move {
            if let Err(error) = provider.request("thread/inject_items", params).await {
                log.line(
                    "bot-code",
                    &format!(
                        "failed to restore Codex additional context after compaction: {}",
                        error.message
                    ),
                );
            }
        });
    }
}
