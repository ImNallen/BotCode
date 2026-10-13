use super::{Observed, ObservedImage, Output, RunState, identity::SANDBOX_LABEL};
use crate::domain::{AppError, Result};
use serde::Deserialize;
use std::{
    collections::{HashMap, VecDeque},
    ffi::{OsStr, OsString},
    future::Future,
    io,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Child,
};

const NOT_RUNNING: [&str; 3] = [
    "cannot connect to the docker daemon",
    "failed to connect to the docker api",
    "is the docker daemon running",
];
const BUILD_TAIL: usize = 30;

pub(super) enum Stdin<'a> {
    Null,
    Bytes(&'a [u8]),
    Held,
}

pub(super) struct Cli {
    program: PathBuf,
    path: Option<OsString>,
}
impl Cli {
    pub fn new(program: PathBuf) -> Self {
        // Docker Desktop's credential helpers sit next to its CLI, and an app opened from
        // Finder does not have that directory on PATH, so image pulls would fail without it.
        let dir = dunce::canonicalize(&program)
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf));
        let path = dir.and_then(|dir| {
            let rest = std::env::var_os("PATH").unwrap_or_default();
            std::env::join_paths(std::iter::once(dir).chain(std::env::split_paths(&rest))).ok()
        });
        Self { program, path }
    }
    pub fn program(&self) -> &Path {
        &self.program
    }
    pub fn command(&self) -> std::process::Command {
        let mut command = crate::process::grouped(&self.program);
        if let Some(path) = &self.path {
            command.env("PATH", path);
        }
        command.env("DOCKER_CLI_HINTS", "false");
        command
    }
    fn with_args<I, S>(&self, args: I) -> std::process::Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = self.command();
        command.args(args);
        command
    }
    pub async fn run<I, S>(&self, args: I, limit: Duration) -> Result<Output>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        capture(
            self.with_args(args),
            Stdin::Null,
            limit,
            super::OUTPUT_LIMIT,
        )
        .await
    }
    pub async fn ok<I, S>(&self, args: I, limit: Duration) -> Result<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self.run(args, limit).await?;
        if output.code != Some(0) {
            return Err(failure(&output));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
    pub async fn stream<I, S>(
        &self,
        args: I,
        limit: Duration,
        line: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<()>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = tokio::process::Command::from(self.with_args(args));
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(spawn_error)?;
        let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
        let tail = std::sync::Mutex::new(VecDeque::with_capacity(BUILD_TAIL));
        let (status, _) = supervise(&mut child, limit, async {
            tokio::try_join!(forward(stdout, line, &tail), forward(stderr, line, &tail))
        })
        .await?;
        if status.success() {
            return Ok(());
        }
        let tail = tail.into_inner().unwrap();
        Err(failure(&Output {
            stdout: Vec::new(),
            stderr: Vec::from(tail).join("\n").into_bytes(),
            code: status.code(),
        }))
    }
}

pub(super) async fn capture(
    command: std::process::Command,
    stdin: Stdin<'_>,
    limit: Duration,
    bytes: u64,
) -> Result<Output> {
    let mut command = tokio::process::Command::from(command);
    command
        .stdin(match stdin {
            Stdin::Null => Stdio::null(),
            Stdin::Bytes(_) | Stdin::Held => Stdio::piped(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(spawn_error)?;
    let mut input = child.stdin.take();
    let (mut stdout, mut stderr) = (child.stdout.take(), child.stderr.take());
    let feed = async {
        if let Stdin::Bytes(data) = stdin
            && let Some(mut pipe) = input.take()
        {
            pipe.write_all(data).await?;
        }
        Ok::<_, io::Error>(())
    };
    let (status, (stdout, stderr, ())) = supervise(&mut child, limit, async {
        tokio::try_join!(
            bounded(&mut stdout, bytes),
            bounded(&mut stderr, bytes),
            feed
        )
    })
    .await?;
    drop(input);
    Ok(Output {
        stdout,
        stderr,
        code: status.code(),
    })
}

async fn supervise<T>(
    child: &mut Child,
    limit: Duration,
    work: impl Future<Output = io::Result<T>>,
) -> Result<(ExitStatus, T)> {
    let pid = child.id();
    let finished =
        tokio::time::timeout(limit, async { tokio::try_join!(child.wait(), work) }).await;
    match finished {
        Ok(Ok(done)) => Ok(done),
        Ok(Err(error)) => {
            crate::vcs::stop(child, pid).await?;
            Err(AppError::new("sandbox", error))
        }
        Err(_) => {
            crate::vcs::stop(child, pid).await?;
            Err(AppError::new("timeout", "Docker did not finish in time."))
        }
    }
}

async fn forward(
    pipe: Option<impl AsyncRead + Unpin>,
    line: &(dyn Fn(&str) + Send + Sync),
    tail: &std::sync::Mutex<VecDeque<String>>,
) -> io::Result<()> {
    let Some(pipe) = pipe else { return Ok(()) };
    let mut lines = BufReader::new(pipe).lines();
    while let Some(text) = lines.next_line().await? {
        line(&text);
        let mut tail = tail.lock().unwrap();
        if tail.len() == BUILD_TAIL {
            tail.pop_front();
        }
        tail.push_back(text);
    }
    Ok(())
}

async fn bounded(pipe: &mut Option<impl AsyncRead + Unpin>, bytes: u64) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    if let Some(pipe) = pipe {
        pipe.take(bytes + 1).read_to_end(&mut out).await?;
    }
    if out.len() as u64 > bytes {
        return Err(io::Error::other(format!(
            "Output exceeded the {bytes} byte limit."
        )));
    }
    Ok(out)
}

fn spawn_error(error: io::Error) -> AppError {
    match error.kind() {
        io::ErrorKind::NotFound => AppError::new(
            "docker_missing",
            "Docker is not installed. Install Docker Desktop to use sandboxes.",
        ),
        _ => error.into(),
    }
}

pub(super) fn failure(output: &Output) -> AppError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = match stderr.trim() {
        "" => stdout.trim(),
        text => text,
    };
    let lower = text.to_lowercase();
    if NOT_RUNNING.iter().any(|marker| lower.contains(marker)) {
        return AppError::new(
            "docker_not_running",
            "Docker Desktop is not running. Start Docker Desktop and try again.",
        );
    }
    AppError::new("sandbox", text)
}

pub(super) fn absent(output: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut lines = stderr
        .lines()
        .filter(|line| !line.trim().is_empty())
        .peekable();
    lines.peek().is_some() && lines.all(|line| line.contains("No such"))
}

pub(super) fn exec_failed(output: &Output) -> bool {
    output.code != Some(0)
        && (String::from_utf8_lossy(&output.stderr).starts_with("Error response from daemon:")
            || failure(output).code == "docker_not_running")
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Inspected {
    state: InspectedState,
    config: InspectedConfig,
}
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InspectedState {
    status: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InspectedConfig {
    #[serde(default)]
    labels: Option<HashMap<String, String>>,
}

pub(super) fn parse_inspect(json: &[u8]) -> Result<Vec<Observed>> {
    let inspected: Vec<Inspected> = serde_json::from_slice(json)?;
    inspected
        .into_iter()
        .map(|container| {
            let mut labels = container.config.labels.unwrap_or_default();
            let label = |labels: &mut HashMap<String, String>, key: &str| {
                labels.remove(key).ok_or_else(|| {
                    AppError::new(
                        "sandbox",
                        format!("A sandbox container has no {key} label."),
                    )
                })
            };
            Ok(Observed {
                id: label(&mut labels, SANDBOX_LABEL)?.parse()?,
                run: run_state(&container.state.status)?,
                image: ObservedImage(label(&mut labels, super::identity::IMAGE_LABEL)?),
            })
        })
        .collect()
}

fn run_state(status: &str) -> Result<RunState> {
    // Bot Code sets no restart policy, so "restarting" is transient; "dead" and "removing"
    // only ever end in removal.
    Ok(match status {
        "created" => RunState::Created,
        "running" | "restarting" => RunState::Running,
        "paused" => RunState::Paused,
        "exited" | "dead" | "removing" => RunState::Exited,
        other => {
            return Err(AppError::new(
                "sandbox",
                format!("Docker reported an unknown container state: {other}"),
            ));
        }
    })
}
