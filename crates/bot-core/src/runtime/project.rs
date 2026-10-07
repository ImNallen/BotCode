// Ports T3 Code v0.0.45 apps/server/src/project/ProjectSetupScriptRunner.ts (MIT).
use super::*;
use crate::project::{self, ProjectConfig, SetupState, WorktreeSetup};
use std::io::{Read, Seek, SeekFrom};
use std::os::{fd::AsRawFd, unix::process::CommandExt};

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
        let command = setup
            .script
            .as_ref()
            .map(|s| s.command.as_str())
            .unwrap_or(":");
        let submodules = match setup.submodules.as_str() {
            "recursive" => "git submodule update --init --recursive",
            "top-level" => "git submodule update --init",
            _ => ":",
        };
        let quote = project::quote;
        let run_script = setup.script.as_ref().map_or_else(String::new, |_| {
            format!(
                "{} -c {}; code=$?; ",
                quote(&project::shell(self.config.shell.as_deref()).to_string_lossy()),
                quote(command)
            )
        });
        let wrapper = format!(
            "echo $$ > {pid}; {submodules}; code=$?; if [ \"$code\" -ne 0 ]; then printf 'Submodule checkout failed with code %s.\\n' \"$code\"; fi; {run_script}printf '%s\\n' \"$code\" > {temp}; mv {temp} {receipt}; exit \"$code\"",
            pid = quote(&attempt_dir.join("pid").to_string_lossy()),
            temp = quote(&attempt_dir.join("receipt.tmp").to_string_lossy()),
            receipt = quote(&attempt_dir.join("receipt").to_string_lossy())
        );
        let lock = lock_attempt(&attempt_dir)?
            .ok_or_else(|| AppError::new("setup_busy", "Setup is already running."))?;
        let output = std::fs::File::create(attempt_dir.join("output"))?;
        let lock_fd = lock.as_raw_fd();
        self.install(thread)?;
        let mut process = std::process::Command::new("/bin/sh");
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
        let result = process
            .arg("-c")
            .arg(wrapper)
            .current_dir(cwd.clone())
            .env("T3CODE_PROJECT_ROOT", root)
            .env("T3CODE_WORKTREE_PATH", cwd)
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .stdin(std::process::Stdio::null())
            .stdout(output.try_clone()?)
            .stderr(output)
            .spawn();
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
            if let Ok(code) = receipt.trim().parse::<i32>() {
                setup.state = if code == 0 {
                    SetupState::Succeeded
                } else {
                    SetupState::Failed {
                        reason: format!("Setup exited with code {code}."),
                        exit_code: Some(code),
                    }
                };
                setup.completed_at_ms = Some(now_ms());
            }
        } else if setup
            .started_at_ms
            .is_none_or(|at| now_ms().saturating_sub(at) > 2000)
            && lock_attempt(&dir)?.is_some()
        {
            setup.state = SetupState::Interrupted {
                reason: "The setup process stopped without recording its result.".into(),
            };
            setup.completed_at_ms = Some(now_ms());
        }
        let finished = !setup.active();
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
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("lock"))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(file));
    }
    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::WouldBlock {
        Ok(None)
    } else {
        Err(error.into())
    }
}
