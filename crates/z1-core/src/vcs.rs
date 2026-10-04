use crate::domain::*;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Child};

/// Neither git nor gh may prompt. Z1 has no terminal to answer from, and a prompt would keep
/// a checkout held until the timeout.
pub(crate) const NON_INTERACTIVE: [(&str, &str); 6] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GCM_INTERACTIVE", "never"),
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("NO_COLOR", "1"),
    ("LC_ALL", "C"),
];
/// How long a timed-out tool has between SIGTERM and SIGKILL. SIGTERM lets git remove its
/// lockfiles.
const GRACE: Duration = Duration::from_secs(2);

/// A resolved CLI and the directory it runs in.
pub(crate) struct Tool<'a> {
    pub program: &'a Path,
    pub cwd: &'a Path,
}
pub(crate) struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}
impl Tool<'_> {
    /// Runs the tool without a shell and with stdin closed. A non-zero exit is not an error
    /// here, because callers read exit codes (`diff --quiet`, gh's exit 4).
    pub async fn run(&self, args: &[&str], limit: Duration) -> Result<Output> {
        let mut command = tokio::process::Command::new(self.program);
        command
            .args(args)
            .current_dir(self.cwd)
            .envs(NON_INTERACTIVE)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = command.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::new(
                "tool_missing",
                format!("{} was not found.", self.program.display()),
            ),
            _ => e.into(),
        })?;
        let pid = child.id();
        let (mut stdout, mut stderr) = (child.stdout.take(), child.stderr.take());
        let finished = tokio::time::timeout(limit, async {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let (status, read_out, read_err) = tokio::join!(
                child.wait(),
                async {
                    match &mut stdout {
                        Some(pipe) => pipe.read_to_end(&mut out).await.map(drop),
                        None => Ok(()),
                    }
                },
                async {
                    match &mut stderr {
                        Some(pipe) => pipe.read_to_end(&mut err).await.map(drop),
                        None => Ok(()),
                    }
                },
            );
            read_out?;
            read_err?;
            Ok::<_, std::io::Error>((status?, out, err))
        })
        .await;
        match finished {
            Ok(result) => {
                let (status, out, err) = result?;
                Ok(Output {
                    stdout: String::from_utf8_lossy(&out).into_owned(),
                    stderr: String::from_utf8_lossy(&err).into_owned(),
                    code: status.code(),
                })
            }
            Err(_) => {
                stop(&mut child, pid).await;
                Err(AppError::new(
                    "timeout",
                    format!("{} {} timed out.", self.name(), args.first().unwrap_or(&"")),
                ))
            }
        }
    }
    /// `run`, with a non-zero exit as an error carrying `code` and the tool's message.
    pub async fn ok(&self, args: &[&str], limit: Duration, code: &str) -> Result<String> {
        let out = self.run(args, limit).await?;
        if out.code != Some(0) {
            let message = match out.stderr.trim() {
                "" => out.stdout.trim(),
                stderr => stderr,
            };
            return Err(AppError::new(code, message));
        }
        Ok(out.stdout)
    }
    fn name(&self) -> String {
        self.program
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}
/// SIGTERM to the process group, then SIGKILL to whatever is left after the grace period.
async fn stop(child: &mut Child, pid: Option<u32>) {
    let group = |signal| {
        if let Some(pid) = pid {
            unsafe {
                libc::kill(-(pid as i32), signal);
            }
        }
    };
    group(libc::SIGTERM);
    if tokio::time::timeout(GRACE, child.wait()).await.is_err() {
        let _ = child.kill().await;
    }
    group(libc::SIGKILL);
}

/// Resolves a CLI for an app launched from Finder, whose PATH lacks the usual install
/// locations: `$<env>`, then PATH, then ~/.local/bin, /opt/homebrew/bin and /usr/local/bin.
pub(crate) fn installed_binary(name: &str, env: &str) -> PathBuf {
    if let Some(path) = std::env::var_os(env) {
        return path.into();
    }
    let path = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>());
    let home = std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/bin"));
    path.chain(home)
        .chain(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from))
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| name.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[tokio::test]
    async fn a_timed_out_tool_is_stopped_with_its_children() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("child.pid");
        let script = format!("sleep 30 & echo $! > {}; wait", pidfile.display());
        let sh = Tool {
            program: Path::new("/bin/sh"),
            cwd: dir.path(),
        };
        let started = Instant::now();
        let error = sh
            .run(&["-c", &script], Duration::from_millis(300))
            .await
            .err()
            .expect("the tool should time out");
        assert_eq!(error.code, "timeout");
        assert_eq!(error.message, "sh -c timed out.");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "stopped within the grace period, took {:?}",
            started.elapsed()
        );
        let child: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut alive = true;
        for _ in 0..100 {
            alive = unsafe { libc::kill(child, 0) } == 0;
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            !alive,
            "the backgrounded sleep in the same group was killed"
        );
    }

    #[tokio::test]
    async fn tools_run_without_prompts_and_report_failures() {
        let dir = tempfile::tempdir().unwrap();
        let sh = Tool {
            program: Path::new("/bin/sh"),
            cwd: dir.path(),
        };
        let out = sh
            .ok(
                &["-c", "echo $GIT_TERMINAL_PROMPT$GH_PROMPT_DISABLED$LC_ALL"],
                Duration::from_secs(5),
                "sh",
            )
            .await
            .unwrap();
        assert_eq!(out, "01C\n");
        let error = sh
            .ok(
                &["-c", "echo nope >&2; exit 3"],
                Duration::from_secs(5),
                "sh",
            )
            .await
            .unwrap_err();
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("sh", "nope")
        );
        let missing = Tool {
            program: &dir.path().join("no-gh"),
            cwd: dir.path(),
        };
        assert_eq!(
            missing
                .run(&["pr", "list"], Duration::from_secs(5))
                .await
                .err()
                .unwrap()
                .code,
            "tool_missing"
        );
    }
}
