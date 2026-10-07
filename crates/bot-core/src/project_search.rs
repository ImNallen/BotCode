// Ported from pingdotgg/t3code v0.0.45 apps/server/src/workspace/WorkspaceSearchIndex.ts (MIT).
use crate::{AppError, Result, repo};
use grep_matcher::{LineTerminator, Matcher};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{SearcherBuilder, sinks::UTF8};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BinaryHeap},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

#[derive(Clone, Copy)]
struct IndexPolicy {
    entries: usize,
    bytes: usize,
    deadline: Duration,
}
const INDEX_POLICY: IndexPolicy = IndexPolicy {
    entries: 250_000,
    bytes: 64 * 1024 * 1024,
    deadline: Duration::from_secs(15),
};
const REFRESH_AFTER: Duration = Duration::from_secs(2);
const IDLE_TTL: Duration = Duration::from_secs(15 * 60);
const CONTENT_DEADLINE: Duration = Duration::from_secs(5);
const CONTENT_BYTES: u64 = 256 * 1024 * 1024;
const MATCH_LIMIT: usize = 500;
const PER_FILE_LIMIT: usize = 100;
const RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const QUERY_BYTES: usize = 4096;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathSearchInput {
    pub query: String,
    pub limit: usize,
    #[serde(default)]
    pub refresh: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchInput {
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub use_regex: bool,
    #[serde(default)]
    pub refresh: bool,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PathSearchResult {
    pub paths: Vec<String>,
    pub generation: u64,
    pub indexed_files: usize,
    pub truncated: bool,
    pub index_coverage: SearchCoverage,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SearchCoverage {
    #[default]
    Complete,
    Limited {
        reason: String,
    },
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    pub path: String,
    pub line_number: u64,
    pub line: String,
    pub ranges: Vec<[usize; 2]>,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchResult {
    pub matches: Vec<ContentMatch>,
    pub generation: u64,
    pub indexed_files: usize,
    pub searched_files: usize,
    pub skipped_files: usize,
    pub coverage: SearchCoverage,
    pub index_coverage: SearchCoverage,
}
struct IndexedPath {
    path: String,
    folded: String,
}
struct Snapshot {
    paths: Vec<IndexedPath>,
    generation: u64,
    built: Instant,
    coverage: SearchCoverage,
}
pub(crate) struct FileInventory {
    pub files: Vec<String>,
    pub coverage: SearchCoverage,
}
struct Entry {
    snapshot: RwLock<Option<Arc<Snapshot>>>,
    rebuild: AsyncMutex<()>,
}
struct RequestStop(Arc<AtomicBool>);
impl Drop for RequestStop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
struct Request {
    sequence: u64,
    stop: Arc<AtomicBool>,
    touched: Instant,
}
#[derive(Clone)]
pub(crate) struct ProjectSearch {
    roots: Arc<Mutex<BTreeMap<PathBuf, Arc<Entry>>>>,
    requests: Arc<Mutex<BTreeMap<String, Request>>>,
    workers: Arc<Semaphore>,
    generation: Arc<AtomicU64>,
}
impl Default for ProjectSearch {
    fn default() -> Self {
        Self {
            roots: Arc::default(),
            requests: Arc::default(),
            workers: Arc::new(Semaphore::new(2)),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}
fn cancelled() -> AppError {
    AppError::new("search_cancelled", "This search was superseded or closed.")
}
fn query_valid(query: &str) -> Result<()> {
    if query.len() > QUERY_BYTES {
        return Err(AppError::new(
            "search_query",
            "Search queries are limited to 4,096 bytes.",
        ));
    }
    Ok(())
}
impl ProjectSearch {
    fn begin(&self, caller: &str, sequence: u64) -> Result<Arc<AtomicBool>> {
        if caller.is_empty() || caller.len() > 128 {
            return Err(AppError::new("search_request", "Invalid search caller."));
        }
        let mut requests = self.requests.lock().unwrap();
        requests.retain(|_, request| {
            request.touched.elapsed() < IDLE_TTL || !request.stop.load(Ordering::Relaxed)
        });
        if let Some(previous) = requests.get(caller) {
            if previous.sequence >= sequence {
                return Err(cancelled());
            }
            previous.stop.store(true, Ordering::Relaxed);
        }
        if requests.len() >= 4096 && !requests.contains_key(caller) {
            return Err(AppError::new(
                "search_busy",
                "Too many search callers. Try again later.",
            ));
        }
        let stop = Arc::new(AtomicBool::new(false));
        requests.insert(
            caller.into(),
            Request {
                sequence,
                stop: stop.clone(),
                touched: Instant::now(),
            },
        );
        Ok(stop)
    }
    pub(crate) fn invalidate(&self) {
        self.roots.lock().unwrap().clear();
        for request in self.requests.lock().unwrap().values() {
            request.stop.store(true, Ordering::Relaxed);
        }
    }
    pub fn cancel(&self, caller: &str, sequence: u64) {
        if caller.is_empty() || caller.len() > 128 {
            return;
        }
        let mut requests = self.requests.lock().unwrap();
        match requests.get_mut(caller) {
            Some(request) if request.sequence <= sequence => {
                request.stop.store(true, Ordering::Relaxed);
                request.sequence = sequence;
                request.touched = Instant::now();
            }
            None => {
                requests.insert(
                    caller.into(),
                    Request {
                        sequence,
                        stop: Arc::new(AtomicBool::new(true)),
                        touched: Instant::now(),
                    },
                );
            }
            _ => {}
        }
    }
    async fn snapshot(&self, root: &Path, refresh: bool) -> Result<Arc<Snapshot>> {
        let root = root.canonicalize()?;
        let entry = {
            let mut roots = self.roots.lock().unwrap();
            roots.retain(|_, entry| {
                entry
                    .snapshot
                    .read()
                    .unwrap()
                    .as_ref()
                    .is_none_or(|snapshot| snapshot.built.elapsed() < IDLE_TTL)
            });
            roots
                .entry(root.clone())
                .or_insert_with(|| {
                    Arc::new(Entry {
                        snapshot: RwLock::new(None),
                        rebuild: AsyncMutex::new(()),
                    })
                })
                .clone()
        };
        if let Some(snapshot) = entry
            .snapshot
            .read()
            .unwrap()
            .as_ref()
            .filter(|snapshot| !refresh && snapshot.built.elapsed() < REFRESH_AFTER)
            .cloned()
        {
            return Ok(snapshot);
        }
        let _rebuild = entry.rebuild.lock().await;
        if let Some(snapshot) = entry
            .snapshot
            .read()
            .unwrap()
            .as_ref()
            .filter(|snapshot| !refresh && snapshot.built.elapsed() < REFRESH_AFTER)
            .cloned()
        {
            return Ok(snapshot);
        }
        let permit = self
            .workers
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| cancelled())?;
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let snapshot = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            build_snapshot(&root, generation, INDEX_POLICY)
        })
        .await
        .map_err(|e| AppError::new("search_worker", e))??;
        let snapshot = Arc::new(snapshot);
        *entry.snapshot.write().unwrap() = Some(snapshot.clone());
        Ok(snapshot)
    }
    pub async fn files(&self, root: &Path) -> Result<FileInventory> {
        let snapshot = self.snapshot(root, false).await?;
        Ok(FileInventory {
            files: snapshot
                .paths
                .iter()
                .map(|entry| entry.path.clone())
                .collect(),
            coverage: snapshot.coverage.clone(),
        })
    }
    pub async fn paths(
        &self,
        root: PathBuf,
        caller: String,
        sequence: u64,
        input: PathSearchInput,
    ) -> Result<PathSearchResult> {
        query_valid(&input.query)?;
        if !(1..=200).contains(&input.limit) {
            return Err(AppError::new(
                "search_limit",
                "File search returns between 1 and 200 results.",
            ));
        }
        let stop = self.begin(&caller, sequence)?;
        let _done = RequestStop(stop.clone());
        let snapshot = self.snapshot(&root, input.refresh).await?;
        if stop.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        let permit = self
            .workers
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| cancelled())?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            search_paths(&snapshot, &input, &stop)
        })
        .await
        .map_err(|e| AppError::new("search_worker", e))?
    }
    pub async fn contents(
        &self,
        root: PathBuf,
        caller: String,
        sequence: u64,
        input: ContentSearchInput,
    ) -> Result<ContentSearchResult> {
        query_valid(&input.query)?;
        let stop = self.begin(&caller, sequence)?;
        let _done = RequestStop(stop.clone());
        let snapshot = self.snapshot(&root, input.refresh).await?;
        if stop.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        let permit = self
            .workers
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| cancelled())?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            search_contents(&root, &snapshot, &input, &stop)
        })
        .await
        .map_err(|e| AppError::new("search_worker", e))?
    }
}
fn build_snapshot(root: &Path, generation: u64, policy: IndexPolicy) -> Result<Snapshot> {
    let started = Instant::now();
    let mut paths = Vec::new();
    let mut bytes = 0;
    let mut skipped = 0;
    let mut coverage = SearchCoverage::Complete;
    let mut walker = WalkBuilder::new(root);
    walker
        .hidden(false)
        .parents(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    for entry in walker.build() {
        if started.elapsed() > policy.deadline {
            coverage = SearchCoverage::Limited { reason: "File indexing stopped at its time limit before all paths were scanned. Choose a smaller checkout.".into() };
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Some(path) = entry.path().strip_prefix(root).ok().and_then(Path::to_str) else {
            skipped += 1;
            continue;
        };
        let path = path.replace(std::path::MAIN_SEPARATOR, "/");
        let folded = path.to_lowercase();
        bytes += path.len() + folded.len() + std::mem::size_of::<IndexedPath>();
        if paths.len() == policy.entries || bytes > policy.bytes {
            coverage = SearchCoverage::Limited { reason: "File indexing stopped at its path or memory limit before all paths were scanned. Choose a smaller checkout.".into() };
            break;
        }
        paths.push(IndexedPath { path, folded });
    }
    paths.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    if skipped > 0 {
        let skipped_reason =
            format!("{skipped} unreadable or non-UTF-8 paths were skipped while indexing.");
        coverage = SearchCoverage::Limited {
            reason: match coverage {
                SearchCoverage::Complete => skipped_reason,
                SearchCoverage::Limited { reason } => format!("{reason} {skipped_reason}"),
            },
        };
    }
    Ok(Snapshot {
        paths,
        generation,
        built: Instant::now(),
        coverage,
    })
}
fn path_score(value: &str, query: &str) -> Option<usize> {
    if query.is_empty() {
        return Some(0);
    }
    let name = value.rsplit('/').next().unwrap_or(value);
    if name == query {
        return Some(0);
    }
    if name.starts_with(query) {
        return Some(10 + name.len() - query.len());
    }
    if let Some(position) = name.find(query) {
        return Some(100 + position);
    }
    if let Some(position) = value.find(query) {
        return Some(200 + position);
    }
    let mut chars = query.chars();
    let mut next = chars.next();
    let mut score = 1000;
    for (index, character) in value.chars().enumerate() {
        if Some(character) == next {
            score += index;
            next = chars.next();
            if next.is_none() {
                return Some(score);
            }
        }
    }
    None
}
fn search_paths(
    snapshot: &Snapshot,
    input: &PathSearchInput,
    stop: &AtomicBool,
) -> Result<PathSearchResult> {
    let query: String = input
        .query
        .trim()
        .trim_start_matches(['@', '.', '/'])
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let mut hits = BinaryHeap::new();
    let mut count = 0;
    for (index, entry) in snapshot.paths.iter().enumerate() {
        if index % 256 == 0 && stop.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        if let Some(score) = path_score(&entry.folded, &query) {
            count += 1;
            hits.push((score, entry.path.as_str()));
            if hits.len() > input.limit {
                hits.pop();
            }
        }
    }
    if stop.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    Ok(PathSearchResult {
        paths: hits
            .into_sorted_vec()
            .into_iter()
            .map(|(_, path)| path.into())
            .collect(),
        generation: snapshot.generation,
        indexed_files: snapshot.paths.len(),
        truncated: count > input.limit,
        index_coverage: snapshot.coverage.clone(),
    })
}
fn search_contents(
    root: &Path,
    snapshot: &Snapshot,
    input: &ContentSearchInput,
    stop: &AtomicBool,
) -> Result<ContentSearchResult> {
    let mut result = ContentSearchResult {
        matches: vec![],
        generation: snapshot.generation,
        indexed_files: snapshot.paths.len(),
        searched_files: 0,
        skipped_files: 0,
        coverage: SearchCoverage::Complete,
        index_coverage: snapshot.coverage.clone(),
    };
    if input.query.trim().is_empty() {
        return Ok(result);
    }
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!input.case_sensitive)
        .fixed_strings(!input.use_regex)
        .multi_line(true)
        .line_terminator(Some(b'\n'))
        .crlf(true)
        .build(&input.query)
        .map_err(|e| AppError::new("invalid_regex", e))?;
    let word_character = RegexMatcherBuilder::new()
        .build(r"^[\p{L}\p{M}\p{N}_]$")
        .map_err(|error| AppError::new("content_search", error))?;
    let started = Instant::now();
    let mut total_bytes = 0;
    let mut response_bytes = 0;
    let mut searcher = SearcherBuilder::new()
        .line_number(true)
        .line_terminator(LineTerminator::crlf())
        .build();
    for entry in &snapshot.paths {
        if stop.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        if started.elapsed() > CONTENT_DEADLINE {
            result.coverage = SearchCoverage::Limited {
                reason: "Search stopped after 5 seconds before all files were searched.".into(),
            };
            break;
        }
        let path = match repo::contained(root, &entry.path) {
            Ok(path) => path,
            Err(_) => {
                result.skipped_files += 1;
                continue;
            }
        };
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(_) => {
                result.skipped_files += 1;
                continue;
            }
        };
        let size = match file.metadata() {
            Ok(metadata) if metadata.is_file() => metadata.len(),
            _ => {
                result.skipped_files += 1;
                continue;
            }
        };
        if size > repo::TEXT_LIMIT as u64 {
            result.skipped_files += 1;
            continue;
        }
        if total_bytes + size > CONTENT_BYTES {
            result.coverage = SearchCoverage::Limited {
                reason: "Search stopped at the 256 MiB read limit before all files were searched."
                    .into(),
            };
            break;
        }
        let read_limit = (repo::TEXT_LIMIT as u64 + 1).min(CONTENT_BYTES - total_bytes + 1);
        let mut contents = Vec::with_capacity(size.min(read_limit) as usize);
        if file.take(read_limit).read_to_end(&mut contents).is_err() {
            result.skipped_files += 1;
            continue;
        }
        total_bytes += contents.len() as u64;
        if total_bytes > CONTENT_BYTES {
            result.coverage = SearchCoverage::Limited {
                reason: "Search stopped at the 256 MiB read limit before all files were searched."
                    .into(),
            };
            break;
        }
        if contents.len() > repo::TEXT_LIMIT
            || contents.contains(&0)
            || std::str::from_utf8(&contents).is_err()
        {
            result.skipped_files += 1;
            continue;
        }
        result.searched_files += 1;
        let mut file_matches = 0;
        searcher
            .search_slice(
                &matcher,
                &contents,
                UTF8(|line_number, line| {
                    if stop.load(Ordering::Relaxed) {
                        return Ok(false);
                    }
                    if started.elapsed() > CONTENT_DEADLINE {
                        result.coverage = SearchCoverage::Limited {
                            reason:
                                "Search stopped after 5 seconds before all files were searched."
                                    .into(),
                        };
                        return Ok(false);
                    }
                    if file_matches >= PER_FILE_LIMIT {
                        result.coverage = SearchCoverage::Limited {
                            reason: "Some files have more than 100 matching lines.".into(),
                        };
                        return Ok(false);
                    }
                    let mut ranges = Vec::new();
                    matcher
                        .find_iter(line.as_bytes(), |hit| {
                            if !line.is_char_boundary(hit.start())
                                || !line.is_char_boundary(hit.end())
                            {
                                return true;
                            }
                            if input.whole_word {
                                let mut buffer = [0; 4];
                                let left = line[..hit.start()].chars().next_back();
                                let right = line[hit.end()..].chars().next();
                                if left.into_iter().chain(right).any(|character| {
                                    word_character
                                        .is_match(character.encode_utf8(&mut buffer).as_bytes())
                                        .unwrap_or(false)
                                }) {
                                    return true;
                                }
                            }
                            if ranges.len() < 100 {
                                ranges.push((hit.start(), hit.end()));
                            }
                            ranges.len() < 100
                        })
                        .map_err(std::io::Error::other)?;
                    if ranges.is_empty() {
                        return Ok(true);
                    }
                    let display = match line.strip_suffix('\n') {
                        Some(line) => line.strip_suffix('\r').unwrap_or(line),
                        None => line,
                    };
                    let (line, ranges) = excerpt(display, &ranges);
                    response_bytes += line.len() + entry.path.len() + ranges.len() * 16 + 64;
                    if response_bytes > RESPONSE_BYTES {
                        result.coverage = SearchCoverage::Limited {
                            reason: "Search stopped at the 2 MiB result limit.".into(),
                        };
                        return Ok(false);
                    }
                    result.matches.push(ContentMatch {
                        path: entry.path.clone(),
                        line_number,
                        line,
                        ranges,
                    });
                    file_matches += 1;
                    Ok(result.matches.len() < MATCH_LIMIT)
                }),
            )
            .map_err(|e| AppError::new("content_search", e))?;
        if result.matches.len() >= MATCH_LIMIT {
            result.coverage = SearchCoverage::Limited {
                reason: "Showing the first 500 matching lines. Narrow your search to see more."
                    .into(),
            };
            break;
        }
        if response_bytes > RESPONSE_BYTES {
            break;
        }
    }
    if stop.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    Ok(result)
}
fn excerpt(line: &str, ranges: &[(usize, usize)]) -> (String, Vec<[usize; 2]>) {
    let first = ranges.first().map_or(0, |range| range.0.min(line.len()));
    let mut start = first.saturating_sub(200);
    while !line.is_char_boundary(start) {
        start += 1;
    }
    let mut end = start;
    let mut units = 0;
    for character in line[start..].chars() {
        if units + character.len_utf16() > 2000 {
            break;
        }
        units += character.len_utf16();
        end += character.len_utf8();
    }
    let prefix = usize::from(start > 0);
    let mut text = if start > 0 {
        "…".to_owned()
    } else {
        String::new()
    };
    text.push_str(&line[start..end]);
    if end < line.len() {
        text.push('…');
    }
    let ranges = ranges
        .iter()
        .filter(|(from, to)| *from >= start && *from < end && *to <= line.len())
        .map(|(from, to)| {
            [
                prefix + line[start..*from].encode_utf16().count(),
                prefix + line[start..(*to).min(end)].encode_utf16().count(),
            ]
        })
        .collect();
    (text, ranges)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    fn write(root: &Path, path: &str, text: impl AsRef<[u8]>) {
        let target = root.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, text).unwrap();
    }
    fn content(query: &str) -> ContentSearchInput {
        ContentSearchInput {
            query: query.into(),
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            refresh: false,
        }
    }
    #[test]
    fn one_inventory_respects_strict_nested_ignores_hidden_files_and_checkout_boundary() {
        let parent = tempfile::tempdir().unwrap();
        write(parent.path(), ".gitignore", "parent-only.txt\n");
        let root = parent.path().join("checkout");
        std::fs::create_dir(&root).unwrap();
        assert!(
            Command::new("git")
                .args(["init", "-q"])
                .arg(&root)
                .status()
                .unwrap()
                .success()
        );
        write(&root, "tracked.txt", "tracked");
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["add", "tracked.txt"])
                .status()
                .unwrap()
                .success()
        );
        write(&root, ".gitignore", "tracked.txt\nignored/\n*.log\n");
        write(&root, "parent-only.txt", "local checkout");
        write(&root, ".hidden", "visible");
        write(&root, "ignored/sentinel.txt", "secret");
        write(&root, "nested/.gitignore", "hide.txt\n");
        write(&root, "nested/.ignore", "also.txt\n");
        write(&root, "nested/hide.txt", "secret");
        write(&root, "nested/also.txt", "secret");
        write(&root, "nested/keep.txt", "visible");
        write(&root, "error.log", "secret");
        #[cfg(unix)]
        std::os::unix::fs::symlink(parent.path().join(".gitignore"), root.join("escape.txt"))
            .unwrap();
        let snapshot = build_snapshot(&root, 1, INDEX_POLICY).unwrap();
        let paths: Vec<_> = snapshot
            .paths
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(
            paths,
            [
                ".gitignore",
                ".hidden",
                "nested/.gitignore",
                "nested/.ignore",
                "nested/keep.txt",
                "parent-only.txt"
            ]
        );
        let matches = search_contents(
            &root,
            &snapshot,
            &content("secret"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(matches.matches.is_empty());
        assert_eq!(matches.coverage, SearchCoverage::Complete);
        assert!(repo::contained(&root, "../.gitignore").is_err());
        #[cfg(unix)]
        assert!(repo::contained(&root, "escape.txt").is_err());
    }
    #[test]
    fn path_ranking_is_deterministic_bounded_and_supports_subsequence_queries() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..250 {
            write(root.path(), &format!("files/file-{index:03}.txt"), "");
        }
        write(root.path(), "src/Composer.tsx", "");
        let snapshot = build_snapshot(root.path(), 3, INDEX_POLICY).unwrap();
        let paths = search_paths(
            &snapshot,
            &PathSearchInput {
                query: " @./cmps ".into(),
                limit: 50,
                refresh: false,
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(paths.paths, ["src/Composer.tsx"]);
        let paths = search_paths(
            &snapshot,
            &PathSearchInput {
                query: "file".into(),
                limit: 200,
                refresh: false,
            },
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(paths.paths.len(), 200);
        assert!(paths.truncated);
        assert_eq!(paths.paths[0], "files/file-000.txt");
        assert_eq!(paths.indexed_files, 251);
    }
    #[test]
    fn grep_options_literal_regex_unicode_ranges_and_displayable_files() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "text.txt",
            "Foo\nfoo\nfoobar\nfoo_bar\nfoó\n-2\na.b\n😊 café target\n",
        );
        write(root.path(), "binary.bin", b"foo\0");
        write(root.path(), "invalid.txt", b"foo\xff");
        write(root.path(), "large.txt", vec![b'a'; repo::TEXT_LIMIT + 1]);
        let snapshot = build_snapshot(root.path(), 1, INDEX_POLICY).unwrap();
        let scan = |input: ContentSearchInput| {
            search_contents(root.path(), &snapshot, &input, &AtomicBool::new(false)).unwrap()
        };
        assert_eq!(scan(content("foo")).matches.len(), 5);
        let mut input = content("foo");
        input.case_sensitive = true;
        assert_eq!(scan(input.clone()).matches.len(), 4);
        input.whole_word = true;
        assert_eq!(scan(input).matches.len(), 1);
        let mut input = content("-2");
        input.whole_word = true;
        assert_eq!(scan(input).matches[0].line_number, 6);
        assert_eq!(scan(content("a.b")).matches[0].line_number, 7);
        let mut input = content("^foo$");
        input.use_regex = true;
        assert_eq!(scan(input).matches.len(), 2);
        let result = scan(content("target"));
        assert_eq!(result.matches[0].line_number, 8);
        assert_eq!(result.matches[0].ranges, [[8, 14]]);
        assert_eq!(result.skipped_files, 3);
        let mut input = content("[");
        input.use_regex = true;
        assert_eq!(
            search_contents(root.path(), &snapshot, &input, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "invalid_regex"
        );
    }
    #[test]
    fn content_caps_are_explicit_and_per_file_cap_still_searches_later_files() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "a.txt", "common\n".repeat(150));
        write(root.path(), "z.txt", "common tail\n");
        let snapshot = build_snapshot(root.path(), 1, INDEX_POLICY).unwrap();
        let result = search_contents(
            root.path(),
            &snapshot,
            &content("common"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.matches.len(), 101);
        assert_eq!(result.matches.last().unwrap().path, "z.txt");
        assert!(matches!(result.coverage, SearchCoverage::Limited { .. }));
        for index in 0..600 {
            write(root.path(), &format!("file-{index:03}.txt"), "common\n");
        }
        let snapshot = build_snapshot(root.path(), 2, INDEX_POLICY).unwrap();
        let result = search_contents(
            root.path(),
            &snapshot,
            &content("common"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.matches.len(), 500);
        assert!(
            matches!(result.coverage, SearchCoverage::Limited { reason } if reason.contains("500"))
        );
    }
    #[tokio::test]
    async fn latest_requests_cancel_queued_work_and_old_cancellations_do_not_cancel_new_work() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "alpha.txt", "alpha");
        write(root.path(), "beta.txt", "beta");
        let search = ProjectSearch::default();
        search.files(root.path()).await.unwrap();
        let permit = search.workers.clone().acquire_many_owned(2).await.unwrap();
        let old = tokio::spawn({
            let search = search.clone();
            let root = root.path().to_owned();
            async move {
                search
                    .paths(
                        root,
                        "picker".into(),
                        1,
                        PathSearchInput {
                            query: "alpha".into(),
                            limit: 50,
                            refresh: false,
                        },
                    )
                    .await
            }
        });
        while !search.requests.lock().unwrap().contains_key("picker") {
            tokio::task::yield_now().await;
        }
        let new = tokio::spawn({
            let search = search.clone();
            let root = root.path().to_owned();
            async move {
                search
                    .paths(
                        root,
                        "picker".into(),
                        2,
                        PathSearchInput {
                            query: "beta".into(),
                            limit: 50,
                            refresh: false,
                        },
                    )
                    .await
            }
        });
        while search.requests.lock().unwrap()["picker"].sequence < 2 {
            tokio::task::yield_now().await;
        }
        search.cancel("picker", 1);
        drop(permit);
        assert_eq!(old.await.unwrap().unwrap_err().code, "search_cancelled");
        assert_eq!(new.await.unwrap().unwrap().paths, ["beta.txt"]);
        assert!(
            search.requests.lock().unwrap()["picker"]
                .stop
                .load(Ordering::Relaxed)
        );
        search.cancel("closed", 1);
        assert_eq!(
            search
                .paths(
                    root.path().into(),
                    "closed".into(),
                    1,
                    PathSearchInput {
                        query: "alpha".into(),
                        limit: 50,
                        refresh: false,
                    }
                )
                .await
                .unwrap_err()
                .code,
            "search_cancelled"
        );
    }
    #[tokio::test]
    async fn refresh_observes_external_ignore_changes_and_folders_share_policy() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "visible.txt", "target");
        let search = ProjectSearch::default();
        assert_eq!(
            search.files(root.path()).await.unwrap().files,
            ["visible.txt"]
        );
        write(root.path(), ".gitignore", "visible.txt\n");
        tokio::time::sleep(REFRESH_AFTER + Duration::from_millis(10)).await;
        assert_eq!(
            search.files(root.path()).await.unwrap().files,
            [".gitignore"]
        );
        let first = search.snapshot(root.path(), false).await.unwrap();
        let alias = search
            .snapshot(&root.path().join("."), false)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&first, &alias));
        search.invalidate();
        write(root.path(), "new.txt", "target");
        assert_eq!(
            search.files(root.path()).await.unwrap().files,
            [".gitignore", "new.txt"]
        );
    }
    #[test]
    fn limited_indexes_keep_representable_paths_and_report_incomplete_coverage() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "first.txt", "target");
        write(root.path(), "second.txt", "target");
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let path = root.path().join(std::ffi::OsString::from_vec(vec![0xff]));
            assert!(path.to_str().is_none());
            let created = std::fs::write(path, "target").is_ok();
            let snapshot = build_snapshot(root.path(), 1, INDEX_POLICY).unwrap();
            assert_eq!(snapshot.paths.len(), 2);
            assert_eq!(
                matches!(snapshot.coverage, SearchCoverage::Limited { .. }),
                created
            );
            let paths = search_paths(
                &snapshot,
                &PathSearchInput {
                    query: "".into(),
                    limit: 50,
                    refresh: false,
                },
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(
                matches!(paths.index_coverage, SearchCoverage::Limited { .. }),
                created
            );
            let contents = search_contents(
                root.path(),
                &snapshot,
                &content("target"),
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(contents.matches.len(), 2);
            assert_eq!(
                matches!(contents.index_coverage, SearchCoverage::Limited { .. }),
                created
            );
        }
        let snapshot = build_snapshot(
            root.path(),
            2,
            IndexPolicy {
                entries: 1,
                ..INDEX_POLICY
            },
        )
        .unwrap();
        assert_eq!(snapshot.paths.len(), 1);
        assert!(matches!(snapshot.coverage, SearchCoverage::Limited { .. }));
    }
    #[test]
    fn whole_word_uses_t3_letter_mark_number_and_underscore_boundaries() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "words.txt",
            "x²\nx‿\nx_\nx́\nx9\nx中\nx\n²x\n‿x\n",
        );
        let snapshot = build_snapshot(root.path(), 1, INDEX_POLICY).unwrap();
        let mut input = content("x");
        input.whole_word = true;
        let result =
            search_contents(root.path(), &snapshot, &input, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            result
                .matches
                .iter()
                .map(|hit| hit.line_number)
                .collect::<Vec<_>>(),
            [2, 7, 9]
        );
    }
    #[tokio::test]
    async fn explicit_refresh_rebuilds_inside_freshness_interval() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "first.txt", "");
        let search = ProjectSearch::default();
        let before = search
            .paths(
                root.path().into(),
                "refresh".into(),
                1,
                PathSearchInput {
                    query: "".into(),
                    limit: 50,
                    refresh: false,
                },
            )
            .await
            .unwrap();
        write(root.path(), "new.txt", "");
        let after = search
            .paths(
                root.path().into(),
                "refresh".into(),
                2,
                PathSearchInput {
                    query: "new".into(),
                    limit: 50,
                    refresh: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(after.paths, ["new.txt"]);
        assert!(after.generation > before.generation);
        assert_eq!(
            search.files(root.path()).await.unwrap().files,
            ["first.txt", "new.txt"]
        );
    }
    #[tokio::test]
    async fn branch_switch_invalidates_before_resolving() {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            assert!(
                Command::new("git")
                    .arg("-C")
                    .arg(root.path())
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        };
        git(&["-c", "init.defaultBranch=main", "init", "-q"]);
        write(root.path(), "branch-a.txt", "a");
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=Search Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "first",
        ]);
        git(&["checkout", "-qb", "other"]);
        write(root.path(), "branch-b.txt", "b");
        git(&["add", "."]);
        git(&[
            "-c",
            "user.name=Search Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            "second",
        ]);
        git(&["checkout", "-q", "main"]);
        let app = crate::App::open(crate::RuntimeConfig {
            data_dir: state.path().to_owned(),
            codex_binary: "/usr/bin/false".into(),
            gh_binary: "/usr/bin/false".into(),
            network_timeout: Duration::from_secs(1),
            shell: None,
        })
        .await
        .unwrap();
        let workspace = app.open_workspace(root.path().into()).await.unwrap();
        let before = app
            .search_paths(
                workspace.id.clone(),
                None,
                "branch".into(),
                1,
                PathSearchInput {
                    query: "branch-b".into(),
                    limit: 50,
                    refresh: false,
                },
            )
            .await
            .unwrap();
        assert!(before.paths.is_empty());
        app.switch_branch(workspace.id.clone(), None, "other".into(), false)
            .await
            .unwrap();
        let after = app
            .search_paths(
                workspace.id.clone(),
                None,
                "branch".into(),
                2,
                PathSearchInput {
                    query: "branch-b".into(),
                    limit: 50,
                    refresh: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(after.paths, ["branch-b.txt"]);
        assert!(after.generation > before.generation);
        let view = app
            .workspace_view(workspace.id.clone(), None)
            .await
            .unwrap();
        assert_eq!(view.branch, "other");
        assert!(view.unavailable.is_none());
        assert_eq!(view.files, ["branch-a.txt", "branch-b.txt"]);
        app.shutdown().await.unwrap();
    }
    #[test]
    fn byte_regex_cannot_return_partial_utf8_ranges_or_panic_excerpt_generation() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "unicode.txt", "©\n");
        let snapshot = build_snapshot(root.path(), 1, INDEX_POLICY).unwrap();
        for whole_word in [false, true] {
            let mut input = content(r"(?-u:\xA9)");
            input.use_regex = true;
            input.whole_word = whole_word;
            let result =
                search_contents(root.path(), &snapshot, &input, &AtomicBool::new(false)).unwrap();
            assert!(result.matches.is_empty());
            assert_eq!(result.coverage, SearchCoverage::Complete);
        }
    }
    #[test]
    fn trailing_carriage_returns_and_zero_width_matches_keep_excerpt_offsets_in_bounds() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "returns.txt",
            format!("x{}\n", "\r".repeat(300)),
        );
        let snapshot = build_snapshot(root.path(), 1, INDEX_POLICY).unwrap();
        for query in [r"\z", r"(?-m:$)", "$"] {
            let mut input = content(query);
            input.use_regex = true;
            let result =
                search_contents(root.path(), &snapshot, &input, &AtomicBool::new(false)).unwrap();
            assert_eq!(result.matches.len(), 1);
            assert_eq!(result.matches[0].line_number, 1);
            assert!(result.matches[0].line.contains('\r'));
        }
        let (text, ranges) = excerpt("target", &[(1006, 1006)]);
        assert_eq!(text, "target");
        assert!(ranges.is_empty());
        let (text, ranges) = excerpt("café", &[(1006, 1006)]);
        assert_eq!(text, "café");
        assert!(ranges.is_empty());
    }
}
