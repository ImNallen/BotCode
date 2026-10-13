use crate::sandbox::{Attach, Container, Exec, WORKSPACE};
use portable_pty::CommandBuilder;
use std::{
    ffi::OsString,
    io::{self, Read},
    process::Stdio,
    time::{Duration, Instant},
};

const TERMINAL: &str = "/opt/l1code/bin/terminal";
const CONTROL: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: u64 = 1024 * 1024;
const PROMPT_MARK: &str = "\u{1b}]133;A\u{7}";

pub(super) fn command(
    container: &Container,
    id: &str,
    environment: &[(OsString, OsString)],
) -> CommandBuilder {
    let forwarded: Vec<(String, String)> = environment
        .iter()
        .filter(|(key, _)| key == "TERM" || key == "COLORTERM")
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    let env: Vec<(&str, &str)> = forwarded
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let client = container.command(
        &Exec {
            argv: &[TERMINAL, "shell", id],
            workdir: WORKSPACE,
            env: &env,
        },
        Attach::Tty,
    );
    let mut command = CommandBuilder::new(client.get_program());
    command.args(client.get_args());
    command.env_clear();
    for (key, value) in environment {
        command.env(key, value);
    }
    for (key, value) in client.get_envs() {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        }
    }
    command
}

pub(super) fn stop(container: &Container, id: &str) {
    let _ = run(container, &[TERMINAL, "stop", id]);
}

pub(super) fn processes(container: &Container) -> io::Result<String> {
    run(container, &[TERMINAL, "ps"]).map(|out| String::from_utf8_lossy(&out).into_owned())
}

fn run(container: &Container, argv: &[&str]) -> io::Result<Vec<u8>> {
    let mut client = container
        .command(
            &Exec {
                argv,
                workdir: WORKSPACE,
                env: &[],
            },
            Attach::Lifeline,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let lifeline = client.stdin.take();
    let mut stdout = client.stdout.take().expect("stdout is piped");
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        (&mut stdout)
            .take(OUTPUT_LIMIT)
            .read_to_end(&mut out)
            .map(|_| out)
    });
    let deadline = Instant::now() + CONTROL;
    let status = loop {
        if let Some(status) = client.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = client.kill();
            let _ = client.wait();
            return Err(io::ErrorKind::TimedOut.into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    drop(lifeline);
    let out = reader
        .join()
        .map_err(|_| io::Error::other("the output reader panicked"))??;
    if !status.success() {
        return Err(io::Error::other(format!(
            "docker exec exited with {status}"
        )));
    }
    Ok(out)
}

#[derive(Default)]
pub(super) struct PromptMarks {
    tail: String,
}
impl PromptMarks {
    pub(super) fn feed(&mut self, data: &str) -> bool {
        let text = std::mem::take(&mut self.tail) + data;
        let found = text.contains(PROMPT_MARK);
        if let Some(partial) = (1..PROMPT_MARK.len())
            .rev()
            .map(|length| &PROMPT_MARK[..length])
            .find(|start| text.ends_with(start))
        {
            self.tail = partial.to_owned();
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::{CodexSource, Docker, SandboxConfig};

    #[test]
    fn the_container_shell_gets_only_the_terminal_type() {
        let docker = Docker::new(SandboxConfig {
            docker: "/usr/local/bin/docker".into(),
            data_dir: "/data".into(),
            codex: CodexSource::Version("0.162.0".parse().unwrap()),
        });
        let container = docker.container(&"0123456789ab".parse().unwrap());
        let environment = super::super::shell_environment(
            [
                ("PATH", "/opt/homebrew/bin:/usr/bin"),
                ("HOME", "/Users/me"),
                ("SSH_AUTH_SOCK", "/private/tmp/agent"),
                ("L1_CODE_DATA_DIR", "/state"),
                ("TERM", "dumb"),
            ]
            .into_iter()
            .map(|(key, value)| (key.into(), value.into())),
        );
        let command = command(&container, "a1b2", &environment);
        let argv: Vec<String> = command
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            argv,
            [
                "/usr/local/bin/docker",
                "exec",
                "--interactive",
                "--tty",
                "--workdir",
                "/workspace",
                "--env",
                "TERM=xterm-256color",
                "--env",
                "COLORTERM=truecolor",
                container.name(),
                "/opt/l1code/bin/run",
                "--",
                "/opt/l1code/bin/terminal",
                "shell",
                "a1b2",
            ]
        );
        assert_eq!(
            command.get_env("HOME").and_then(|home| home.to_str()),
            Some("/Users/me"),
            "the Docker client itself finds its configuration under the Mac home"
        );
        assert_eq!(command.get_env("L1_CODE_DATA_DIR"), None);
        assert_eq!(command.get_env("DOCKER_CLI_HINTS"), Some("false".as_ref()));
    }

    #[test]
    fn prompt_marks_are_found_across_chunks() {
        let mut marks = PromptMarks::default();
        assert!(!marks.feed("ls\r\nREADME.md\r\n"));
        assert!(marks.feed("\u{1b}]133;A\u{7}$ "));
        assert!(!marks.feed("echo hi\r\nhi\r\n\u{1b}]1"));
        assert!(marks.feed("33;A\u{7}$ "));
        assert!(
            !marks.feed("\u{1b}]133;B\u{7}"),
            "only a prompt start counts"
        );
        assert!(!marks.feed("\u{1b}"));
        assert!(!marks.feed("]133"));
        assert!(marks.feed(";A\u{7}"));
        assert!(!marks.feed("plain ]133;A\u{7} text"));
    }

    #[cfg(unix)]
    mod docker {
        use super::*;

        use crate::terminal::{
            CloseScope, Launch, Sink, TerminalEvent, TerminalKey, TerminalLabels, TerminalSize,
            Terminals,
        };
        use crate::{
            domain::{ThreadId, WorkspaceId},
            sandbox::{
                Desired,
                tests::{Fixture, gone_within, running, stdout},
            },
        };
        use std::sync::{Arc, Mutex};

        struct Shell {
            terminals: Terminals,
            key: TerminalKey,
            output: Arc<Mutex<String>>,
        }
        impl Shell {
            fn open(terminals: Terminals, container: &Container) -> Self {
                let key = TerminalKey {
                    workspace: WorkspaceId::default(),
                    thread: Some(ThreadId::default()),
                    terminal: "term-1".parse().unwrap(),
                };
                let output = Arc::new(Mutex::new(String::new()));
                let sink: Sink = {
                    let output = output.clone();
                    Arc::new(move |event| {
                        if let TerminalEvent::Output { data } = event {
                            output.lock().unwrap().push_str(&data);
                        }
                    })
                };
                terminals
                    .attach(
                        key.clone(),
                        Some(&Launch::Sandbox {
                            container: container.clone(),
                        }),
                        TerminalSize::new(80, 24).unwrap(),
                        sink,
                    )
                    .unwrap()
                    .expect("a new terminal");
                Self {
                    terminals,
                    key,
                    output,
                }
            }
            fn type_line(&self, line: &str) {
                self.terminals
                    .write(&self.key, format!("{line}\r").as_bytes())
                    .unwrap();
            }
            async fn expect(&self, from: usize, pattern: &str) -> usize {
                let started = Instant::now();
                loop {
                    let output = self.output.lock().unwrap().clone();
                    if let Some(at) = output[from..].find(pattern) {
                        return from + at + pattern.len();
                    }
                    assert!(
                        started.elapsed() < Duration::from_secs(20),
                        "no {pattern:?} in {:?}",
                        &output[from..]
                    );
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
            fn len(&self) -> usize {
                self.output.lock().unwrap().len()
            }
            fn client(&self) -> i32 {
                self.terminals.shells()[0].1 as i32
            }
        }

        async fn running_container(fixture: &Fixture) -> Container {
            let container = fixture.container();
            container.converge(Desired::Running).await.unwrap();
            container
        }

        #[tokio::test]
        #[ignore = "needs Docker"]
        async fn a_sandbox_terminal_is_a_login_shell_of_the_sandbox_user_that_resizes() {
            let fixture = Fixture::new().await;
            let container = running_container(&fixture).await;
            let (prompts, mut prompted) = tokio::sync::mpsc::unbounded_channel();
            let shell = Shell::open(Terminals::new(None, None, None, Some(prompts)), &container);
            tokio::time::timeout(Duration::from_secs(20), prompted.recv())
                .await
                .expect("the first prompt is reported")
                .unwrap();
            let from = shell.len();
            shell.type_line("whoami; pwd; uname -s; echo \"home=$HOME\"; env | grep -c /Users/");
            shell
                .expect(
                    from,
                    "l1code\r\n/workspace\r\nLinux\r\nhome=/home/l1code\r\n0\r\n",
                )
                .await;
            assert_eq!(
                prompted.recv().await.as_ref(),
                Some(&shell.key),
                "the prompt after the command is reported"
            );
            shell
                .terminals
                .resize(&shell.key, TerminalSize::new(123, 40).unwrap())
                .unwrap();
            // The Docker client forwards the size asynchronously, so a command can still see the old one.
            let started = Instant::now();
            loop {
                let from = shell.len();
                shell.type_line("tput cols");
                let end = shell.expect(from, "$ ").await;
                if shell.output.lock().unwrap()[from..end].contains("\r123\r\n") {
                    break;
                }
                assert!(
                    started.elapsed() < Duration::from_secs(10),
                    "the size never reached the container"
                );
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            shell.terminals.shutdown();
        }

        #[tokio::test]
        #[ignore = "needs Docker"]
        async fn a_killed_client_or_a_closed_terminal_leaves_nothing_running_in_the_container() {
            let fixture = Fixture::new().await;
            let container = running_container(&fixture).await;
            let terminals = Terminals::new(None, None, None, None);
            for (round, how) in ["kill the client", "close the terminal"]
                .into_iter()
                .enumerate()
            {
                let shell = Shell::open(terminals.clone(), &container);
                let (background, foreground) =
                    (format!("sleep 10{round}1"), format!("sleep 10{round}2"));
                shell.type_line(&format!("{background} &"));
                shell.type_line(&foreground);
                let started = Instant::now();
                while !(running(&container, &background).await
                    && running(&container, &foreground).await)
                {
                    assert!(
                        started.elapsed() < Duration::from_secs(20),
                        "{how}: jobs never started"
                    );
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                match round {
                    0 => unsafe {
                        libc::kill(shell.client(), libc::SIGKILL);
                    },
                    _ => terminals.close(&CloseScope::Terminal(shell.key.clone())),
                }
                for pattern in [background.as_str(), foreground.as_str(), "bash -l"] {
                    assert!(
                        gone_within(&container, pattern, Duration::from_secs(10)).await,
                        "{how}: {pattern} survived"
                    );
                }
                let left = stdout(&container, &["ps", "-eo", "args="]).await;
                assert!(
                    !left
                        .lines()
                        .any(|args| args.starts_with("bash") || args.starts_with("sleep 10")),
                    "{how}: {left}"
                );
                assert!(
                    stdout(&container, &["sh", "-c", "ls /dev/shm/l1code-terminals"])
                        .await
                        .trim()
                        .is_empty(),
                    "{how}: the record is removed"
                );
            }
        }

        #[tokio::test]
        #[ignore = "needs Docker"]
        async fn the_label_poller_reads_the_command_inside_the_container() {
            let fixture = Fixture::new().await;
            let container = running_container(&fixture).await;
            let (labels, mut watched) = tokio::sync::watch::channel(TerminalLabels::default());
            let shell = Shell::open(Terminals::new(None, Some(labels), None, None), &container);
            shell.expect(0, "$ ").await;
            shell.type_line("sleep 30");
            let label = |labels: &TerminalLabels| labels.labels.first().map(|l| l.label.clone());
            let found = tokio::time::timeout(
                Duration::from_secs(20),
                watched.wait_for(|labels| label(labels).is_some()),
            )
            .await
            .expect("a label within 20 s")
            .unwrap()
            .clone();
            assert_eq!(label(&found).as_deref(), Some("sleep"));
            assert_eq!(found.labels[0].terminal_id, shell.key.terminal);
            shell.terminals.write(&shell.key, b"\x03").unwrap();
            tokio::time::timeout(
                Duration::from_secs(20),
                watched.wait_for(|labels| labels.labels.is_empty()),
            )
            .await
            .expect("the label clears when the command ends")
            .unwrap();
            shell.terminals.shutdown();
        }
    }
}
