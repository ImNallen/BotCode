//! Spawning and stopping child processes the same way on Unix and Windows.
use std::{ffi::OsStr, process::Command};

/// A command that opens no console window when Bot Code runs as a Windows GUI app.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(clippy::disallowed_methods)]
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// A [`command`] whose descendants [`kill_tree`] can stop together.
pub(crate) fn grouped(program: impl AsRef<OsStr>) -> Command {
    #[cfg_attr(windows, allow(unused_mut))]
    let mut command = command(program);
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    command
}

#[derive(Clone, Copy)]
pub(crate) enum Kill {
    Polite,
    Force,
}

/// Signals the process tree a [`grouped`] command started. Windows has no polite signal for
/// console programs, so both kinds force `taskkill /T` there.
pub(crate) fn kill_tree(pid: u32, kill: Kill) {
    #[cfg(unix)]
    {
        let signal = match kill {
            Kill::Polite => libc::SIGTERM,
            Kill::Force => libc::SIGKILL,
        };
        unsafe {
            libc::kill(-(pid as i32), signal);
        }
    }
    #[cfg(windows)]
    {
        let _ = kill;
        let _ = command("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Whether any process of a [`grouped`] command's tree still runs. On Windows, `taskkill /F`
/// has already ended the tree, so this reports none.
pub(crate) fn tree_alive(pid: u32) -> bool {
    #[cfg(unix)]
    return unsafe { libc::kill(-(pid as i32), 0) } == 0;
    #[cfg(windows)]
    {
        let _ = pid;
        false
    }
}
