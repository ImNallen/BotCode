use crate::{domain::*, log::RotatingLog};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    process::ExitStatus,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStderr, ChildStdout, Command},
    sync::{Mutex, mpsc, oneshot, watch},
    task::JoinHandle,
    time::{Instant, timeout, timeout_at},
};
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>;
type Status = watch::Receiver<Option<ExitStatus>>;
type Tail = Arc<std::sync::Mutex<VecDeque<String>>>;
const FRAME_LIMIT: usize = 8_000_000;
const STDERR_LINE_BYTES: u64 = 4096;
const TAIL_LINES: usize = 40;
const TAIL_CHARS: usize = 300;
const REASON_LINES: usize = 12;
const LIFECYCLE: &str = "bot-code";
#[derive(Debug)]
pub enum Signal {
    Frame { epoch: u64, value: Value },
    Exited { epoch: u64, exit: Exit },
}
/// How a Codex process ended. `cause` names a transport or protocol failure; a plain exit has none.
#[derive(Debug)]
pub struct Exit {
    pub status: Option<ExitStatus>,
    pub cause: Option<String>,
    pub stderr: Vec<String>,
}
impl Exit {
    pub fn headline(&self) -> String {
        if let Some(cause) = &self.cause {
            return format!("{cause} Your next message restarts Codex.");
        }
        let detail = self
            .status
            .and_then(describe)
            .map(|detail| format!(" ({detail})"))
            .unwrap_or_default();
        format!("Codex stopped unexpectedly{detail}. Your next message restarts it.")
    }
    pub fn reason(&self) -> String {
        let mut reason = self.headline();
        if !self.stderr.is_empty() {
            let tail = &self.stderr[self.stderr.len().saturating_sub(REASON_LINES)..];
            reason.push_str("\n\nCodex stderr:\n");
            reason.push_str(&tail.join("\n"));
        }
        reason
    }
}
fn describe(status: ExitStatus) -> Option<String> {
    #[cfg(unix)]
    if let Some(signal) = std::os::unix::process::ExitStatusExt::signal(&status) {
        return Some(format!("killed by signal {signal}"));
    }
    status.code().map(|code| format!("exit code {code}"))
}
#[derive(Clone)]
pub struct Codex {
    stdin: Arc<Mutex<tokio::process::ChildStdin>>,
    pending: Pending,
    sequence: Arc<AtomicU64>,
    status: Status,
    // The process owner kills the group once the last clone drops this sender.
    _alive: Arc<oneshot::Sender<()>>,
    pid: u32,
}
impl Codex {
    pub(crate) async fn launch(
        binary: PathBuf,
        epoch: u64,
        events: mpsc::Sender<Signal>,
        log: RotatingLog,
    ) -> Result<Self> {
        let mut command = Command::new(binary);
        command
            .arg("app-server")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // Covers runtime teardown, which drops the owning task without running it.
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| AppError::new("provider", "Codex did not start."))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::new("provider", "Codex stdin is unavailable."))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::new("provider", "Codex stdout is unavailable."))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::new("provider", "Codex stderr is unavailable."))?;
        log.line(LIFECYCLE, &format!("started pid {pid}"));
        let (published, status) = watch::channel(None);
        let (alive, dropped) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let exited = tokio::select! {
                exited = child.wait() => exited,
                _ = dropped => {
                    signal_group(pid, Kill::Force);
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            if let Ok(exited) = exited {
                published.send_replace(Some(exited));
            }
        });
        let tail = Tail::default();
        let stderr = read_stderr(stderr, pid, log.clone(), tail.clone());
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        tokio::spawn(read_stdout(
            stdout,
            Watch {
                epoch,
                events,
                pending: pending.clone(),
                status: status.clone(),
                stderr,
                tail,
                log,
            },
        ));
        Ok(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            sequence: Arc::new(AtomicU64::new(1)),
            status,
            _alive: Arc::new(alive),
            pid,
        })
    }
    async fn write(&self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        let written = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let mut sink = self.stdin.lock().await;
            sink.write_all(&bytes).await?;
            sink.flush().await?;
            Ok(())
        })
        .await
        .map_err(|_| {
            AppError::new(
                "provider_timeout",
                "Codex stopped reading its input. Delivery is uncertain.",
            )
        })?;
        if let Err(error) = written {
            // A write to an exited Codex fails with a broken pipe; its Exited signal reports the loss.
            let mut status = self.status.clone();
            if timeout(Duration::from_secs(1), exited(&mut status))
                .await
                .is_ok()
            {
                return Err(AppError::new("provider_lost", "Codex exited."));
            }
            return Err(error);
        }
        Ok(())
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_with_timeout(method, params, std::time::Duration::from_secs(20))
            .await
    }
    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: std::time::Duration,
    ) -> Result<Value> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        if let Err(e) = self
            .write(json!({"id":id,"method":method,"params":params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => v,
            _ => {
                self.pending.lock().await.remove(&id);
                Err(AppError::new(
                    "provider_timeout",
                    format!("Codex did not acknowledge {method}. Delivery may be uncertain."),
                ))
            }
        }
    }
    pub async fn initialize(&self) -> Result<()> {
        self.request("initialize",json!({"clientInfo":{"name":"bot_code","title":"Bot Code","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
        self.write(json!({"method":"initialized"})).await
    }
    pub async fn respond(&self, id: Value, result: Value) -> Result<()> {
        self.write(json!({"id":id,"result":result})).await
    }
    pub async fn refuse(&self, id: Value, method: &str) -> Result<()> {
        self.write(json!({"id":id,"error":{"code":-32601,"message":format!("Bot Code does not yet support {method}")}})).await
    }
    pub async fn terminate(&self) -> Result<()> {
        let mut status = self.status.clone();
        signal_group(self.pid, Kill::Polite);
        if timeout(Duration::from_secs(2), exited(&mut status))
            .await
            .is_err()
        {
            signal_group(self.pid, Kill::Force);
            let _ = timeout(Duration::from_secs(2), exited(&mut status)).await;
        }
        // A same-group tool can outlive its leader.
        signal_group(self.pid, Kill::Force);
        Ok(())
    }
}
enum Kill {
    Polite,
    Force,
}
fn signal_group(pid: u32, kill: Kill) {
    #[cfg(unix)]
    unsafe {
        let signal = match kill {
            Kill::Polite => libc::SIGTERM,
            Kill::Force => libc::SIGKILL,
        };
        libc::kill(-(pid as i32), signal);
    }
}
/// Resolves once the process has exited, or when its status can no longer be known.
async fn exited(status: &mut Status) {
    let _ = status.wait_for(Option::is_some).await;
}
fn read_stderr(stderr: ChildStderr, pid: u32, log: RotatingLog, tail: Tail) -> JoinHandle<()> {
    tokio::spawn(async move {
        let source = format!("codex[{pid}]");
        let mut reader = BufReader::new(stderr);
        let mut line = Vec::new();
        loop {
            line.clear();
            match (&mut reader)
                .take(STDERR_LINE_BYTES)
                .read_until(b'\n', &mut line)
                .await
            {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = strip_ansi(&String::from_utf8_lossy(&line));
            let text = text.trim_end_matches(['\n', '\r']);
            log.line(&source, text);
            let mut tail = tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if tail.len() == TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(text.chars().take(TAIL_CHARS).collect());
        }
    })
}
/// Removes the CSI color sequences Codex's tracing output carries.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.next() == Some('[') {
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}
struct Watch {
    epoch: u64,
    events: mpsc::Sender<Signal>,
    pending: Pending,
    status: Status,
    stderr: JoinHandle<()>,
    tail: Tail,
    log: RotatingLog,
}
enum Read {
    Frame,
    End,
    Failed(String),
}
async fn read_stdout(stdout: ChildStdout, mut watch: Watch) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    // A descendant can inherit stdout and keep it open after Codex exits.
    let mut drain_until = None;
    let cause = loop {
        let read = match drain_until {
            None => tokio::select! {
                read = next_frame(&mut reader, &mut buf) => read,
                () = exited(&mut watch.status) => {
                    drain_until = Some(Instant::now() + Duration::from_millis(500));
                    continue;
                }
            },
            Some(deadline) => timeout_at(deadline, next_frame(&mut reader, &mut buf))
                .await
                .unwrap_or(Read::End),
        };
        match read {
            Read::Frame => {}
            Read::End => break None,
            Read::Failed(cause) => break Some(cause),
        }
        let value: Value = match serde_json::from_slice(&buf) {
            Ok(v) => v,
            Err(e) => break Some(format!("Codex protocol is incompatible: {e}.")),
        };
        buf.clear();
        if value.get("method").is_none()
            && let Some(id) = value.get("id").and_then(Value::as_u64)
        {
            if let Some(reply) = watch.pending.lock().await.remove(&id) {
                let result = if let Some(error) = value.get("error") {
                    Err(AppError::new(
                        "provider",
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Codex rejected the request."),
                    ))
                } else {
                    value
                        .get("result")
                        .cloned()
                        .ok_or_else(|| AppError::new("protocol", "Codex response has no result."))
                };
                let _ = reply.send(result);
            }
        } else if watch
            .events
            .send(Signal::Frame {
                epoch: watch.epoch,
                value,
            })
            .await
            .is_err()
        {
            return;
        }
    };
    if cause.is_none() {
        let _ = timeout(Duration::from_secs(1), exited(&mut watch.status)).await;
    }
    let _ = timeout(Duration::from_millis(500), watch.stderr).await;
    let status = *watch.status.borrow();
    let stderr = watch
        .tail
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .cloned()
        .collect();
    let exit = Exit {
        status,
        cause,
        stderr,
    };
    let outcome = match (&exit.cause, exit.status) {
        (Some(cause), _) => cause.clone(),
        (None, Some(status)) => status.to_string(),
        (None, None) => "status unknown".into(),
    };
    watch.log.line(LIFECYCLE, &format!("exited: {outcome}"));
    let reason = exit.reason();
    for (_, reply) in watch.pending.lock().await.drain() {
        let _ = reply.send(Err(AppError::new("provider_lost", &reason)));
    }
    let _ = watch
        .events
        .send(Signal::Exited {
            epoch: watch.epoch,
            exit,
        })
        .await;
}
async fn next_frame(reader: &mut BufReader<ChildStdout>, buf: &mut Vec<u8>) -> Read {
    loop {
        let available = match reader.fill_buf().await {
            Ok(v) => v,
            Err(e) => return Read::Failed(format!("Codex output could not be read: {e}.")),
        };
        if available.is_empty() {
            return Read::End;
        }
        let take = available
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(available.len());
        if buf.len() + take > FRAME_LIMIT {
            return Read::Failed("Codex sent a frame above the 8 MB limit.".into());
        }
        let newline = available[take - 1] == b'\n';
        buf.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline {
            return Read::Frame;
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::{fs::PermissionsExt, process::ExitStatusExt};

    fn exit(status: Option<i32>, cause: Option<&str>, stderr: usize) -> Exit {
        Exit {
            status: status.map(ExitStatus::from_raw),
            cause: cause.map(str::to_owned),
            stderr: (0..stderr).map(|n| format!("line {n}")).collect(),
        }
    }

    #[test]
    fn headline_names_the_signal_code_or_cause() {
        assert_eq!(
            exit(Some(9), None, 0).headline(),
            "Codex stopped unexpectedly (killed by signal 9). Your next message restarts it."
        );
        assert_eq!(
            exit(Some(1 << 8), None, 0).headline(),
            "Codex stopped unexpectedly (exit code 1). Your next message restarts it."
        );
        assert_eq!(
            exit(None, None, 0).headline(),
            "Codex stopped unexpectedly. Your next message restarts it."
        );
        assert_eq!(
            exit(Some(0), Some("Codex sent a frame above the 8 MB limit."), 0).headline(),
            "Codex sent a frame above the 8 MB limit. Your next message restarts Codex."
        );
    }

    #[test]
    fn strip_ansi_removes_color_sequences() {
        assert_eq!(
            strip_ansi("\u{1b}[2m2026-10-07T15:36:12Z\u{1b}[0m \u{1b}[32m INFO\u{1b}[0m started"),
            "2026-10-07T15:36:12Z  INFO started"
        );
    }

    #[test]
    fn reason_appends_the_last_twelve_stderr_lines() {
        assert_eq!(
            exit(Some(9), None, 0).reason(),
            exit(Some(9), None, 0).headline()
        );
        let expected = (28..40)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            exit(Some(9), None, 40).reason(),
            format!(
                "Codex stopped unexpectedly (killed by signal 9). Your next message restarts it.\n\nCodex stderr:\n{expected}"
            )
        );
    }

    fn script(dir: &std::path::Path, body: &str) -> PathBuf {
        let path = dir.join("codex.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[tokio::test]
    async fn stderr_tail_keeps_forty_bounded_lines_and_logs_every_line() {
        let dir = tempfile::tempdir().unwrap();
        let binary = script(
            dir.path(),
            "for n in $(seq 1 45); do echo \"stderr $n\" >&2; done\nhead -c 9000 /dev/zero | tr '\\0' x >&2\nexit 1\n",
        );
        let log = RotatingLog::open(dir.path().join("codex.log"));
        let (events, mut signals) = mpsc::channel(4);
        let _codex = Codex::launch(binary, 7, events, log).await.unwrap();
        let Some(Signal::Exited { epoch, exit }) = signals.recv().await else {
            panic!("expected an exit signal");
        };
        assert_eq!(epoch, 7);
        assert_eq!(exit.status.and_then(|status| status.code()), Some(1));
        assert_eq!(exit.cause, None);
        assert_eq!(exit.stderr.len(), 40);
        assert_eq!(exit.stderr[0], "stderr 9");
        assert_eq!(exit.stderr[36], "stderr 45");
        assert!(
            exit.stderr[37..]
                .iter()
                .all(|line| *line == "x".repeat(300))
        );
        let logged = std::fs::read_to_string(dir.path().join("codex.log")).unwrap();
        let lines: Vec<_> = logged.lines().collect();
        assert!(lines[0].contains(" bot-code started pid "), "{}", lines[0]);
        assert_eq!(
            lines.iter().filter(|line| line.contains(" codex[")).count(),
            48,
            "45 lines and a 9000-byte line cut at 4 KiB"
        );
        assert!(
            lines
                .last()
                .unwrap()
                .ends_with(" bot-code exited: exit status: 1")
        );
    }

    #[tokio::test]
    async fn dropping_the_last_handle_kills_the_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let child = dir.path().join("child.pid");
        let binary = script(
            dir.path(),
            &format!("sleep 60 &\necho $! > {}\nexec sleep 60\n", child.display()),
        );
        let (events, _signals) = mpsc::channel(4);
        let codex = Codex::launch(
            binary,
            1,
            events,
            RotatingLog::open(dir.path().join("codex.log")),
        )
        .await
        .unwrap();
        let leader = codex.pid as i32;
        let clone = codex.clone();
        for _ in 0..200 {
            if std::fs::read_to_string(&child).is_ok_and(|pid| pid.ends_with('\n')) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let child: i32 = std::fs::read_to_string(&child)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        drop(codex);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            unsafe { libc::kill(leader, 0) },
            0,
            "a live clone keeps Codex running"
        );
        drop(clone);
        for pid in [leader, child] {
            for _ in 0..300 {
                if unsafe { libc::kill(pid, 0) } != 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert_ne!(
                unsafe { libc::kill(pid, 0) },
                0,
                "pid {pid} outlived its handles"
            );
        }
    }
}
