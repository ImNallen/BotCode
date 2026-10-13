use super::model::{
    Counters, HISTORY_CAPACITY, HISTORY_WINDOW_MS, History, HistoryEntry, HistoryPoint,
    MonitorState, ProcessRow, Reading, TreeRow, build_tree,
};
use super::*;
use crate::ThreadId;
use std::collections::HashMap;

fn row(pid: u32, ppid: u32, start_time_ms: u64, name: &str) -> ProcessRow {
    ProcessRow {
        pid,
        ppid,
        start_time_ms,
        name: name.into(),
    }
}

fn app_roots(pid: u32) -> KnownRoots {
    HashMap::from([(pid, Root::App)])
}

#[test]
fn tree_drops_a_reused_pid_and_orders_rows_depth_first() {
    let rows = [
        row(1, 0, 0, "launchd"),
        row(250, 100, 3_000, "second"),
        row(100, 1, 1_000, "l1-code"),
        row(300, 100, 500, "reused"),
        row(301, 300, 600, "under-reused"),
        row(400, 200, 2_500, "grandchild"),
        row(200, 100, 2_000, "first"),
        row(500, 1, 4_000, "unrelated"),
    ];
    let tree = build_tree(&rows, &app_roots(100));
    let order: Vec<(u32, u16)> = tree
        .iter()
        .map(|row| (row.identity.pid, row.depth))
        .collect();
    assert_eq!(order, [(100, 0), (200, 1), (400, 2), (250, 1)]);
    assert_eq!(tree[0].child_pids, [200, 250]);
}

#[test]
fn categories_come_from_known_roots_and_descendants_follow_their_root() {
    let thread = ThreadId::default();
    let roots = KnownRoots::from([
        (100, Root::App),
        (200, Root::Provider),
        (
            300,
            Root::Terminal {
                thread_id: Some(thread.clone()),
            },
        ),
    ]);
    let rows = [
        row(100, 1, 1_000, "l1-code"),
        row(200, 100, 1_100, "codex"),
        row(210, 200, 1_200, "rg"),
        row(300, 100, 1_300, "zsh"),
        row(310, 300, 1_400, "cargo"),
        row(311, 310, 1_500, "rustc"),
        row(400, 100, 1_600, "msedgewebview2.exe"),
        row(410, 400, 1_700, "renderer"),
        row(500, 100, 1_800, "gh"),
    ];
    let tree = build_tree(&rows, &roots);
    let summary: Vec<(u32, u32, ProcessCategory)> = tree
        .iter()
        .map(|row| (row.identity.pid, row.ppid, row.category))
        .collect();
    assert_eq!(
        summary,
        [
            (100, 1, ProcessCategory::App),
            (200, 100, ProcessCategory::Provider),
            (210, 200, ProcessCategory::BackendChild),
            (300, 100, ProcessCategory::Terminal),
            (310, 300, ProcessCategory::BackendChild),
            (311, 310, ProcessCategory::BackendChild),
            (400, 100, ProcessCategory::Webview),
            (410, 400, ProcessCategory::Webview),
            (500, 100, ProcessCategory::BackendChild),
        ]
    );
    assert_eq!(tree[3].thread_id, Some(thread));
    assert_eq!(tree[4].thread_id, None);
}

fn reading(pid: u32, cpu_time_ms: u64, io_read_bytes: u64, resident_bytes: u64) -> Reading {
    Reading {
        row: TreeRow {
            identity: ProcessIdentity {
                pid,
                start_time_ms: 1_000,
            },
            ppid: 1,
            depth: 0,
            name: "l1-code".into(),
            category: ProcessCategory::App,
            thread_id: None,
            child_pids: vec![],
        },
        command: "l1-code".into(),
        counters: Counters {
            cpu_time_ms,
            io_read_bytes,
            io_write_bytes: 0,
        },
        resident_bytes,
    }
}

#[test]
fn rates_are_zero_across_a_long_gap_or_a_falling_counter_and_exact_otherwise() {
    let mut state = MonitorState::default();
    state.advance(10_000, vec![reading(7, 1_000, 0, 10)]);

    let normal = state.advance(12_000, vec![reading(7, 1_500, 4_096, 30)]);
    let process = &normal.processes[0];
    assert_eq!(process.cpu_percent, 25.0);
    assert_eq!(process.io_read_bytes_per_second, 2_048.0);
    assert_eq!(normal.groups.all.cpu_time_ms, 500);
    assert_eq!(normal.groups.all.io_read_bytes, 4_096);
    assert_eq!(normal.groups.all.peak_rss_bytes, 30);

    let gap = state.advance(42_001, vec![reading(7, 9_000, 9_000, 20)]);
    assert_eq!(gap.processes[0].cpu_percent, 0.0);
    assert_eq!(gap.processes[0].io_read_bytes_per_second, 0.0);
    assert_eq!(gap.groups.all.cpu_time_ms, 500);
    assert_eq!(gap.groups.all.peak_rss_bytes, 30);

    let falling = state.advance(43_001, vec![reading(7, 8_000, 100, 20)]);
    assert_eq!(falling.processes[0].cpu_percent, 0.0);
    assert_eq!(falling.processes[0].io_read_bytes_per_second, 0.0);
    assert_eq!(falling.groups.all.process_starts, 1);

    let exited = state.advance(44_001, vec![]);
    assert_eq!(exited.groups.all.process_exits, 1);
    assert_eq!(exited.groups.all.process_count, 0);
}

fn point(pid: u32, cpu_percent: f64, resident_bytes: u64, io_read_bytes: u64) -> HistoryPoint {
    HistoryPoint {
        identity: ProcessIdentity {
            pid,
            start_time_ms: 0,
        },
        name: "p".into(),
        command: "p".into(),
        category: ProcessCategory::BackendChild,
        cpu_percent,
        cpu_time_ms: cpu_percent as u64,
        resident_bytes,
        io_read_bytes,
        io_write_bytes: 1,
    }
}

#[test]
fn buckets_give_exact_averages_and_peaks_and_drop_samples_outside_the_window() {
    let mut history = History::default();
    let entries = [
        (30_000, vec![point(1, 99.0, 9_000, 9_000)]),
        (45_000, vec![point(1, 4.0, 100, 10), point(2, 6.0, 200, 20)]),
        (50_000, vec![point(1, 30.0, 50, 5)]),
        (80_000, vec![point(2, 5.0, 70, 7)]),
    ];
    for (at_ms, points) in entries {
        history.push(HistoryEntry { at_ms, points });
    }
    let result = history.query(100_000, 60_000, 30_000);
    assert_eq!(
        result.buckets,
        [
            HistoryBucket {
                started_at_ms: 40_000,
                avg_cpu_percent: 20.0,
                max_cpu_percent: 30.0,
                max_rss_bytes: 300,
                io_read_bytes: 35,
                io_write_bytes: 3,
            },
            HistoryBucket {
                started_at_ms: 70_000,
                avg_cpu_percent: 5.0,
                max_cpu_percent: 5.0,
                max_rss_bytes: 70,
                io_read_bytes: 7,
                io_write_bytes: 1,
            },
        ]
    );
    let top: Vec<(u32, u64, u64, usize)> = result
        .top_processes
        .iter()
        .map(|process| {
            (
                process.identity.pid,
                process.cpu_time_ms,
                process.peak_rss_bytes,
                process.sample_count,
            )
        })
        .collect();
    assert_eq!(top, [(1, 34, 100, 2), (2, 11, 200, 2)]);
}

#[test]
fn retention_evicts_the_oldest_samples_past_the_cap_and_the_hour() {
    let mut history = History::default();
    for at_ms in 0..=HISTORY_CAPACITY as u64 {
        history.push(HistoryEntry {
            at_ms,
            points: vec![],
        });
    }
    assert_eq!(history.len(), HISTORY_CAPACITY);
    assert_eq!(history.oldest_at_ms(), Some(1));

    history.push(HistoryEntry {
        at_ms: HISTORY_CAPACITY as u64 + HISTORY_WINDOW_MS,
        points: vec![],
    });
    assert_eq!(history.len(), 2);
    assert_eq!(history.oldest_at_ms(), Some(HISTORY_CAPACITY as u64));
}

#[cfg(unix)]
fn spawn_sleep() -> std::process::Child {
    crate::process::command("sleep").arg("30").spawn().unwrap()
}

#[cfg(unix)]
fn monitor_rooted_at(pid: u32) -> ResourceMonitor {
    ResourceMonitor::start(Arc::new(move || app_roots(pid)))
}

#[cfg(unix)]
fn identity_of(monitor: &ResourceMonitor, pid: u32) -> ProcessIdentity {
    monitor
        .snapshot()
        .processes
        .iter()
        .find(|process| process.identity.pid == pid)
        .map(|process| process.identity)
        .unwrap()
}

#[cfg(unix)]
#[test]
fn signal_refuses_the_app_pid_a_stale_start_time_and_an_app_row() {
    let this = std::process::id();
    let mut child = spawn_sleep();
    let monitor = monitor_rooted_at(this);
    let app = identity_of(&monitor, this);
    let sleeper = identity_of(&monitor, child.id());

    assert_eq!(
        monitor.signal(app, ProcessSignal::Kill),
        SignalOutcome::refused("Refusing to signal the L1 Code process.".into())
    );
    let stale = ProcessIdentity {
        start_time_ms: sleeper.start_time_ms + 1_000,
        ..sleeper
    };
    assert_eq!(
        monitor.signal(stale, ProcessSignal::Kill),
        SignalOutcome::refused(format!(
            "Process {} no longer matches the selected process identity.",
            child.id()
        ))
    );
    let rooted_at_child = monitor_rooted_at(child.id());
    assert_eq!(
        rooted_at_child.signal(sleeper, ProcessSignal::Kill),
        SignalOutcome::refused(format!(
            "Process {} is not a signalable L1 Code backend descendant.",
            child.id()
        ))
    );
    assert!(
        child.try_wait().unwrap().is_none(),
        "every refusal left it running"
    );
    child.kill().unwrap();
    child.wait().unwrap();
}

#[cfg(unix)]
#[test]
fn signal_kills_a_backend_child_that_then_leaves_the_snapshot() {
    use std::os::unix::process::ExitStatusExt;
    let mut child = spawn_sleep();
    let monitor = monitor_rooted_at(std::process::id());
    let sleeper = identity_of(&monitor, child.id());

    assert_eq!(
        monitor.signal(sleeper, ProcessSignal::Kill),
        SignalOutcome {
            signaled: true,
            message: None
        }
    );
    assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
    assert!(
        !monitor
            .snapshot()
            .processes
            .iter()
            .any(|process| process.identity == sleeper)
    );
}

#[cfg(unix)]
#[test]
fn a_live_snapshot_includes_this_process_and_a_spawned_child_with_resident_memory() {
    let this = std::process::id();
    let mut child = spawn_sleep();
    let snapshot = monitor_rooted_at(this).snapshot();
    let app = snapshot
        .processes
        .iter()
        .find(|process| process.identity.pid == this)
        .unwrap();
    let sleeper = snapshot
        .processes
        .iter()
        .find(|process| process.identity.pid == child.id())
        .unwrap();
    assert_eq!((app.category, app.depth), (ProcessCategory::App, 0));
    assert_eq!(
        (sleeper.category, sleeper.ppid, sleeper.depth),
        (ProcessCategory::BackendChild, this, 1)
    );
    assert!(app.resident_bytes > 0 && sleeper.resident_bytes > 0);
    assert!(sleeper.command.contains("sleep 30"), "{}", sleeper.command);
    assert!(app.child_pids.contains(&child.id()));
    assert_eq!(snapshot.health.status, CollectionStatus::Healthy);
    child.kill().unwrap();
    child.wait().unwrap();
}
