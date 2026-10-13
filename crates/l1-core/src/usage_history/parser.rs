use super::{TokenTotals, UsageRecord};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub(super) const MAX_COUNTER: u64 = 1_000_000_000;
const FORK_COPY_MAX_GAP_MS: i64 = 1_000;
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Diagnostics {
    pub malformed: u64,
    pub duplicates: u64,
    pub fork_copies: u64,
}
pub(super) struct Parser {
    model: String,
    session_id: String,
    saw_meta: bool,
    last_signature: Option<String>,
    fork_anchor: Option<i64>,
    occurrences: HashMap<String, u64>,
    pub diagnostics: Diagnostics,
}
impl Parser {
    pub fn new(fallback_id: String) -> Self {
        Self {
            model: String::new(),
            session_id: fallback_id,
            saw_meta: false,
            last_signature: None,
            fork_anchor: None,
            occurrences: HashMap::new(),
            diagnostics: Diagnostics::default(),
        }
    }
    pub fn line(&mut self, line: &[u8]) -> Option<UsageRecord> {
        let relevant = [
            b"token_count".as_slice(),
            b"turn_context".as_slice(),
            b"session_meta".as_slice(),
        ]
        .iter()
        .any(|needle| line.windows(needle.len()).any(|p| p == *needle));
        if !relevant {
            return None;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            self.diagnostics.malformed += 1;
            return None;
        };
        let Some(payload) = value.get("payload").and_then(Value::as_object) else {
            self.diagnostics.malformed += 1;
            return None;
        };
        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis());
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            if self.saw_meta {
                return None;
            }
            self.saw_meta = true;
            if let Some(id) = payload
                .get("id")
                .or_else(|| payload.get("session_id"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 256)
            {
                self.session_id = id.into();
            } else {
                self.diagnostics.malformed += 1;
            }
            let fork = payload.get("forked_from_id").is_some_and(Value::is_string)
                || payload
                    .get("source")
                    .and_then(|s| s.pointer("/subagent/thread_spawn/parent_thread_id"))
                    .is_some_and(Value::is_string);
            if fork {
                self.fork_anchor = timestamp;
            }
            return None;
        }
        if value.get("type").and_then(Value::as_str) == Some("turn_context") {
            if let Some(model) = payload
                .get("model")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty() && s.len() <= 256)
            {
                self.model = model.into();
            } else {
                self.diagnostics.malformed += 1;
            }
            return None;
        }
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            return None;
        }
        let Some(timestamp_ms) = timestamp else {
            self.diagnostics.malformed += 1;
            return None;
        };
        if self.model.is_empty() {
            self.diagnostics.malformed += 1;
            return None;
        }
        let Some(last) = payload
            .get("info")
            .and_then(|v| v.get("last_token_usage"))
            .and_then(Value::as_object)
        else {
            self.diagnostics.malformed += 1;
            return None;
        };
        let count = |key: &str, required: bool| match last.get(key) {
            None if !required => Some(0),
            value => value.and_then(Value::as_u64).filter(|n| *n <= MAX_COUNTER),
        };
        let Some((input, cached, creation, output, reasoning)) = count("input_tokens", true)
            .zip(count("cached_input_tokens", false))
            .zip(count("cache_write_input_tokens", false))
            .zip(count("output_tokens", true))
            .zip(count("reasoning_output_tokens", false))
            .map(|((((i, c), w), o), r)| (i, c, w, o, r))
        else {
            self.diagnostics.malformed += 1;
            return None;
        };
        let signature = serde_json::to_string(last).ok()?;
        if self.last_signature.as_ref() == Some(&signature) {
            self.diagnostics.duplicates += 1;
            return None;
        }
        self.last_signature = Some(signature.clone());
        // Codex copies fork history in a restamped opening burst. The observed T3 threshold is one second.
        if let Some(anchor) = self.fork_anchor {
            if timestamp_ms - anchor < FORK_COPY_MAX_GAP_MS {
                self.fork_anchor = Some(timestamp_ms);
                self.diagnostics.fork_copies += 1;
                return None;
            }
            self.fork_anchor = None;
        }
        let tokens = TokenTotals {
            uncached_input: input.saturating_sub(cached + creation),
            cached_input: cached,
            cache_creation: creation,
            output,
            reasoning: reasoning.min(output),
        };
        if tokens.total() == 0 {
            return None;
        }
        let event_key = format!(
            "{:x}",
            Sha256::digest(format!("{timestamp_ms}\0{}\0{signature}", self.model).as_bytes())
        );
        let occurrence = self.occurrences.entry(event_key.clone()).or_default();
        let record = UsageRecord {
            timestamp_ms,
            session_id: self.session_id.clone(),
            model: self.model.clone(),
            tokens,
            event_key,
            occurrence: *occurrence,
        };
        *occurrence += 1;
        Some(record)
    }
}
