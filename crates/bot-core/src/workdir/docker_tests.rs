//! The sandbox handle's lifecycle against real Docker. Ignored by default. Run with
//! `cargo test -p bot-core --lib workdir::docker_tests -- --include-ignored --nocapture`.
use super::*;
use crate::sandbox::tests::{Fixture, gone_within, running, stdout};
use std::time::Instant;

const OWN: &str = "botcode/lifecycle";

fn git(root: &Path, args: &[&str]) -> String {
    let output = crate::process::command("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
/// A readied handle on a one-commit mirror, with a 250 ms probe cadence.
async fn readied(fixture: &Fixture, dir: &Path) -> Arc<SandboxHandle> {
    let root = dir.join("mirror");
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q", "-b", OWN]);
    git(&root, &["config", "user.name", "Lifecycle"]);
    git(
        &root,
        &["config", "user.email", "lifecycle@example.invalid"],
    );
    git(&root, &["config", "commit.gpgsign", "false"]);
    std::fs::write(root.join("README.md"), "lifecycle\n").unwrap();
    git(&root, &["add", "README.md"]);
    git(&root, &["commit", "-qm", "initial"]);
    let container = fixture.container();
    let handle = SandboxHandle::new(
        fixture.docker.clone(),
        container.id().clone(),
        root,
        OWN.into(),
        Duration::from_millis(250),
        RotatingLog::silent(),
    );
    handle.ready().await.unwrap();
    handle
}
fn status(handle: &SandboxHandle) -> String {
    let output = crate::process::command(crate::sandbox::docker_binary())
        .args([
            "inspect",
            "-f",
            "{{.State.Status}}",
            handle.container.name(),
        ])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn a_paused_sandbox_wakes_within_a_second_without_a_turn() {
    let fixture = Fixture::new().await;
    let dir = tempfile::tempdir().unwrap();
    let handle = readied(&fixture, dir.path()).await;
    assert_eq!(status(&handle), "running");
    handle.retire(Desired::Paused).await.unwrap();
    assert_eq!(status(&handle), "paused");
    assert_eq!(handle.phase(), Phase::Paused);
    assert!(!handle.is_ready() && handle.is_started());

    let started = Instant::now();
    handle.wake().await.unwrap();
    let took = started.elapsed();
    assert_eq!(status(&handle), "running");
    assert_eq!(handle.phase(), Phase::Running);
    assert!(took < Duration::from_secs(1), "wake took {took:?}");
    eprintln!("wake from paused: {took:?}");

    let started = Instant::now();
    handle.wake().await.unwrap();
    let took = started.elapsed();
    assert!(
        took < Duration::from_millis(50),
        "a running wake took {took:?}"
    );
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn a_busy_container_keeps_the_rule_from_pausing_it() {
    let fixture = Fixture::new().await;
    let dir = tempfile::tempdir().unwrap();
    let handle = readied(&fixture, dir.path()).await;
    let limits = Limits {
        pause_after: Duration::from_secs(1),
        stop_after: Duration::from_secs(60),
        desktop_idle: Duration::from_secs(60),
    };
    // Two probes after the wake's touch has aged out of the window: quiet means pause.
    handle.probe().await.unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let quiet = handle
        .probe()
        .await
        .unwrap()
        .expect("a second probe gives a reading");
    assert!(
        quiet < idle::CPU_BUSY_PERCENT,
        "idle container at {quiet:.2}%"
    );
    assert_eq!(
        handle.activity().desired(Instant::now(), &limits),
        Desired::Paused
    );

    // A job with no Bot Code entry point, like a build, is seen through the probe.
    stdout(
        &handle.container,
        &["sh", "-c", "setsid yes >/dev/null 2>&1 </dev/null &"],
    )
    .await;
    assert!(running(&handle.container, "yes").await);
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let busy = handle.probe().await.unwrap().unwrap();
    assert!(
        busy >= idle::CPU_BUSY_PERCENT,
        "busy container at {busy:.2}%"
    );
    eprintln!("yes > /dev/null measured at {busy:.1}% CPU");
    assert_eq!(
        handle.activity().desired(Instant::now(), &limits),
        Desired::Running,
        "the busy probe is within the window"
    );
    stdout(&handle.container, &["pkill", "-x", "yes"]).await;
    assert!(gone_within(&handle.container, "yes", Duration::from_secs(5)).await);
    handle.probe().await.unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let quiet = handle.probe().await.unwrap().unwrap();
    assert!(quiet < idle::CPU_BUSY_PERCENT, "quiet again at {quiet:.2}%");
    assert_eq!(
        handle.activity().desired(Instant::now(), &limits),
        Desired::Paused
    );
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn stopping_the_idle_desktop_leaves_no_xvnc_or_chromium_and_it_starts_again() {
    let fixture = Fixture::new().await;
    let dir = tempfile::tempdir().unwrap();
    let handle = readied(&fixture, dir.path()).await;
    handle.desktop().await.unwrap();
    assert!(running(&handle.container, "Xvnc :1.*").await);
    stdout(
        &handle.container,
        &[
            "sh",
            "-c",
            "setsid /opt/botcode/bin/browser --no-sandbox --no-first-run about:blank >/tmp/chromium.log 2>&1 </dev/null &",
        ],
    )
    .await;
    // Patterns are anchored at the start: `pgrep -f` would otherwise match the `run` wrapper
    // whose own command line carries the pattern.
    let chrome = "(/opt/botcode/chromium|/opt/botcode/playwright/[^ ]*/chrome)( .*)?";
    let started = Instant::now();
    while !running(&handle.container, chrome).await {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "Chromium never started: {}",
            stdout(&handle.container, &["cat", "/tmp/chromium.log"]).await
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let probe = handle.container.probe().await.unwrap();
    assert!(probe.desktop_running);
    assert_eq!(probe.desktop_clients, 0, "nothing is connected");

    handle.stop_desktop().await.unwrap();
    for pattern in [
        "Xvnc :1.*",
        "matchbox-window-manager.*",
        "/usr/bin/python3 /usr/bin/websockify --web /opt/botcode/desktop.*",
        chrome,
    ] {
        assert!(
            gone_within(&handle.container, pattern, Duration::from_secs(10)).await,
            "{pattern} still runs after the stop"
        );
    }
    let probe = handle.container.probe().await.unwrap();
    assert!(!probe.desktop_running);
    assert!(!handle.activity().desktop_running);

    // The Desktop tab, or the agent's browser, starts it again.
    handle.desktop().await.unwrap();
    assert!(running(&handle.container, "Xvnc :1.*").await);
    assert!(handle.container.probe().await.unwrap().desktop_running);
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn old_images_are_removed_unless_a_container_of_any_instance_uses_them() {
    let fixture = Fixture::new().await;
    let current = fixture.docker.image(&|_| {}).await.unwrap().tag();
    let old = "botcode-sandbox:000000000000";
    let docker = crate::sandbox::docker_binary();
    let cli = |args: &[&str]| {
        let output = crate::process::command(&docker)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "docker {args:?}: {output:?}");
        String::from_utf8_lossy(&output.stdout).into_owned()
    };
    // A distinct image under an old-looking tag: a tag of the current image would share its
    // id, and the ancestor filter would then count this fixture's own containers.
    let mut build = crate::process::command(&docker)
        .args(["build", "-q", "-t", old, "-"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(
        build.stdin.as_mut().unwrap(),
        format!("FROM {current}\nLABEL dev.botcode.test=old\n").as_bytes(),
    )
    .unwrap();
    let built = build.wait_with_output().unwrap();
    assert!(built.status.success(), "{built:?}");
    // A container with no Bot Code labels at all stands in for another instance's.
    let name = format!("botcode-test-user-{}", SandboxId::new());
    cli(&["create", "--name", &name, old, "sleep", "infinity"]);
    struct Removal(String);
    impl Drop for Removal {
        fn drop(&mut self) {
            let _ = crate::process::command(crate::sandbox::docker_binary())
                .args(["rm", "--force", &self.0])
                .output();
            let _ = crate::process::command(crate::sandbox::docker_binary())
                .args(["image", "rm", "botcode-sandbox:000000000000"])
                .output();
        }
    }
    let _removal = Removal(name.clone());
    let tags = || {
        cli(&[
            "image",
            "ls",
            "--filter",
            "reference=botcode-sandbox",
            "--format",
            "{{.Repository}}:{{.Tag}}",
        ])
    };

    assert_eq!(
        fixture.docker.prune_images().await.unwrap(),
        Vec::<String>::new()
    );
    assert!(
        tags().contains(old),
        "an image a container uses stays: {}",
        tags()
    );
    cli(&["rm", "--force", &name]);
    assert_eq!(
        fixture.docker.prune_images().await.unwrap(),
        vec![old.to_owned()]
    );
    let after = tags();
    assert!(!after.contains(old) && after.contains(&current), "{after}");
}
