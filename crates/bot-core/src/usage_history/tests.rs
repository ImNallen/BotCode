use super::*;
use serde_json::{Value, json};
use std::fs;

fn ms(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .timestamp_millis()
}
fn line(value: Value) -> String {
    format!("{value}\n")
}
fn meta(id: &str, timestamp: &str) -> String {
    line(json!({"type":"session_meta","timestamp":timestamp,"payload":{"id":id}}))
}
fn context(model: &str) -> String {
    line(json!({"type":"turn_context","payload":{"model":model}}))
}
fn usage(
    timestamp: &str,
    input: u64,
    cached: u64,
    creation: u64,
    output: u64,
    reasoning: u64,
) -> String {
    line(
        json!({"type":"event_msg","timestamp":timestamp,"payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":input,"cached_input_tokens":cached,"cache_write_input_tokens":creation,"output_tokens":output,"reasoning_output_tokens":reasoning}}}}),
    )
}
fn rates() -> pricing::RateTable {
    pricing::parse_rates(
        &json!({"model-a":{"input_cost_per_token":0.000002,"output_cost_per_token":0.000008,"cache_read_input_token_cost":0.0000005,"cache_creation_input_token_cost":0.000003},"model-b":{"input_cost_per_token":0.000002,"output_cost_per_token":0.000008,"cache_read_input_token_cost":0.0000005,"cache_creation_input_token_cost":0.000003}}),
    )
}
fn fixture() -> (tempfile::TempDir, tempfile::TempDir, PathBuf, i64) {
    let home = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    fs::create_dir(home.path().join("sessions")).unwrap();
    fs::create_dir(home.path().join("archived_sessions")).unwrap();
    let path = home.path().join("sessions/external.jsonl");
    let transcript = meta("external-session", "2026-10-07T09:00:00Z")
        + &context("model-a")
        + &usage("2026-10-07T09:00:00Z", 1000, 200, 0, 100, 40)
        + &usage("2026-10-08T09:00:00Z", 2000, 500, 0, 200, 50)
        + &context("model-b")
        + &usage("2026-10-08T09:01:00Z", 500, 100, 50, 50, 20)
        + &context("unknown-model")
        + &usage("2026-10-08T09:02:00Z", 100, 0, 0, 10, 0);
    fs::write(&path, transcript).unwrap();
    (home, data, path, ms("2026-10-08T12:00:00Z"))
}
fn report(
    home: &std::path::Path,
    data: &std::path::Path,
    now: i64,
    period: UsagePeriod,
    zone: Tz,
) -> UsageHistoryReport {
    let (records, coverage) = scan::read(home, data, now);
    aggregate(
        records,
        Window::new(period, zone, now).unwrap(),
        zone,
        now,
        rates(),
        coverage,
    )
}
fn close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-12, "{actual} != {expected}");
}
#[test]
fn external_transcripts_have_disjoint_exact_totals_prices_models_and_dates() {
    let (home, data, _, now) = fixture();
    let result = report(
        home.path(),
        data.path(),
        now,
        UsagePeriod::SevenDays,
        chrono_tz::Europe::Stockholm,
    );
    assert_eq!(
        result.totals.tokens,
        TokenTotals {
            uncached_input: 2750,
            cached_input: 800,
            cache_creation: 50,
            output: 360,
            reasoning: 110
        }
    );
    assert_eq!(result.totals.tokens.total(), 3960);
    assert_eq!(result.totals.records, 4);
    assert_eq!(result.totals.sessions, 1);
    assert_eq!(result.totals.unpriced_records, 1);
    assert_eq!(result.totals.unpriced_tokens, 110);
    close(result.totals.estimated_cost_usd, 0.00865);
    let a = result.models.iter().find(|m| m.model == "model-a").unwrap();
    assert_eq!(a.totals.tokens.total(), 3300);
    close(a.totals.estimated_cost_usd, 0.00735);
    assert_eq!(result.buckets.len(), 7);
    let today = result.buckets.last().unwrap();
    assert_eq!(today.totals.tokens.total(), 2860);
    close(today.totals.estimated_cost_usd, 0.00615);
    assert_eq!(
        result
            .buckets
            .iter()
            .map(|b| b.totals.tokens.total())
            .sum::<u64>(),
        3960
    );
    let hourly = report(
        home.path(),
        data.path(),
        now,
        UsagePeriod::Past24Hours,
        chrono_tz::Europe::Stockholm,
    );
    assert_eq!(hourly.buckets.len(), 24);
    assert_eq!(hourly.totals.tokens.total(), 2860);
    assert_eq!(hourly.coverage.reused_files, 1);
}
#[test]
fn duplicates_archive_copies_and_repeated_metadata_do_not_double_count() {
    let (home, data, path, now) = fixture();
    let original = fs::read_to_string(&path).unwrap();
    let duplicate = usage("2026-10-07T09:00:00Z", 1000, 200, 0, 100, 40);
    fs::write(
        &path,
        original.replacen(&duplicate, &(duplicate.clone() + &duplicate), 1),
    )
    .unwrap();
    fs::copy(&path, home.path().join("archived_sessions/copied.jsonl")).unwrap();
    let result = report(
        home.path(),
        data.path(),
        now,
        UsagePeriod::SevenDays,
        chrono_tz::UTC,
    );
    assert_eq!(result.totals.tokens.total(), 3960);
    assert_eq!(result.totals.sessions, 1);
    assert_eq!(result.coverage.suppressed_duplicates, 6);
    let mut parser = parser::Parser::new("fallback".into());
    parser.line(meta("child", "2026-10-08T09:00:00Z").as_bytes());
    parser.line(meta("parent", "2026-10-07T09:00:00Z").as_bytes());
    parser.line(context("model-a").as_bytes());
    let record = parser
        .line(usage("2026-10-08T09:00:10Z", 10, 0, 0, 1, 0).as_bytes())
        .unwrap();
    assert_eq!(record.session_id, "child");
}
#[test]
fn copied_prefix_does_not_shift_identity_of_later_continuation_events() {
    let (home, data, path, now) = fixture();
    let original = fs::read_to_string(&path).unwrap();
    fs::write(
        home.path().join("archived_sessions/prefix.jsonl"),
        &original,
    )
    .unwrap();
    let extra = usage("2026-10-08T09:03:00Z", 120, 0, 0, 12, 0);
    fs::write(&path, original + &extra).unwrap();
    let result = report(
        home.path(),
        data.path(),
        now,
        UsagePeriod::SevenDays,
        chrono_tz::UTC,
    );
    assert_eq!(result.totals.tokens.total(), 4092);
    assert_eq!(result.totals.records, 5);
}
#[test]
fn fork_opening_burst_is_suppressed_but_later_child_turn_is_counted() {
    for source in [
        json!({"forked_from_id":"parent"}),
        json!({"source":{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}}),
    ] {
        let mut payload = source;
        payload["id"] = json!("child");
        let mut parser = parser::Parser::new("fallback".into());
        parser.line(
            line(
                json!({"type":"session_meta","timestamp":"2026-10-08T09:00:00Z","payload":payload}),
            )
            .as_bytes(),
        );
        parser.line(meta("parent", "2026-10-07T09:00:00Z").as_bytes());
        parser.line(context("model-a").as_bytes());
        assert!(
            parser
                .line(usage("2026-10-08T09:00:00.040Z", 1000, 200, 0, 100, 40).as_bytes())
                .is_none()
        );
        assert!(
            parser
                .line(usage("2026-10-08T09:00:00.060Z", 2000, 500, 0, 200, 50).as_bytes())
                .is_none()
        );
        let child = parser
            .line(usage("2026-10-08T09:00:05Z", 10, 0, 0, 1, 0).as_bytes())
            .unwrap();
        assert_eq!(child.session_id, "child");
        assert_eq!(child.tokens.total(), 11);
        assert_eq!(parser.diagnostics.fork_copies, 2);
    }
}
#[test]
fn missing_model_does_not_consume_signature_and_malformed_counters_are_rejected() {
    let mut parser = parser::Parser::new("session".into());
    let event = usage("2026-10-08T09:00:00Z", 100, 20, 0, 10, 20);
    assert!(parser.line(event.as_bytes()).is_none());
    parser.line(context("model-a").as_bytes());
    let record = parser.line(event.as_bytes()).unwrap();
    assert_eq!(record.tokens.reasoning, 10);
    assert!(parser.line(event.as_bytes()).is_none());
    for bad in [json!(-1), json!(1.5), json!("100"), json!(u64::MAX)] {
        let mut value: Value = serde_json::from_str(&event).unwrap();
        value["payload"]["info"]["last_token_usage"]["input_tokens"] = bad;
        assert!(parser.line(line(value).as_bytes()).is_none());
    }
    assert!(parser.line(b"{broken token_count").is_none());
    assert_eq!(parser.diagnostics.malformed, 6);
    assert_eq!(parser.diagnostics.duplicates, 1);
    parser.line(context("model-b").as_bytes());
    let switched = parser
        .line(usage("2026-10-08T09:01:00Z", 80, 100, 10, 5, 20).as_bytes())
        .unwrap();
    assert_eq!(switched.model, "model-b");
    assert_eq!(switched.tokens.uncached_input, 0);
    assert_eq!(switched.tokens.reasoning, 5);
}
#[test]
fn append_rewrite_removal_and_corrupt_cache_recover_without_duplicating_history() {
    let (home, data, path, now) = fixture();
    assert_eq!(
        report(
            home.path(),
            data.path(),
            now,
            UsagePeriod::SevenDays,
            chrono_tz::UTC
        )
        .totals
        .tokens
        .total(),
        3960
    );
    let original = fs::read_to_string(&path).unwrap();
    fs::write(
        &path,
        original + &usage("2026-10-08T10:00:00Z", 10, 0, 0, 1, 0),
    )
    .unwrap();
    let appended = report(
        home.path(),
        data.path(),
        now,
        UsagePeriod::SevenDays,
        chrono_tz::UTC,
    );
    assert_eq!(appended.totals.tokens.total(), 3971);
    assert_eq!(appended.coverage.scanned_files, 1);
    fs::write(
        &path,
        meta("replacement", "2026-10-08T09:00:00Z")
            + &context("model-a")
            + &usage("2026-10-08T10:00:00Z", 50, 0, 0, 5, 0),
    )
    .unwrap();
    assert_eq!(
        report(
            home.path(),
            data.path(),
            now,
            UsagePeriod::SevenDays,
            chrono_tz::UTC
        )
        .totals
        .tokens
        .total(),
        55
    );
    fs::remove_file(&path).unwrap();
    let removed = report(
        home.path(),
        data.path(),
        now,
        UsagePeriod::SevenDays,
        chrono_tz::UTC,
    );
    assert_eq!(removed.totals.tokens.total(), 55);
    assert_eq!(removed.coverage.retained_records, 1);
    assert!(removed.coverage.partial);
    assert_eq!(
        report(
            home.path(),
            data.path(),
            now + RETENTION_MS + 1,
            UsagePeriod::NinetyDays,
            chrono_tz::UTC
        )
        .totals
        .tokens
        .total(),
        0
    );
    fs::write(data.path().join("usage-scan-cache.json"), "bad cache").unwrap();
    let cold = report(
        home.path(),
        data.path(),
        now,
        UsagePeriod::SevenDays,
        chrono_tz::UTC,
    );
    assert_eq!(cold.totals.tokens.total(), 0);
    assert!(cold.coverage.messages.iter().any(|m| m.contains("Rebuilt")));
}
#[test]
fn cache_is_isolated_by_codex_home_and_bad_numeric_cache_is_a_cold_scan() {
    let (home, data, _, now) = fixture();
    report(
        home.path(),
        data.path(),
        now,
        UsagePeriod::SevenDays,
        chrono_tz::UTC,
    );
    let other = tempfile::tempdir().unwrap();
    let empty = report(
        other.path(),
        data.path(),
        now,
        UsagePeriod::SevenDays,
        chrono_tz::UTC,
    );
    assert_eq!(empty.totals.tokens.total(), 0);
    assert_eq!(empty.coverage.sources[0].status, SourceStatus::Missing);
    report(
        home.path(),
        data.path(),
        now,
        UsagePeriod::SevenDays,
        chrono_tz::UTC,
    );
    let cache_path = data.path().join("usage-scan-cache.json");
    let mut cache: Value = serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
    let file = cache["files"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    file["records"][0]["tokens"]["output"] = json!(u64::MAX);
    fs::write(&cache_path, cache.to_string()).unwrap();
    assert_eq!(
        report(
            home.path(),
            data.path(),
            now,
            UsagePeriod::SevenDays,
            chrono_tz::UTC
        )
        .totals
        .tokens
        .total(),
        3960
    );
}
#[test]
fn calendar_windows_handle_midnight_future_records_and_both_dst_transitions() {
    for (now, transition, hours) in [
        ("2026-03-31T12:00:00Z", "2026-03-29", 23),
        ("2026-10-27T12:00:00Z", "2026-10-25", 25),
    ] {
        let window = Window::new(
            UsagePeriod::SevenDays,
            chrono_tz::Europe::Stockholm,
            ms(now),
        )
        .unwrap();
        let date = NaiveDate::parse_from_str(transition, "%Y-%m-%d").unwrap();
        let start = first_instant_of_local_date(date, chrono_tz::Europe::Stockholm).unwrap();
        let bucket = window.buckets.iter().find(|b| b.start_ms == start).unwrap();
        assert_eq!(bucket.end_ms - bucket.start_ms, hours * 3_600_000);
        assert!(
            window
                .buckets
                .windows(2)
                .all(|b| b[0].end_ms == b[1].start_ms)
        );
    }
    let (home, data, path, now) = fixture();
    let first = Window::new(UsagePeriod::SevenDays, chrono_tz::UTC, now)
        .unwrap()
        .start_ms;
    let instant = |ms| {
        DateTime::<Utc>::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339()
    };
    fs::write(
        &path,
        meta("boundary", "2026-10-01T00:00:00Z")
            + &context("model-a")
            + &usage(&instant(first - 1), 10, 0, 0, 1, 0)
            + &usage(&instant(first), 20, 0, 0, 2, 0)
            + &usage(&instant(now), 30, 0, 0, 3, 0)
            + &usage(&instant(now + 1), 40, 0, 0, 4, 0),
    )
    .unwrap();
    let result = report(
        home.path(),
        data.path(),
        now,
        UsagePeriod::SevenDays,
        chrono_tz::UTC,
    );
    assert_eq!(result.totals.tokens.total(), 22);
    for period in [UsagePeriod::ThirtyDays, UsagePeriod::NinetyDays] {
        let window = Window::new(period, chrono_tz::UTC, now).unwrap();
        assert_eq!(
            window.buckets.len(),
            if matches!(period, UsagePeriod::ThirtyDays) {
                30
            } else {
                90
            }
        );
    }
}
#[tokio::test]
async fn invalid_zone_is_rejected_at_the_reader_boundary() {
    let home = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let reader = UsageHistory::new(home.path().into(), data.path().into());
    let error = reader
        .read(UsageHistoryRequest {
            period: UsagePeriod::SevenDays,
            time_zone: "not-a-zone".into(),
            refresh: false,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "invalid_usage_zone");
}
