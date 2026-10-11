// Ported from pingdotgg/t3code v0.0.45 apps/server/src/textGeneration/{ThreadTitleContext,TextGenerationPrompts,TextGenerationUtils}.ts (MIT).
use crate::domain::*;
use serde::Deserialize;
use std::{collections::HashMap, path::Path, time::Duration};
use tokio::sync::watch;

const MAX_CONTEXT: usize = 8_000;
const MAX_MESSAGE: usize = 2_000;
const OMITTED: &str = "[Earlier content truncated]\n\n";
const TRUNCATED: &str = "\n[Content truncated]\n";
const MAX_THREAD_TITLE_CHARS: usize = 120;
const DEFAULT_THREAD_TITLE: &str = "New thread";
pub(crate) const SCHEMA: &str = r#"{"type":"object","properties":{"title":{"type":"string"},"needsRefinement":{"type":"boolean"}},"required":["title","needsRefinement"],"additionalProperties":false}"#;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Role {
    User,
    Assistant,
}
pub(crate) struct TitleMessage<'a> {
    pub role: Role,
    pub text: &'a str,
    pub attachments: &'a [Attachment],
}

pub(crate) fn messages(thread: &ThreadSnapshot) -> Vec<TitleMessage<'_>> {
    thread
        .turns
        .iter()
        .flat_map(|turn| {
            std::iter::once(TitleMessage {
                role: Role::User,
                text: &turn.prompt,
                attachments: &turn.attachments,
            })
            .chain(turn.items.iter().filter_map(|item| match item {
                Item::UserInput {
                    text, attachments, ..
                } => Some(TitleMessage {
                    role: Role::User,
                    text,
                    attachments,
                }),
                Item::Assistant { text, .. } => Some(TitleMessage {
                    role: Role::Assistant,
                    text,
                    attachments: &[],
                }),
                _ => None,
            }))
        })
        .collect()
}

fn chars(text: &str) -> usize {
    text.chars().count()
}
fn head(text: &str, count: usize) -> &str {
    text.char_indices()
        .nth(count)
        .map_or(text, |(at, _)| &text[..at])
}
fn tail(text: &str, count: usize) -> &str {
    let skip = chars(text).saturating_sub(count);
    text.char_indices()
        .nth(skip)
        .map_or("", |(at, _)| &text[at..])
}

pub(crate) fn limit_title_message(text: &str, budget: usize) -> String {
    if chars(text) <= budget {
        return text.into();
    }
    if budget <= chars(TRUNCATED) {
        return String::new();
    }
    let available = budget - chars(TRUNCATED);
    let start = available.div_ceil(2);
    let end = available - start;
    format!(
        "{}{TRUNCATED}{}",
        head(text, start),
        if end > 0 { tail(text, end) } else { "" }
    )
}

pub(crate) struct TitleContext<'a> {
    pub message: String,
    pub attachments: Vec<&'a Attachment>,
}

pub(crate) fn format_context<'a>(messages: &[TitleMessage<'a>]) -> TitleContext<'a> {
    struct Section<'m, 'a> {
        index: usize,
        message: &'m TitleMessage<'a>,
        prefix: &'static str,
        contents: String,
    }
    let sections: Vec<Section> = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| !message.text.trim().is_empty() || !message.attachments.is_empty())
        .map(|(index, message)| {
            let names = message
                .attachments
                .iter()
                .map(Attachment::name)
                .collect::<Vec<_>>()
                .join(", ");
            let contents = [
                message.text.trim().to_owned(),
                if names.is_empty() {
                    String::new()
                } else {
                    format!("[Attachments: {names}]")
                },
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
            Section {
                index,
                message,
                prefix: match message.role {
                    Role::User => "USER:\n",
                    Role::Assistant => "ASSISTANT:\n",
                },
                contents,
            }
        })
        .collect();
    let mut selected: HashMap<usize, String> = HashMap::new();
    let mut remaining = (MAX_CONTEXT - chars(OMITTED)) as isize;
    let mut add = |section: &Section, budget: isize, remaining: &mut isize| {
        if selected.contains_key(&section.index) {
            return;
        }
        let limit = budget.min(*remaining) - chars(section.prefix) as isize - 2;
        if limit <= chars(TRUNCATED) as isize {
            return;
        }
        let contents = limit_title_message(&section.contents, limit as usize);
        if contents.is_empty() {
            return;
        }
        let text = format!("{}{contents}", section.prefix);
        *remaining -= chars(&text) as isize + 2;
        selected.insert(section.index, text);
    };
    let first_user = sections.iter().find(|s| s.message.role == Role::User);
    if let Some(first) = first_user {
        add(first, MAX_MESSAGE as isize, &mut remaining);
    }
    for section in sections.iter().rev() {
        if section.message.role == Role::User {
            let budget = (MAX_MESSAGE as isize).min(remaining - 2_000);
            add(section, budget, &mut remaining);
        }
    }
    for section in sections.iter().rev() {
        if section.message.role == Role::Assistant {
            add(section, MAX_MESSAGE as isize, &mut remaining);
        }
    }
    for role in [Role::User, Role::Assistant] {
        for section in sections.iter().rev() {
            let Some(previous) = selected.get(&section.index) else {
                continue;
            };
            if section.message.role != role {
                continue;
            }
            let budget =
                (chars(previous) as isize + remaining - chars(section.prefix) as isize).max(0);
            let expanded = format!(
                "{}{}",
                section.prefix,
                limit_title_message(&section.contents, budget as usize)
            );
            remaining -= chars(&expanded) as isize - chars(previous) as isize;
            selected.insert(section.index, expanded);
        }
    }
    let retained: Vec<&Section> = sections
        .iter()
        .filter(|s| selected.contains_key(&s.index))
        .collect();
    let truncated = retained
        .iter()
        .any(|s| selected[&s.index] != format!("{}{}", s.prefix, s.contents));
    let first_attachment = first_user.and_then(|s| s.message.attachments.first());
    let recent: Vec<&Attachment> = retained
        .iter()
        .flat_map(|s| s.message.attachments)
        .filter(|a| first_attachment.is_none_or(|first| a.id() != first.id()))
        .collect();
    let keep = if first_attachment.is_some() { 3 } else { 4 };
    let mut attachments: Vec<&Attachment> = first_attachment.into_iter().collect();
    attachments.extend(&recent[recent.len().saturating_sub(keep)..]);
    TitleContext {
        message: format!(
            "{}{}",
            if truncated || retained.len() < sections.len() {
                OMITTED
            } else {
                ""
            },
            retained
                .iter()
                .map(|s| selected[&s.index].as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
        ),
        attachments,
    }
}

fn preserve_message_end(message: &str) -> String {
    let already = message.strip_prefix(OMITTED);
    let contents = already.unwrap_or(message);
    if already.is_none() && chars(contents) <= 8_000 {
        return contents.into();
    }
    format!("{OMITTED}{}", tail(contents, 8_000))
}

fn limit_section(input: &str, limit: usize) -> String {
    if chars(input) <= limit {
        return input.into();
    }
    format!("{}\n\n[truncated]", head(input, limit))
}

pub(crate) fn regenerate_prompt(previous_title: &str, context: &TitleContext) -> String {
    let previous = serde_json::to_string(previous_title).unwrap_or_default();
    let mut prompt = format!(
        r#"Regenerate the title for an existing Bot Code thread so the user can recognize it weeks later.
The previous title was {previous}.
Return JSON with keys title and needsRefinement. Set needsRefinement to false.

Determine the title in this order:
1. Read the USER messages first. Identify the latest explicit durable goal. The original subject remains the subject until the user clearly changes what the thread is about.
2. Use ASSISTANT messages to resolve vague links, unnamed code, and discovered product nouns. Do not promote one assistant finding into the thread subject unless the user adopts it as a new goal.
3. Compare that subject with the previous title. Preserve accurate scope words, especially when earlier content is truncated. Replace the previous title when it is generic, artifact-based, a completion update, or contradicted by the thread.
4. Title the durable subject and desired outcome, not the current workflow state.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Preserve the umbrella subject when later messages focus on one finding, provider, platform, or implementation detail.
- A thread progressing through research, planning, implementation, review, CI, merge, and monitoring has usually not changed subjects.
- Ignore deliverables and operations such as mocks, plans, HTML, branches, PRs, tests, CI, commits, merging, and monitoring unless they are the actual topic.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- Treat final operational follow-ups and assistant completion summaries as weak evidence of subject.
- For reviews, name the reviewed feature or system and its durable concern, not one finding from the review.
- For research, name the question domain rather than the research process.
- Do not claim the work is complete.
- Do not copy and truncate a thread message.
- Avoid project names already visible in the UI, PR numbers, quotes, labels, filler, and trailing punctuation.
- Use attached images as primary context for UI issues.
- When a URL or attachment is the only source of the subject, use available tools to inspect it directly.
- Local git history is not evidence of what a linked PR or issue is about. Never title the thread after branch names, commit messages, or merged commits found in the checkout.
- If a linked PR or issue cannot be read, fall back to the user's stated action plus its number, such as "Take Over PR 8588". This is the one case where a PR or issue number belongs in the title.
- Keep the previous title unchanged if it is already accurate. Otherwise return a meaningfully improved title, not a cosmetic paraphrase.

Examples of the distinction:
- A subagent-monitoring review that finds a Codex roster bug remains "Review Subagent Monitoring Risks," not "Codex Roster Bug Review."
- A vague failing-test request later identified as a lazy thread-feed mismatch becomes "Fix Lazy Thread Feed Test," not "Prevent Mobile Feed Regressions."
- A QR-sharing overhaul that ends with CI and merge work remains about QR sharing, not the PR lifecycle.

Thread contents:
{}"#,
        preserve_message_end(&context.message)
    );
    let lines: Vec<String> = context
        .attachments
        .iter()
        .map(|a| {
            format!(
                "- {} ({}, {} bytes)",
                a.name(),
                a.mime_type(),
                a.size_bytes()
            )
        })
        .collect();
    if !lines.is_empty() {
        prompt.push_str("\n\nAttachment metadata:\n");
        prompt.push_str(&limit_section(&lines.join("\n"), 4_000));
    }
    prompt
}

#[derive(Deserialize)]
struct GeneratedTitle {
    title: String,
}

pub(crate) fn sanitize(raw: &str) -> Option<String> {
    let title = serde_json::from_str::<GeneratedTitle>(raw)
        .map(|generated| generated.title)
        .unwrap_or_else(|_| raw.into());
    let first = title.trim().lines().next().unwrap_or_default().trim();
    let unquoted = first.trim_matches(|c| matches!(c, '\'' | '"' | '`')).trim();
    let normalized = unquoted.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() || normalized == DEFAULT_THREAD_TITLE {
        return None;
    }
    if chars(&normalized) <= MAX_THREAD_TITLE_CHARS {
        return Some(normalized);
    }
    Some(format!(
        "{}...",
        head(&normalized, MAX_THREAD_TITLE_CHARS - 3).trim_end()
    ))
}

pub(crate) async fn regenerate(
    binary: &Path,
    model: &crate::settings::ModelSelection,
    prompt: &str,
    mut cancel: watch::Receiver<bool>,
    limit: Duration,
) -> Result<Option<String>> {
    let output =
        crate::text_generation::generate(binary, model, prompt, SCHEMA, &mut cancel, limit).await?;
    let generated: GeneratedTitle = serde_json::from_str(&output)
        .map_err(|_| AppError::new("title_output", "Invalid title response."))?;
    Ok(sanitize(&generated.title))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_messages_keep_their_start_and_end() {
        let text = format!("{}{}", "a".repeat(50), "b".repeat(50));
        let limited = limit_title_message(&text, 21 + 40);
        assert_eq!(
            limited,
            format!("{}{TRUNCATED}{}", "a".repeat(20), "b".repeat(20))
        );
        assert_eq!(limit_title_message("short", 100), "short");
        assert_eq!(limit_title_message(&text, 5), "");
    }

    #[test]
    fn sanitize_unwraps_quotes_lines_and_the_default_title() {
        assert_eq!(sanitize("  \"Fix  login\"\nmore"), Some("Fix login".into()));
        assert_eq!(sanitize(r#"{"title":"Nested"}"#), Some("Nested".into()));
        assert_eq!(sanitize("New thread"), None);
        assert_eq!(sanitize("   "), None);
        let long = sanitize(&"x".repeat(200)).unwrap();
        assert_eq!(long.chars().count(), 120);
        assert!(long.ends_with("..."));
    }
}
