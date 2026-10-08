use super::{UsageRecord, scan::atomic_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::Path,
    sync::atomic::{AtomicI64, Ordering},
    time::Duration,
};

pub(super) const SOURCE: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MAX_RATE_BYTES: u64 = 16 * 1024 * 1024;
const TTL_MS: i64 = 86_400_000;
#[derive(Clone, Debug)]
pub(super) struct Rate {
    input: f64,
    output: f64,
    cached: f64,
    creation: f64,
}
pub(super) type RateTable = BTreeMap<String, Rate>;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PricingState {
    Fresh,
    Cached,
    Stale,
    Unavailable,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingStatus {
    pub status: PricingState,
    pub version: Option<String>,
    pub source: &'static str,
    pub fetched_at_ms: Option<i64>,
    pub known_models: usize,
    pub message: Option<String>,
}
impl Default for PricingStatus {
    fn default() -> Self {
        Self {
            status: PricingState::Unavailable,
            version: None,
            source: SOURCE,
            fetched_at_ms: None,
            known_models: 0,
            message: None,
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RatesCache {
    version: u32,
    source: String,
    fetched_at_ms: i64,
    document: Value,
}
fn document_version(document: &Value) -> Option<String> {
    serde_json::to_vec(document)
        .ok()
        .map(|bytes| format!("sha256:{:x}", Sha256::digest(bytes)))
}
pub(super) fn parse_rates(document: &Value) -> RateTable {
    let mut table = BTreeMap::new();
    let Some(entries) = document.as_object() else {
        return table;
    };
    for (model, entry) in entries.iter().take(20_000) {
        let number = |key| {
            entry
                .get(key)
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0)
        };
        let Some(input) = number("input_cost_per_token") else {
            continue;
        };
        let Some(output) = number("output_cost_per_token") else {
            continue;
        };
        if model.trim().is_empty() || model.len() > 256 {
            continue;
        }
        table.insert(
            model.trim().to_lowercase(),
            Rate {
                input,
                output,
                cached: number("cache_read_input_token_cost").unwrap_or(input),
                creation: number("cache_creation_input_token_cost").unwrap_or(input),
            },
        );
    }
    table
}
pub(super) fn price(rates: &RateTable, record: &UsageRecord) -> Option<f64> {
    let rate = rates.get(&record.model.trim().to_lowercase())?;
    Some(
        record.tokens.uncached_input as f64 * rate.input
            + record.tokens.cached_input as f64 * rate.cached
            + record.tokens.cache_creation as f64 * rate.creation
            + record.tokens.output as f64 * rate.output,
    )
}
fn fetch() -> std::result::Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(SOURCE)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RATE_BYTES)
    {
        return Err("Price source exceeds the download limit.".into());
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_RATE_BYTES {
        return Err("Price source exceeds the download limit.".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
pub(super) fn read_rates(
    data_dir: &Path,
    now: i64,
    force: bool,
    last_attempt: &AtomicI64,
) -> (RateTable, PricingStatus) {
    load_rates(data_dir, now, force, last_attempt, fetch)
}
fn load_rates(
    data_dir: &Path,
    now: i64,
    force: bool,
    last_attempt: &AtomicI64,
    fetch: impl FnOnce() -> std::result::Result<Value, String>,
) -> (RateTable, PricingStatus) {
    let path = data_dir.join("usage-model-rates.json");
    let cached = super::scan::bounded_json::<RatesCache>(&path, MAX_RATE_BYTES)
        .ok()
        .filter(|c| {
            c.version == 1
                && c.source == SOURCE
                && c.fetched_at_ms > 0
                && c.fetched_at_ms <= now + 60_000
        });
    let mut table = cached
        .as_ref()
        .map(|c| parse_rates(&c.document))
        .unwrap_or_default();
    let mut status = PricingStatus {
        status: if table.is_empty() {
            PricingState::Unavailable
        } else {
            PricingState::Cached
        },
        version: cached
            .as_ref()
            .filter(|_| !table.is_empty())
            .and_then(|c| document_version(&c.document)),
        fetched_at_ms: cached.as_ref().map(|c| c.fetched_at_ms),
        known_models: table.len(),
        ..PricingStatus::default()
    };
    let age = cached.as_ref().map(|c| now.saturating_sub(c.fetched_at_ms));
    if !table.is_empty() && age.is_some_and(|n| n < if force { 60_000 } else { TTL_MS }) {
        return (table, status);
    }
    if !table.is_empty() {
        status.status = PricingState::Stale;
    }
    if now.saturating_sub(last_attempt.load(Ordering::Relaxed)) < 60_000 {
        return (table, status);
    }
    last_attempt.store(now, Ordering::Relaxed);
    match fetch() {
        Ok(document) => {
            let fetched = parse_rates(&document);
            if fetched.is_empty() {
                status.message = Some(
                    "Price source contained no usable model rates. Cached rates remain available."
                        .into(),
                );
            } else {
                table = fetched;
                status.status = PricingState::Fresh;
                status.version = document_version(&document);
                status.fetched_at_ms = Some(now);
                status.known_models = table.len();
                let cache = RatesCache {
                    version: 1,
                    source: SOURCE.into(),
                    fetched_at_ms: now,
                    document,
                };
                if let Err(error) = atomic_json(&path, &cache) {
                    status.message = Some(format!("Could not save price cache. {error}"));
                }
            }
        }
        Err(error) => status.message = Some(format!("Could not refresh API rates. {error}")),
    }
    (table, status)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn cached_table_skips_network_and_stale_rates_survive_failure() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_800_000_000_000;
        let cache = RatesCache {
            version: 1,
            source: SOURCE.into(),
            fetched_at_ms: now,
            document: json!({"test-model":{"input_cost_per_token":0.000002,"output_cost_per_token":0.000008}}),
        };
        atomic_json(&dir.path().join("usage-model-rates.json"), &cache).unwrap();
        let attempt = AtomicI64::new(0);
        let (table, status) = load_rates(dir.path(), now, true, &attempt, || {
            panic!("fresh cache must not fetch")
        });
        assert_eq!(table.len(), 1);
        assert_eq!(status.status, PricingState::Cached);
        let (table, status) = load_rates(dir.path(), now + TTL_MS + 1, false, &attempt, || {
            Err("offline".into())
        });
        assert_eq!(table.len(), 1);
        assert_eq!(status.status, PricingState::Stale);
        assert!(status.message.unwrap().contains("offline"));
        let (_, status) = load_rates(dir.path(), now + TTL_MS + 2, true, &attempt, || {
            panic!("failed fetch has a cooldown")
        });
        assert_eq!(status.status, PricingState::Stale);
    }
    #[test]
    fn bad_rates_do_not_guess_aliases_or_accept_half_prices() {
        let table = parse_rates(
            &json!({"openai/a":{"input_cost_per_token":0.1,"output_cost_per_token":0.2},"negative":{"input_cost_per_token":-1,"output_cost_per_token":0.2},"half":{"input_cost_per_token":0.1}}),
        );
        assert_eq!(table.len(), 1);
        assert!(!table.contains_key("a"));
    }
}
