mod history;
use crate::{domain::*, process::Kill};
use history::History;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
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
const KILL_GRACE: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub(crate) struct TerminalKey {
    pub workspace: WorkspaceId,
    pub thread: Option<ThreadId>,
    pub terminal: TerminalId,
}

pub(crate) type Sink = Arc<dyn Fn(TerminalEvent) + Send + Sync>;

struct Output {
    history: History,
    unfinished_sequence: String,
    subscribers: Vec<(u64, Sink)>,
    exited: bool,
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
        let (visible, unfinished) = history::sanitize(&output.unfinished_sequence, &data);
        output.unfinished_sequence = unfinished;
        output.history.append(&visible);
        for (_, sink) in &output.subscribers {
            sink(TerminalEvent::Output { data: data.clone() });
        }
    }
    fn running(&self) -> bool {
        matches!(lock(&self.child).try_wait(), Ok(None))
    }
    /// A polite stop hangs up, since interactive shells ignore SIGTERM.
    fn signal(&self, kill: Kill) {
        #[cfg(unix)]
        unsafe {
            let signal = match kill {
                Kill::Polite => libc::SIGHUP,
                Kill::Force => libc::SIGKILL,
            };
            libc::kill(-self.pid, signal);
        }
        #[cfg(windows)]
        crate::process::kill_tree(self.pid as u32, kill);
    }
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

/// Each group gets a hangup and, a second later, a kill.
fn terminate(sessions: &[Arc<Session>]) {
    let live: Vec<&Arc<Session>> = sessions.iter().filter(|s| s.running()).collect();
    for session in &live {
        session.signal(Kill::Polite);
    }
    let deadline = Instant::now() + KILL_GRACE;
    while live.iter().any(|s| s.running()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    for session in &live {
        if session.running() {
            session.signal(Kill::Force);
        }
        session.reap();
        session.signal(Kill::Force);
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
    blocked: Mutex<HashSet<ThreadId>>,
}
impl Drop for Registry {
    fn drop(&mut self) {
        let sessions: Vec<_> = lock(&self.sessions).drain().map(|(_, s)| s).collect();
        if !sessions.is_empty() {
            std::thread::spawn(move || terminate(&sessions));
        }
    }
}

#[derive(Clone)]
pub(crate) struct Terminals(Arc<Registry>);
impl Terminals {
    pub(crate) fn new(shell: Option<PathBuf>) -> Self {
        Self(Arc::new(Registry {
            shell,
            sessions: Mutex::new(HashMap::new()),
            subscriptions: AtomicU64::new(1),
            blocked: Mutex::new(HashSet::new()),
        }))
    }
    fn get(&self, key: &TerminalKey) -> Option<Arc<Session>> {
        lock(&self.0.sessions).get(key).cloned()
    }
    pub(crate) fn attach(
        &self,
        key: TerminalKey,
        cwd: Option<&Path>,
        size: TerminalSize,
        sink: Sink,
    ) -> Result<Option<u64>> {
        loop {
            let blocked = lock(&self.0.blocked);
            if key.thread.as_ref().is_some_and(|id| blocked.contains(id)) {
                return Err(AppError::new(
                    "missing_thread",
                    "This thread is being deleted.",
                ));
            }
            let session = {
                let mut sessions = lock(&self.0.sessions);
                match (sessions.get(&key), cwd) {
                    (Some(session), _) => session.clone(),
                    (None, None) => return Ok(None),
                    (None, Some(cwd)) => {
                        let (session, reader) = spawn(self.0.shell.as_deref(), cwd, size)?;
                        let registry = Arc::downgrade(&self.0);
                        let (pumped, pump_key) = (session.clone(), key.clone());
                        if let Err(error) = std::thread::Builder::new()
                            .name("bot-code-terminal".into())
                            .spawn(move || pump(registry, pump_key, pumped, reader))
                        {
                            terminate(&[session]);
                            return Err(error.into());
                        }
                        sessions.insert(key.clone(), session.clone());
                        session
                    }
                }
            };
            drop(blocked);
            session.resize(size)?;
            let mut output = lock(&session.output);
            if output.exited {
                continue;
            }
            let id = self.0.subscriptions.fetch_add(1, Ordering::Relaxed);
            sink(TerminalEvent::Snapshot {
                history: output.history.value(),
            });
            output.subscribers.push((id, sink));
            return Ok(Some(id));
        }
    }
    pub(crate) fn block_thread(&self, id: &ThreadId) {
        lock(&self.0.blocked).insert(id.clone());
    }
    pub(crate) fn unblock_thread(&self, id: &ThreadId) {
        lock(&self.0.blocked).remove(id);
    }
    pub(crate) fn detach(&self, subscription: u64) {
        for session in lock(&self.0.sessions).values() {
            lock(&session.output)
                .subscribers
                .retain(|(id, _)| *id != subscription);
        }
    }
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
    pub(crate) fn close(&self, matches: impl Fn(&TerminalKey) -> bool) {
        let closed: Vec<Arc<Session>> = {
            let mut sessions = lock(&self.0.sessions);
            let keys: Vec<TerminalKey> = sessions.keys().filter(|k| matches(k)).cloned().collect();
            keys.iter().filter_map(|k| sessions.remove(k)).collect()
        };
        terminate(&closed);
    }
}

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
        if sessions.get(&key).is_some_and(|s| Arc::ptr_eq(s, &session)) {
            sessions.remove(&key);
        }
    }
    let mut output = lock(&session.output);
    output.exited = true;
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
    let environment = shell_environment(std::env::vars_os());
    let (program, args) = resolve_shell(pinned)
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
            unfinished_sequence: String::new(),
            subscribers: Vec::new(),
            exited: false,
        }),
    });
    Ok((session, reader))
}

pub(crate) fn resolve_shell(pinned: Option<&Path>) -> Option<(PathBuf, Vec<&'static str>)> {
    #[cfg(windows)]
    let candidates = windows_shell_candidates(pinned);
    #[cfg(not(windows))]
    let candidates = shell_candidates(pinned, std::env::var_os("SHELL"), cfg!(target_os = "macos"));
    candidates.into_iter().find(|(program, _)| program.exists())
}

/// PowerShell 7 when installed, then the Windows PowerShell every Windows ships, then cmd.exe.
#[cfg(windows)]
fn windows_shell_candidates(pinned: Option<&Path>) -> Vec<(PathBuf, Vec<&'static str>)> {
    let system =
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32");
    let paths: Vec<PathBuf> = match pinned {
        Some(shell) => vec![shell.to_path_buf()],
        None => crate::vcs::bin_dirs()
            .into_iter()
            .find_map(|dir| crate::vcs::executable(dir.join("pwsh")))
            .into_iter()
            .chain([
                system.join("WindowsPowerShell\\v1.0\\powershell.exe"),
                std::env::var_os("ComSpec").map_or_else(|| system.join("cmd.exe"), PathBuf::from),
            ])
            .collect(),
    };
    paths
        .into_iter()
        .map(|path| {
            let args = match crate::project::Dialect::of(&path) {
                crate::project::Dialect::PowerShell => vec!["-NoLogo"],
                _ => vec![],
            };
            (path, args)
        })
        .collect()
}

#[cfg_attr(windows, allow(dead_code))]
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
            !key.to_string_lossy().starts_with("BOT_CODE_")
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

    #[test]
    fn deleted_thread_gate_prevents_stale_checkout_attach() {
        let directory = tempfile::tempdir().unwrap();
        let terminals = Terminals::new(Some("/bin/sh".into()));
        let id = ThreadId::default();
        let key = TerminalKey {
            workspace: WorkspaceId::default(),
            thread: Some(id.clone()),
            terminal: "term-1".parse().unwrap(),
        };
        let sink: Sink = Arc::new(|_| {});
        let size = TerminalSize::new(80, 24).unwrap();
        assert!(
            terminals
                .attach(key.clone(), Some(directory.path()), size, sink.clone())
                .unwrap()
                .is_some()
        );
        terminals.block_thread(&id);
        terminals.close(|key| key.thread.as_ref() == Some(&id));
        assert!(terminals.get(&key).is_none());
        assert!(
            terminals
                .attach(key.clone(), Some(directory.path()), size, sink.clone())
                .is_err()
        );
        assert!(terminals.get(&key).is_none());
        terminals.unblock_thread(&id);
        assert!(
            terminals
                .attach(key.clone(), Some(directory.path()), size, sink)
                .unwrap()
                .is_some()
        );
        terminals.close(|_| true);
    }
    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    #[test]
    fn environment_drops_bot_code_variables_and_sets_terminal_type() {
        assert_eq!(
            shell_environment(
                env(&[
                    ("PATH", "/usr/bin"),
                    ("BOT_CODE_DATA_DIR", "/state"),
                    ("BOT_CODE_SHELL", "/bin/sh"),
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
