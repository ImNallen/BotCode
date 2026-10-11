//! Saved terminal history, ported from T3 Code v0.0.45 apps/server/src/terminal/Manager.ts (persist worker and readHistory).
use super::{
    CloseScope, Session, TerminalKey,
    history::{History, MAX_BYTES},
};
use crate::domain::{ThreadId, WorkspaceId};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use std::{
    collections::{HashMap, hash_map::Entry},
    fs::{self, File},
    hash::Hash,
    io::{self, ErrorKind, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Weak,
        mpsc::{self, RecvTimeoutError},
    },
    time::{Duration, Instant},
};

const DEBOUNCE: Duration = Duration::from_millis(40);

struct Coalescer<K, V> {
    pending: HashMap<K, (Instant, V)>,
}
impl<K: Eq + Hash, V> Default for Coalescer<K, V> {
    fn default() -> Self {
        Self {
            pending: HashMap::new(),
        }
    }
}
impl<K: Eq + Hash, V> Coalescer<K, V> {
    fn mark(&mut self, key: K, value: V, now: Instant) {
        match self.pending.entry(key) {
            Entry::Occupied(mut entry) => entry.get_mut().1 = value,
            Entry::Vacant(entry) => {
                entry.insert((now + DEBOUNCE, value));
            }
        }
    }
    fn due(&mut self, now: Instant) -> Vec<(K, V)> {
        self.pending
            .extract_if(|_, (deadline, _)| *deadline <= now)
            .map(|(key, (_, value))| (key, value))
            .collect()
    }
    fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().map(|(deadline, _)| *deadline).min()
    }
    fn forget(&mut self, matches: impl Fn(&K) -> bool) {
        self.pending.retain(|key, _| !matches(key));
    }
    fn take_all(&mut self) -> Vec<(K, V)> {
        self.pending
            .drain()
            .map(|(key, (_, value))| (key, value))
            .collect()
    }
}

fn workspace_dir(dir: &Path, workspace: &WorkspaceId) -> PathBuf {
    dir.join(workspace.to_string())
}
fn thread_dir(dir: &Path, workspace: &WorkspaceId, thread: Option<&ThreadId>) -> PathBuf {
    workspace_dir(dir, workspace).join(thread.map_or_else(|| "draft".into(), ToString::to_string))
}
fn history_path(dir: &Path, key: &TerminalKey) -> PathBuf {
    thread_dir(dir, &key.workspace, key.thread.as_ref())
        .join(format!("{}.log", URL_SAFE_NO_PAD.encode(&key.terminal.0)))
}
fn remove(dir: &Path, scope: &CloseScope) -> io::Result<()> {
    let removed = match scope {
        CloseScope::Terminal(key) => fs::remove_file(history_path(dir, key)),
        CloseScope::Thread { workspace, thread } => {
            fs::remove_dir_all(thread_dir(dir, workspace, Some(thread)))
        }
        CloseScope::Workspace(workspace) => fs::remove_dir_all(workspace_dir(dir, workspace)),
    };
    match removed {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn read_tail(path: &Path, limit: u64) -> io::Result<Option<(String, bool)>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let size = file.metadata()?.len();
    let offset = size.saturating_sub(limit);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    file.take(size - offset).read_to_end(&mut bytes)?;
    let start = if offset > 0 {
        bytes
            .iter()
            .take_while(|&&byte| byte & 0xC0 == 0x80)
            .count()
    } else {
        0
    };
    Ok(Some((
        String::from_utf8_lossy(&bytes[start..]).into_owned(),
        offset > 0,
    )))
}

fn write(path: &Path, text: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("log.tmp");
    fs::write(&temporary, text)?;
    fs::rename(&temporary, path)
}

enum Job {
    Save(TerminalKey, Weak<Session>),
    Flush(mpsc::Sender<()>),
    Forget(CloseScope, mpsc::Sender<()>),
}

#[derive(Clone)]
pub(super) struct HistoryStore {
    dir: PathBuf,
    jobs: mpsc::Sender<Job>,
}
impl HistoryStore {
    pub(super) fn open(dir: PathBuf) -> io::Result<Self> {
        let (jobs, received) = mpsc::channel();
        let writer = dir.clone();
        std::thread::Builder::new()
            .name("bot-code-terminal-history".into())
            .spawn(move || run(&writer, received))?;
        Ok(Self { dir, jobs })
    }
    pub(super) fn save(&self, key: &TerminalKey, session: Weak<Session>) {
        let _ = self.jobs.send(Job::Save(key.clone(), session));
    }
    pub(super) fn flush(&self) {
        self.wait(Job::Flush);
    }
    pub(super) fn forget(&self, scope: &CloseScope) {
        self.wait(|done| Job::Forget(scope.clone(), done));
    }
    fn wait(&self, job: impl FnOnce(mpsc::Sender<()>) -> Job) {
        let (done, finished) = mpsc::channel();
        if self.jobs.send(job(done)).is_ok() {
            let _ = finished.recv();
        }
    }
    pub(super) fn restore(&self, key: &TerminalKey) -> History {
        let path = history_path(&self.dir, key);
        let mut history = History::default();
        match read_tail(&path, MAX_BYTES as u64) {
            Ok(None) => {}
            Ok(Some((saved, truncated))) => {
                history.append(&saved);
                let capped = history.value();
                if (truncated || capped != saved)
                    && let Err(error) = write(&path, &capped)
                {
                    eprintln!("failed to truncate terminal history: {error}");
                }
            }
            Err(error) => eprintln!("failed to read terminal history: {error}"),
        }
        history
    }
}

fn run(dir: &Path, jobs: mpsc::Receiver<Job>) {
    let save = |key: &TerminalKey, session: &Weak<Session>| {
        let Some(text) = session
            .upgrade()
            .and_then(|session| session.saved_history())
        else {
            return;
        };
        if let Err(error) = write(&history_path(dir, key), &text) {
            eprintln!("failed to persist terminal history: {error}");
        }
    };
    let mut pending = Coalescer::default();
    loop {
        let job = match pending.next_deadline() {
            Some(deadline) => {
                match jobs.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(job) => Some(job),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            None => match jobs.recv() {
                Ok(job) => Some(job),
                Err(_) => break,
            },
        };
        match job {
            Some(Job::Save(key, session)) => pending.mark(key, session, Instant::now()),
            Some(Job::Flush(done)) => {
                for (key, session) in pending.take_all() {
                    save(&key, &session);
                }
                let _ = done.send(());
            }
            Some(Job::Forget(scope, done)) => {
                pending.forget(|key| scope.matches(key));
                if let Err(error) = remove(dir, &scope) {
                    eprintln!("failed to delete terminal history: {error}");
                }
                let _ = done.send(());
            }
            None => {}
        }
        for (key, session) in pending.due(Instant::now()) {
            save(&key, &session);
        }
    }
    for (key, session) in pending.take_all() {
        save(&key, &session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(workspace: &WorkspaceId, thread: Option<&ThreadId>, terminal: &str) -> TerminalKey {
        TerminalKey {
            workspace: workspace.clone(),
            thread: thread.cloned(),
            terminal: terminal.parse().unwrap(),
        }
    }

    #[test]
    fn coalescer_writes_the_latest_value_once_per_deadline() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut coalescer = Coalescer::default();
        coalescer.mark("a", 1, at(0));
        coalescer.mark("a", 2, at(30));
        assert_eq!(coalescer.next_deadline(), Some(at(40)));
        assert_eq!(coalescer.due(at(39)), []);
        assert_eq!(coalescer.due(at(40)), [("a", 2)]);
        assert_eq!(coalescer.due(at(41)), []);
        assert_eq!(coalescer.next_deadline(), None);

        coalescer.mark("a", 3, at(100));
        coalescer.mark("b", 4, at(110));
        assert_eq!(coalescer.next_deadline(), Some(at(140)));
        coalescer.forget(|key| *key == "a");
        assert_eq!(coalescer.next_deadline(), Some(at(150)));
        assert_eq!(coalescer.take_all(), [("b", 4)]);
        assert_eq!(coalescer.due(at(1_000)), []);
    }

    #[test]
    fn history_paths_nest_terminals_under_their_workspace_and_thread() {
        let workspace: WorkspaceId = "6f1c2b9e-0000-4000-8000-000000000001".parse().unwrap();
        let thread: ThreadId = "9a2e4d1c-0000-4000-8000-000000000002".parse().unwrap();
        let dir = Path::new("/data/logs/terminals");
        assert_eq!(
            history_path(dir, &key(&workspace, Some(&thread), "term-1")),
            Path::new(
                "/data/logs/terminals/6f1c2b9e-0000-4000-8000-000000000001/9a2e4d1c-0000-4000-8000-000000000002/dGVybS0x.log"
            )
        );
        assert_eq!(
            history_path(dir, &key(&workspace, None, "名/..")),
            Path::new(
                "/data/logs/terminals/6f1c2b9e-0000-4000-8000-000000000001/draft/5ZCNLy4u.log"
            )
        );
    }

    #[test]
    fn tail_reads_skip_a_split_code_point() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.log");
        fs::write(&path, "éééé").unwrap();
        assert_eq!(read_tail(&path, 5).unwrap(), Some(("éé".to_owned(), true)));
        assert_eq!(
            read_tail(&path, 100).unwrap(),
            Some(("éééé".to_owned(), false))
        );
        assert_eq!(read_tail(&dir.path().join("missing.log"), 5).unwrap(), None);
    }

    #[test]
    fn restore_recaps_and_rewrites_the_saved_history() {
        let dir = tempfile::tempdir().unwrap();
        let (jobs, _) = mpsc::channel();
        let store = HistoryStore {
            dir: dir.path().into(),
            jobs,
        };
        let workspace = WorkspaceId::default();
        let lines = key(&workspace, None, "lines");
        let path = history_path(dir.path(), &lines);
        let saved: String = (0..5_003).map(|line| format!("l{line}\n")).collect();
        write(&path, &saved).unwrap();
        let restored = store.restore(&lines).value();
        assert!(restored.starts_with("l3\nl4\n"), "{}", &restored[..12]);
        assert!(restored.ends_with("l5002\n"));
        assert_eq!(restored.lines().count(), 5_000);
        assert_eq!(fs::read_to_string(&path).unwrap(), restored);

        let long = key(&workspace, None, "long");
        let path = history_path(dir.path(), &long);
        write(&path, &format!("dropped\n{}", "k".repeat(MAX_BYTES))).unwrap();
        assert_eq!(store.restore(&long).value(), "k".repeat(MAX_BYTES));
        assert_eq!(fs::read_to_string(&path).unwrap(), "k".repeat(MAX_BYTES));

        assert_eq!(store.restore(&key(&workspace, None, "none")).value(), "");
    }

    #[test]
    fn scopes_remove_files_of_terminals_that_are_not_running() {
        let dir = tempfile::tempdir().unwrap();
        let (workspace, other) = (WorkspaceId::default(), WorkspaceId::default());
        let (thread, sibling) = (ThreadId::default(), ThreadId::default());
        let paths = [
            history_path(dir.path(), &key(&workspace, Some(&thread), "term-1")),
            history_path(dir.path(), &key(&workspace, Some(&thread), "term-2")),
            history_path(dir.path(), &key(&workspace, Some(&sibling), "term-1")),
            history_path(dir.path(), &key(&workspace, None, "term-1")),
            history_path(dir.path(), &key(&other, None, "term-1")),
        ];
        for path in &paths {
            write(path, "saved\n").unwrap();
        }
        let exists = || paths.iter().map(|path| path.exists()).collect::<Vec<_>>();
        let terminal = CloseScope::Terminal(key(&workspace, Some(&thread), "term-2"));
        remove(dir.path(), &terminal).unwrap();
        remove(dir.path(), &terminal).unwrap();
        assert_eq!(exists(), [true, false, true, true, true]);
        let thread_scope = CloseScope::Thread {
            workspace: workspace.clone(),
            thread,
        };
        remove(dir.path(), &thread_scope).unwrap();
        remove(dir.path(), &thread_scope).unwrap();
        assert_eq!(exists(), [false, false, true, true, true]);
        remove(dir.path(), &CloseScope::Workspace(workspace.clone())).unwrap();
        assert_eq!(exists(), [false, false, false, false, true]);
        assert!(!workspace_dir(dir.path(), &workspace).exists());
    }
}
