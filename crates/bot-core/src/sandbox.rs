//! Docker sandboxes: detection, the sandbox image, container identity and lifecycle, and
//! exec. This module knows nothing about threads, git or the Codex protocol.
mod docker;
mod identity;
mod image;
#[cfg(test)]
mod tests;

use crate::domain::{AppError, Result, SandboxId};
use docker::{Cli, Stdin};
pub use identity::{IMAGE_LABEL, INSTANCE_LABEL, Instance, SANDBOX_LABEL};
pub use image::{CodexVersion, ImageVersion};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

/// Fixed container paths, so mapping a host path is a prefix swap.
pub const WORKSPACE: &str = "/workspace";
pub const ATTACHMENTS: &str = "/botcode/attachments";
pub const CODEX_HOME: &str = "/codex-home";
const RUN: &str = "/opt/botcode/bin/run";

const STATUS: Duration = Duration::from_secs(10);
const CONTROL: Duration = Duration::from_secs(60);
const BUILD: Duration = Duration::from_secs(30 * 60);
const STOP_GRACE_SECONDS: &str = "3";
const OUTPUT_LIMIT: u64 = 4 * 1024 * 1024;

pub struct SandboxConfig {
    pub docker: PathBuf,
    pub data_dir: PathBuf,
    pub codex: CodexSource,
}
/// Where the Codex version the image installs comes from. The app names the host binary and
/// the version is read on first use, so startup never waits for `codex --version`.
pub enum CodexSource {
    Version(CodexVersion),
    Binary(PathBuf),
}
const VERSION_PROBE: Duration = Duration::from_secs(10);

/// `BOT_CODE_DOCKER_BIN`, then the directories `vcs::bin_dirs` searches, then Docker
/// Desktop's own install locations.
pub fn docker_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("BOT_CODE_DOCKER_BIN") {
        return path.into();
    }
    let desktop = [
        std::env::home_dir().map(|home| home.join(".docker/bin")),
        Some("/Applications/Docker.app/Contents/Resources/bin".into()),
    ];
    crate::vcs::bin_dirs()
        .into_iter()
        .chain(desktop.into_iter().flatten())
        .find_map(|dir| crate::vcs::executable(dir.join("docker")))
        .unwrap_or_else(|| "docker".into())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DockerStatus {
    Ready {
        server_version: String,
        memory_bytes: u64,
    },
    NotInstalled,
    NotRunning {
        detail: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunState {
    Created,
    Running,
    Paused,
    Exited,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContainerState {
    Absent,
    Present { run: RunState, image: ImageVersion },
}
impl ContainerState {
    pub fn stale(&self, current: &ImageVersion) -> bool {
        matches!(self, Self::Present { image, .. } if image != current)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Desired {
    Running,
    Paused,
    Stopped,
    Removed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Create,
    Start,
    Unpause,
    Pause,
    Stop,
    Remove,
}
/// Every (current, desired) pair has a path, so a crash between steps re-plans from what
/// Docker reports. A stale container is never replaced here: that needs a mirror pull first.
fn plan(current: &ContainerState, desired: Desired) -> Vec<Step> {
    use {Desired as D, RunState as R, Step::*};
    let run = match current {
        ContainerState::Absent => {
            return match desired {
                D::Running => vec![Create, Start],
                D::Paused => vec![Create, Start, Pause],
                D::Stopped | D::Removed => vec![],
            };
        }
        ContainerState::Present { run, .. } => *run,
    };
    match (run, desired) {
        (_, D::Removed) => vec![Remove],
        (R::Created | R::Exited, D::Running) => vec![Start],
        (R::Created | R::Exited, D::Paused) => vec![Start, Pause],
        (R::Created | R::Exited, D::Stopped) => vec![],
        (R::Running, D::Running) | (R::Paused, D::Paused) => vec![],
        (R::Running, D::Paused) => vec![Pause],
        (R::Running, D::Stopped) => vec![Stop],
        (R::Paused, D::Running) => vec![Unpause],
        (R::Paused, D::Stopped) => vec![Unpause, Stop],
    }
}

/// A container of this instance, as `Docker::list` found it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observed {
    pub id: SandboxId,
    pub run: RunState,
    pub image: ImageVersion,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reconcile {
    /// Running or paused after a crash or a quit that skipped the stop.
    PullThenStop(SandboxId),
    /// No checkout names it, which happens when the app crashed during a delete.
    Remove(SandboxId),
}
/// Startup repair. A stale image is left for the next use, which pulls before recreating.
pub fn reconcile_plan(observed: &[Observed], referenced: &HashSet<SandboxId>) -> Vec<Reconcile> {
    observed
        .iter()
        .filter_map(|container| {
            let id = container.id.clone();
            if !referenced.contains(&id) {
                return Some(Reconcile::Remove(id));
            }
            match container.run {
                RunState::Running | RunState::Paused => Some(Reconcile::PullThenStop(id)),
                RunState::Created | RunState::Exited => None,
            }
        })
        .collect()
}

/// Cheap to clone.
#[derive(Clone)]
pub struct Docker {
    inner: Arc<Inner>,
}
struct Inner {
    cli: Cli,
    instance: Instance,
    data_dir: PathBuf,
    codex: CodexSource,
    versions: tokio::sync::OnceCell<(CodexVersion, ImageVersion)>,
    building: tokio::sync::Mutex<()>,
    /// Converge inspects and then acts, so two callers must not both decide to create.
    converging: std::sync::Mutex<HashMap<SandboxId, Arc<tokio::sync::Mutex<()>>>>,
}
impl Docker {
    pub fn new(config: SandboxConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                cli: Cli::new(config.docker),
                instance: Instance::of(&config.data_dir),
                data_dir: config.data_dir,
                codex: config.codex,
                versions: tokio::sync::OnceCell::new(),
                building: tokio::sync::Mutex::new(()),
                converging: Default::default(),
            }),
        }
    }
    pub fn instance(&self) -> &Instance {
        &self.inner.instance
    }
    /// Never fails, because the composer shows the result.
    pub async fn status(&self) -> DockerStatus {
        let info = self
            .inner
            .cli
            .ok(
                ["info", "--format", "{{.ServerVersion}} {{.MemTotal}}"],
                STATUS,
            )
            .await;
        let info = match info {
            Ok(info) => info,
            Err(error) if error.code == "docker_missing" => return DockerStatus::NotInstalled,
            Err(error) => {
                return DockerStatus::NotRunning {
                    detail: error.message,
                };
            }
        };
        match info.trim().split_once(' ') {
            Some((version, memory)) if !version.is_empty() => match memory.parse() {
                Ok(memory_bytes) => DockerStatus::Ready {
                    server_version: version.into(),
                    memory_bytes,
                },
                Err(_) => unexpected(&info),
            },
            _ => unexpected(&info),
        }
    }
    /// The host Codex version and the image version it names.
    async fn versions(&self) -> Result<&(CodexVersion, ImageVersion)> {
        self.inner
            .versions
            .get_or_try_init(|| async {
                let codex = match &self.inner.codex {
                    CodexSource::Version(version) => version.clone(),
                    CodexSource::Binary(binary) => probe_codex_version(binary).await?,
                };
                let image = ImageVersion::of(&codex);
                Ok((codex, image))
            })
            .await
    }
    /// Builds `botcode-sandbox:<version>` when Docker lacks it. `progress` gets each build
    /// log line, because a first build takes minutes.
    pub async fn image(&self, progress: &(dyn Fn(&str) + Send + Sync)) -> Result<ImageVersion> {
        let (codex, version) = self.versions().await?;
        let _building = self.inner.building.lock().await;
        let inspected = self
            .inner
            .cli
            .run(
                ["image", "inspect", "--format", "{{.Id}}", &version.tag()],
                CONTROL,
            )
            .await?;
        if inspected.code == Some(0) {
            return Ok(version.clone());
        }
        if !docker::absent(&inspected) {
            return Err(docker::failure(&inspected));
        }
        let context = tempfile::tempdir()?;
        image::write_context(context.path())?;
        let args: [std::ffi::OsString; 9] = [
            "build".into(),
            "--progress=plain".into(),
            "--tag".into(),
            version.tag().into(),
            "--label".into(),
            format!("{IMAGE_LABEL}={}", version.as_str()).into(),
            "--build-arg".into(),
            format!("CODEX_VERSION={}", codex.as_str()).into(),
            context.path().into(),
        ];
        self.inner.cli.stream(args, BUILD, progress).await?;
        Ok(version.clone())
    }
    pub fn container(&self, id: &SandboxId) -> Container {
        Container {
            docker: self.clone(),
            name: identity::container_name(&self.inner.instance, id),
            id: id.clone(),
        }
    }
    /// This instance's containers. Only startup reconciliation needs the whole set.
    pub async fn list(&self) -> Result<Vec<Observed>> {
        let filter = identity::instance_filter(&self.inner.instance);
        let ids = self
            .inner
            .cli
            .ok(
                ["container", "ls", "--all", "--quiet", "--filter", &filter],
                CONTROL,
            )
            .await?;
        let ids: Vec<&str> = ids.split_whitespace().collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let inspected = self
            .inner
            .cli
            .run(["container", "inspect"].into_iter().chain(ids), CONTROL)
            .await?;
        // A container removed since the listing is simply missing from the result.
        if inspected.code != Some(0) && !docker::absent(&inspected) {
            return Err(docker::failure(&inspected));
        }
        docker::parse_inspect(&inspected.stdout)
    }
    fn flight(&self, id: &SandboxId) -> Arc<tokio::sync::Mutex<()>> {
        self.inner
            .converging
            .lock()
            .unwrap()
            .entry(id.clone())
            .or_default()
            .clone()
    }
}
/// `codex --version` on the host, so the image installs the protocol the Mac agent speaks.
async fn probe_codex_version(binary: &Path) -> Result<CodexVersion> {
    let binary = crate::onboarding::resolve_binary(binary);
    let (_cancel, mut cancelled) = tokio::sync::watch::channel(false);
    let output = crate::vcs::Tool {
        program: &binary,
        cwd: Path::new("."),
    }
    .run_with_input(&["--version"], VERSION_PROBE, 4096, &mut cancelled, None)
    .await
    .map_err(|_| {
        AppError::new(
            "codex_missing",
            "Install Codex on this Mac before starting a sandbox.",
        )
    })?;
    if output.code != Some(0) {
        return Err(AppError::new(
            "codex_missing",
            "Install Codex on this Mac before starting a sandbox.",
        ));
    }
    CodexVersion::from_version_output(&output.stdout)
}
fn unexpected(info: &str) -> DockerStatus {
    DockerStatus::NotRunning {
        detail: format!("Docker returned an unexpected response: {}", info.trim()),
    }
}

/// How an exec's stdin is used by [`Container::run`].
pub enum Input<'a> {
    /// The command gets /dev/null, and killing the host client kills the command.
    Lifeline,
    Bytes(&'a [u8]),
}
/// How a caller-owned exec process from [`Container::command`] is attached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attach {
    /// The caller keeps stdin open. Closing it, or the client dying, kills the command.
    Lifeline,
    /// Stdin passes through to the command. Killing the client leaves the command running.
    Stdin,
    Tty,
}
pub struct Exec<'a> {
    pub argv: &'a [&'a str],
    /// A container path, usually [`WORKSPACE`].
    pub workdir: &'a str,
    pub env: &'a [(&'a str, &'a str)],
}
#[derive(Debug)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: Option<i32>,
}

/// Everything about one container derives from the instance, the id and the data directory.
/// It mounts only its Codex home: never a worktree, a `.git` directory or attachments.
#[derive(Clone)]
pub struct Container {
    docker: Docker,
    id: SandboxId,
    name: String,
}
impl Container {
    pub fn id(&self) -> &SandboxId {
        &self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn codex_home(&self) -> PathBuf {
        identity::codex_home(&self.docker.inner.data_dir, &self.id)
    }
    pub async fn state(&self) -> Result<ContainerState> {
        let inspected = self
            .docker
            .inner
            .cli
            .run(["container", "inspect", &self.name], CONTROL)
            .await?;
        if inspected.code != Some(0) {
            return if docker::absent(&inspected) {
                Ok(ContainerState::Absent)
            } else {
                Err(docker::failure(&inspected))
            };
        }
        match docker::parse_inspect(&inspected.stdout)?.pop() {
            Some(Observed { run, image, .. }) => Ok(ContainerState::Present { run, image }),
            None => Ok(ContainerState::Absent),
        }
    }
    /// Idempotent: inspect, plan, act, and return the state Docker then reports.
    pub async fn converge(&self, desired: Desired) -> Result<ContainerState> {
        let flight = self.docker.flight(&self.id);
        let _flight = flight.lock().await;
        let current = self.state().await?;
        let steps = plan(&current, desired);
        if steps.is_empty() {
            return Ok(current);
        }
        for step in steps {
            self.apply(step).await?;
        }
        self.state().await
    }
    async fn apply(&self, step: Step) -> Result<()> {
        let name = self.name.as_str();
        let args: Vec<String> = match step {
            Step::Create => self.create_args().await?,
            Step::Start => vec!["start".into(), name.into()],
            Step::Unpause => vec!["unpause".into(), name.into()],
            Step::Pause => vec!["pause".into(), name.into()],
            Step::Stop => vec![
                "stop".into(),
                "--time".into(),
                STOP_GRACE_SECONDS.into(),
                name.into(),
            ],
            Step::Remove => vec!["rm".into(), "--force".into(), name.into()],
        };
        self.docker.inner.cli.ok(args, CONTROL).await.map(drop)
    }
    async fn create_args(&self) -> Result<Vec<String>> {
        let image = self.docker.image(&|_| {}).await?;
        let home = self.codex_home();
        std::fs::create_dir_all(&home)?;
        let home = home.to_str().ok_or_else(|| {
            AppError::new(
                "sandbox",
                "The Bot Code data directory path is not valid UTF-8.",
            )
        })?;
        let mut args = vec![
            "create".into(),
            "--name".into(),
            self.name.clone(),
            "--init".into(),
        ];
        for (key, value) in identity::labels(&self.docker.inner.instance, &self.id, &image) {
            args.extend(["--label".into(), format!("{key}={value}")]);
        }
        // --mount is CSV, so a quoted field keeps commas in the path intact.
        let source = format!("\"source={}\"", home.replace('"', "\"\""));
        args.extend([
            "--mount".into(),
            format!("type=bind,{source},target={CODEX_HOME}"),
            image.tag(),
        ]);
        Ok(args)
    }
    /// Runs through `/opt/botcode/bin/run` with bounded output. A timeout or overflow stops
    /// the client, which with [`Input::Lifeline`] also stops the work in the container.
    pub async fn run(&self, exec: &Exec<'_>, input: Input<'_>, limit: Duration) -> Result<Output> {
        let (attach, stdin) = match input {
            Input::Lifeline => (Attach::Lifeline, Stdin::Held),
            Input::Bytes(bytes) => (Attach::Stdin, Stdin::Bytes(bytes)),
        };
        let output =
            docker::capture(self.command(exec, attach), stdin, limit, OUTPUT_LIMIT).await?;
        if docker::exec_failed(&output) {
            return Err(docker::failure(&output));
        }
        Ok(output)
    }
    /// The exec as a process the caller owns, such as a terminal or a setup script.
    pub fn command(&self, exec: &Exec<'_>, attach: Attach) -> std::process::Command {
        let mut command = self.docker.inner.cli.command();
        command.args(["exec", "--interactive"]);
        if attach == Attach::Tty {
            command.arg("--tty");
        }
        command.args(["--workdir", exec.workdir]);
        for (key, value) in exec.env {
            command.arg("--env").arg(format!("{key}={value}"));
        }
        command.args([self.name.as_str(), RUN]);
        if attach == Attach::Lifeline {
            command.arg("--lifeline");
        }
        command.arg("--").args(exec.argv);
        command
    }
    /// A remote for git's `ext::` transport. Host git exchanges only objects through it and
    /// never reads the container repository's config.
    pub fn git_transport(&self) -> String {
        let docker = self.docker.inner.cli.program().to_string_lossy();
        format!(
            "ext::{} exec --interactive {} git %s {WORKSPACE}",
            ext_escape(&docker),
            self.name
        )
    }
    pub async fn copy_in(&self, host: &Path, container: &str) -> Result<()> {
        let target = format!("{}:{container}", self.name);
        self.docker
            .inner
            .cli
            .ok(
                [
                    std::ffi::OsStr::new("cp"),
                    host.as_os_str(),
                    target.as_ref(),
                ],
                CONTROL,
            )
            .await
            .map(drop)
    }
}
/// `ext::` splits its command on spaces and expands `%` sequences.
fn ext_escape(text: &str) -> String {
    text.replace('%', "%%").replace(' ', "% ")
}
