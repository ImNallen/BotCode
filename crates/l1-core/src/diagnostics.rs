//! Ported from T3 Code v0.0.45 native/resource-monitor/src/main.rs and apps/server/src/diagnostics/ProcessDiagnostics.ts (MIT).
mod model;
#[cfg(test)]
mod tests;

pub use model::{
    Aggregate, Groups, HistoryBucket, ProcessCategory, ProcessIdentity, ProcessSample,
    ProcessSummary, ResourceHistory,
};
pub(crate) use model::{KnownRoots, Root};

use model::{Counters, History, MonitorState, ProcessRow, Reading};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tokio::sync::watch;

const IDLE_INTERVAL: Duration = Duration::from_secs(5);
const LIVE_INTERVAL: Duration = Duration::from_secs(1);
const MAX_NAME_BYTES: usize = 256;
const MAX_COMMAND_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IoSemantics {
    Storage,
    AllIo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollectionStatus {
    Healthy,
    Degraded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionHealth {
    pub status: CollectionStatus,
    pub last_error: Option<String>,
    pub collection_micros: u64,
    pub scanned_process_count: usize,
    pub retained_process_count: usize,
    pub inaccessible_process_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub read_at_ms: u64,
    pub sample_interval_ms: u64,
    pub io_semantics: IoSemantics,
    pub processes: Vec<ProcessSample>,
    pub groups: Groups,
    pub health: CollectionHealth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessSignal {
    Interrupt,
    Kill,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignalOutcome {
    pub signaled: bool,
    pub message: Option<String>,
}
impl SignalOutcome {
    fn refused(message: String) -> Self {
        Self {
            signaled: false,
            message: Some(message),
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct ProviderPids(Arc<Mutex<HashSet<u32>>>);
impl ProviderPids {
    pub(crate) fn register(&self, pid: u32) -> ProviderRegistration {
        lock(&self.0).insert(pid);
        ProviderRegistration {
            pids: self.clone(),
            pid,
        }
    }
    pub(crate) fn current(&self) -> Vec<u32> {
        lock(&self.0).iter().copied().collect()
    }
}
pub(crate) struct ProviderRegistration {
    pids: ProviderPids,
    pid: u32,
}
impl Drop for ProviderRegistration {
    fn drop(&mut self) {
        lock(&self.pids.0).remove(&self.pid);
    }
}

pub(crate) type RootSource = Arc<dyn Fn() -> KnownRoots + Send + Sync>;

#[derive(Clone)]
pub(crate) struct ResourceMonitor(Arc<Shared>);

struct Shared {
    sampler: Mutex<Sampler>,
    subscribers: Mutex<HashSet<u64>>,
    next_subscriber: AtomicU64,
    events: watch::Sender<Option<ResourceSnapshot>>,
    background: Mutex<Background>,
}

struct Background {
    thread: Option<std::thread::Thread>,
    last_tick: Instant,
    spawn_error: Option<String>,
}

struct Sampler {
    system: System,
    roots: RootSource,
    state: MonitorState,
    history: History,
}

impl ResourceMonitor {
    pub(crate) fn start(roots: RootSource) -> Self {
        let monitor = Self(Arc::new(Shared {
            sampler: Mutex::new(Sampler {
                system: System::new(),
                roots,
                state: MonitorState::default(),
                history: History::default(),
            }),
            subscribers: Mutex::new(HashSet::new()),
            next_subscriber: AtomicU64::new(1),
            events: watch::channel(None).0,
            background: Mutex::new(Background {
                thread: None,
                last_tick: Instant::now(),
                spawn_error: None,
            }),
        }));
        let weak = Arc::downgrade(&monitor.0);
        let spawned = std::thread::Builder::new()
            .name("l1code-resource-monitor".into())
            .spawn(move || run(weak));
        let mut background = lock(&monitor.0.background);
        match spawned {
            Ok(handle) => background.thread = Some(handle.thread().clone()),
            Err(error) => background.spawn_error = Some(error.to_string()),
        }
        drop(background);
        monitor
    }

    pub(crate) fn snapshot(&self) -> ResourceSnapshot {
        self.0.sample()
    }

    pub(crate) fn history(&self, window_ms: u64, bucket_ms: u64) -> ResourceHistory {
        lock(&self.0.sampler)
            .history
            .query(unix_ms(), window_ms, bucket_ms)
    }

    pub(crate) fn subscribe(&self) -> u64 {
        let id = self.0.next_subscriber.fetch_add(1, Ordering::Relaxed);
        lock(&self.0.subscribers).insert(id);
        if let Some(thread) = &lock(&self.0.background).thread {
            thread.unpark();
        }
        id
    }

    pub(crate) fn unsubscribe(&self, id: u64) {
        lock(&self.0.subscribers).remove(&id);
    }

    pub(crate) fn watch(&self) -> watch::Receiver<Option<ResourceSnapshot>> {
        self.0.events.subscribe()
    }

    pub(crate) fn signal(&self, identity: ProcessIdentity, signal: ProcessSignal) -> SignalOutcome {
        let pid = identity.pid;
        if pid == std::process::id() {
            return SignalOutcome::refused("Refusing to signal the L1 Code process.".into());
        }
        let snapshot = self.snapshot();
        let Some(process) = snapshot
            .processes
            .iter()
            .find(|process| process.identity == identity)
        else {
            return SignalOutcome::refused(format!(
                "Process {pid} no longer matches the selected process identity."
            ));
        };
        if !process.category.signalable() {
            return SignalOutcome::refused(format!(
                "Process {pid} is not a signalable L1 Code backend descendant."
            ));
        }
        match send_signal(pid, signal) {
            Ok(()) => SignalOutcome {
                signaled: true,
                message: None,
            },
            Err(error) => SignalOutcome::refused(error),
        }
    }
}

impl Shared {
    fn interval(&self) -> Duration {
        if lock(&self.subscribers).is_empty() {
            IDLE_INTERVAL
        } else {
            LIVE_INTERVAL
        }
    }

    fn health(&self) -> (CollectionStatus, Option<String>) {
        let background = lock(&self.background);
        if let Some(error) = &background.spawn_error {
            return (
                CollectionStatus::Degraded,
                Some(format!("Background sampling is off: {error}")),
            );
        }
        if background.last_tick.elapsed() > IDLE_INTERVAL * 3 {
            return (
                CollectionStatus::Degraded,
                Some("Background sampling stopped. Samples are taken only on refresh.".into()),
            );
        }
        (CollectionStatus::Healthy, None)
    }

    fn sample(&self) -> ResourceSnapshot {
        let interval = self.interval();
        let (status, last_error) = self.health();
        let snapshot = lock(&self.sampler).sample(interval, status, last_error);
        if !lock(&self.subscribers).is_empty() {
            self.events.send_replace(Some(snapshot.clone()));
        }
        snapshot
    }
}

fn run(monitor: Weak<Shared>) {
    loop {
        let interval = match monitor.upgrade() {
            Some(shared) => shared.interval(),
            None => return,
        };
        std::thread::park_timeout(interval);
        let Some(shared) = monitor.upgrade() else {
            return;
        };
        lock(&shared.background).last_tick = Instant::now();
        shared.sample();
    }
}

impl Sampler {
    fn sample(
        &mut self,
        interval: Duration,
        status: CollectionStatus,
        last_error: Option<String>,
    ) -> ResourceSnapshot {
        let started = Instant::now();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().without_tasks(),
        );
        let rows: Vec<ProcessRow> = self
            .system
            .processes()
            .iter()
            .map(|(pid, process)| ProcessRow {
                pid: pid.as_u32(),
                ppid: process.parent().map_or(0, Pid::as_u32),
                start_time_ms: process.start_time().saturating_mul(1_000),
                name: truncate(
                    process.name().to_string_lossy().into_owned(),
                    MAX_NAME_BYTES,
                ),
            })
            .collect();
        let tree = model::build_tree(&rows, &(self.roots)());
        let tracked: Vec<Pid> = tree
            .iter()
            .map(|row| Pid::from_u32(row.identity.pid))
            .collect();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&tracked),
            true,
            ProcessRefreshKind::nothing()
                .with_memory()
                .with_cpu()
                .with_disk_usage()
                .with_cmd(UpdateKind::OnlyIfNotSet)
                .without_tasks(),
        );
        let tracked_count = tree.len();
        let readings: Vec<Reading> = tree
            .into_iter()
            .filter_map(|row| {
                let process = self.system.process(Pid::from_u32(row.identity.pid))?;
                if process.start_time().saturating_mul(1_000) != row.identity.start_time_ms {
                    return None;
                }
                let disk = process.disk_usage();
                let command = if process.cmd().is_empty() {
                    row.name.clone()
                } else {
                    process
                        .cmd()
                        .iter()
                        .map(|part| part.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join(" ")
                };
                Some(Reading {
                    command: truncate(command, MAX_COMMAND_BYTES),
                    counters: Counters {
                        cpu_time_ms: process.accumulated_cpu_time(),
                        io_read_bytes: disk.total_read_bytes,
                        io_write_bytes: disk.total_written_bytes,
                    },
                    resident_bytes: process.memory(),
                    row,
                })
            })
            .collect();
        let retained = readings.len();
        let read_at_ms = unix_ms();
        let advanced = self.state.advance(read_at_ms, readings);
        self.history.push(advanced.entry);
        ResourceSnapshot {
            read_at_ms,
            sample_interval_ms: interval.as_millis() as u64,
            io_semantics: if cfg!(windows) {
                IoSemantics::AllIo
            } else {
                IoSemantics::Storage
            },
            processes: advanced.processes,
            groups: advanced.groups,
            health: CollectionHealth {
                status,
                last_error,
                collection_micros: started.elapsed().as_micros() as u64,
                scanned_process_count: rows.len(),
                retained_process_count: retained,
                inaccessible_process_count: tracked_count - retained,
            },
        }
    }
}

fn send_signal(pid: u32, signal: ProcessSignal) -> Result<(), String> {
    #[cfg(unix)]
    {
        let number = match signal {
            ProcessSignal::Interrupt => libc::SIGINT,
            ProcessSignal::Kill => libc::SIGKILL,
        };
        if unsafe { libc::kill(pid as i32, number) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }
    #[cfg(windows)]
    {
        if signal == ProcessSignal::Interrupt {
            return Err("SIGINT is not available on Windows.".into());
        }
        let status = crate::process::command("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("Failed to send SIGKILL to process {pid}."))
        }
    }
}

fn truncate(mut value: String, max: usize) -> String {
    if value.len() > max {
        let mut end = max;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
    value
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
