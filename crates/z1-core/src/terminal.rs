//! Integrated terminals: one PTY shell per `TerminalKey`, independent of the conversation owner.
mod history;
use crate::domain::*;
use history::History;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::OsString,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

/// A client-chosen terminal name such as `term-1`, unique within its thread.
#[derive(Debug, Clone, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct TerminalId(String);
impl TryFrom<String> for TerminalId {
    type Error = AppError;
    fn try_from(value: String) -> Result<Self> {
        let id = value.trim();
        if id.is_empty() || id.chars().count() > 128 {
            return Err(AppError::new(
                "invalid_terminal",
                "Terminal ids are 1 to 128 characters.",
            ));
        }
        Ok(Self(id.into()))
    }
}
impl From<TerminalId> for String {
    fn from(id: TerminalId) -> Self {
        id.0
    }
}
impl std::str::FromStr for TerminalId {
    type Err = AppError;
    fn from_str(s: &str) -> Result<Self> {
        s.to_owned().try_into()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    Snapshot {
        history: String,
    },
    Output {
        data: String,
    },
    /// `None` when a signal ended the shell.
    Exited {
        exit_code: Option<i32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TerminalSize {
    cols: u16,
    rows: u16,
}
impl TerminalSize {
    pub(crate) fn new(cols: u16, rows: u16) -> Result<Self> {
        if !(1..=1000).contains(&cols) || !(1..=500).contains(&rows) {
            return Err(AppError::new(
                "invalid_terminal_size",
                "Terminals are 1 to 1000 columns and 1 to 500 rows.",
            ));
        }
        Ok(Self { cols, rows })
    }
    fn pty(self) -> PtySize {
        PtySize {
            rows: self.rows,
            cols: self.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

pub(crate) const MAX_WRITE_BYTES: usize = 65_536;

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub(crate) struct TerminalKey {
    pub workspace: WorkspaceId,
    /// `None` is a repository draft that has no thread yet.
    pub thread: Option<ThreadId>,
    pub terminal: TerminalId,
}

pub(crate) type Sink = Arc<dyn Fn(TerminalEvent) + Send + Sync>;

struct Output {
    history: History,
    /// An incomplete control sequence the sanitizer carries into the next chunk.
    pending: String,
    subscribers: Vec<(u64, Sink)>,
}

struct Session {
    /// The shell leads its own session and process group, so this is also the group id.
    pid: i32,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    output: Mutex<Output>,
}
impl Session {
    fn resize(&self, size: TerminalSize) -> Result<()> {
        lock(&self.master).resize(size.pty()).map_err(pty_error)
    }
    fn write(&self, data: &[u8]) -> Result<()> {
        let mut writer = lock(&self.writer);
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }
    fn publish(&self, data: String) {
        let mut output = lock(&self.output);
        let (visible, pending) = history::sanitize(&output.pending, &data);
        output.pending = pending;
        output.history.append(&visible);
        for (_, sink) in &output.subscribers {
            sink(TerminalEvent::Output { data: data.clone() });
        }
    }
    fn running(&self) -> bool {
        matches!(lock(&self.child).try_wait(), Ok(None))
    }
    fn signal(&self, signal: i32) {
        unsafe {
            libc::kill(-self.pid, signal);
        }
    }
    /// Polls instead of blocking in `wait`, so `terminate` can take the child lock meanwhile.
    fn reap(&self) -> Option<i32> {
        loop {
            match lock(&self.child).try_wait() {
                Ok(Some(status)) if status.signal().is_none() => {
                    return Some(status.exit_code() as i32);
                }
                Ok(Some(_)) | Err(_) => return None,
                Ok(None) => {}
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// Interactive shells ignore SIGTERM, so each group gets SIGHUP and, a second later, SIGKILL.
fn terminate(sessions: &[Arc<Session>]) {
    let live: Vec<&Arc<Session>> = sessions.iter().filter(|s| s.running()).collect();
    for session in &live {
        session.signal(libc::SIGHUP);
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    while live.iter().any(|s| s.running()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    for session in &live {
        if session.running() {
            session.signal(libc::SIGKILL);
        }
        session.reap();
        // Members that outlived the shell, such as a job that ignores SIGHUP.
        session.signal(libc::SIGKILL);
    }
}

fn pty_error(e: impl ToString) -> AppError {
    AppError::new("terminal", e)
}
fn lock<T: ?Sized>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Registry {
    shell: Option<PathBuf>,
    sessions: Mutex<HashMap<TerminalKey, Arc<Session>>>,
    subscriptions: AtomicU64,
}
impl Drop for Registry {
    fn drop(&mut self) {
        let sessions: Vec<_> = lock(&self.sessions).drain().map(|(_, s)| s).collect();
        if !sessions.is_empty() {
            std::thread::spawn(move || terminate(&sessions));
        }
    }
}

/// Live shells keyed by `TerminalKey`. Dropping the last handle kills every shell.
#[derive(Clone)]
pub(crate) struct Terminals(Arc<Registry>);
impl Terminals {
    pub(crate) fn new(shell: Option<PathBuf>) -> Self {
        Self(Arc::new(Registry {
            shell,
            sessions: Mutex::new(HashMap::new()),
            subscriptions: AtomicU64::new(1),
        }))
    }
    fn get(&self, key: &TerminalKey) -> Option<Arc<Session>> {
        lock(&self.0.sessions).get(key).cloned()
    }
    /// Resizes the session at `key`, spawning a shell in `cwd` first when there is none, then
    /// sends the history snapshot and registers `sink` in one step, so no output is lost or
    /// repeated between them. `Ok(None)` means there is no session and no `cwd` to start one.
    pub(crate) fn attach(
        &self,
        key: TerminalKey,
        cwd: Option<&Path>,
        size: TerminalSize,
        sink: Sink,
    ) -> Result<Option<u64>> {
        let session = {
            let mut sessions = lock(&self.0.sessions);
            match (sessions.get(&key), cwd) {
                (Some(session), _) => session.clone(),
                (None, None) => return Ok(None),
                (None, Some(cwd)) => {
                    let (session, reader) = spawn(self.0.shell.as_deref(), cwd, size)?;
                    let registry = Arc::downgrade(&self.0);
                    let (pumped, pump_key) = (session.clone(), key.clone());
                    // The pump touches the registry only after end of file, behind this lock.
                    if let Err(error) = std::thread::Builder::new()
                        .name("z1-terminal".into())
                        .spawn(move || pump(registry, pump_key, pumped, reader))
                    {
                        terminate(&[session]);
                        return Err(error.into());
                    }
                    sessions.insert(key, session.clone());
                    session
                }
            }
        };
        session.resize(size)?;
        let id = self.0.subscriptions.fetch_add(1, Ordering::Relaxed);
        let mut output = lock(&session.output);
        sink(TerminalEvent::Snapshot {
            history: output.history.value(),
        });
        output.subscribers.push((id, sink));
        Ok(Some(id))
    }
    pub(crate) fn detach(&self, subscription: u64) {
        for session in lock(&self.0.sessions).values() {
            lock(&session.output)
                .subscribers
                .retain(|(id, _)| *id != subscription);
        }
    }
    /// Blocks while the shell is not reading and the PTY buffer is full.
    pub(crate) fn write(&self, key: &TerminalKey, data: &[u8]) -> Result<()> {
        match self.get(key) {
            Some(session) => session.write(data),
            None => Ok(()),
        }
    }
    pub(crate) fn resize(&self, key: &TerminalKey, size: TerminalSize) -> Result<()> {
        match self.get(key) {
            Some(session) => session.resize(size),
            None => Ok(()),
        }
    }
    /// Blocks up to about a second while shells exit.
    pub(crate) fn close(&self, matches: impl Fn(&TerminalKey) -> bool) {
        let closed: Vec<Arc<Session>> = {
            let mut sessions = lock(&self.0.sessions);
            let keys: Vec<TerminalKey> = sessions.keys().filter(|k| matches(k)).cloned().collect();
            keys.iter().filter_map(|k| sessions.remove(k)).collect()
        };
        terminate(&closed);
    }
}

/// Reads until the PTY closes, then reaps the shell and retires the session.
fn pump(
    registry: Weak<Registry>,
    key: TerminalKey,
    session: Arc<Session>,
    mut reader: Box<dyn Read + Send>,
) {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut carry = Vec::new();
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                let data = history::decode(&mut carry, &buffer[..n]);
                if !data.is_empty() {
                    session.publish(data);
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            // macOS reports a closed PTY as EIO rather than end of file.
            Err(_) => break,
        }
    }
    let exit_code = session.reap();
    if let Some(registry) = registry.upgrade() {
        let mut sessions = lock(&registry.sessions);
        // A close followed by a new attach may have replaced this session.
        if sessions.get(&key).is_some_and(|s| Arc::ptr_eq(s, &session)) {
            sessions.remove(&key);
        }
    }
    let mut output = lock(&session.output);
    for (_, sink) in output.subscribers.drain(..) {
        sink(TerminalEvent::Exited { exit_code });
    }
}

fn spawn(
    pinned: Option<&Path>,
    cwd: &Path,
    size: TerminalSize,
) -> Result<(Arc<Session>, Box<dyn Read + Send>)> {
    if !cwd.is_dir() {
        return Err(AppError::new(
            "terminal_unavailable",
            format!("{} is not a directory.", cwd.display()),
        ));
    }
    let pair = native_pty_system().openpty(size.pty()).map_err(pty_error)?;
    let candidates = shell_candidates(pinned, std::env::var_os("SHELL"), cfg!(target_os = "macos"));
    let environment = shell_environment(std::env::vars_os());
    let (program, args) = candidates
        .into_iter()
        .find(|(program, _)| program.exists())
        .ok_or_else(|| AppError::new("terminal_unavailable", "No shell was found."))?;
    let mut command = CommandBuilder::new(&program);
    command.args(args);
    command.cwd(cwd);
    command.env_clear();
    for (key, value) in environment {
        command.env(key, value);
    }
    let child = pair.slave.spawn_command(command).map_err(pty_error)?;
    // The shell holds the only slave descriptor, so its exit closes the PTY.
    drop(pair.slave);
    let pid = child
        .process_id()
        .ok_or_else(|| AppError::new("terminal", "The shell did not start."))? as i32;
    let reader = pair.master.try_clone_reader().map_err(pty_error)?;
    let writer = pair.master.take_writer().map_err(pty_error)?;
    let session = Arc::new(Session {
        pid,
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        output: Mutex::new(Output {
            history: History::default(),
            pending: String::new(),
            subscribers: Vec::new(),
        }),
    });
    Ok((session, reader))
}

/// A pinned shell is the only candidate. A relative `$SHELL` is skipped, since only absolute
/// paths can be checked for existence before spawning.
fn shell_candidates(
    pinned: Option<&Path>,
    env_shell: Option<OsString>,
    login: bool,
) -> Vec<(PathBuf, Vec<&'static str>)> {
    let paths: Vec<PathBuf> = match pinned {
        Some(shell) => vec![shell.to_path_buf()],
        None => env_shell
            .map(PathBuf::from)
            .filter(|shell| shell.is_absolute())
            .into_iter()
            .chain(["/bin/zsh", "/bin/bash", "/bin/sh"].map(PathBuf::from))
            .collect(),
    };
    let mut candidates: Vec<(PathBuf, Vec<&'static str>)> = Vec::new();
    for path in paths {
        if candidates.iter().any(|(seen, _)| *seen == path) {
            continue;
        }
        // A Finder-launched app inherits launchd's minimal PATH; Terminal.app runs login shells.
        let mut args = if login { vec!["-l"] } else { vec![] };
        if path.file_name().is_some_and(|name| name == "zsh") {
            args.extend(["-o", "nopromptsp"]);
        }
        candidates.push((path, args));
    }
    candidates
}

fn shell_environment(
    base: impl Iterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    let mut environment: Vec<(OsString, OsString)> = base
        .filter(|(key, value)| {
            !key.to_string_lossy().starts_with("Z1_")
                && key != "TERM"
                && (key != "COLORTERM" || !value.is_empty())
        })
        .collect();
    environment.push(("TERM".into(), "xterm-256color".into()));
    if !environment.iter().any(|(key, _)| key == "COLORTERM") {
        environment.push(("COLORTERM".into(), "truecolor".into()));
    }
    environment
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    #[test]
    fn environment_drops_z1_variables_and_sets_terminal_type() {
        assert_eq!(
            shell_environment(
                env(&[
                    ("PATH", "/usr/bin"),
                    ("Z1_DATA_DIR", "/state"),
                    ("Z1_SHELL", "/bin/sh"),
                    ("TERM", "dumb"),
                    ("COLORTERM", ""),
                ])
                .into_iter()
            ),
            env(&[
                ("PATH", "/usr/bin"),
                ("TERM", "xterm-256color"),
                ("COLORTERM", "truecolor"),
            ])
        );
        assert_eq!(
            shell_environment(env(&[("COLORTERM", "24bit")]).into_iter()),
            env(&[("COLORTERM", "24bit"), ("TERM", "xterm-256color")])
        );
    }
    #[test]
    fn shell_candidates_prefer_shell_then_system_shells() {
        let paths = |c: Vec<(PathBuf, Vec<&str>)>| {
            c.into_iter()
                .map(|(p, a)| format!("{} {}", p.display(), a.join(" ")))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            paths(shell_candidates(
                None,
                Some("/opt/homebrew/bin/fish".into()),
                true
            )),
            [
                "/opt/homebrew/bin/fish -l",
                "/bin/zsh -l -o nopromptsp",
                "/bin/bash -l",
                "/bin/sh -l"
            ]
        );
        assert_eq!(
            paths(shell_candidates(None, Some("/bin/zsh".into()), false)),
            ["/bin/zsh -o nopromptsp", "/bin/bash ", "/bin/sh "]
        );
        assert_eq!(
            paths(shell_candidates(None, Some("fish".into()), false)),
            ["/bin/zsh -o nopromptsp", "/bin/bash ", "/bin/sh "]
        );
        assert_eq!(
            paths(shell_candidates(
                Some(Path::new("/bin/sh")),
                Some("/bin/zsh".into()),
                true
            )),
            ["/bin/sh -l"]
        );
    }
    #[test]
    fn terminal_ids_are_trimmed_and_bounded() {
        assert_eq!("  term-1 ".parse::<TerminalId>().unwrap().0, "term-1");
        assert!("   ".parse::<TerminalId>().is_err());
        assert!("x".repeat(129).parse::<TerminalId>().is_err());
        assert!("名".repeat(128).parse::<TerminalId>().is_ok());
    }
}
