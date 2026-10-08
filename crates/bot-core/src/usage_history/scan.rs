use super::{
    MAX_RECORDS, RETENTION_MS, SourceStatus, UsageCoverage, UsageRecord, UsageSource,
    parser::{Diagnostics, MAX_COUNTER, Parser},
    pricing::PricingStatus,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_FILES: usize = 10_000;
const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: usize = 12;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SCAN_BYTES: u64 = 512 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 128 * 1024 * 1024;
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cache {
    version: u32,
    home: String,
    files: BTreeMap<String, CachedFile>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedFile {
    size: u64,
    modified_ns: u64,
    complete: bool,
    records: Vec<UsageRecord>,
    diagnostics: Diagnostics,
}
pub(super) fn bounded_json<T: DeserializeOwned>(path: &Path, limit: u64) -> io::Result<T> {
    let file = File::open(path)?;
    if file.metadata()?.len() > limit {
        return Err(io::Error::other("Cache exceeds its size limit."));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other("Cache exceeds its size limit."));
    }
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}
pub(super) fn atomic_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("No cache directory."))?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(temp.as_file_mut(), value).map_err(io::Error::other)?;
    temp.as_file_mut().flush()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
fn valid_cache(cache: &Cache, home: &str) -> bool {
    if cache.version != 1 || cache.home != home || cache.files.len() > MAX_FILES * 2 {
        return false;
    }
    let mut records = 0usize;
    for file in cache.files.values() {
        records = records.saturating_add(file.records.len());
        if records > MAX_RECORDS {
            return false;
        }
        if [
            file.diagnostics.malformed,
            file.diagnostics.duplicates,
            file.diagnostics.fork_copies,
        ]
        .iter()
        .any(|n| *n > MAX_SCAN_BYTES)
        {
            return false;
        }
        if file.records.iter().any(|r| {
            r.session_id.len() > 4096
                || r.session_id.is_empty()
                || r.model.len() > 256
                || r.model.is_empty()
                || r.event_key.len() != 64
                || r.occurrence > MAX_RECORDS as u64
                || [
                    r.tokens.uncached_input,
                    r.tokens.cached_input,
                    r.tokens.cache_creation,
                    r.tokens.output,
                    r.tokens.reasoning,
                ]
                .iter()
                .any(|n| *n > MAX_COUNTER)
                || r.tokens.reasoning > r.tokens.output
        }) {
            return false;
        }
    }
    true
}
fn discover(path: &Path, files: &mut Vec<PathBuf>, entries: &mut usize) -> SourceStatus {
    if !path.exists() {
        return SourceStatus::Missing;
    }
    let mut status = SourceStatus::Ok;
    let mut directories = vec![(path.to_path_buf(), 0)];
    while let Some((directory, depth)) = directories.pop() {
        let listing = match fs::read_dir(&directory) {
            Ok(v) => v,
            Err(_) => {
                status = if depth == 0 {
                    SourceStatus::Failed
                } else {
                    SourceStatus::Partial
                };
                continue;
            }
        };
        for entry in listing {
            *entries += 1;
            if *entries > MAX_ENTRIES || files.len() >= MAX_FILES {
                return SourceStatus::Partial;
            }
            let Ok(entry) = entry else {
                status = SourceStatus::Partial;
                continue;
            };
            let Ok(kind) = entry.file_type() else {
                status = SourceStatus::Partial;
                continue;
            };
            if kind.is_dir() {
                if depth >= MAX_DEPTH {
                    status = SourceStatus::Partial;
                } else {
                    directories.push((entry.path(), depth + 1));
                }
            } else if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
                files.push(entry.path());
            }
        }
    }
    status
}
enum Line {
    Bytes(Vec<u8>),
    Oversized,
    End,
}
fn bounded_line(reader: &mut impl BufRead) -> io::Result<Line> {
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return Ok(if oversized {
                Line::Oversized
            } else if line.is_empty() {
                Line::End
            } else {
                Line::Bytes(line)
            });
        }
        let end = bytes.iter().position(|b| *b == b'\n').map(|i| i + 1);
        let length = end.unwrap_or(bytes.len());
        if !oversized && line.len() + length <= MAX_LINE_BYTES {
            line.extend_from_slice(&bytes[..length]);
        } else {
            oversized = true;
            line.clear();
        }
        reader.consume(length);
        if end.is_some() {
            return Ok(if oversized {
                Line::Oversized
            } else {
                Line::Bytes(line)
            });
        }
    }
}
fn parse_file(
    path: &Path,
    allowed: u64,
    limit: usize,
    size: u64,
    modified_ns: u64,
    cutoff: i64,
) -> io::Result<CachedFile> {
    let mut reader = BufReader::new(File::open(path)?.take(allowed));
    let mut parser = Parser::new(path.to_string_lossy().into_owned());
    let mut records = Vec::new();
    let mut complete = allowed >= size;
    loop {
        match bounded_line(&mut reader)? {
            Line::End => break,
            Line::Oversized => {
                parser.diagnostics.malformed += 1;
                complete = false;
            }
            Line::Bytes(line) => {
                if let Some(record) = parser.line(&line).filter(|r| r.timestamp_ms >= cutoff) {
                    if records.len() >= limit {
                        complete = false;
                        break;
                    }
                    records.push(record);
                }
            }
        }
    }
    Ok(CachedFile {
        size,
        modified_ns,
        complete,
        records,
        diagnostics: parser.diagnostics,
    })
}
fn identity(record: &UsageRecord) -> (String, String, u64) {
    (
        record.session_id.clone(),
        record.event_key.clone(),
        record.occurrence,
    )
}
fn retain_previous(parsed: &mut CachedFile, previous: &CachedFile, limit: usize) -> u64 {
    let mut seen = parsed.records.iter().map(identity).collect::<HashSet<_>>();
    let mut retained = 0;
    for record in &previous.records {
        if parsed.records.len() >= limit {
            break;
        }
        if seen.insert(identity(record)) {
            parsed.records.push(record.clone());
            retained += 1;
        }
    }
    retained
}
pub(super) fn read(home: &Path, data_dir: &Path, now: i64) -> (Vec<UsageRecord>, UsageCoverage) {
    let home_text = home.to_string_lossy().into_owned();
    let cache_path = data_dir.join("usage-scan-cache.json");
    let loaded = bounded_json::<Cache>(&cache_path, MAX_CACHE_BYTES);
    let mut coverage = UsageCoverage {
        home: home_text.clone(),
        sources: Vec::new(),
        scanned_files: 0,
        reused_files: 0,
        skipped_files: 0,
        malformed_records: 0,
        suppressed_duplicates: 0,
        suppressed_fork_copies: 0,
        earliest_included_ms: None,
        latest_included_ms: None,
        retained_records: 0,
        partial: false,
        messages: Vec::new(),
        pricing: PricingStatus::default(),
    };
    let mut cache = match loaded {
        Ok(cache) if valid_cache(&cache, &home_text) => cache,
        Ok(_) => {
            coverage.messages.push("Usage cache belongs to another Codex home or is incompatible. Rebuilt from transcripts.".into());
            Cache {
                version: 1,
                home: home_text.clone(),
                files: BTreeMap::new(),
            }
        }
        Err(error) => {
            if error.kind() != io::ErrorKind::NotFound {
                coverage
                    .messages
                    .push("Usage cache could not be read. Rebuilt from transcripts.".into());
            }
            Cache {
                version: 1,
                home: home_text.clone(),
                files: BTreeMap::new(),
            }
        }
    };
    let cutoff = now - RETENTION_MS;
    for file in cache.files.values_mut() {
        file.records.retain(|r| r.timestamp_ms >= cutoff);
    }
    let mut paths = Vec::new();
    let mut entries = 0;
    for name in ["sessions", "archived_sessions"] {
        let path = home.join(name);
        let status = discover(&path, &mut paths, &mut entries);
        if matches!(status, SourceStatus::Partial | SourceStatus::Failed) {
            coverage.partial = true;
            coverage.messages.push(format!(
                "{} could not be read completely. File, directory or traversal limits may apply.",
                path.display()
            ));
        }
        coverage.sources.push(UsageSource {
            path: path.to_string_lossy().into_owned(),
            status,
        });
    }
    paths.sort();
    paths.dedup();
    let mut found = HashSet::new();
    let mut unavailable = HashSet::new();
    let mut bytes_left = MAX_SCAN_BYTES;
    let mut cached_record_count = cache
        .files
        .values()
        .map(|file| file.records.len())
        .sum::<usize>();
    for path in paths {
        let key = path.to_string_lossy().into_owned();
        found.insert(key.clone());
        let metadata = match fs::metadata(&path) {
            Ok(v) => v,
            Err(_) => {
                coverage.skipped_files += 1;
                coverage.partial = true;
                unavailable.insert(key.clone());
                continue;
            }
        };
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos().min(u64::MAX as u128) as u64)
            .unwrap_or(0);
        let previous = cache.files.get(&key);
        if previous.is_some_and(|file| {
            file.complete
                && file.size == metadata.len()
                && modified_ns != 0
                && file.modified_ns == modified_ns
        }) {
            coverage.reused_files += 1;
            continue;
        }
        let old_count = previous.map_or(0, |file| file.records.len());
        let available = MAX_RECORDS.saturating_sub(cached_record_count - old_count);
        if bytes_left == 0 || available == 0 {
            coverage.skipped_files += 1;
            coverage.partial = true;
            unavailable.insert(key.clone());
            continue;
        }
        let allowed = metadata.len().min(MAX_FILE_BYTES).min(bytes_left);
        bytes_left -= allowed;
        match parse_file(
            &path,
            allowed,
            available,
            metadata.len(),
            modified_ns,
            cutoff,
        ) {
            Ok(mut parsed) => {
                coverage.scanned_files += 1;
                if !parsed.complete {
                    coverage.partial = true;
                    if let Some(previous) = previous {
                        coverage.retained_records +=
                            retain_previous(&mut parsed, previous, available);
                    }
                }
                cached_record_count = cached_record_count - old_count + parsed.records.len();
                cache.files.insert(key, parsed);
            }
            Err(_) => {
                coverage.skipped_files += 1;
                coverage.partial = true;
                unavailable.insert(key);
            }
        }
    }
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    for (path, file) in &cache.files {
        let retained = !found.contains(path) || unavailable.contains(path) || !file.complete;
        if retained && !file.records.is_empty() {
            coverage.partial = true;
        }
        if !found.contains(path) || unavailable.contains(path) {
            coverage.retained_records += file.records.len() as u64;
        }
        coverage.malformed_records += file.diagnostics.malformed;
        coverage.suppressed_duplicates += file.diagnostics.duplicates;
        coverage.suppressed_fork_copies += file.diagnostics.fork_copies;
        for record in &file.records {
            if seen.insert(identity(record)) {
                records.push(record.clone());
            } else {
                coverage.suppressed_duplicates += 1;
            }
        }
    }
    cache
        .files
        .retain(|path, file| found.contains(path) || !file.records.is_empty());
    if coverage.retained_records > 0 {
        coverage.messages.push("Includes retained usage from removed or incompletely read transcripts within the past 90 days.".into());
    }
    if coverage.malformed_records > 0 {
        coverage.partial = true;
        coverage.messages.push(format!(
            "{} malformed usage records were skipped.",
            coverage.malformed_records
        ));
    }
    for source in &mut coverage.sources {
        let incomplete = cache.files.iter().any(|(path, file)| {
            Path::new(path).starts_with(&source.path)
                && (file.diagnostics.malformed > 0
                    || !file.complete
                    || ((!found.contains(path) || unavailable.contains(path))
                        && !file.records.is_empty()))
        });
        if incomplete && matches!(source.status, SourceStatus::Ok | SourceStatus::Missing) {
            source.status = SourceStatus::Partial;
        }
    }
    if coverage.partial {
        coverage.messages.push("History has partial transcript coverage. Scans allow 10,000 files, 512 MiB total, 64 MiB per file, 2 MiB per line and 250,000 records.".into());
    }
    if let Err(error) = atomic_json(&cache_path, &cache) {
        coverage.partial = true;
        coverage.messages.push(format!(
            "Usage was read but its cache could not be saved. {error}"
        ));
    }
    (records, coverage)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> String {
        format!(
            "{}\n{}\n{}\n{}\n{}\n",
            json!({"type":"session_meta","timestamp":"2026-10-08T09:00:00Z","payload":{"id":"bounded"}}),
            json!({"type":"turn_context","payload":{"model":"test"}}),
            json!({"type":"event_msg","timestamp":"2026-10-08T09:00:01Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":1}}}}),
            json!({"type":"event_msg","timestamp":"2026-10-08T09:00:02Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20,"output_tokens":2}}}}),
            json!({"type":"event_msg","timestamp":"2026-10-08T09:00:03Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":30,"output_tokens":3}}}})
        )
    }
    #[test]
    fn oversized_lines_are_discarded_without_hiding_following_usage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bounded.jsonl");
        let mut content = vec![b'x'; MAX_LINE_BYTES + 1];
        content.push(b'\n');
        content.extend(fixture().as_bytes());
        fs::write(&path, &content).unwrap();
        let file = parse_file(
            &path,
            content.len() as u64,
            MAX_RECORDS,
            content.len() as u64,
            0,
            0,
        )
        .unwrap();
        assert_eq!(file.records.len(), 3);
        assert_eq!(file.diagnostics.malformed, 1);
        assert!(!file.complete);
    }
    #[test]
    fn record_and_byte_limits_mark_partial_results() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bounded.jsonl");
        let content = fixture();
        fs::write(&path, &content).unwrap();
        let file = parse_file(&path, content.len() as u64, 2, content.len() as u64, 0, 0).unwrap();
        assert_eq!(file.records.len(), 2);
        assert!(!file.complete);
        let file = parse_file(
            &path,
            content.len() as u64 - 1,
            MAX_RECORDS,
            content.len() as u64,
            0,
            0,
        )
        .unwrap();
        assert!(!file.complete);
        let mut reader = BufReader::new(&b"normal\n"[..]);
        assert!(
            matches!(bounded_line(&mut reader).unwrap(),Line::Bytes(line) if line==b"normal\n")
        );
    }
    #[test]
    fn source_removal_and_cache_write_failure_keep_scanned_data_usable() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let now = 1_791_460_800_000;
        fs::create_dir(home.path().join("sessions")).unwrap();
        fs::write(home.path().join("sessions/event.jsonl"), fixture()).unwrap();
        let (records, _) = read(home.path(), data.path(), now);
        assert_eq!(records.len(), 3);
        fs::remove_dir_all(home.path().join("sessions")).unwrap();
        let (records, coverage) = read(home.path(), data.path(), now);
        assert_eq!(records.len(), 3);
        assert_eq!(coverage.sources[0].status, SourceStatus::Partial);
        assert_eq!(coverage.retained_records, 3);
        fs::create_dir(home.path().join("sessions")).unwrap();
        fs::write(home.path().join("sessions/event.jsonl"), fixture()).unwrap();
        let blocked = data.path().join("file");
        fs::write(&blocked, "not a directory").unwrap();
        let (records, coverage) = read(home.path(), &blocked, now);
        assert_eq!(records.len(), 3);
        assert!(coverage.partial);
        assert!(
            coverage
                .messages
                .iter()
                .any(|m| m.contains("cache could not be saved"))
        );
    }
    #[cfg(unix)]
    #[test]
    fn discovery_does_not_follow_symlinks_outside_the_codex_home() {
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join("sessions")).unwrap();
        fs::write(outside.path().join("outside.jsonl"), fixture()).unwrap();
        std::os::unix::fs::symlink(outside.path(), home.path().join("sessions/outside")).unwrap();
        let (records, _) = read(home.path(), data.path(), 1_791_460_800_000);
        assert!(records.is_empty());
    }
}
