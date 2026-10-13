//! Ported from T3 Code v0.0.45 apps/server/src/resourceTelemetry/Model.ts and ResourceTelemetryHistory.ts (MIT).
use crate::ThreadId;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

const MAX_DELTA_INTERVAL_MS: u64 = 30_000;
pub(crate) const HISTORY_WINDOW_MS: u64 = 60 * 60_000;
pub(crate) const HISTORY_CAPACITY: usize = 3_600;
/// WebView engines that run as children of the app. macOS WebKit runs its processes as
/// launchd XPC services instead, so none descend from the app there.
const WEBVIEW_PROCESS_NAMES: [&str; 4] = [
    "msedgewebview2.exe",
    "WebKitWebProcess",
    "WebKitNetworkProcess",
    "WebKitGPUProcess",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start_time_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessCategory {
    App,
    Provider,
    Terminal,
    Webview,
    BackendChild,
}
impl ProcessCategory {
    pub(crate) fn signalable(self) -> bool {
        match self {
            Self::Provider | Self::Terminal | Self::BackendChild => true,
            Self::App | Self::Webview => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Root {
    App,
    Provider,
    Terminal { thread_id: Option<ThreadId> },
}
pub(crate) type KnownRoots = HashMap<u32, Root>;

#[derive(Debug, Clone)]
pub(crate) struct ProcessRow {
    pub pid: u32,
    pub ppid: u32,
    pub start_time_ms: u64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TreeRow {
    pub identity: ProcessIdentity,
    pub ppid: u32,
    pub depth: u16,
    pub name: String,
    pub category: ProcessCategory,
    pub thread_id: Option<ThreadId>,
    pub child_pids: Vec<u32>,
}

/// The app's process tree in depth-first order, children by pid. A child that started
/// before its parent holds a reused pid and is dropped with its descendants.
pub(crate) fn build_tree(rows: &[ProcessRow], roots: &KnownRoots) -> Vec<TreeRow> {
    let by_pid: HashMap<u32, &ProcessRow> = rows.iter().map(|row| (row.pid, row)).collect();
    let mut children: HashMap<u32, Vec<&ProcessRow>> = HashMap::new();
    for row in rows {
        if row.pid != row.ppid {
            children.entry(row.ppid).or_default().push(row);
        }
    }
    for list in children.values_mut() {
        list.sort_by_key(|row| row.pid);
    }
    let mut starts: Vec<u32> = roots.keys().copied().collect();
    starts.sort_by_key(|pid| (roots[pid] != Root::App, *pid));

    let mut ordered = Vec::new();
    let mut visited = HashSet::new();
    for start in starts {
        let Some(row) = by_pid.get(&start) else {
            continue;
        };
        let mut stack = vec![(*row, 0u16, None::<ProcessCategory>)];
        while let Some((row, depth, parent)) = stack.pop() {
            if !visited.insert(row.pid) {
                continue;
            }
            let (category, thread_id) = categorize(row, parent, roots);
            let kids: Vec<&ProcessRow> = children
                .get(&row.pid)
                .into_iter()
                .flatten()
                .filter(|child| child.start_time_ms >= row.start_time_ms)
                .copied()
                .collect();
            ordered.push(TreeRow {
                identity: ProcessIdentity {
                    pid: row.pid,
                    start_time_ms: row.start_time_ms,
                },
                ppid: row.ppid,
                depth,
                name: row.name.clone(),
                category,
                thread_id,
                child_pids: kids.iter().map(|child| child.pid).collect(),
            });
            for child in kids.into_iter().rev() {
                stack.push((child, depth.saturating_add(1), Some(category)));
            }
        }
    }
    ordered
}

fn categorize(
    row: &ProcessRow,
    parent: Option<ProcessCategory>,
    roots: &KnownRoots,
) -> (ProcessCategory, Option<ThreadId>) {
    match roots.get(&row.pid) {
        Some(Root::App) => (ProcessCategory::App, None),
        Some(Root::Provider) => (ProcessCategory::Provider, None),
        Some(Root::Terminal { thread_id }) => (ProcessCategory::Terminal, thread_id.clone()),
        None if parent == Some(ProcessCategory::Webview)
            || WEBVIEW_PROCESS_NAMES.contains(&row.name.as_str()) =>
        {
            (ProcessCategory::Webview, None)
        }
        None => (ProcessCategory::BackendChild, None),
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Reading {
    pub row: TreeRow,
    pub command: String,
    pub counters: Counters,
    pub resident_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Counters {
    pub cpu_time_ms: u64,
    pub io_read_bytes: u64,
    pub io_write_bytes: u64,
}

fn delta(current: u64, previous: u64, elapsed_ms: u64) -> u64 {
    if elapsed_ms == 0 || elapsed_ms > MAX_DELTA_INTERVAL_MS || current < previous {
        return 0;
    }
    current - previous
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pub identity: ProcessIdentity,
    pub ppid: u32,
    pub depth: u16,
    pub name: String,
    pub command: String,
    pub category: ProcessCategory,
    pub thread_id: Option<ThreadId>,
    pub cpu_percent: f64,
    pub cpu_time_ms: u64,
    pub resident_bytes: u64,
    pub io_read_bytes: u64,
    pub io_write_bytes: u64,
    pub io_read_bytes_per_second: f64,
    pub io_write_bytes_per_second: f64,
    pub child_pids: Vec<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Aggregate {
    pub process_count: usize,
    pub current_cpu_percent: f64,
    pub cpu_time_ms: u64,
    pub current_rss_bytes: u64,
    pub peak_rss_bytes: u64,
    pub io_read_bytes: u64,
    pub io_write_bytes: u64,
    pub io_read_bytes_per_second: f64,
    pub io_write_bytes_per_second: f64,
    pub process_starts: u64,
    pub process_exits: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Groups {
    pub all: Aggregate,
    pub backend: Aggregate,
    pub webview: Aggregate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Group {
    Backend,
    Webview,
}
impl From<ProcessCategory> for Group {
    fn from(category: ProcessCategory) -> Self {
        match category {
            ProcessCategory::Webview => Self::Webview,
            ProcessCategory::App
            | ProcessCategory::Provider
            | ProcessCategory::Terminal
            | ProcessCategory::BackendChild => Self::Backend,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct Totals {
    cpu_time_ms: u64,
    io_read_bytes: u64,
    io_write_bytes: u64,
    process_starts: u64,
    process_exits: u64,
}

#[derive(Debug, Clone)]
struct Previous {
    counters: Counters,
    peak_rss_bytes: u64,
    group: Group,
}

#[derive(Debug, Default)]
pub(crate) struct MonitorState {
    previous_at_ms: Option<u64>,
    previous: HashMap<ProcessIdentity, Previous>,
    backend: Totals,
    webview: Totals,
    names: HashMap<ProcessIdentity, (Arc<str>, Arc<str>)>,
}

pub(crate) struct Advanced {
    pub processes: Vec<ProcessSample>,
    pub groups: Groups,
    pub entry: HistoryEntry,
}

impl MonitorState {
    pub(crate) fn advance(&mut self, at_ms: u64, readings: Vec<Reading>) -> Advanced {
        let elapsed_ms = self
            .previous_at_ms
            .map_or(0, |previous| at_ms.saturating_sub(previous));
        let mut next = HashMap::with_capacity(readings.len());
        let mut processes = Vec::with_capacity(readings.len());
        let mut points = Vec::with_capacity(readings.len());
        let mut peaks = (0u64, 0u64);
        for reading in readings {
            let identity = reading.row.identity;
            let group = Group::from(reading.row.category);
            let prior = self.previous.get(&identity).cloned();
            let before = prior
                .as_ref()
                .map_or(reading.counters, |prior| prior.counters);
            let cpu = delta(reading.counters.cpu_time_ms, before.cpu_time_ms, elapsed_ms);
            let read = delta(
                reading.counters.io_read_bytes,
                before.io_read_bytes,
                elapsed_ms,
            );
            let write = delta(
                reading.counters.io_write_bytes,
                before.io_write_bytes,
                elapsed_ms,
            );
            let per_second = |value: u64| {
                if elapsed_ms == 0 {
                    0.0
                } else {
                    value as f64 * 1_000.0 / elapsed_ms as f64
                }
            };
            let cpu_percent = per_second(cpu) / 10.0;
            let totals = self.totals(group);
            totals.cpu_time_ms += cpu;
            totals.io_read_bytes += read;
            totals.io_write_bytes += write;
            if prior.is_none() {
                totals.process_starts += 1;
            }
            let peak_rss_bytes = prior
                .as_ref()
                .map_or(0, |prior| prior.peak_rss_bytes)
                .max(reading.resident_bytes);
            match group {
                Group::Backend => peaks.0 += peak_rss_bytes,
                Group::Webview => peaks.1 += peak_rss_bytes,
            }
            next.insert(
                identity,
                Previous {
                    counters: reading.counters,
                    peak_rss_bytes,
                    group,
                },
            );
            let (name, command) = self
                .names
                .entry(identity)
                .or_insert_with(|| {
                    (
                        Arc::from(reading.row.name.as_str()),
                        Arc::from(reading.command.as_str()),
                    )
                })
                .clone();
            points.push(HistoryPoint {
                identity,
                name,
                command,
                category: reading.row.category,
                cpu_percent,
                cpu_time_ms: cpu,
                resident_bytes: reading.resident_bytes,
                io_read_bytes: read,
                io_write_bytes: write,
            });
            processes.push(ProcessSample {
                identity,
                ppid: reading.row.ppid,
                depth: reading.row.depth,
                name: reading.row.name,
                command: reading.command,
                category: reading.row.category,
                thread_id: reading.row.thread_id,
                cpu_percent,
                cpu_time_ms: reading.counters.cpu_time_ms,
                resident_bytes: reading.resident_bytes,
                io_read_bytes: reading.counters.io_read_bytes,
                io_write_bytes: reading.counters.io_write_bytes,
                io_read_bytes_per_second: per_second(read),
                io_write_bytes_per_second: per_second(write),
                child_pids: reading.row.child_pids,
            });
        }
        let exited: Vec<Group> = self
            .previous
            .iter()
            .filter(|(identity, _)| !next.contains_key(identity))
            .map(|(_, gone)| gone.group)
            .collect();
        for group in exited {
            self.totals(group).process_exits += 1;
        }
        self.names.retain(|identity, _| next.contains_key(identity));
        self.previous = next;
        self.previous_at_ms = Some(at_ms);

        let backend = aggregate(&processes, Group::Backend, self.backend, peaks.0);
        let webview = aggregate(&processes, Group::Webview, self.webview, peaks.1);
        let all = combine(&backend, &webview);
        Advanced {
            processes,
            groups: Groups {
                all,
                backend,
                webview,
            },
            entry: HistoryEntry { at_ms, points },
        }
    }

    fn totals(&mut self, group: Group) -> &mut Totals {
        match group {
            Group::Backend => &mut self.backend,
            Group::Webview => &mut self.webview,
        }
    }
}

fn aggregate(processes: &[ProcessSample], group: Group, totals: Totals, peak: u64) -> Aggregate {
    let members = processes
        .iter()
        .filter(|process| Group::from(process.category) == group);
    let mut aggregate = Aggregate {
        cpu_time_ms: totals.cpu_time_ms,
        peak_rss_bytes: peak,
        io_read_bytes: totals.io_read_bytes,
        io_write_bytes: totals.io_write_bytes,
        process_starts: totals.process_starts,
        process_exits: totals.process_exits,
        ..Aggregate::default()
    };
    for process in members {
        aggregate.process_count += 1;
        aggregate.current_cpu_percent += process.cpu_percent;
        aggregate.current_rss_bytes += process.resident_bytes;
        aggregate.io_read_bytes_per_second += process.io_read_bytes_per_second;
        aggregate.io_write_bytes_per_second += process.io_write_bytes_per_second;
    }
    aggregate
}

fn combine(left: &Aggregate, right: &Aggregate) -> Aggregate {
    Aggregate {
        process_count: left.process_count + right.process_count,
        current_cpu_percent: left.current_cpu_percent + right.current_cpu_percent,
        cpu_time_ms: left.cpu_time_ms + right.cpu_time_ms,
        current_rss_bytes: left.current_rss_bytes + right.current_rss_bytes,
        peak_rss_bytes: left.peak_rss_bytes + right.peak_rss_bytes,
        io_read_bytes: left.io_read_bytes + right.io_read_bytes,
        io_write_bytes: left.io_write_bytes + right.io_write_bytes,
        io_read_bytes_per_second: left.io_read_bytes_per_second + right.io_read_bytes_per_second,
        io_write_bytes_per_second: left.io_write_bytes_per_second + right.io_write_bytes_per_second,
        process_starts: left.process_starts + right.process_starts,
        process_exits: left.process_exits + right.process_exits,
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HistoryPoint {
    pub identity: ProcessIdentity,
    pub name: Arc<str>,
    pub command: Arc<str>,
    pub category: ProcessCategory,
    pub cpu_percent: f64,
    pub cpu_time_ms: u64,
    pub resident_bytes: u64,
    pub io_read_bytes: u64,
    pub io_write_bytes: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct HistoryEntry {
    pub at_ms: u64,
    pub points: Vec<HistoryPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBucket {
    pub started_at_ms: u64,
    pub avg_cpu_percent: f64,
    pub max_cpu_percent: f64,
    pub max_rss_bytes: u64,
    pub io_read_bytes: u64,
    pub io_write_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSummary {
    pub identity: ProcessIdentity,
    pub name: String,
    pub command: String,
    pub category: ProcessCategory,
    pub cpu_time_ms: u64,
    pub max_cpu_percent: f64,
    pub peak_rss_bytes: u64,
    pub io_read_bytes: u64,
    pub io_write_bytes: u64,
    pub sample_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceHistory {
    pub read_at_ms: u64,
    pub window_ms: u64,
    pub bucket_ms: u64,
    pub buckets: Vec<HistoryBucket>,
    pub top_processes: Vec<ProcessSummary>,
}

#[derive(Debug, Default)]
pub(crate) struct History(VecDeque<HistoryEntry>);

impl History {
    pub(crate) fn push(&mut self, entry: HistoryEntry) {
        let oldest = entry.at_ms.saturating_sub(HISTORY_WINDOW_MS);
        self.0.push_back(entry);
        while self.0.len() > HISTORY_CAPACITY
            || self.0.front().is_some_and(|entry| entry.at_ms < oldest)
        {
            self.0.pop_front();
        }
    }

    #[cfg(test)]
    pub(crate) fn oldest_at_ms(&self) -> Option<u64> {
        self.0.front().map(|entry| entry.at_ms)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }

    pub(crate) fn query(&self, now_ms: u64, window_ms: u64, bucket_ms: u64) -> ResourceHistory {
        let window_ms = window_ms.clamp(1_000, HISTORY_WINDOW_MS);
        let bucket_ms = bucket_ms.clamp(1_000, window_ms);
        let start_ms = now_ms.saturating_sub(window_ms);
        let entries: Vec<&HistoryEntry> = self
            .0
            .iter()
            .filter(|entry| entry.at_ms >= start_ms && entry.at_ms <= now_ms)
            .collect();
        ResourceHistory {
            read_at_ms: now_ms,
            window_ms,
            bucket_ms,
            buckets: buckets(&entries, start_ms, now_ms, bucket_ms),
            top_processes: top_processes(&entries),
        }
    }
}

fn buckets(
    entries: &[&HistoryEntry],
    start_ms: u64,
    now_ms: u64,
    bucket_ms: u64,
) -> Vec<HistoryBucket> {
    let mut buckets = Vec::new();
    let mut started_at_ms = start_ms;
    while started_at_ms < now_ms {
        let ended_at_ms = now_ms.min(started_at_ms + bucket_ms);
        let samples: Vec<(f64, u64, u64, u64)> = entries
            .iter()
            .filter(|entry| {
                entry.at_ms >= started_at_ms
                    && (entry.at_ms < ended_at_ms
                        || (ended_at_ms == now_ms && entry.at_ms == now_ms))
            })
            .map(|entry| {
                entry.points.iter().fold((0.0, 0, 0, 0), |sum, point| {
                    (
                        sum.0 + point.cpu_percent,
                        sum.1 + point.resident_bytes,
                        sum.2 + point.io_read_bytes,
                        sum.3 + point.io_write_bytes,
                    )
                })
            })
            .collect();
        let count = samples.len();
        buckets.push(HistoryBucket {
            started_at_ms,
            avg_cpu_percent: if count == 0 {
                0.0
            } else {
                samples.iter().map(|sample| sample.0).sum::<f64>() / count as f64
            },
            max_cpu_percent: samples.iter().map(|sample| sample.0).fold(0.0, f64::max),
            max_rss_bytes: samples.iter().map(|sample| sample.1).max().unwrap_or(0),
            io_read_bytes: samples.iter().map(|sample| sample.2).sum(),
            io_write_bytes: samples.iter().map(|sample| sample.3).sum(),
        });
        started_at_ms = ended_at_ms;
    }
    buckets
}

fn top_processes(entries: &[&HistoryEntry]) -> Vec<ProcessSummary> {
    let mut summaries: HashMap<ProcessIdentity, ProcessSummary> = HashMap::new();
    for point in entries.iter().flat_map(|entry| &entry.points) {
        let summary = summaries
            .entry(point.identity)
            .or_insert_with(|| ProcessSummary {
                identity: point.identity,
                name: point.name.to_string(),
                command: point.command.to_string(),
                category: point.category,
                cpu_time_ms: 0,
                max_cpu_percent: 0.0,
                peak_rss_bytes: 0,
                io_read_bytes: 0,
                io_write_bytes: 0,
                sample_count: 0,
            });
        summary.cpu_time_ms += point.cpu_time_ms;
        summary.max_cpu_percent = summary.max_cpu_percent.max(point.cpu_percent);
        summary.peak_rss_bytes = summary.peak_rss_bytes.max(point.resident_bytes);
        summary.io_read_bytes += point.io_read_bytes;
        summary.io_write_bytes += point.io_write_bytes;
        summary.sample_count += 1;
    }
    let mut summaries: Vec<ProcessSummary> = summaries.into_values().collect();
    summaries.sort_by(|left, right| {
        right
            .cpu_time_ms
            .cmp(&left.cpu_time_ms)
            .then(right.peak_rss_bytes.cmp(&left.peak_rss_bytes))
            .then(left.identity.pid.cmp(&right.identity.pid))
    });
    summaries
}
