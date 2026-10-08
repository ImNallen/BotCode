// Ports T3 Code v0.0.45 apps/server/src/project/ProjectSetupScriptRunner.ts (MIT).
use super::*;
use crate::project::{self, ProjectConfig, SetupState, WorktreeSetup};
use std::io::{Read, Seek, SeekFrom};

impl Owner {
    pub(super) fn setup_busy(&self, root: &Path) -> bool {
        self.threads.values().any(|t| {
            t.worktree_setup
                .as_ref()
                .is_some_and(|s| s.active() && Path::new(&s.cwd) == root)
        })
    }
    pub(super) fn initialize_setup(&mut self, id: &ThreadId, config: ProjectConfig) -> Result<()> {
        let mut thread = self.thread(id)?.clone();
        thread.worktree_setup = setup_for(&thread.checkout, config);
        self.install(thread)?;
        self.begin_setup(id);
        Ok(())
    }
    pub(super) fn begin_setup(&mut self, id: &ThreadId) {
        if let Err(error) = self.launch_setup(id) {
            let mut thread = self.threads[id].clone();
            if let Some(setup) = thread.worktree_setup.as_mut() {
                setup.state = SetupState::Failed {
                    reason: error.message,
                    exit_code: None,
                };
                setup.completed_at_ms = Some(now_ms());
                if let Err(error) = self.install(thread) {
                    eprintln!("Unable to save setup failure: {}", error.message);
                }
            }
        }
    }
    fn setup_dir(&self, setup: &WorktreeSetup) -> PathBuf {
        self.config.data_dir.join("worktree-setup").join(&setup.id)
    }
    fn launch_setup(&mut self, id: &ThreadId) -> Result<()> {
        let mut thread = self.thread(id)?.clone();
        let Some(setup) = thread.worktree_setup.as_mut() else {
            return Ok(());
        };
        let attempt_dir = self.setup_dir(setup);
        std::fs::create_dir_all(attempt_dir.parent().unwrap())?;
        if let Err(e) = std::fs::create_dir(&attempt_dir) {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                return Ok(());
            }
            return Err(e.into());
        }
        setup.state = SetupState::Running;
        setup.started_at_ms = Some(now_ms());
        let root = self.workspaces[&thread.workspace_id].root.clone();
        let cwd = setup.cwd.clone();
        let script = setup.script.as_ref().map(|s| s.command.clone());
        let submodules = setup.submodules.clone();
        let lock = lock_attempt(&attempt_dir)?
            .ok_or_else(|| AppError::new("setup_busy", "Setup is already running."))?;
        let stderr = std::fs::File::create(attempt_dir.join("output"))?;
        let stdout = stderr.try_clone()?;
        self.install(thread)?;
        let attempt = SetupAttempt {
            dir: &attempt_dir,
            shell: &project::shell(self.config.shell.as_deref()),
            script: script.as_deref(),
            submodules: &submodules,
        };
        let result = attempt.spawn(lock, |process| {
            process
                .current_dir(cwd.clone())
                .env("T3CODE_PROJECT_ROOT", root)
                .env("T3CODE_WORKTREE_PATH", cwd)
                .env("NO_COLOR", "1")
                .env("FORCE_COLOR", "0")
                .stdin(std::process::Stdio::null())
                .stdout(stdout)
                .stderr(stderr);
        });
        match result {
            Ok(mut child) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            }
            Err(e) => {
                let mut thread = self.thread(id)?.clone();
                let setup = thread.worktree_setup.as_mut().unwrap();
                setup.state = SetupState::Failed {
                    reason: e.to_string(),
                    exit_code: None,
                };
                setup.completed_at_ms = Some(now_ms());
                self.install(thread)?;
            }
        }
        Ok(())
    }
    pub(super) fn poll_setups(&mut self) {
        let ids: Vec<_> = self
            .threads
            .values()
            .filter(|t| t.worktree_setup.as_ref().is_some_and(WorktreeSetup::active))
            .map(|t| t.id.clone())
            .collect();
        for id in ids {
            if let Err(e) = self.poll_setup(&id) {
                eprintln!("Worktree setup: {}", e.message);
            }
        }
    }
    fn poll_setup(&mut self, id: &ThreadId) -> Result<()> {
        let mut thread = self.thread(id)?.clone();
        let setup = thread.worktree_setup.as_mut().unwrap();
        let dir = self.setup_dir(setup);
        if matches!(setup.state, SetupState::Pending) && !dir.exists() {
            return self.launch_setup(id);
        }
        let prior_state = setup.state.clone();
        let prior_output = setup.output.clone();
        if let Ok(mut file) = std::fs::File::open(dir.join("output")) {
            let len = file.metadata()?.len();
            file.seek(SeekFrom::Start(len.saturating_sub(128 * 1024)))?;
            let mut bytes = vec![];
            file.read_to_end(&mut bytes)?;
            setup.output = String::from_utf8_lossy(&bytes)
                .lines()
                .map(String::from)
                .collect();
        }
        if let Ok(receipt) = std::fs::read_to_string(dir.join("receipt")) {
            setup.state = match receipt.trim().parse::<i32>() {
                Ok(0) => SetupState::Succeeded,
                Ok(code) => SetupState::Failed {
                    reason: format!("Setup exited with code {code}."),
                    exit_code: Some(code),
                },
                Err(_) => SetupState::Failed {
                    reason: "Setup finished without recording its exit code.".into(),
                    exit_code: None,
                },
            };
            setup.completed_at_ms = Some(now_ms());
        } else if setup.started_at_ms.is_none_or(|at| {
            let elapsed = now_ms().saturating_sub(at);
            elapsed > 2000 && (dir.join("pid").exists() || elapsed > 60_000)
        }) && lock_attempt(&dir)?.is_some()
        {
            setup.state = SetupState::Interrupted {
                reason: "The setup process stopped without recording its result.".into(),
            };
            setup.completed_at_ms = Some(now_ms());
        }
        let finished = !setup.active();
        if finished && prior_state != setup.state {
            self.project_search.invalidate();
        }
        if prior_state != setup.state || prior_output != setup.output {
            self.install(thread)?;
        }
        if finished {
            self.release_setup_prompt(id);
        }
        Ok(())
    }
    fn release_setup_prompt(&mut self, id: &ThreadId) {
        let t = &self.threads[id];
        if !self
            .held
            .contains_key(t.root(&self.workspaces[&t.workspace_id]))
            && t.session == SessionState::Connecting
            && t.turns.last().is_some_and(|t| {
                matches!(t.delivery, Delivery::Preparing)
                    && matches!(t.checkpoint, TurnCheckpoint::Pending)
            })
        {
            let turn = t.turns.last().unwrap().id.clone();
            self.start_name(id);
            self.capture_before(id.clone(), turn);
        }
    }
    pub(super) fn retry_setup(&mut self, id: &ThreadId) -> Result<ThreadSnapshot> {
        if self.thread(id)?.worktree_setup.is_none() {
            return self.thread(id).cloned();
        }
        let setup = self.thread(id)?.worktree_setup.as_ref().unwrap();
        if setup.active() || matches!(setup.state, SetupState::Interrupted { .. }) {
            self.poll_setup(id)?;
        }
        let mut thread = self.thread(id)?.clone();
        let setup = thread.worktree_setup.as_mut().unwrap();
        if setup.active() || matches!(setup.state, SetupState::Succeeded) {
            return Ok(thread);
        }
        let dir = self.setup_dir(setup);
        if dir.exists() && lock_attempt(&dir)?.is_none() {
            return Err(AppError::new(
                "setup_busy",
                "The prior setup process is still running.",
            ));
        }
        if !Path::new(&setup.cwd).is_dir() {
            return Err(worktree_removed());
        }
        setup.id = uuid::Uuid::new_v4().to_string();
        setup.state = SetupState::Pending;
        setup.started_at_ms = None;
        setup.completed_at_ms = None;
        setup.output.clear();
        self.install(thread)?;
        self.begin_setup(id);
        self.thread(id).cloned()
    }
}

pub(super) fn setup_for(checkout: &Checkout, config: ProjectConfig) -> Option<WorktreeSetup> {
    let Checkout::Worktree { path, .. } = checkout else {
        return None;
    };
    let script = config
        .scripts
        .into_iter()
        .find(|s| s.run_on_worktree_create);
    let submodules = if path.join(".gitmodules").is_file() {
        config.worktree_submodules
    } else {
        "none".into()
    };
    if script.is_none() && submodules == "none" {
        return None;
    }
    Some(WorktreeSetup {
        head_oid: repo::git(path, &["rev-parse", "HEAD"])
            .ok()
            .map(|v| String::from_utf8_lossy(&v).trim().to_owned()),
        id: uuid::Uuid::new_v4().to_string(),
        script,
        cwd: path.to_string_lossy().into(),
        state: SetupState::Pending,
        output: vec![],
        started_at_ms: None,
        completed_at_ms: None,
        submodules,
    })
}
fn lock_attempt(dir: &Path) -> Result<Option<std::fs::File>> {
    let file = match std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("lock"))
    {
        Ok(file) => file,
        // ERROR_SHARING_VIOLATION: the Windows setup wrapper holds the file open unshared.
        Err(error) if cfg!(windows) && error.raw_os_error() == Some(32) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
    }
}

/// A detached setup run that records its exit code in `receipt`. It holds the attempt's lock
/// until it exits, so a held lock without a receipt means it is still running.
struct SetupAttempt<'a> {
    dir: &'a Path,
    #[cfg_attr(windows, allow(dead_code))]
    shell: &'a Path,
    script: Option<&'a str>,
    submodules: &'a str,
}
impl SetupAttempt<'_> {
    #[cfg(unix)]
    fn spawn(
        &self,
        lock: std::fs::File,
        configure: impl FnOnce(&mut std::process::Command),
    ) -> std::io::Result<std::process::Child> {
        use std::os::{fd::AsRawFd, unix::process::CommandExt};
        let quote = project::quote;
        let submodules = match self.submodules {
            "recursive" => "git submodule update --init --recursive",
            "top-level" => "git submodule update --init",
            _ => ":",
        };
        let run_script = self.script.map_or_else(String::new, |command| {
            format!(
                "{} -c {}; code=$?; ",
                quote(&self.shell.to_string_lossy()),
                quote(command)
            )
        });
        let wrapper = format!(
            "echo $$ > {pid}; {submodules}; code=$?; if [ \"$code\" -ne 0 ]; then printf 'Submodule checkout failed with code %s.\\n' \"$code\"; fi; {run_script}printf '%s\\n' \"$code\" > {temp}; mv {temp} {receipt}; exit \"$code\"",
            pid = quote(&self.dir.join("pid").to_string_lossy()),
            temp = quote(&self.dir.join("receipt.tmp").to_string_lossy()),
            receipt = quote(&self.dir.join("receipt").to_string_lossy())
        );
        let mut process = crate::process::command("/bin/sh");
        let lock_fd = lock.as_raw_fd();
        unsafe {
            process.pre_exec(move || {
                if libc::dup2(lock_fd, 198) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(198, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        process.arg("-c").arg(wrapper);
        configure(&mut process);
        process.spawn()
    }

    /// Windows cannot hand a lock to a child, so the PowerShell wrapper takes it by opening
    /// the lock file unshared. The script runs as a batch file in cmd.exe.
    #[cfg(windows)]
    fn spawn(
        &self,
        lock: std::fs::File,
        configure: impl FnOnce(&mut std::process::Command),
    ) -> std::io::Result<std::process::Child> {
        std::fs::write(self.dir.join("setup.ps1"), include_str!("setup.ps1"))?;
        let script = match self.script {
            Some(command) => {
                let path = self.dir.join("script.cmd");
                std::fs::write(&path, project::batch_script(command))?;
                path.into_os_string()
            }
            None => Default::default(),
        };
        drop(lock);
        let mut process = crate::process::command("powershell.exe");
        process
            .args(["-NoLogo", "-NoProfile", "-NonInteractive"])
            .args(["-ExecutionPolicy", "Bypass", "-File"])
            .arg(self.dir.join("setup.ps1"))
            .env("BOT_CODE_SETUP_DIR", self.dir)
            .env("BOT_CODE_SETUP_SUBMODULES", self.submodules)
            .env("BOT_CODE_SETUP_SCRIPT", script);
        configure(&mut process);
        process.spawn()
    }
}
