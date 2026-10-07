use std::{
    ffi::OsString,
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::SystemTime,
};

const LIMIT: u64 = 1024 * 1024;
const ROTATED: usize = 3;

/// An append-only log that rotates at 1 MiB. Logging never fails the caller: an
/// unopenable file drops lines and is retried on the next write.
#[derive(Clone)]
pub(crate) struct RotatingLog(Arc<Mutex<State>>);
struct State {
    path: PathBuf,
    file: Option<File>,
    size: u64,
}
impl RotatingLog {
    pub(crate) fn open(path: PathBuf) -> Self {
        let mut state = State {
            path,
            file: None,
            size: 0,
        };
        state.reopen();
        Self(Arc::new(Mutex::new(state)))
    }
    pub(crate) fn line(&self, source: &str, text: &str) {
        let at = chrono::DateTime::<chrono::Utc>::from(SystemTime::now())
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let line = format!("{at} {source} {}\n", text.trim_end_matches(['\n', '\r']));
        let mut guard = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let state = &mut *guard;
        if state.size > 0 && state.size + line.len() as u64 > LIMIT {
            state.rotate();
        } else if state.file.is_none() {
            state.reopen();
        }
        let Some(file) = &mut state.file else {
            return;
        };
        match file.write_all(line.as_bytes()) {
            Ok(()) => state.size += line.len() as u64,
            Err(_) => state.file = None,
        }
    }
}
impl State {
    fn reopen(&mut self) {
        let opened = (|| -> std::io::Result<(File, u64)> {
            if let Some(parent) = self.path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
            let size = file.metadata()?.len();
            Ok((file, size))
        })();
        (self.file, self.size) = match opened {
            Ok((file, size)) => (Some(file), size),
            Err(_) => (None, 0),
        };
    }
    fn rotate(&mut self) {
        self.file = None;
        for n in (1..ROTATED).rev() {
            let _ = std::fs::rename(self.rotated(n), self.rotated(n + 1));
        }
        let _ = std::fs::rename(&self.path, self.rotated(1));
        self.reopen();
    }
    fn rotated(&self, n: usize) -> PathBuf {
        let mut name = OsString::from(self.path.as_os_str());
        name.push(format!(".{n}"));
        name.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_keeps_three_files_of_whole_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("codex.log");
        let log = RotatingLog::open(path.clone());
        let filler = "x".repeat(200);
        let lines = 30_000;
        for n in 0..lines {
            log.line("codex[1]", &format!("{n:05} {filler}\n"));
        }
        let mut names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["codex.log", "codex.log.1", "codex.log.2", "codex.log.3"]
        );
        let mut numbers = Vec::new();
        for name in ["codex.log.3", "codex.log.2", "codex.log.1", "codex.log"] {
            let text = std::fs::read_to_string(path.with_file_name(name)).unwrap();
            assert!(text.len() as u64 <= LIMIT, "{name} exceeds the limit");
            assert!(text.ends_with('\n'));
            for line in text.lines() {
                let (at, rest) = line.split_once(' ').unwrap();
                assert!(chrono::DateTime::parse_from_rfc3339(at).is_ok(), "{line}");
                assert_eq!(at.len(), "2026-10-07T12:00:00.000Z".len());
                let (number, text) = rest
                    .strip_prefix("codex[1] ")
                    .unwrap()
                    .split_once(' ')
                    .unwrap();
                assert_eq!(text, filler);
                numbers.push(number.parse::<usize>().unwrap());
            }
        }
        assert_eq!(numbers.last(), Some(&(lines - 1)));
        assert!(numbers.windows(2).all(|pair| pair[1] == pair[0] + 1));
        assert!(numbers[0] > 0, "the oldest lines rotate out");
    }

    #[test]
    fn reopening_appends_and_a_missing_directory_is_retried() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("logs");
        std::fs::write(&blocker, "not a directory").unwrap();
        let path = blocker.join("codex.log");
        let log = RotatingLog::open(path.clone());
        log.line("bot-code", "dropped");
        std::fs::remove_file(&blocker).unwrap();
        log.line("bot-code", "first");
        RotatingLog::open(path.clone()).line("bot-code", "second");
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<_> = text
            .lines()
            .map(|line| line.split_once(' ').unwrap().1)
            .collect();
        assert_eq!(lines, ["bot-code first", "bot-code second"]);
    }
}
