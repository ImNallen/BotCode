//! Ported from T3 Code v0.0.45 `apps/server/src/terminal/Manager.ts` (subprocess activity polling).
use super::Registry;
use std::{io, sync::Weak, time::Duration};

const POLL: Duration = Duration::from_secs(1);
const MAX_POLL: Duration = Duration::from_secs(60);
const MAX_FAILURES: u32 = 30;
const MAX_LABEL_CHARS: usize = 128;

trait ProcessTable {
    fn children(&self, pid: u32) -> Vec<u32>;
    fn command(&self, pid: u32) -> Option<String>;
}

pub(super) fn spawn_poller(registry: Weak<Registry>) -> io::Result<()> {
    std::thread::Builder::new()
        .name("bot-code-terminal-labels".into())
        .spawn(move || {
            let mut failures = 0;
            while let Some(delay) = tick(&registry, &mut failures) {
                std::thread::sleep(delay);
            }
        })
        .map(drop)
}

fn tick(registry: &Weak<Registry>, failures: &mut u32) -> Option<Duration> {
    let shells = registry.upgrade()?.shells();
    if shells.is_empty() {
        *failures = 0;
        registry.upgrade()?.publish_labels(Vec::new());
        return Some(POLL);
    }
    match capture() {
        Ok(table) => {
            *failures = 0;
            let found = shells
                .into_iter()
                .filter_map(|(key, pid)| {
                    let label = derive_label(table.as_ref(), pid, cfg!(windows))?;
                    Some((key, pid, label))
                })
                .collect();
            registry.upgrade()?.publish_labels(found);
        }
        Err(_) => *failures = (*failures + 1).min(MAX_FAILURES),
    }
    Some(poll_delay(*failures))
}

fn poll_delay(failures: u32) -> Duration {
    POLL.saturating_mul(2u32.saturating_pow(failures))
        .min(MAX_POLL)
}

fn normalize_command_name(raw: &str, windows: bool) -> Option<String> {
    let mut trimmed = raw.trim();
    if (trimmed.starts_with('[') && trimmed.ends_with(']'))
        || (trimmed.starts_with('(') && trimmed.ends_with(')'))
    {
        trimmed = trimmed[1..trimmed.len() - 1].trim();
    }
    let token = trimmed.split_whitespace().next()?;
    let base = if windows {
        token.rsplit(['\\', '/']).next()
    } else {
        token.rsplit('/').next()
    }
    .unwrap_or(token);
    let base = match base
        .len()
        .checked_sub(4)
        .and_then(|at| base.split_at_checked(at))
    {
        Some((stem, extension)) if windows && extension.eq_ignore_ascii_case(".exe") => stem,
        _ => base,
    };
    (!base.is_empty()).then(|| base.to_owned())
}

fn derive_label(table: &dyn ProcessTable, shell: u32, windows: bool) -> Option<String> {
    let name =
        |pid| normalize_command_name(table.command(pid).as_deref().unwrap_or_default(), windows);
    let shell_name = name(shell);
    let child = table.children(shell).into_iter().find(|&pid| {
        shell_name.is_none() || name(pid) != shell_name || !table.children(pid).is_empty()
    })?;
    Some(name(child)?.chars().take(MAX_LABEL_CHARS).collect())
}

#[cfg(any(windows, test))]
#[derive(Default)]
struct Snapshot {
    children: std::collections::HashMap<u32, Vec<u32>>,
    commands: std::collections::HashMap<u32, String>,
}
#[cfg(any(windows, test))]
impl Snapshot {
    fn from_rows(rows: impl IntoIterator<Item = (u32, u32, String)>) -> Self {
        let mut snapshot = Self::default();
        for (pid, parent, command) in rows {
            snapshot.children.entry(parent).or_default().push(pid);
            snapshot.commands.insert(pid, command);
        }
        for children in snapshot.children.values_mut() {
            children.sort_unstable();
        }
        snapshot
    }
}
#[cfg(any(windows, test))]
impl ProcessTable for Snapshot {
    fn children(&self, pid: u32) -> Vec<u32> {
        self.children.get(&pid).cloned().unwrap_or_default()
    }
    fn command(&self, pid: u32) -> Option<String> {
        self.commands.get(&pid).cloned()
    }
}

#[cfg(target_os = "macos")]
struct Libproc;
#[cfg(target_os = "macos")]
impl ProcessTable for Libproc {
    fn children(&self, pid: u32) -> Vec<u32> {
        let mut capacity = 64;
        loop {
            let mut pids = vec![0 as libc::pid_t; capacity];
            let bytes = std::mem::size_of_val(pids.as_slice()) as libc::c_int;
            // Returns a pid count, not a byte count.
            let count = unsafe {
                libc::proc_listchildpids(pid as libc::pid_t, pids.as_mut_ptr().cast(), bytes)
            };
            let Ok(count) = usize::try_from(count) else {
                return Vec::new();
            };
            if count < capacity {
                pids.truncate(count);
                let mut children: Vec<u32> = pids
                    .into_iter()
                    .filter_map(|pid| u32::try_from(pid).ok())
                    .collect();
                children.sort_unstable();
                return children;
            }
            capacity *= 2;
        }
    }
    fn command(&self, pid: u32) -> Option<String> {
        let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let length = unsafe {
            libc::proc_pidpath(
                pid as libc::c_int,
                path.as_mut_ptr().cast(),
                path.len() as u32,
            )
        };
        let length = usize::try_from(length).ok().filter(|&length| length > 0)?;
        Some(String::from_utf8_lossy(&path[..length]).into_owned())
    }
}

#[cfg(target_os = "macos")]
fn capture() -> io::Result<Box<dyn ProcessTable>> {
    Ok(Box::new(Libproc))
}

#[cfg(windows)]
fn capture() -> io::Result<Box<dyn ProcessTable>> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
    };
    let mut rows = Vec::new();
    unsafe {
        let handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = Process32FirstW(handle, &mut entry);
        while found != 0 {
            let name = &entry.szExeFile;
            let length = name.iter().position(|&c| c == 0).unwrap_or(name.len());
            rows.push((
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                String::from_utf16_lossy(&name[..length]),
            ));
            found = Process32NextW(handle, &mut entry);
        }
        CloseHandle(handle);
    }
    Ok(Box::new(Snapshot::from_rows(rows)))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn capture() -> io::Result<Box<dyn ProcessTable>> {
    Err(io::ErrorKind::Unsupported.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(rows: &[(u32, u32, &str)]) -> Snapshot {
        Snapshot::from_rows(
            rows.iter()
                .map(|&(pid, parent, command)| (pid, parent, command.to_owned())),
        )
    }

    #[test]
    fn command_names_normalize_like_t3() {
        let unix = |raw| normalize_command_name(raw, false);
        let windows = |raw| normalize_command_name(raw, true);
        assert_eq!(unix("  /usr/bin/vim  ").as_deref(), Some("vim"));
        assert_eq!(unix("(zsh)").as_deref(), Some("zsh"));
        assert_eq!(unix("[kthreadd]").as_deref(), Some("kthreadd"));
        assert_eq!(unix("/usr/bin/node server.js").as_deref(), Some("node"));
        assert_eq!(
            unix("C:\\tools\\ping.exe").as_deref(),
            Some("C:\\tools\\ping.exe")
        );
        assert_eq!(windows("node.exe").as_deref(), Some("node"));
        assert_eq!(windows("NODE.EXE").as_deref(), Some("NODE"));
        assert_eq!(windows("C:\\tools\\ping.exe").as_deref(), Some("ping"));
        assert_eq!(windows("C:/tools/git.exe").as_deref(), Some("git"));
        assert_eq!(unix(""), None);
        assert_eq!(unix("   "), None);
        assert_eq!(unix("()"), None);
        assert_eq!(unix("/usr/bin/"), None);
        assert_eq!(windows(".exe"), None);
    }

    #[test]
    fn label_is_the_first_child_that_is_not_a_prompt_fork() {
        let label = |rows: &[(u32, u32, &str)]| derive_label(&table(rows), 100, false);
        let shell = (100, 1, "/bin/zsh");
        assert_eq!(label(&[shell]), None);
        assert_eq!(label(&[shell, (101, 100, "/bin/zsh")]), None);
        assert_eq!(
            label(&[shell, (101, 100, "/bin/zsh"), (102, 101, "/usr/bin/vim")]).as_deref(),
            Some("zsh")
        );
        assert_eq!(
            label(&[shell, (101, 100, "/usr/bin/vim")]).as_deref(),
            Some("vim")
        );
        assert_eq!(
            label(&[shell, (102, 100, "/usr/bin/node"), (101, 100, "/bin/zsh")]).as_deref(),
            Some("node")
        );
        assert_eq!(
            label(&[shell, (103, 100, "/bin/cat"), (102, 100, "/usr/bin/git")]).as_deref(),
            Some("git")
        );
        assert_eq!(
            label(&[(101, 100, "/bin/zsh")]).as_deref(),
            Some("zsh"),
            "Without a shell name, the first child wins"
        );
        assert_eq!(
            label(&[shell, (101, 100, "")]),
            None,
            "An unnamed child keeps the default label"
        );
        let long = format!("/bin/{}", "x".repeat(200));
        assert_eq!(
            label(&[shell, (101, 100, &long)]).map(|label| label.chars().count()),
            Some(128)
        );
        assert_eq!(
            derive_label(
                &table(&[(100, 1, "powershell.exe"), (101, 100, "PING.EXE")]),
                100,
                true
            )
            .as_deref(),
            Some("PING")
        );
    }

    #[test]
    fn failed_snapshots_back_off_to_a_minute() {
        assert_eq!(poll_delay(0), Duration::from_secs(1));
        assert_eq!(poll_delay(1), Duration::from_secs(2));
        assert_eq!(poll_delay(3), Duration::from_secs(8));
        assert_eq!(poll_delay(5), Duration::from_secs(32));
        assert_eq!(poll_delay(6), Duration::from_secs(60));
        assert_eq!(poll_delay(MAX_FAILURES), Duration::from_secs(60));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn libproc_lists_a_shells_child_by_executable_path() {
        let mut shell = crate::process::command("/bin/sh")
            .args(["-c", "/bin/sleep 5 & wait"])
            .spawn()
            .unwrap();
        let pid = shell.id();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let children = loop {
            let children = Libproc.children(pid);
            let named = children
                .iter()
                .filter_map(|&child| Libproc.command(child))
                .collect::<Vec<_>>();
            if named.iter().any(|path| path.ends_with("/sleep"))
                || std::time::Instant::now() > deadline
            {
                break (children, named);
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let _ = shell.kill();
        let _ = shell.wait();
        assert_eq!(children.0.len(), 1, "{children:?}");
        assert_eq!(children.1, ["/bin/sleep"]);
    }
}
