use crate::domain::*;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{Mutex, mpsc, oneshot},
};
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>;
#[derive(Debug)]
pub enum Signal {
    Frame { epoch: u64, value: Value },
    Exited { epoch: u64, reason: String },
}
#[derive(Clone)]
pub struct Codex {
    stdin: Arc<Mutex<tokio::process::ChildStdin>>,
    pending: Pending,
    sequence: Arc<AtomicU64>,
    child: Arc<Mutex<Child>>,
    pid: u32,
}
impl Codex {
    pub async fn launch(binary: PathBuf, epoch: u64, events: mpsc::Sender<Signal>) -> Result<Self> {
        let mut command = Command::new(binary);
        command
            .arg("app-server")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
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
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let routes = pending.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            let reason = loop {
                buf.clear();
                let frame = loop {
                    let available = match reader.fill_buf().await {
                        Ok(v) => v,
                        Err(e) => break Err(e.to_string()),
                    };
                    if available.is_empty() {
                        break Err("Codex exited. Resume the conversation to reconnect.".into());
                    }
                    let take = available
                        .iter()
                        .position(|b| *b == b'\n')
                        .map(|i| i + 1)
                        .unwrap_or(available.len());
                    if buf.len() + take > 8_000_000 {
                        break Err("Codex sent a frame above the 8 MB limit.".into());
                    }
                    let newline = available[take - 1] == b'\n';
                    buf.extend_from_slice(&available[..take]);
                    reader.consume(take);
                    if newline {
                        break Ok(());
                    }
                };
                if let Err(reason) = frame {
                    break reason;
                }
                let value: Value = match serde_json::from_slice(&buf) {
                    Ok(v) => v,
                    Err(e) => break format!("Codex protocol is incompatible: {e}"),
                };
                if value.get("method").is_none()
                    && let Some(id) = value.get("id").and_then(Value::as_u64)
                {
                    if let Some(reply) = routes.lock().await.remove(&id) {
                        let result = if let Some(error) = value.get("error") {
                            Err(AppError::new(
                                "provider",
                                error
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Codex rejected the request."),
                            ))
                        } else {
                            value.get("result").cloned().ok_or_else(|| {
                                AppError::new("protocol", "Codex response has no result.")
                            })
                        };
                        let _ = reply.send(result);
                    }
                } else if events.send(Signal::Frame { epoch, value }).await.is_err() {
                    return;
                }
            };
            for (_, reply) in routes.lock().await.drain() {
                let _ = reply.send(Err(AppError::new("provider_lost", &reason)));
            }
            let _ = events.send(Signal::Exited { epoch, reason }).await;
        });
        tokio::spawn(async move {
            let mut stderr = stderr;
            let mut buffer = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
            }
        });
        Ok(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            sequence: Arc::new(AtomicU64::new(1)),
            child: Arc::new(Mutex::new(child)),
            pid,
        })
    }
    async fn write(&self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
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
        })?
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
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
        match tokio::time::timeout(std::time::Duration::from_secs(20), rx).await {
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
        self.request("initialize",json!({"clientInfo":{"name":"z1_code","title":"Z1 Code","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
        self.write(json!({"method":"initialized"})).await
    }
    pub async fn respond(&self, id: Value, result: Value) -> Result<()> {
        self.write(json!({"id":id,"result":result})).await
    }
    pub async fn refuse(&self, id: Value, method: &str) -> Result<()> {
        self.write(json!({"id":id,"error":{"code":-32601,"message":format!("Z1 Code does not yet support {method}")}})).await
    }
    pub async fn terminate(&self) -> Result<()> {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGTERM);
        }
        let mut child = self.child.lock().await;
        if tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
            child.kill().await?;
            let _ = child.wait().await;
        }
        #[cfg(unix)]
        unsafe {
            if libc::kill(-(self.pid as i32), 0) == 0 {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
        }
        Ok(())
    }
}
pub fn installed_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("Z1_CODEX_BIN") {
        return path.into();
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let path = dir.join("codex");
            if path.is_file() {
                return path;
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let path = PathBuf::from(home).join(".local/bin/codex");
        if path.is_file() {
            return path;
        }
    }
    for path in ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"] {
        if std::path::Path::new(path).exists() {
            return path.into();
        }
    }
    PathBuf::from("codex")
}
