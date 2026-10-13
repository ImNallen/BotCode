//! The sandbox handle's lifecycle against real Docker. Ignored by default. Run with
//! `cargo test -p bot-core --lib workdir::docker_tests -- --include-ignored --nocapture`.
use super::*;
use crate::sandbox::tests::{Fixture, gone_within, running, stdout};
use std::{collections::BTreeSet, time::Instant};

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

/// Starts `command` detached in the container, so it outlives the exec.
async fn spawn(handle: &SandboxHandle, command: &str) {
    stdout(
        &handle.container,
        &[
            "sh",
            "-c",
            &format!("setsid sh -c '{command}' >/dev/null 2>&1 </dev/null &"),
        ],
    )
    .await;
}
/// A static server bound to exactly `address`, whose page says `body`.
async fn serve(handle: &SandboxHandle, address: &str, port: u16, body: &str) {
    spawn(
        handle,
        &format!(
            "mkdir -p /tmp/{port} && echo {body} > /tmp/{port}/index.html && cd /tmp/{port} && exec python3 -m http.server --bind {address} {port}"
        ),
    )
    .await;
}
async fn listening(network: &SandboxNetwork, ports: &[u16]) -> Listeners {
    let started = Instant::now();
    loop {
        let listeners = network.listeners().await.unwrap();
        if ports.iter().all(|port| listeners.ports.contains(port)) {
            return listeners;
        }
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{ports:?} never listened: {listeners:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
async fn get(port: u16) -> std::io::Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    stream
        .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .await?;
    let mut response = String::new();
    tokio::time::timeout(
        Duration::from_secs(20),
        stream.read_to_string(&mut response),
    )
    .await
    .map_err(|_| std::io::Error::other("timed out"))??;
    Ok(response)
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn servers_on_either_loopback_are_reachable_through_the_mac_forwarder() {
    let fixture = Fixture::new().await;
    let dir = tempfile::tempdir().unwrap();
    let handle = readied(&fixture, dir.path()).await;
    let network = SandboxNetwork(handle.clone());
    serve(&handle, "::1", 8001, "six").await;
    serve(&handle, "127.0.0.1", 8002, "four").await;
    // The desktop's own listeners must not show up as servers of the user's.
    handle.desktop().await.unwrap();
    let listeners = listening(&network, &[8001, 8002]).await;
    assert!(listeners.live);

    let six = network.forward(8001).unwrap();
    let four = network.forward(8002).unwrap();
    assert_ne!(six, four);
    assert_eq!(network.forward(8001).unwrap(), six, "one listener per port");
    let started = Instant::now();
    let page = get(six).await.unwrap();
    eprintln!("first load through the forwarder: {:?}", started.elapsed());
    assert!(
        page.starts_with("HTTP/1.0 200") && page.ends_with("six\n"),
        "{page}"
    );
    let page = get(four).await.unwrap();
    assert!(
        page.starts_with("HTTP/1.0 200") && page.ends_with("four\n"),
        "{page}"
    );

    let listeners = network.listeners().await.unwrap();
    assert_eq!(
        listeners.ports,
        BTreeSet::from([8001, 8002]),
        "the gateway, VNC and noVNC are Bot Code's"
    );
    assert_eq!(
        handle.activity().forwarding,
        0,
        "closed connections no longer count"
    );
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn a_websocket_echoes_through_the_forwarder_and_counts_as_use_while_open() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const ECHO: &str = r#"
import base64, hashlib, socket, threading
def exactly(c, n):
    data = b""
    while len(data) < n:
        chunk = c.recv(n - len(data))
        if not chunk: raise EOFError
        data += chunk
    return data
def session(c):
    request = b""
    while b"\r\n\r\n" not in request: request += c.recv(1024)
    key = [l.split(b":", 1)[1].strip() for l in request.split(b"\r\n") if l.lower().startswith(b"sec-websocket-key")][0]
    accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
    c.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
    while True:
        head = exactly(c, 2)
        mask = exactly(c, 4)
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(exactly(c, head[1] & 127)))
        c.sendall(bytes([head[0], len(payload)]) + payload)
server = socket.socket(socket.AF_INET6)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("::1", 8003))
server.listen()
while True:
    threading.Thread(target=session, args=(server.accept()[0],), daemon=True).start()
"#;
    let fixture = Fixture::new().await;
    let dir = tempfile::tempdir().unwrap();
    let handle = readied(&fixture, dir.path()).await;
    let network = SandboxNetwork(handle.clone());
    let written = handle
        .container
        .run(
            &Exec {
                argv: &["sh", "-c", "cat > /tmp/echo.py"],
                workdir: WORKSPACE,
                env: &[],
            },
            Input::Bytes(ECHO.as_bytes()),
            Duration::from_secs(30),
        )
        .await
        .unwrap();
    assert_eq!(written.code, Some(0));
    spawn(&handle, "exec python3 /tmp/echo.py").await;
    listening(&network, &[8003]).await;

    let port = network.forward(8003).unwrap();
    let mut socket = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    socket
        .write_all(
            b"GET / HTTP/1.1\r\nHost: localhost:8003\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    while !response.ends_with(b"\r\n\r\n") {
        response.push(socket.read_u8().await.unwrap());
    }
    let response = String::from_utf8(response).unwrap();
    assert!(response.starts_with("HTTP/1.1 101"), "{response}");
    assert!(
        response.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
        "{response}"
    );
    for text in ["hello", "again"] {
        let mask = [1u8, 2, 3, 4];
        let mut frame = vec![0x81, 0x80 | text.len() as u8];
        frame.extend(mask);
        frame.extend(text.bytes().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        socket.write_all(&frame).await.unwrap();
        let mut echoed = vec![0; 2 + text.len()];
        socket.read_exact(&mut echoed).await.unwrap();
        assert_eq!(echoed[..2], [0x81, text.len() as u8]);
        assert_eq!(&echoed[2..], text.as_bytes());
    }
    let limits = Limits {
        pause_after: Duration::from_millis(500),
        stop_after: Duration::from_secs(60),
        desktop_idle: Duration::from_secs(60),
    };
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(handle.activity().forwarding, 1);
    assert_eq!(
        handle.activity().desired(Instant::now(), &limits),
        Desired::Running,
        "an open hot-reload socket is use"
    );
    drop(socket);
    let started = Instant::now();
    while handle.activity().forwarding > 0 {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the close never reached the forwarder"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(
        handle.activity().desired(Instant::now(), &limits),
        Desired::Paused
    );
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn the_gateway_sends_nothing_without_its_token() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fixture = Fixture::new().await;
    let dir = tempfile::tempdir().unwrap();
    let handle = readied(&fixture, dir.path()).await;
    let network = SandboxNetwork(handle.clone());
    serve(&handle, "127.0.0.1", 8002, "four").await;
    listening(&network, &[8002]).await;
    let mut good = network.dial(8002).await.unwrap();
    good.write_all(b"GET / HTTP/1.0\r\n\r\n").await.unwrap();
    let mut page = String::new();
    good.read_to_string(&mut page).await.unwrap();
    assert!(page.ends_with("four\n"), "{page}");

    let gateway = handle
        .container
        .published(crate::sandbox::GATEWAY_PORT)
        .await
        .unwrap();
    for secret in ["0123456789abcdef0123456789abcdef", ""] {
        let mut stream = crate::sandbox::dial(gateway, secret, 8002).await.unwrap();
        stream.write_all(b"GET / HTTP/1.0\r\n\r\n").await.unwrap();
        let mut received = Vec::new();
        let read = tokio::time::timeout(Duration::from_secs(15), stream.read_to_end(&mut received))
            .await
            .expect("the gateway closes a connection it refuses");
        assert!(
            read.is_err() || received.is_empty(),
            "{secret:?} got {}",
            String::from_utf8_lossy(&received)
        );
    }
}

#[tokio::test]
#[ignore = "needs Docker"]
async fn a_connection_to_a_paused_sandbox_wakes_it_and_a_stop_closes_the_forwarders() {
    let fixture = Fixture::new().await;
    let dir = tempfile::tempdir().unwrap();
    let handle = readied(&fixture, dir.path()).await;
    let network = SandboxNetwork(handle.clone());
    serve(&handle, "::1", 8001, "six").await;
    listening(&network, &[8001]).await;
    let port = network.forward(8001).unwrap();
    assert!(get(port).await.unwrap().ends_with("six\n"));

    handle.retire(Desired::Paused).await.unwrap();
    assert_eq!(status(&handle), "paused");
    let paused = network.listeners().await.unwrap();
    assert!(!paused.live);
    assert!(
        paused.ports.contains(&8001),
        "a paused container keeps its servers"
    );
    let started = Instant::now();
    let page = get(port).await.unwrap();
    eprintln!("load that woke a paused sandbox: {:?}", started.elapsed());
    assert!(page.ends_with("six\n"), "{page}");
    assert_eq!(status(&handle), "running");
    assert_eq!(handle.phase(), Phase::Running);

    handle.retire(Desired::Stopped).await.unwrap();
    assert!(
        tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .is_err(),
        "the forwarder closed with the container"
    );
    let stopped = network.listeners().await.unwrap();
    assert!(!stopped.live && stopped.ports.is_empty());
}
