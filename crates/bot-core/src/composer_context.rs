// Ported from T3 Code v0.0.45 packages/contracts/src/composerContext.ts and assistantCitations.ts.
use crate::domain::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const COMPOSER_CONTEXT_MAX_RECORDS: usize = 200;
const MAX_SERIALIZED_BYTES: usize = 16_000_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerContextBase {
    pub version: u8,
    pub context_id: String,
    pub label: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestContextState {
    Open,
    Closed,
    Merged,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestContextMetadata {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub head_branch: String,
    pub base_branch: String,
    pub state: PullRequestContextState,
    pub is_draft: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ComposerContextRecord {
    Image {
        #[serde(flatten)]
        base: ComposerContextBase,
        attachment_id: String,
        name: String,
        mime_type: String,
        size_bytes: u64,
    },
    File {
        #[serde(flatten)]
        base: ComposerContextBase,
        attachment_id: String,
        name: String,
        mime_type: String,
        size_bytes: u64,
    },
    Terminal {
        #[serde(flatten)]
        base: ComposerContextBase,
        terminal_id: String,
        terminal_label: String,
        line_start: u64,
        line_end: u64,
        text: String,
    },
    ReviewComment {
        #[serde(flatten)]
        base: ComposerContextBase,
        section_id: String,
        section_title: String,
        file_path: String,
        start_index: u64,
        end_index: u64,
        range_label: String,
        text: String,
        diff: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fence_language: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pull_request: Option<PullRequestContextMetadata>,
    },
    Mention {
        #[serde(flatten)]
        base: ComposerContextBase,
        path: String,
    },
    Skill {
        #[serde(flatten)]
        base: ComposerContextBase,
        name: String,
    },
    Citation {
        #[serde(flatten)]
        base: ComposerContextBase,
        environment_id: String,
        thread_id: String,
        message_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        comment: Option<String>,
        start: u64,
        end: u64,
        prefix: String,
        suffix: String,
    },
}
impl ComposerContextRecord {
    pub fn base(&self) -> &ComposerContextBase {
        match self {
            Self::Image { base, .. }
            | Self::File { base, .. }
            | Self::Terminal { base, .. }
            | Self::ReviewComment { base, .. }
            | Self::Mention { base, .. }
            | Self::Skill { base, .. }
            | Self::Citation { base, .. } => base,
        }
    }
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Image { .. } => "image",
            Self::File { .. } => "file",
            Self::Terminal { .. } => "terminal",
            Self::ReviewComment { .. } => "review-comment",
            Self::Mention { .. } => "mention",
            Self::Skill { .. } => "skill",
            Self::Citation { .. } => "citation",
        }
    }
    fn valid(&self) -> bool {
        let base = self.base();
        if base.version != 1 || !context_id(&base.context_id) || !bounded(&base.label, 200) {
            return false;
        }
        match self {
            Self::Image {
                attachment_id,
                name,
                mime_type,
                size_bytes,
                ..
            }
            | Self::File {
                attachment_id,
                name,
                mime_type,
                size_bytes,
                ..
            } => {
                context_id(attachment_id)
                    && short(name, 255)
                    && short(mime_type, 100)
                    && *size_bytes <= MAX_SAFE_INTEGER
            }
            Self::Terminal {
                terminal_id,
                terminal_label,
                line_start,
                line_end,
                text,
                ..
            } => {
                short(terminal_id, 255)
                    && short(terminal_label, 255)
                    && range(*line_start, *line_end)
                    && bounded(text, 64_000)
            }
            Self::ReviewComment {
                section_id,
                section_title,
                file_path,
                start_index,
                end_index,
                range_label,
                text,
                diff,
                fence_language,
                pull_request,
                ..
            } => {
                short(section_id, 255)
                    && bounded(section_title, 2_048)
                    && short(file_path, 2_048)
                    && range(*start_index, *end_index)
                    && bounded(range_label, 2_048)
                    && bounded(text, 16_000)
                    && bounded(diff, 32_000)
                    && fence_language.as_ref().is_none_or(|s| bounded(s, 64))
                    && pull_request
                        .as_ref()
                        .is_none_or(PullRequestContextMetadata::valid)
            }
            Self::Mention { path, .. } => short(path, 2_048),
            Self::Skill { name, .. } => short(name, 255),
            Self::Citation {
                environment_id,
                thread_id,
                message_id,
                text,
                comment,
                start,
                end,
                prefix,
                suffix,
                ..
            } => {
                short(environment_id, 512)
                    && short(thread_id, 512)
                    && short(message_id, 512)
                    && !text.trim().is_empty()
                    && bounded(text, 8_000)
                    && comment.as_ref().is_none_or(|s| bounded(s, 8_000))
                    && end > start
                    && range(*start, *end)
                    && bounded(prefix, 32)
                    && bounded(suffix, 32)
            }
        }
    }
}
impl PullRequestContextMetadata {
    pub(crate) fn valid(&self) -> bool {
        self.number > 0
            && self.number <= MAX_SAFE_INTEGER
            && [&self.title, &self.url, &self.head_branch, &self.base_branch]
                .iter()
                .all(|s| bounded(s, 2_048))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageContext {
    pub version: u8,
    pub records: Vec<ComposerContextRecord>,
}
pub type OrchestrationMessageContext = MessageContext;
impl MessageContext {
    pub fn validate(&self) -> Result<()> {
        let mut ids = HashSet::new();
        if self.version != 1
            || self.records.len() > COMPOSER_CONTEXT_MAX_RECORDS
            || self
                .records
                .iter()
                .any(|record| !record.valid() || !ids.insert(&record.base().context_id))
            || serde_json::to_string(self)?.encode_utf16().count() > MAX_SERIALIZED_BYTES
        {
            return Err(AppError::new(
                "invalid_context",
                "Composer context has invalid versions, IDs, ranges, or exceeds its size limits.",
            ));
        }
        Ok(())
    }
}
fn bounded(value: &str, max: usize) -> bool {
    value.encode_utf16().take(max + 1).count() <= max
}
fn short(value: &str, max: usize) -> bool {
    !value.is_empty() && value.trim() == value && bounded(value, max)
}
fn range(start: u64, end: u64) -> bool {
    start <= end && end <= MAX_SAFE_INTEGER
}
pub(crate) fn context_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
