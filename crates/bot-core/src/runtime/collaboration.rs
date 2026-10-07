use super::{Codex, Completion, ModelPage, Owner};
use crate::domain::*;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ModePreset {
    pub mode: Option<InteractionMode>,
    pub reasoning_effort: Option<String>,
}
#[derive(Deserialize)]
struct ModeList {
    data: Vec<ModePreset>,
}
pub(super) struct ProviderSession {
    pub provider: Codex,
    pub modes: Vec<ModePreset>,
    pub models: Option<Vec<ModelOption>>,
}
pub(super) async fn discover(provider: Codex) -> ProviderSession {
    let modes = match provider
        .request_with_timeout("collaborationMode/list", json!({}), Duration::from_secs(1))
        .await
    {
        Ok(value) => serde_json::from_value::<ModeList>(value)
            .map(|list| list.data)
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let modes: Vec<_> = modes
        .into_iter()
        .filter(|preset| preset.mode.is_some())
        .collect();
    let models = if modes.is_empty() {
        None
    } else {
        read_models(&provider).await.ok()
    };
    ProviderSession {
        provider,
        modes,
        models,
    }
}
pub(super) async fn read_models(provider: &Codex) -> Result<Vec<ModelOption>> {
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen = HashSet::new();
    loop {
        let value = provider
            .request("model/list", json!({"cursor":cursor,"includeHidden":false}))
            .await?;
        let page: ModelPage = serde_json::from_value(value)?;
        models.extend(
            page.data
                .into_iter()
                .filter(|model| !model.hidden)
                .map(|model| model.option),
        );
        match page.next_cursor {
            Some(next) if seen.insert(next.clone()) => cursor = Some(next),
            Some(_) => return Err(AppError::new("protocol", "Codex repeated a model cursor.")),
            None => return Ok(models),
        }
    }
}
pub(super) fn turn_mode(
    modes: &[ModePreset],
    settings: &SessionSettings,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<Option<Value>> {
    if modes.is_empty() && settings.interaction_mode == InteractionMode::Default {
        return Ok(None);
    }
    let preset = modes
        .iter()
        .find(|preset| preset.mode == Some(settings.interaction_mode))
        .ok_or_else(|| {
            AppError::new(
                "plan_unavailable",
                "This Codex app-server does not support the selected collaboration mode.",
            )
        })?;
    let model = model.ok_or_else(|| {
        AppError::new(
            "models_unavailable",
            "Load the model list before starting a collaboration mode.",
        )
    })?;
    Ok(Some(json!({
        "mode": settings.interaction_mode,
        "settings": {
            "model": model,
            "reasoning_effort": effort.or(preset.reasoning_effort.as_deref()),
            "developer_instructions": null
        }
    })))
}
pub(super) fn validate_questions(questions: &[UserQuestion]) -> Result<()> {
    let mut ids = HashSet::new();
    if questions.is_empty()
        || questions.len() > 10
        || questions.iter().any(|question| {
            question.id.is_empty() || !ids.insert(&question.id) || question.question.is_empty()
        })
    {
        return Err(AppError::new(
            "invalid_questions",
            "Codex supplied an invalid question request.",
        ));
    }
    Ok(())
}
pub(super) fn validate_answers(
    questions: &[UserQuestion],
    answers: &UserQuestionAnswers,
) -> Result<()> {
    if answers.len() != questions.len()
        || questions.iter().any(|question| {
            answers.get(&question.id).is_none_or(|answer| {
                answer.answers.len() != 1
                    || answer.answers[0].trim().is_empty()
                    || answer.answers[0].len() > 100_000
                    || (!question.is_other
                        && question.options.as_ref().is_some_and(|options| {
                            !options.is_empty()
                                && !options
                                    .iter()
                                    .any(|option| option.label == answer.answers[0])
                        }))
            })
        })
    {
        return Err(AppError::new(
            "invalid_answers",
            "Answer every question with one available option or permitted text response.",
        ));
    }
    Ok(())
}

impl Owner {
    pub(super) fn answer_questions(
        &mut self,
        id: UserQuestionRequestId,
        answers: UserQuestionAnswers,
    ) -> Result<()> {
        let route = self.question_routes.get(&id).cloned().ok_or_else(|| {
            AppError::new(
                "question_expired",
                "This question no longer has a live callback.",
            )
        })?;
        if route.epoch != self.epoch {
            return Err(AppError::new(
                "question_expired",
                "Codex restarted. This question expired.",
            ));
        }
        let provider = self
            .provider
            .clone()
            .ok_or_else(|| AppError::new("provider_lost", "Codex is unavailable."))?;
        let mut thread = self.thread(&route.thread)?.clone();
        let request = thread
            .user_questions
            .iter_mut()
            .find(|request| request.id == id)
            .ok_or_else(|| AppError::new("question_expired", "Question not found."))?;
        if request.state != UserQuestionState::Pending {
            return Err(AppError::new(
                "question_expired",
                "This question has already been answered.",
            ));
        }
        validate_answers(&request.questions, &answers)?;
        request.state = UserQuestionState::Answering;
        self.install(thread)?;
        self.question_routes.remove(&id);
        let done = self.done.clone();
        let epoch = self.epoch;
        tokio::spawn(async move {
            let result = provider
                .respond(route.request, json!({"answers": answers}))
                .await;
            let _ = done
                .send(Completion::UserQuestionsAnswered { epoch, id, result })
                .await;
        });
        Ok(())
    }
}
