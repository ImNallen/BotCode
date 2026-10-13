//! Docker sandboxes: detection, the sandbox image, container identity and lifecycle, and
//! exec. This module knows nothing about threads, git or the Codex protocol.
mod docker;
mod identity;
mod image;
#[cfg(test)]
pub(crate) mod tests;

use crate::domain::{AppError, Result, SandboxId};
use docker::{Cli, Stdin};
pub use identity::{IMAGE_LABEL, INSTANCE_LABEL, Instance, SANDBOX_LABEL};
pub use image::{CodexVersion, ImageVersion};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

/// Fixed container paths, so mapping a host path is a prefix swap.
pub const WORKSPACE: &str = "/workspace";
pub const ATTACHMENTS: &str = "/botcode/attachments";
pub const CODEX_HOME: &str = "/codex-home";
pub const DESKTOP: &str = "/opt/botcode/bin/desktop";
/// The container port of the desktop's noVNC page and websocket. Docker publishes it on a
/// random loopback port of the Mac.
pub const DESKTOP_PORT: u16 = 6080;
/// The container port of the in-image `gateway`, the relay to servers on the container's
/// loopback. Docker publishes it like [`DESKTOP_PORT`].
pub const GATEWAY_PORT: u16 = 6081;
/// The desktop's VNC server, which listens on the container's loopback.
const VNC_PORT: u16 = 5900;
/// Listeners that are Bot Code's own, never a local server of the user's.
const OWN_PORTS: [u16; 3] = [VNC_PORT, DESKTOP_PORT, GATEWAY_PORT];
const RUN: &str = "/opt/botcode/bin/run";
const PROBE: &str = "/opt/botcode/bin/probe";
const GATEWAY: &str = "/opt/botcode/bin/gateway";

const STATUS: Duration = Duration::from_secs(10);
const PROBE_LIMIT: Duration = Duration::from_secs(15);
const DESKTOP_STOP: Duration = Duration::from_secs(30);
const GATEWAY_START: Duration = Duration::from_secs(30);
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
        drop(_building);
        if let Err(error) = self.prune_images().await {
            progress(&format!("old sandbox images kept: {}", error.message));
        }
        Ok(version.clone())
    }
    /// Removes `botcode-sandbox` images other than the current one that no container of any
    /// instance was created from. Returns the tags it removed. With one tag or none there is
    /// nothing to remove, and the Codex version is not probed: startup pays one `image ls`.
    pub async fn prune_images(&self) -> Result<Vec<String>> {
        let cli = &self.inner.cli;
        let tags = cli
            .ok(
                [
                    "image",
                    "ls",
                    "--filter",
                    &format!("reference={}", image::REPOSITORY),
                    "--format",
                    "{{.Repository}}:{{.Tag}}",
                ],
                CONTROL,
            )
            .await?;
        let tags: Vec<&str> = tags
            .lines()
            .map(str::trim)
            .filter(|tag| !tag.is_empty() && !tag.ends_with(":<none>"))
            .collect();
        if tags.len() <= 1 {
            return Ok(Vec::new());
        }
        let (_, current) = self.versions().await?;
        let mut removed = Vec::new();
        for tag in tags {
            if tag == current.tag() {
                continue;
            }
            let users = cli
                .ok(
                    [
                        "container",
                        "ls",
                        "--all",
                        "--quiet",
                        "--filter",
                        &format!("ancestor={tag}"),
                    ],
                    CONTROL,
                )
                .await?;
            if !users.trim().is_empty() {
                continue;
            }
            cli.ok(["image", "rm", tag], CONTROL).await?;
            removed.push(tag.to_owned());
        }
        Ok(removed)
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
            "--publish".into(),
            format!("127.0.0.1::{DESKTOP_PORT}"),
            "--publish".into(),
            format!("127.0.0.1::{GATEWAY_PORT}"),
            image.tag(),
        ]);
        Ok(args)
    }
    /// The Mac loopback port Docker published for a container port. Docker picks a new one each
    /// time the container starts.
    pub async fn published(&self, port: u16) -> Result<u16> {
        let output = self
            .docker
            .inner
            .cli
            .run(["port", &self.name, &format!("{port}/tcp")], CONTROL)
            .await?;
        let unpublished = || {
            AppError::new(
                "sandbox",
                format!("The sandbox container does not publish port {port}."),
            )
        };
        if output.code != Some(0) {
            return Err(
                if String::from_utf8_lossy(&output.stderr).contains("no public port") {
                    unpublished()
                } else {
                    docker::failure(&output)
                },
            );
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().rsplit_once(':'))
            .find(|(host, _)| *host == "127.0.0.1")
            .and_then(|(_, port)| port.parse().ok())
            .ok_or_else(unpublished)
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
    /// What the in-image `probe` reports: CPU time used so far and the desktop's clients.
    pub async fn probe(&self) -> Result<Probe> {
        let output = self
            .run(
                &Exec {
                    argv: &[PROBE],
                    workdir: WORKSPACE,
                    env: &[],
                },
                Input::Lifeline,
                PROBE_LIMIT,
            )
            .await?;
        if output.code != Some(0) {
            return Err(AppError::new(
                "sandbox",
                format!(
                    "The sandbox probe failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            ));
        }
        Probe::parse(&String::from_utf8_lossy(&output.stdout))
    }
    /// Starts the gateway unless it runs, with `secret` as its token either way, and returns
    /// the Mac port Docker published it on.
    pub async fn start_gateway(&self, secret: &str) -> Result<u16> {
        let output = self
            .run(
                &Exec {
                    argv: &[GATEWAY, "start"],
                    workdir: WORKSPACE,
                    env: &[],
                },
                Input::Bytes(format!("{secret}\n").as_bytes()),
                GATEWAY_START,
            )
            .await?;
        if output.code != Some(0) {
            return Err(AppError::new(
                "sandbox",
                format!(
                    "The sandbox gateway did not start: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            ));
        }
        self.published(GATEWAY_PORT).await
    }
    /// Stops the desktop and every window on it. Nothing happens when it is not running.
    pub async fn stop_desktop(&self) -> Result<()> {
        let output = self
            .run(
                &Exec {
                    argv: &[DESKTOP, "stop"],
                    workdir: WORKSPACE,
                    env: &[],
                },
                Input::Lifeline,
                DESKTOP_STOP,
            )
            .await?;
        if output.code != Some(0) {
            return Err(AppError::new(
                "sandbox",
                format!(
                    "The sandbox desktop did not stop: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            ));
        }
        Ok(())
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
/// Opens a connection to `localhost:<port>` inside a container through its gateway, published
/// on `gateway`. The gateway closes it without a byte when the token is wrong or nothing
/// listens on the port.
pub(crate) async fn dial(
    gateway: u16,
    secret: &str,
    port: u16,
) -> std::io::Result<tokio::net::TcpStream> {
    use tokio::io::AsyncWriteExt;
    let mut stream =
        tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, gateway)).await?;
    stream.set_nodelay(true)?;
    stream
        .write_all(format!("{secret} {port}\n").as_bytes())
        .await?;
    Ok(stream)
}

/// One `probe` reading. `cpu` only means something against an earlier reading.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Probe {
    /// CPU time the whole container has used since it started.
    pub cpu: Duration,
    /// Connected Desktop tabs.
    pub desktop_clients: u32,
    pub desktop_running: bool,
    pub gateway_running: bool,
    /// Ports a server listens on that `localhost` reaches, without Bot Code's own.
    pub listeners: BTreeSet<u16>,
}
impl Probe {
    /// Parses `cpu_usec=<n> clients=<n> desktop=<0|1>` and the LISTEN rows that follow it.
    pub fn parse(output: &str) -> Result<Self> {
        let (line, sockets) = output.split_once('\n').unwrap_or((output, ""));
        let invalid = || AppError::new("sandbox", format!("The sandbox probe returned {line:?}."));
        let field = |name: &str| -> Result<u64> {
            line.split_whitespace()
                .find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
                .and_then(|value| value.parse().ok())
                .ok_or_else(invalid)
        };
        let mut listeners = listening_ports(sockets);
        let gateway_running = listeners.contains(&GATEWAY_PORT);
        listeners.retain(|port| !OWN_PORTS.contains(port));
        Ok(Self {
            cpu: Duration::from_micros(field("cpu_usec")?),
            desktop_clients: u32::try_from(field("clients")?).map_err(|_| invalid())?,
            desktop_running: field("desktop")? == 1,
            gateway_running,
            listeners,
        })
    }
}
/// The ports of `/proc/net/tcp` and `/proc/net/tcp6` rows in the LISTEN state whose address
/// `localhost` reaches: a loopback address or the unspecified one. Other rows are skipped.
/// Each address word is printed in the kernel's byte order, which is little-endian on every
/// host Docker Desktop runs.
pub(crate) fn listening_ports(proc_net: &str) -> BTreeSet<u16> {
    proc_net
        .lines()
        .filter_map(|row| {
            let mut columns = row.split_whitespace();
            let local = columns.nth(1)?;
            (columns.nth(1)? == "0A").then_some(())?;
            let (address, port) = local.split_once(':')?;
            let port = u16::from_str_radix(port, 16)
                .ok()
                .filter(|port| *port > 0)?;
            let bytes: Vec<u8> = (0..address.len())
                .step_by(8)
                .map(|start| {
                    let word = address.get(start..start + 8)?;
                    u32::from_str_radix(word, 16).ok().map(u32::to_le_bytes)
                })
                .collect::<Option<Vec<_>>>()?
                .concat();
            let ip = match <[u8; 16]>::try_from(bytes.as_slice()) {
                Ok(v6) => std::net::IpAddr::from(std::net::Ipv6Addr::from(v6)).to_canonical(),
                Err(_) => std::net::IpAddr::from(<[u8; 4]>::try_from(bytes.as_slice()).ok()?),
            };
            (ip.is_loopback() || ip.is_unspecified()).then_some(port)
        })
        .collect()
}
/// `ext::` splits its command on spaces and expands `%` sequences.
fn ext_escape(text: &str) -> String {
    text.replace('%', "%%").replace(' ', "% ")
}
