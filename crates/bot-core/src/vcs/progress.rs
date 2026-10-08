use super::*;
use tokio::io::AsyncRead;

type Observer<'a> = &'a (dyn Fn(GitProgress) + Send + Sync);

pub(super) async fn read_output<R: AsyncRead + Unpin>(
    pipe: &mut Option<R>,
    captured: &mut Vec<u8>,
    bytes: u64,
    observer: Option<Observer<'_>>,
    stream: GitOutputStream,
) -> std::io::Result<()> {
    let Some(pipe) = pipe else {
        return Ok(());
    };
    let Some(observer) = observer else {
        pipe.take(bytes + 1).read_to_end(captured).await?;
        return if captured.len() as u64 > bytes {
            Err(std::io::Error::other(
                "Tool response exceeded the byte limit.",
            ))
        } else {
            Ok(())
        };
    };
    let mut buffer = [0; 4096];
    let mut line = Vec::new();
    loop {
        let count = pipe.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        captured.extend_from_slice(&buffer[..count]);
        if captured.len() > bytes as usize {
            captured.drain(..captured.len() - bytes as usize);
        }
        for byte in &buffer[..count] {
            if matches!(byte, b'\n' | b'\r') {
                emit_line(&mut line, stream, observer);
            } else {
                line.push(*byte);
                if line.len() >= 8192 {
                    emit_line(&mut line, stream, observer);
                }
            }
        }
    }
    emit_line(&mut line, stream, observer);
    Ok(())
}
fn emit_line(line: &mut Vec<u8>, stream: GitOutputStream, observer: Observer<'_>) {
    if line.is_empty() {
        return;
    }
    observer(GitProgress::Output {
        stream,
        line: String::from_utf8_lossy(line).into_owned(),
    });
    line.clear();
}

pub(super) struct HookTrace {
    file: tokio::fs::File,
    pending: Vec<u8>,
    hooks: BTreeMap<(String, u64), String>,
    pub failed: Vec<String>,
}
impl HookTrace {
    pub async fn new(path: &Path) -> Result<Self> {
        Ok(Self {
            file: tokio::fs::File::open(path).await?,
            pending: Vec::new(),
            hooks: BTreeMap::new(),
            failed: Vec::new(),
        })
    }
    pub async fn drain(&mut self, observer: Observer<'_>) -> Result<()> {
        self.file.read_to_end(&mut self.pending).await?;
        let Some(last) = self.pending.iter().rposition(|byte| *byte == b'\n') else {
            return Ok(());
        };
        let complete: Vec<_> = self.pending.drain(..=last).collect();
        for line in complete.split(|byte| *byte == b'\n') {
            let Ok(event) = serde_json::from_slice::<serde_json::Value>(line) else {
                continue;
            };
            let (Some(sid), Some(child)) = (event["sid"].as_str(), event["child_id"].as_u64())
            else {
                continue;
            };
            let key = (sid.to_owned(), child);
            match event["event"].as_str() {
                Some("child_start") if event["child_class"] == "hook" => {
                    if let Some(name) = event["hook_name"].as_str() {
                        self.hooks.insert(key, name.to_owned());
                        observer(GitProgress::HookStarted {
                            name: name.to_owned(),
                        });
                    }
                }
                Some("child_exit") => {
                    if let Some(name) = self.hooks.remove(&key) {
                        let code = event["code"].as_i64().and_then(|code| code.try_into().ok());
                        if code != Some(0) {
                            self.failed.push(format!(
                                "{name} hook failed (exit {}).",
                                code.map_or_else(|| "unknown".into(), |code| code.to_string())
                            ));
                        }
                        observer(GitProgress::HookFinished { name, code });
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}
