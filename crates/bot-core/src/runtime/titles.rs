// Title regeneration adapts pingdotgg/t3code v0.0.45 ProviderCommandReactor.regenerateThreadTitle to Bot Code's runtime owner (MIT).
use super::*;
use crate::thread_title;
use tokio::sync::watch;

struct PendingTitle {
    request: u64,
    previous: String,
    cancel: watch::Sender<bool>,
    reply: Reply<()>,
}
pub(super) struct TitleCompletion {
    thread: ThreadId,
    request: u64,
    result: Result<Option<String>>,
}
#[derive(Default)]
pub(super) struct Titles {
    pending: HashMap<ThreadId, PendingTitle>,
    requests: u64,
    pub(super) active: tokio::task::JoinSet<TitleCompletion>,
}
impl Titles {
    pub(super) fn regenerating(&self, id: &ThreadId) -> bool {
        self.pending.contains_key(id)
    }
}
impl Owner {
    pub(super) fn regenerate_title(&mut self, id: ThreadId, reply: Reply<()>) {
        let t = match self.thread(&id) {
            Ok(t) if t.archived() => {
                let _ = reply.send(Err(AppError::new(
                    "thread_archived",
                    "Unarchive this thread first.",
                )));
                return;
            }
            Ok(t) => t,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        let context = thread_title::format_context(&thread_title::messages(t));
        if context.message.is_empty() {
            let _ = reply.send(Ok(()));
            return;
        }
        let previous = t.title.clone();
        let prompt = thread_title::regenerate_prompt(&previous, &context);
        let model =
            settings::text_generation(&self.config.data_dir.join("settings.json"), &t.workspace_id);
        let binary = self.config.codex_binary.clone();
        self.supersede_title(&id);
        self.titles.requests += 1;
        let request = self.titles.requests;
        let (cancel, receiver) = watch::channel(false);
        self.titles.pending.insert(
            id.clone(),
            PendingTitle {
                request,
                previous,
                cancel,
                reply,
            },
        );
        let thread = id.clone();
        self.titles.active.spawn(async move {
            let result = tokio::spawn(async move {
                thread_title::regenerate(
                    &binary,
                    &model,
                    &prompt,
                    receiver,
                    crate::text_generation::LIMIT,
                )
                .await
            })
            .await
            .map_err(|_| AppError::new("title_worker", "Title generation worker stopped."))
            .and_then(|result| result);
            TitleCompletion {
                thread,
                request,
                result,
            }
        });
        self.title_hint(&id);
    }
    pub(super) fn supersede_title(&mut self, id: &ThreadId) {
        if let Some(pending) = self.titles.pending.remove(id) {
            let _ = pending.cancel.send(true);
            let _ = pending.reply.send(Ok(()));
        }
    }
    fn title_hint(&self, id: &ThreadId) {
        if let Some(t) = self.threads.get(id) {
            let _ = self.changes.send(self.thread_hint(t));
        }
    }
    pub(super) fn finish_title(
        &mut self,
        done: std::result::Result<TitleCompletion, tokio::task::JoinError>,
    ) {
        let Ok(done) = done else {
            eprintln!("Title regeneration failed: worker stopped");
            return;
        };
        if self
            .titles
            .pending
            .get(&done.thread)
            .is_none_or(|pending| pending.request != done.request)
        {
            return;
        }
        let pending = self.titles.pending.remove(&done.thread).unwrap();
        let result = match done.result {
            Ok(Some(title))
                if title != pending.previous
                    && self
                        .threads
                        .get(&done.thread)
                        .is_some_and(|t| t.title == pending.previous) =>
            {
                let mut next = self.threads[&done.thread].clone();
                next.title = title;
                self.install(next)
            }
            Ok(_) => {
                self.title_hint(&done.thread);
                Ok(())
            }
            Err(error) => Err(error),
        };
        if let Err(error) = &result {
            eprintln!("Title regeneration kept the previous title: {}", error.code);
            self.title_hint(&done.thread);
        }
        let _ = pending.reply.send(result);
    }
    pub(super) async fn stop_titles(&mut self) {
        let ids: Vec<_> = self.titles.pending.keys().cloned().collect();
        for id in ids {
            self.supersede_title(&id);
        }
        while let Some(done) = self.titles.active.join_next().await {
            self.finish_title(done);
        }
    }
}
