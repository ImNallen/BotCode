//! Docker tests are ignored by default. Run them against a running Docker with
//! `cargo test -p bot-core --lib sandbox -- --include-ignored --nocapture`.
use super::*;
use std::time::Instant;
use tokio::process::Command as TokioCommand;

const STATES: [ContainerState; 5] = [
    ContainerState::Absent,
    present(RunState::Created),
    present(RunState::Running),
    present(RunState::Paused),
    present(RunState::Exited),
];
const DESIRED: [Desired; 4] = [
    Desired::Running,
    Desired::Paused,
    Desired::Stopped,
    Desired::Removed,
];

const fn present(run: RunState) -> ContainerState {
    ContainerState::Present {
        run,
        image: ImageVersion(String::new()),
    }
}
fn id(text: &str) -> SandboxId {
    text.parse().unwrap()
}

#[test]
fn every_state_has_a_plan_to_every_desired_state() {
    use {Desired as D, RunState as R, Step::*};
    let absent = ContainerState::Absent;
    let table = [
        (&absent, D::Running, vec![Create, Start]),
        (&absent, D::Paused, vec![Create, Start, Pause]),
        (&absent, D::Stopped, vec![]),
        (&absent, D::Removed, vec![]),
        (&present(R::Created), D::Running, vec![Start]),
        (&present(R::Created), D::Paused, vec![Start, Pause]),
        (&present(R::Created), D::Stopped, vec![]),
        (&present(R::Created), D::Removed, vec![Remove]),
        (&present(R::Running), D::Running, vec![]),
        (&present(R::Running), D::Paused, vec![Pause]),
        (&present(R::Running), D::Stopped, vec![Stop]),
        (&present(R::Running), D::Removed, vec![Remove]),
        (&present(R::Paused), D::Running, vec![Unpause]),
        (&present(R::Paused), D::Paused, vec![]),
        (&present(R::Paused), D::Stopped, vec![Unpause, Stop]),
        (&present(R::Paused), D::Removed, vec![Remove]),
        (&present(R::Exited), D::Running, vec![Start]),
        (&present(R::Exited), D::Paused, vec![Start, Pause]),
        (&present(R::Exited), D::Stopped, vec![]),
        (&present(R::Exited), D::Removed, vec![Remove]),
    ];
    assert_eq!(table.len(), STATES.len() * DESIRED.len());
    for (current, desired, steps) in table {
        assert_eq!(plan(current, desired), steps, "{current:?} -> {desired:?}");
    }
}

/// What Docker does with each step, refusing the transitions Docker refuses.
fn apply(step: Step, state: ContainerState) -> ContainerState {
    use RunState as R;
    let run = match &state {
        ContainerState::Absent => None,
        ContainerState::Present { run, .. } => Some(*run),
    };
    match (step, run) {
        (Step::Create, None) => present(R::Created),
        (Step::Remove, Some(_)) => ContainerState::Absent,
        (Step::Start, Some(R::Created | R::Exited)) => present(R::Running),
        (Step::Pause, Some(R::Running)) => present(R::Paused),
        (Step::Unpause, Some(R::Paused)) => present(R::Running),
        (Step::Stop, Some(R::Running)) => present(R::Exited),
        _ => panic!("Docker refuses {step:?} on {state:?}"),
    }
}

#[test]
fn applying_a_plan_reaches_the_desired_state_and_then_plans_nothing() {
    for current in STATES {
        for desired in DESIRED {
            let reached = plan(&current, desired)
                .into_iter()
                .fold(current.clone(), |state, step| apply(step, state));
            let satisfied = match (desired, &reached) {
                (Desired::Removed, state) => *state == ContainerState::Absent,
                (_, ContainerState::Absent) => desired == Desired::Stopped,
                (_, ContainerState::Present { run, .. }) => matches!(
                    (desired, run),
                    (Desired::Running, RunState::Running)
                        | (Desired::Paused, RunState::Paused)
                        | (Desired::Stopped, RunState::Created | RunState::Exited)
                ),
            };
            assert!(satisfied, "{current:?} -> {desired:?} reached {reached:?}");
            assert_eq!(plan(&reached, desired), [], "{current:?} -> {desired:?}");
        }
    }
}

#[test]
fn reconciliation_stops_live_referenced_containers_and_removes_orphans() {
    let observed: Vec<Observed> = [
        ("00000000000a", RunState::Running),
        ("00000000000b", RunState::Paused),
        ("00000000000c", RunState::Exited),
        ("00000000000d", RunState::Created),
        ("00000000000e", RunState::Running),
        ("00000000000f", RunState::Exited),
    ]
    .into_iter()
    .map(|(text, run)| Observed {
        id: id(text),
        run,
        image: ImageVersion("old".into()),
    })
    .collect();
    let referenced: HashSet<_> = [
        "00000000000a",
        "00000000000b",
        "00000000000c",
        "00000000000d",
    ]
    .into_iter()
    .map(id)
    .collect();
    assert_eq!(
        reconcile_plan(&observed, &referenced),
        [
            Reconcile::PullThenStop(id("00000000000a")),
            Reconcile::PullThenStop(id("00000000000b")),
            Reconcile::Remove(id("00000000000e")),
            Reconcile::Remove(id("00000000000f")),
        ]
    );
}

#[test]
fn identity_derives_from_the_data_dir_and_the_id() {
    let dir = tempfile::tempdir().unwrap();
    let instance = Instance::of(dir.path());
    assert_eq!(instance.as_str().len(), 8);
    assert!(instance.as_str().bytes().all(|b| b.is_ascii_hexdigit()));
    #[cfg(unix)]
    {
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        assert_eq!(
            Instance::of(&link),
            instance,
            "a symlinked data dir is the same instance"
        );
    }
    let other = tempfile::tempdir().unwrap();
    assert_ne!(Instance::of(other.path()), instance);

    let sandbox = id("0123456789ab");
    assert_eq!(
        identity::container_name(&instance, &sandbox),
        format!("botcode-{}-0123456789ab", instance.as_str())
    );
    assert_eq!(
        identity::labels(&instance, &sandbox, &ImageVersion("abc".into())),
        [
            ("dev.botcode.instance", instance.as_str().to_string()),
            ("dev.botcode.sandbox", "0123456789ab".to_string()),
            ("dev.botcode.image", "abc".to_string()),
        ]
    );
    assert_eq!(
        identity::codex_home(dir.path(), &sandbox),
        dir.path().join("sandboxes/0123456789ab/codex-home")
    );
}

#[test]
fn codex_versions_admit_only_version_characters() {
    assert_eq!(
        CodexVersion::from_version_output("codex-cli 0.162.0\n")
            .unwrap()
            .as_str(),
        "0.162.0"
    );
    assert_eq!(
        CodexVersion::from_version_output("codex 0.1.0-alpha.2+b1")
            .unwrap()
            .as_str(),
        "0.1.0-alpha.2+b1"
    );
    for bad in [
        "",
        "codex-cli ",
        "codex-cli 0.1; rm -rf /",
        "latest",
        "0.1 0",
        "$(id)",
    ] {
        assert!(CodexVersion::from_version_output(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn the_image_version_names_the_build_context_and_codex() {
    let a = ImageVersion::of(&"0.162.0".parse().unwrap());
    assert_eq!(a, ImageVersion::of(&"0.162.0".parse().unwrap()));
    assert_ne!(a, ImageVersion::of(&"0.163.0".parse().unwrap()));
    assert_eq!(a.as_str().len(), 12);
    assert_eq!(a.tag(), format!("botcode-sandbox:{}", a.as_str()));
    assert!(present(RunState::Running).stale(&a));
    assert!(!ContainerState::Absent.stale(&a));
}

#[test]
fn the_git_transport_escapes_spaces_and_percent_signs() {
    let data = tempfile::tempdir().unwrap();
    let docker = Docker::new(SandboxConfig {
        docker: "/Applications/My Docker/100%/docker".into(),
        data_dir: data.path().into(),
        codex_version: "0.162.0".parse().unwrap(),
    });
    let container = docker.container(&id("0123456789ab"));
    assert_eq!(
        container.git_transport(),
        format!(
            "ext::/Applications/My% Docker/100%%/docker exec --interactive {} git %s /workspace",
            container.name()
        )
    );
}

#[test]
fn an_unreachable_daemon_is_worded_for_the_banner() {
    for stderr in [
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        "failed to connect to the docker API at unix:///Users/me/.docker/run/docker.sock; check if the path is correct and if the daemon is running: dial unix: connect: no such file or directory",
    ] {
        let error = docker::failure(&Output {
            stdout: Vec::new(),
            stderr: stderr.into(),
            code: Some(1),
        });
        assert_eq!(error.code, "docker_not_running");
        assert_eq!(
            error.message,
            "Docker Desktop is not running. Start Docker Desktop and try again."
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn status_reports_a_missing_cli_and_an_unreachable_daemon() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let status = |docker: PathBuf| {
        Docker::new(SandboxConfig {
            docker,
            data_dir: dir.path().into(),
            codex_version: "0.162.0".parse().unwrap(),
        })
    };
    assert_eq!(
        status(dir.path().join("no-docker")).status().await,
        DockerStatus::NotInstalled
    );
    let fake = dir.path().join("docker");
    std::fs::write(
        &fake,
        "#!/bin/sh\necho 'failed to connect to the docker API at unix:///nope.sock' >&2\nexit 1\n",
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        status(fake).status().await,
        DockerStatus::NotRunning {
            detail: "Docker Desktop is not running. Start Docker Desktop and try again.".into()
        }
    );
}

// ---- Docker -------------------------------------------------------------------------------

/// Concurrent tests share one image build.
static IMAGE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// An isolated instance whose containers are removed on drop, including after a failure.
struct Fixture {
    docker: Docker,
    data: tempfile::TempDir,
}
impl Fixture {
    async fn new() -> Self {
        // A space and a comma in the path exercise the CSV quoting of the mount.
        let data = tempfile::Builder::new()
            .prefix("botcode sandbox,test-")
            .tempdir()
            .unwrap();
        let docker = Docker::new(SandboxConfig {
            docker: docker_binary(),
            data_dir: data.path().into(),
            codex_version: "0.162.0".parse().unwrap(),
        });
        let _build = IMAGE.lock().await;
        docker.image(&|_| {}).await.unwrap();
        Self { docker, data }
    }
    fn container(&self) -> Container {
        self.docker.container(&SandboxId::new())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let docker = docker_binary();
        let filter = identity::instance_filter(self.docker.instance());
        let listed = crate::process::command(&docker)
            .args(["container", "ls", "--all", "--quiet", "--filter", &filter])
            .output()
            .unwrap();
        let ids = String::from_utf8_lossy(&listed.stdout).into_owned();
        if !ids.trim().is_empty() {
            crate::process::command(&docker)
                .args(["rm", "--force"])
                .args(ids.split_whitespace())
                .output()
                .unwrap();
        }
    }
}

fn exec<'a>(argv: &'a [&'a str]) -> Exec<'a> {
    Exec {
        argv,
        workdir: WORKSPACE,
        env: &[],
    }
}
async fn stdout(container: &Container, argv: &[&str]) -> String {
    let output = container
        .run(&exec(argv), Input::Lifeline, Duration::from_secs(30))
        .await
        .unwrap();
    String::from_utf8(output.stdout).unwrap()
}
async fn running(container: &Container, pattern: &str) -> bool {
    !stdout(container, &["pgrep", "-fx", pattern])
        .await
        .trim()
        .is_empty()
}
async fn gone_within(container: &Container, pattern: &str, limit: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < limit {
        if !running(container, pattern).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}
fn docker_cli(args: &[&str]) -> String {
    let output = crate::process::command(docker_binary())
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "docker {args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap()
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn status_reads_a_running_docker() {
    let data = tempfile::tempdir().unwrap();
    let docker = Docker::new(SandboxConfig {
        docker: docker_binary(),
        data_dir: data.path().into(),
        codex_version: "0.162.0".parse().unwrap(),
    });
    let DockerStatus::Ready {
        server_version,
        memory_bytes,
    } = docker.status().await
    else {
        panic!("Docker is not ready");
    };
    eprintln!("Docker {server_version}, {memory_bytes} bytes");
    assert!(!server_version.is_empty());
    assert!(memory_bytes > 1024 * 1024 * 1024);
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn the_image_builds_once_and_then_is_found() {
    let data = tempfile::tempdir().unwrap();
    let docker = Docker::new(SandboxConfig {
        docker: docker_binary(),
        data_dir: data.path().into(),
        codex_version: "0.162.0".parse().unwrap(),
    });
    let _build = IMAGE.lock().await;
    let lines = std::sync::atomic::AtomicUsize::new(0);
    let started = Instant::now();
    let first = docker
        .image(&|_| {
            lines.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        })
        .await
        .unwrap();
    eprintln!(
        "first image call: {:?}, {} build log lines",
        started.elapsed(),
        lines.load(std::sync::atomic::Ordering::Relaxed)
    );
    let started = Instant::now();
    let built = lines.load(std::sync::atomic::Ordering::Relaxed);
    let second = docker.image(&|_| panic!("rebuilt")).await.unwrap();
    eprintln!("second image call: {:?}", started.elapsed());
    assert_eq!(first, second);
    assert_eq!(lines.load(std::sync::atomic::Ordering::Relaxed), built);
    assert_eq!(
        docker_cli(&[
            "image",
            "inspect",
            "--format",
            "{{index .Config.Labels \"dev.botcode.image\"}}",
            &first.tag()
        ])
        .trim(),
        first.as_str()
    );
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn converge_walks_the_lifecycle_and_repeats_as_no_ops() {
    let fixture = Fixture::new().await;
    let container = fixture.container();
    let image = fixture.docker.image(&|_| {}).await.unwrap();
    assert_eq!(container.state().await.unwrap(), ContainerState::Absent);
    let at = |run| ContainerState::Present {
        run,
        image: image.clone(),
    };
    for (desired, expected) in [
        (Desired::Running, at(RunState::Running)),
        (Desired::Paused, at(RunState::Paused)),
        (Desired::Running, at(RunState::Running)),
        (Desired::Stopped, at(RunState::Exited)),
        (Desired::Paused, at(RunState::Paused)),
        (Desired::Stopped, at(RunState::Exited)),
        (Desired::Paused, at(RunState::Paused)),
        (Desired::Removed, ContainerState::Absent),
        (Desired::Stopped, ContainerState::Absent),
    ] {
        for attempt in 0..2 {
            assert_eq!(
                container.converge(desired).await.unwrap(),
                expected,
                "{desired:?}, attempt {attempt}"
            );
            assert_eq!(container.state().await.unwrap(), expected);
        }
    }
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn converge_recovers_a_killed_or_half_created_container() {
    let fixture = Fixture::new().await;
    let container = fixture.container();
    container.converge(Desired::Running).await.unwrap();
    docker_cli(&["kill", container.name()]);
    assert!(matches!(
        container.state().await.unwrap(),
        ContainerState::Present {
            run: RunState::Exited,
            ..
        }
    ));
    assert!(matches!(
        container.converge(Desired::Running).await.unwrap(),
        ContainerState::Present {
            run: RunState::Running,
            ..
        }
    ));

    container.converge(Desired::Removed).await.unwrap();
    container.apply(Step::Create).await.unwrap();
    assert!(matches!(
        container.state().await.unwrap(),
        ContainerState::Present {
            run: RunState::Created,
            ..
        }
    ));
    assert!(matches!(
        container.converge(Desired::Running).await.unwrap(),
        ContainerState::Present {
            run: RunState::Running,
            ..
        }
    ));
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn a_container_runs_as_the_sandbox_user_with_only_its_codex_home_mounted() {
    let fixture = Fixture::new().await;
    let container = fixture.container();
    container.converge(Desired::Running).await.unwrap();
    assert_eq!(stdout(&container, &["id", "-un"]).await, "botcode\n");
    assert_eq!(
        stdout(&container, &["stat", "-c", "%U", WORKSPACE]).await,
        "botcode\n"
    );
    assert_eq!(
        docker_cli(&[
            "container",
            "inspect",
            "--format",
            "{{range .Mounts}}{{.Destination}} {{end}}",
            container.name()
        ])
        .trim(),
        CODEX_HOME
    );
    stdout(
        &container,
        &[
            "sh",
            "-c",
            "echo kept > /codex-home/probe && codex --version",
        ],
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(container.codex_home().join("probe")).unwrap(),
        "kept\n"
    );
    container.converge(Desired::Removed).await.unwrap();
    container.converge(Desired::Running).await.unwrap();
    assert_eq!(
        stdout(&container, &["cat", "/codex-home/probe"]).await,
        "kept\n",
        "the Codex home survives recreation"
    );
    assert_eq!(
        stdout(&container, &["codex", "--version"]).await.trim(),
        "codex-cli 0.162.0"
    );

    let file = fixture.data.path().join("note.txt");
    std::fs::write(&file, "attached").unwrap();
    container
        .copy_in(&file, &format!("{ATTACHMENTS}/note.txt"))
        .await
        .unwrap();
    assert_eq!(
        stdout(&container, &["cat", &format!("{ATTACHMENTS}/note.txt")]).await,
        "attached"
    );

    let fed = container
        .run(
            &exec(&["sh", "-c", "tr a-z A-Z"]),
            Input::Bytes(b"stdin"),
            Duration::from_secs(30),
        )
        .await
        .unwrap();
    assert_eq!(fed.stdout, b"STDIN");
    let failed = container
        .run(
            &exec(&["sh", "-c", "exit 7"]),
            Input::Lifeline,
            Duration::from_secs(30),
        )
        .await
        .unwrap();
    assert_eq!(failed.code, Some(7));

    stdout(&container, &["git", "init", "--quiet", WORKSPACE]).await;
    let remote = crate::process::command("git")
        .args([
            "-c",
            "protocol.ext.allow=always",
            "ls-remote",
            &container.git_transport(),
        ])
        .output()
        .unwrap();
    assert!(remote.status.success(), "{remote:?}");

    container.converge(Desired::Stopped).await.unwrap();
    let error = container
        .run(&exec(&["true"]), Input::Lifeline, Duration::from_secs(30))
        .await
        .unwrap_err();
    assert_eq!(error.code, "sandbox", "{error:?}");
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn instances_never_see_or_touch_each_others_containers() {
    let (a, b) = (Fixture::new().await, Fixture::new().await);
    let shared = SandboxId::new();
    let (in_a, in_b) = (a.docker.container(&shared), b.docker.container(&shared));
    assert_ne!(in_a.name(), in_b.name());
    in_a.converge(Desired::Running).await.unwrap();
    in_b.converge(Desired::Running).await.unwrap();
    let listed = |observed: Vec<Observed>| -> Vec<SandboxId> {
        observed.into_iter().map(|o| o.id).collect()
    };
    let only = std::slice::from_ref(&shared);
    assert_eq!(listed(a.docker.list().await.unwrap()), only);
    assert_eq!(listed(b.docker.list().await.unwrap()), only);
    in_b.converge(Desired::Removed).await.unwrap();
    assert!(b.docker.list().await.unwrap().is_empty());
    assert_eq!(
        a.docker.list().await.unwrap(),
        [Observed {
            id: shared,
            run: RunState::Running,
            image: a.docker.image(&|_| {}).await.unwrap(),
        }]
    );
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn killing_a_lifeline_client_kills_its_work_in_the_container() {
    let fixture = Fixture::new().await;
    let container = fixture.container();
    container.converge(Desired::Running).await.unwrap();
    for (attach, pattern, survives) in [
        (Attach::Stdin, "sleep 4241", true),
        (Attach::Lifeline, "sleep 4242", false),
    ] {
        let argv: Vec<&str> = pattern.split(' ').collect();
        let mut client = TokioCommand::from(container.command(&exec(&argv), attach))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let started = Instant::now();
        while !running(&container, pattern).await {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "{pattern} never started"
            );
        }
        client.kill().await.unwrap();
        let killed = Instant::now();
        let gone = gone_within(&container, pattern, Duration::from_secs(3)).await;
        eprintln!("{attach:?}: gone={gone} after {:?}", killed.elapsed());
        assert_eq!(gone, !survives, "{attach:?}");
    }
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn run_bounds_output_and_time_inside_the_container() {
    let fixture = Fixture::new().await;
    let container = fixture.container();
    container.converge(Desired::Running).await.unwrap();

    let started = Instant::now();
    let error = container
        .run(
            &exec(&["yes", "botcode"]),
            Input::Lifeline,
            Duration::from_secs(60),
        )
        .await
        .unwrap_err();
    assert!(error.message.contains("byte limit"), "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(gone_within(&container, "yes botcode", Duration::from_secs(3)).await);

    let error = container
        .run(
            &exec(&["sleep", "4243"]),
            Input::Lifeline,
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "timeout");
    assert!(gone_within(&container, "sleep 4243", Duration::from_secs(3)).await);
}
