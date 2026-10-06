// Commit previews adapt pingdotgg/t3code v0.0.45 text generation to Bot Code's runtime owner (MIT).
use super::*;
use tokio::sync::watch;

struct Preview {
    thread: ThreadId,
    root: PathBuf,
    cancel: watch::Sender<bool>,
    reply: Option<Reply<String>>,
    result: Option<Result<String>>,
    expires: tokio::time::Instant,
}
#[derive(Default)]
pub(super) struct Writing {
    pending: HashMap<String, Preview>,
    pub active: tokio::task::JoinSet<(String, Result<String>)>,
}
impl Owner {
    pub(super) fn begin_commit_preview(&mut self, thread: ThreadId) -> Result<String> {
        let t = self.thread(&thread)?;
        let (_, location) = self.checkout(&t.workspace_id, Some(thread.clone()))?;
        let root = location.repository()?;
        if self.held.contains_key(&root) || self.leases.contains_key(&root) {
            return Err(AppError::new(
                "checkout_busy",
                "This checkout is busy. Enter a commit message or try again when it is idle.",
            ));
        }
        let model = self.resolve_model(&t.settings).map(str::to_owned);
        self.cancel_commit_previews(Some(&root));
        if self.writing.active.len() >= 4 || self.writing.pending.len() >= 4 {
            return Err(AppError::new(
                "generation_busy",
                "Commit message generation is busy. Enter a commit message.",
            ));
        }
        let binary = self.config.codex_binary.clone();
        let id = uuid::Uuid::new_v4().to_string();
        let (cancel, mut receiver) = watch::channel(false);
        self.writing.pending.insert(
            id.clone(),
            Preview {
                thread,
                root: root.clone(),
                cancel,
                reply: None,
                result: None,
                expires: tokio::time::Instant::now() + Duration::from_secs(150),
            },
        );
        let job = id.clone();
        self.writing.active.spawn(async move {
            let result = tokio::spawn(async move {
                crate::text_generation::preview_commit(
                    &binary,
                    model.as_deref(),
                    &root,
                    &mut receiver,
                )
                .await
                .map(String::from)
            })
            .await
            .map_err(|_| AppError::new("generation_worker", "Commit generation worker stopped."))
            .and_then(|result| result);
            (job, result)
        });
        Ok(id)
    }
    pub(super) fn await_commit_preview(&mut self, id: String, reply: Reply<String>) {
        let Some(preview) = self.writing.pending.get_mut(&id) else {
            let _ = reply.send(Err(AppError::new(
                "cancelled",
                "Commit message generation cancelled.",
            )));
            return;
        };
        if let Some(result) = preview.result.take() {
            self.writing.pending.remove(&id);
            let _ = reply.send(result);
        } else if preview.reply.is_some() {
            let _ = reply.send(Err(AppError::new(
                "generation_busy",
                "Commit message is already being awaited.",
            )));
        } else {
            preview.reply = Some(reply);
        }
    }
    pub(super) fn cancel_commit_preview(&mut self, id: &str) {
        if let Some(preview) = self.writing.pending.remove(id) {
            let _ = preview.cancel.send(true);
            if let Some(reply) = preview.reply {
                let _ = reply.send(Err(AppError::new(
                    "cancelled",
                    "Commit message generation cancelled.",
                )));
            }
        }
    }
    pub(super) fn cancel_commit_previews(&mut self, root: Option<&Path>) {
        let ids: Vec<_> = self
            .writing
            .pending
            .iter()
            .filter(|(_, p)| root.is_none_or(|root| root == p.root))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.cancel_commit_preview(&id);
        }
    }
    pub(super) fn cancel_thread_commit_previews(&mut self, threads: &HashSet<ThreadId>) {
        let ids: Vec<_> = self
            .writing
            .pending
            .iter()
            .filter(|(_, preview)| threads.contains(&preview.thread))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.cancel_commit_preview(&id);
        }
    }
    pub(super) fn expire_commit_previews(&mut self) {
        let ids: Vec<_> = self
            .writing
            .pending
            .iter()
            .filter(|(_, p)| {
                p.expires <= tokio::time::Instant::now() || !self.threads.contains_key(&p.thread)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.cancel_commit_preview(&id);
        }
    }
    pub(super) fn finish_commit_preview(
        &mut self,
        done: std::result::Result<(String, Result<String>), tokio::task::JoinError>,
    ) {
        let Ok((id, result)) = done else {
            return;
        };
        let Some(preview) = self.writing.pending.get_mut(&id) else {
            return;
        };
        if let Some(reply) = preview.reply.take() {
            self.writing.pending.remove(&id);
            let _ = reply.send(result);
        } else {
            preview.result = Some(result);
        }
    }
    pub(super) async fn stop_commit_previews(&mut self) {
        self.cancel_commit_previews(None);
        while let Some(done) = self.writing.active.join_next().await {
            self.finish_commit_preview(done);
        }
    }
}
