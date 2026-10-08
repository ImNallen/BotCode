// Codex parsing, windowing and base-rate arithmetic follow T3 Code v0.0.45 usage modules (MIT).
mod parser;
mod pricing;
mod scan;
#[cfg(test)]
mod tests;

use crate::{AppError, Result};
use chrono::{DateTime, Days, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::{Arc, atomic::AtomicI64},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;

const DAY_MS: i64 = 86_400_000;
const RETENTION_MS: i64 = 90 * DAY_MS;
const MAX_RECORDS: usize = 250_000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsagePeriod {
    Past24Hours,
    SevenDays,
    ThirtyDays,
    NinetyDays,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageHistoryRequest {
    pub period: UsagePeriod,
    pub time_zone: String,
    pub refresh: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenTotals {
    pub uncached_input: u64,
    pub cached_input: u64,
    pub cache_creation: u64,
    pub output: u64,
    pub reasoning: u64,
}
impl TokenTotals {
    fn total(&self) -> u64 {
        self.uncached_input + self.cached_input + self.cache_creation + self.output
    }
    fn add(&mut self, other: &Self) {
        self.uncached_input += other.uncached_input;
        self.cached_input += other.cached_input;
        self.cache_creation += other.cache_creation;
        self.output += other.output;
        self.reasoning += other.reasoning;
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageRecord {
    timestamp_ms: i64,
    session_id: String,
    model: String,
    tokens: TokenTotals,
    event_key: String,
    occurrence: u64,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub tokens: TokenTotals,
    pub estimated_cost_usd: f64,
    pub records: u64,
    pub unpriced_records: u64,
    pub unpriced_tokens: u64,
    pub sessions: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub start_ms: i64,
    pub end_ms: i64,
    pub totals: UsageTotals,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub totals: UsageTotals,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceStatus {
    Ok,
    Missing,
    Partial,
    Failed,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSource {
    pub path: String,
    pub status: SourceStatus,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCoverage {
    pub home: String,
    pub sources: Vec<UsageSource>,
    pub scanned_files: u64,
    pub reused_files: u64,
    pub skipped_files: u64,
    pub malformed_records: u64,
    pub suppressed_duplicates: u64,
    pub suppressed_fork_copies: u64,
    pub earliest_included_ms: Option<i64>,
    pub latest_included_ms: Option<i64>,
    pub retained_records: u64,
    pub partial: bool,
    pub messages: Vec<String>,
    pub pricing: pricing::PricingStatus,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistoryReport {
    pub generated_at_ms: i64,
    pub time_zone: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub totals: UsageTotals,
    pub buckets: Vec<UsageBucket>,
    pub models: Vec<ModelUsage>,
    pub coverage: UsageCoverage,
}
#[derive(Clone)]
pub(crate) struct UsageHistory {
    home: PathBuf,
    data_dir: PathBuf,
    slot: Arc<Semaphore>,
    last_rate_attempt: Arc<AtomicI64>,
}
impl UsageHistory {
    pub(crate) fn from_environment(data_dir: PathBuf) -> Self {
        let home = std::env::var_os("CODEX_HOME")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::home_dir().unwrap_or_default().join(".codex"));
        Self::new(home, data_dir)
    }
    fn new(home: PathBuf, data_dir: PathBuf) -> Self {
        let home = dunce::canonicalize(&home).unwrap_or_else(|_| {
            if home.is_absolute() {
                home
            } else {
                std::env::current_dir().unwrap_or_default().join(home)
            }
        });
        Self {
            home,
            data_dir,
            slot: Arc::new(Semaphore::new(1)),
            last_rate_attempt: Arc::new(AtomicI64::new(0)),
        }
    }
    pub(crate) async fn read(&self, request: UsageHistoryRequest) -> Result<UsageHistoryReport> {
        let zone: Tz = request.time_zone.parse().map_err(|_| {
            AppError::new(
                "invalid_usage_zone",
                "Usage requires a valid IANA time zone.",
            )
        })?;
        let permit = self
            .slot
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| AppError::new("usage_history", e))?;
        let reader = self.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let now = now_ms();
            let window = Window::new(request.period, zone, now)?;
            let (records, mut coverage) = scan::read(&reader.home, &reader.data_dir, now);
            let (rates, status) = pricing::read_rates(
                &reader.data_dir,
                now,
                request.refresh,
                &reader.last_rate_attempt,
            );
            coverage.pricing = status;
            Ok(aggregate(records, window, zone, now, rates, coverage))
        })
        .await
        .map_err(|e| AppError::new("usage_history", e))?
    }
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
struct Window {
    start_ms: i64,
    end_ms: i64,
    buckets: Vec<UsageBucket>,
}
fn first_instant_of_local_date(date: NaiveDate, zone: Tz) -> Result<i64> {
    let midnight = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| AppError::new("usage_window", "Invalid local day."))?;
    for minute in 0..=24 * 60 {
        if let Some(dt) = zone
            .from_local_datetime(&(midnight + Duration::minutes(minute)))
            .earliest()
        {
            return Ok(dt.timestamp_millis());
        }
    }
    Err(AppError::new(
        "usage_window",
        "No valid instant for the local day.",
    ))
}
impl Window {
    fn new(period: UsagePeriod, zone: Tz, now: i64) -> Result<Self> {
        if matches!(period, UsagePeriod::Past24Hours) {
            let start = now - DAY_MS;
            return Ok(Self {
                start_ms: start,
                end_ms: now,
                buckets: (0..24)
                    .map(|i| UsageBucket {
                        start_ms: start + i * 3_600_000,
                        end_ms: start + (i + 1) * 3_600_000,
                        totals: UsageTotals::default(),
                    })
                    .collect(),
            });
        }
        let days = match period {
            UsagePeriod::SevenDays => 7,
            UsagePeriod::ThirtyDays => 30,
            UsagePeriod::NinetyDays => 90,
            UsagePeriod::Past24Hours => unreachable!(),
        };
        let today = DateTime::<Utc>::from_timestamp_millis(now)
            .ok_or_else(|| AppError::new("usage_window", "Invalid current time."))?
            .with_timezone(&zone)
            .date_naive();
        let first = today
            .checked_sub_days(Days::new(days - 1))
            .ok_or_else(|| AppError::new("usage_window", "Usage window exceeds date range."))?;
        let mut buckets = Vec::new();
        for i in 0..days {
            let date = first
                .checked_add_days(Days::new(i))
                .ok_or_else(|| AppError::new("usage_window", "Invalid usage date."))?;
            let next = date
                .checked_add_days(Days::new(1))
                .ok_or_else(|| AppError::new("usage_window", "Invalid usage date."))?;
            buckets.push(UsageBucket {
                start_ms: first_instant_of_local_date(date, zone)?,
                end_ms: first_instant_of_local_date(next, zone)?.min(now),
                totals: UsageTotals::default(),
            });
        }
        Ok(Self {
            start_ms: first_instant_of_local_date(first, zone)?,
            end_ms: now,
            buckets,
        })
    }
}
fn accumulate(
    totals: &mut UsageTotals,
    sessions: &mut HashSet<String>,
    record: &UsageRecord,
    rates: &pricing::RateTable,
) {
    totals.tokens.add(&record.tokens);
    totals.records += 1;
    sessions.insert(record.session_id.clone());
    totals.sessions = sessions.len() as u64;
    match pricing::price(rates, record) {
        Some(cost) => totals.estimated_cost_usd += cost,
        None => {
            totals.unpriced_records += 1;
            totals.unpriced_tokens += record.tokens.total();
        }
    }
}
fn aggregate(
    records: Vec<UsageRecord>,
    mut window: Window,
    zone: Tz,
    now: i64,
    rates: pricing::RateTable,
    mut coverage: UsageCoverage,
) -> UsageHistoryReport {
    let mut totals = UsageTotals::default();
    let mut sessions = HashSet::new();
    let mut bucket_sessions = vec![HashSet::new(); window.buckets.len()];
    let mut models: BTreeMap<String, (UsageTotals, HashSet<String>)> = BTreeMap::new();
    for record in records
        .into_iter()
        .filter(|r| r.timestamp_ms >= window.start_ms && r.timestamp_ms < window.end_ms)
    {
        coverage.earliest_included_ms = Some(
            coverage
                .earliest_included_ms
                .map_or(record.timestamp_ms, |v| v.min(record.timestamp_ms)),
        );
        coverage.latest_included_ms = Some(
            coverage
                .latest_included_ms
                .map_or(record.timestamp_ms, |v| v.max(record.timestamp_ms)),
        );
        accumulate(&mut totals, &mut sessions, &record, &rates);
        let (model_totals, model_sessions) = models.entry(record.model.clone()).or_default();
        accumulate(model_totals, model_sessions, &record, &rates);
        if let Some((i, bucket)) = window
            .buckets
            .iter_mut()
            .enumerate()
            .find(|(_, b)| record.timestamp_ms >= b.start_ms && record.timestamp_ms < b.end_ms)
        {
            accumulate(&mut bucket.totals, &mut bucket_sessions[i], &record, &rates);
        }
    }
    UsageHistoryReport {
        generated_at_ms: now,
        time_zone: zone.name().into(),
        start_ms: window.start_ms,
        end_ms: window.end_ms,
        totals,
        buckets: window.buckets,
        models: models
            .into_iter()
            .map(|(model, (totals, _))| ModelUsage { model, totals })
            .collect(),
        coverage,
    }
}
