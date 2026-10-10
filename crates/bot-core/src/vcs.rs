mod progress;
pub(crate) mod publish;
mod staging;
use crate::{domain::*, repo};
use staging::new_branch_name;
pub(crate) use staging::stage;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Child,
};

pub(crate) const NON_INTERACTIVE: [(&str, &str); 6] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GCM_INTERACTIVE", "never"),
    ("GH_PROMPT_DISABLED", "1"),
    ("GH_NO_UPDATE_NOTIFIER", "1"),
    ("NO_COLOR", "1"),
    ("LC_ALL", "C"),
];
/// SIGTERM lets git remove its lockfiles before SIGKILL.
const GRACE: Duration = Duration::from_secs(2);

pub(crate) struct Tool<'a> {
    pub program: &'a Path,
    pub cwd: &'a Path,
}
pub(crate) struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    hook_warnings: Vec<String>,
}
impl Output {
    fn success(self, warnings: &mut Vec<String>) -> Result<String> {
        warnings.extend(self.hook_warnings);
        if self.code == Some(0) {
            return Ok(self.stdout);
        }
        Err(AppError::new(
            "git",
            if self.stderr.trim().is_empty() {
                self.stdout.trim()
            } else {
                self.stderr.trim()
            },
        ))
    }
}
struct ToolExecution<'a> {
    prefix: bool,
    input: Option<&'a [u8]>,
    env: &'a [(&'a str, &'a std::ffi::OsStr)],
    observer: Option<&'a (dyn Fn(GitProgress) + Send + Sync)>,
}
impl Tool<'_> {
    pub async fn run(&self, args: &[&str], limit: Duration) -> Result<Output> {
        self.run_bounded(args, limit, u64::MAX - 1).await
    }
    pub async fn run_bounded(&self, args: &[&str], limit: Duration, bytes: u64) -> Result<Output> {
        let (_send, mut cancel) = tokio::sync::watch::channel(false);
        self.run_cancellable(args, limit, bytes, &mut cancel).await
    }
    pub async fn run_cancellable(
        &self,
        args: &[&str],
        limit: Duration,
        bytes: u64,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<Output> {
        self.run_with_input(args, limit, bytes, cancel, None).await
    }
    pub async fn run_prefix(
        &self,
        args: &[&str],
        limit: Duration,
        bytes: u64,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<Output> {
        self.run_observable(
            args,
            Some(limit),
            bytes,
            cancel,
            ToolExecution {
                prefix: true,
                input: None,
                env: &[],
                observer: None,
            },
        )
        .await
    }
    pub async fn run_with_input(
        &self,
        args: &[&str],
        limit: Duration,
        bytes: u64,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
        input: Option<&[u8]>,
    ) -> Result<Output> {
        self.run_with_env_input(args, limit, bytes, cancel, input, &[])
            .await
    }
    pub async fn run_with_env_input(
        &self,
        args: &[&str],
        limit: Duration,
        bytes: u64,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
        input: Option<&[u8]>,
        env: &[(&str, &std::ffi::OsStr)],
    ) -> Result<Output> {
        self.run_observable(
            args,
            Some(limit),
            bytes,
            cancel,
            ToolExecution {
                prefix: false,
                input,
                env,
                observer: None,
            },
        )
        .await
    }
    pub(crate) async fn clone_progress(
        &self,
        args: &[&str],
        cancel: &mut tokio::sync::watch::Receiver<bool>,
        observer: &(dyn Fn(GitProgress) + Send + Sync),
    ) -> Result<Output> {
        self.run_observable(
            args,
            None,
            256 * 1024,
            cancel,
            ToolExecution {
                prefix: false,
                input: None,
                env: &[("GIT_PROGRESS_DELAY", std::ffi::OsStr::new("0"))],
                observer: Some(observer),
            },
        )
        .await
    }
    async fn run_observable(
        &self,
        args: &[&str],
        limit: Option<Duration>,
        bytes: u64,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
        execution: ToolExecution<'_>,
    ) -> Result<Output> {
        let ToolExecution {
            prefix,
            input,
            env,
            observer,
        } = execution;
        if *cancel.borrow() {
            return Err(AppError::new("cancelled", "Tool work cancelled."));
        }
        let mut command = tokio::process::Command::from(crate::process::grouped(self.program));
        command
            .args(args)
            .current_dir(self.cwd)
            .envs(NON_INTERACTIVE)
            .envs(env.iter().copied())
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::new(
                "tool_missing",
                format!("{} was not found.", self.program.display()),
            ),
            _ => e.into(),
        })?;
        let pid = child.id();
        let (mut stdout, mut stderr) = (child.stdout.take(), child.stderr.take());
        let mut stdin = child.stdin.take();
        let finished = tokio::select! {
            _ = cancel.changed() => None,
            result = async {
                let run = async {
                    let (mut out, mut err) = (Vec::new(), Vec::new());
                    let (status, _, _, _) = tokio::try_join!(
                        child.wait(),
                        async {
                            if let (Some(mut pipe), Some(input)) = (stdin.take(), input) {
                                pipe.write_all(input).await?;
                                pipe.shutdown().await?;
                            }
                            Ok::<_, std::io::Error>(())
                        },
                        progress::read_output(&mut stdout, &mut out, bytes, prefix, observer, GitOutputStream::Stdout),
                        progress::read_output(&mut stderr, &mut err, bytes, false, observer, GitOutputStream::Stderr),
                    )?;
                    Ok::<_, std::io::Error>((status, out, err))
                };
                match limit {
                    Some(limit) => tokio::time::timeout(limit, run).await,
                    None => Ok(run.await),
                }
            } => Some(result),
        };
        let Some(finished) = finished else {
            stop(&mut child, pid).await?;
            return Err(AppError::new("cancelled", "Tool work cancelled."));
        };
        match finished {
            Ok(result) => {
                let (status, out, err) = match result {
                    Ok(result) => result,
                    Err(error) => {
                        stop(&mut child, pid).await?;
                        return Err(error.into());
                    }
                };
                Ok(Output {
                    stdout: String::from_utf8_lossy(&out).into_owned(),
                    stderr: String::from_utf8_lossy(&err).into_owned(),
                    code: status.code(),
                    hook_warnings: Vec::new(),
                })
            }
            Err(_) => {
                stop(&mut child, pid).await?;
                Err(AppError::new(
                    "timeout",
                    format!("{} {} timed out.", self.name(), args.first().unwrap_or(&"")),
                ))
            }
        }
    }
    async fn run_observed(
        &self,
        args: &[&str],
        limit: Duration,
        observer: &(dyn Fn(GitProgress) + Send + Sync),
    ) -> Result<Output> {
        let trace = tempfile::NamedTempFile::new()?;
        let env = [("GIT_TRACE2_EVENT", trace.path().as_os_str())];
        let (_send, mut cancel) = tokio::sync::watch::channel(false);
        let run = self.run_observable(
            args,
            Some(limit),
            64 * 1024,
            &mut cancel,
            ToolExecution {
                prefix: false,
                input: None,
                env: &env,
                observer: Some(observer),
            },
        );
        tokio::pin!(run);
        let mut reader = progress::HookTrace::new(trace.path()).await?;
        let mut tick = tokio::time::interval(Duration::from_millis(20));
        let mut trace_available = true;
        loop {
            tokio::select! {
                result = &mut run => {
                    if trace_available { let _ = reader.drain(observer).await; }
                    return result.map(|mut output| {
                        if output.code == Some(0) && !reader.failed.is_empty() {
                            output.hook_warnings = reader.failed;
                        }
                        output
                    });
                }
                _ = tick.tick(), if trace_available => {
                    if let Err(error) = reader.drain(observer).await {
                        trace_available = false;
                        observer(GitProgress::Output { stream: GitOutputStream::Stderr, line: format!("Hook progress unavailable: {}", error.message) });
                    }
                },
            }
        }
    }
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
async fn stop(child: &mut Child, pid: Option<u32>) -> Result<()> {
    use crate::process::{Kill, kill_tree, tree_alive};
    if let Some(pid) = pid {
        kill_tree(pid, Kill::Polite);
    }
    if tokio::time::timeout(GRACE, child.wait()).await.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let Some(pid) = pid else {
        return Ok(());
    };
    kill_tree(pid, Kill::Force);
    let reaped = tokio::time::timeout(GRACE, async {
        while tree_alive(pid) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    reaped.map_err(|_| {
        AppError::new(
            "process_cleanup",
            "A tool process group did not exit after cancellation.",
        )
    })
}

/// Resolves a CLI for an app launched from Finder: `$<env>`, then [`bin_dirs`].
pub(crate) fn installed_binary(name: &str, env: &str) -> PathBuf {
    if let Some(path) = std::env::var_os(env) {
        return path.into();
    }
    bin_dirs()
        .into_iter()
        .find_map(|dir| executable(dir.join(name)))
        .unwrap_or_else(|| name.into())
}
/// An app launched from Finder gets launchd's minimal PATH, so the usual install locations
/// follow it: ~/.local/bin, /opt/homebrew/bin and /usr/local/bin.
pub(crate) fn bin_dirs() -> Vec<PathBuf> {
    let path = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>());
    let home = std::env::home_dir().map(|home| home.join(".local/bin"));
    let fallbacks: &[&str] = if cfg!(unix) {
        &["/opt/homebrew/bin", "/usr/local/bin"]
    } else {
        &[]
    };
    path.chain(home)
        .chain(fallbacks.iter().map(PathBuf::from))
        .collect()
}
/// The runnable file `path` names. Windows runs `code` as `code.cmd` or `code.exe`, so there
/// the first `PATHEXT` extension that exists completes a bare name.
pub(crate) fn executable(path: PathBuf) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(&path)
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .then_some(path)
    }
    #[cfg(windows)]
    {
        let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let extensions: Vec<&str> = extensions.split(';').filter(|e| !e.is_empty()).collect();
        let listed = path.extension().is_some_and(|ext| {
            extensions
                .iter()
                .any(|e| e[1..].eq_ignore_ascii_case(&ext.to_string_lossy()))
        });
        let mut candidates = Vec::new();
        if listed {
            candidates.push(path.clone());
        }
        candidates.extend(extensions.iter().map(|e| {
            let mut name = path.clone().into_os_string();
            name.push(e.to_ascii_lowercase());
            PathBuf::from(name)
        }));
        candidates.into_iter().find(|candidate| candidate.is_file())
    }
}

const LOCAL: Duration = Duration::from_secs(30);
/// `git commit` runs the repository's hooks, which may lint or test.
const COMMIT: Duration = Duration::from_secs(600);

fn git(root: &Path) -> Tool<'_> {
    Tool {
        program: Path::new("git"),
        cwd: root,
    }
}
async fn head(root: &Path) -> Result<String> {
    Ok(git(root)
        .ok(&["rev-parse", "HEAD"], LOCAL, "git")
        .await?
        .trim()
        .to_owned())
}

pub(crate) async fn status(root: &Path) -> Result<GitStatus> {
    let git = git(root);
    let porcelain = parse_porcelain(
        &git.ok(
            &[
                "--no-optional-locks",
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                "--untracked-files=all",
            ],
            LOCAL,
            "git",
        )
        .await?,
    );
    let against = if porcelain.unborn { "--cached" } else { "HEAD" };
    let numstat = git
        .ok(
            &[
                "--no-optional-locks",
                "diff",
                against,
                "--numstat",
                "-z",
                "--",
            ],
            LOCAL,
            "git",
        )
        .await?;
    let mut files: BTreeMap<String, FileStat> = porcelain
        .paths
        .into_iter()
        .map(|path| {
            let stat = FileStat {
                path: path.clone(),
                insertions: 0,
                deletions: 0,
            };
            (path, stat)
        })
        .collect();
    // Diff and status can infer different rename sources for identical files.
    for stat in parse_numstat(&numstat) {
        if let Some(file) = files.get_mut(&stat.path) {
            *file = stat;
        }
    }
    let origin = git.run(&["remote", "get-url", "origin"], LOCAL).await?.code == Some(0);
    let branch = match porcelain.head {
        Some(name) => Some(branch_status(root, name, porcelain.ahead_behind).await?),
        None => None,
    };
    Ok(GitStatus {
        branch,
        origin,
        files: files.into_values().collect(),
    })
}
/// Only a remote branch with the same name is an upstream. A branch that tracks another
/// branch was cut from it, and pushing there would write onto a shared branch.
fn split_tracking(
    name: &str,
    tracked: Option<(String, String)>,
    ahead_behind: Option<(u32, u32)>,
) -> (Option<Tracking>, Option<String>) {
    match (tracked, ahead_behind) {
        (Some((remote, branch)), Some((ahead, behind))) if branch == name => (
            Some(Tracking {
                remote,
                branch,
                ahead,
                behind,
            }),
            None,
        ),
        (tracked, _) => (None, tracked.map(|(_, branch)| branch)),
    }
}
async fn branch_status(
    root: &Path,
    name: String,
    ahead_behind: Option<(u32, u32)>,
) -> Result<BranchStatus> {
    let git = git(root);
    let config = |key: &'static str| {
        let key = format!("branch.{name}.{key}");
        let git = &git;
        async move {
            let out = git.run(&["config", "--get", &key], LOCAL).await?;
            Ok::<_, AppError>((out.code == Some(0)).then(|| out.stdout.trim().to_owned()))
        }
    };
    let tracked = config("remote").await?.zip(
        config("merge")
            .await?
            .map(|merge| merge.trim_start_matches("refs/heads/").to_owned()),
    );
    let recorded = config("gh-merge-base").await?;
    let path = root.to_path_buf();
    let default = tokio::task::spawn_blocking(move || repo::default_branch(&path))
        .await
        .map_err(|e| AppError::new("repository", e))?;
    let (upstream, cut_from) = split_tracking(&name, tracked, ahead_behind);
    let base = recorded
        .or(cut_from.filter(|branch| *branch != name))
        .or(default.clone())
        .unwrap_or_else(|| name.clone());
    let is_default = default.as_deref() == Some(name.as_str());
    let ahead_of_base = if is_default || base == name {
        0
    } else {
        ahead_of(root, &base).await?
    };
    Ok(BranchStatus {
        name,
        is_default,
        base,
        ahead_of_base,
        upstream,
    })
}
async fn ahead_of(root: &Path, base: &str) -> Result<u32> {
    let git = git(root);
    for candidate in [
        format!("refs/remotes/origin/{base}"),
        format!("refs/heads/{base}"),
    ] {
        let exists = git
            .run(&["show-ref", "--verify", "--quiet", &candidate], LOCAL)
            .await?;
        if exists.code == Some(0) {
            let range = format!("{candidate}..HEAD");
            let count = git.run(&["rev-list", "--count", &range], LOCAL).await?;
            return Ok(count.stdout.trim().parse().unwrap_or(0));
        }
    }
    Ok(0)
}
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Porcelain {
    pub head: Option<String>,
    pub unborn: bool,
    pub ahead_behind: Option<(u32, u32)>,
    pub paths: Vec<String>,
    pub renames: BTreeMap<String, String>,
}
pub(crate) fn parse_porcelain(out: &str) -> Porcelain {
    let mut porcelain = Porcelain::default();
    let mut records = out.split('\0');
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => porcelain.unborn = value == "(initial)",
                "branch.head" if value != "(detached)" => porcelain.head = Some(value.into()),
                "branch.ab" => {
                    porcelain.ahead_behind = value.split_once(' ').and_then(|(ahead, behind)| {
                        Some((
                            ahead.trim_start_matches('+').parse().ok()?,
                            behind.trim_start_matches('-').parse().ok()?,
                        ))
                    })
                }
                _ => {}
            }
            continue;
        }
        let path = match record.split_once(' ') {
            Some(("1", _)) => record.splitn(9, ' ').nth(8),
            // A rename's original path follows as its own field.
            Some(("2", _)) => {
                let original = records.next();
                let path = record.splitn(10, ' ').nth(9);
                if let (Some(path), Some(original)) = (path, original) {
                    porcelain.renames.insert(path.into(), original.into());
                }
                path
            }
            Some(("u", _)) => record.splitn(11, ' ').nth(10),
            Some(("?", path)) => Some(path),
            _ => None,
        };
        if let Some(path) = path {
            porcelain.paths.push(path.into());
        }
    }
    porcelain
}
/// Parses `diff --numstat -z`. Binary files count 0/0; renames report the new path.
pub(crate) fn parse_numstat(out: &str) -> Vec<FileStat> {
    let mut records = out.split('\0');
    let mut stats = Vec::new();
    while let Some(record) = records.next() {
        let mut fields = record.splitn(3, '\t');
        let (Some(insertions), Some(deletions), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            records.next();
            records.next().unwrap_or_default()
        } else {
            path
        };
        stats.push(FileStat {
            path: path.into(),
            insertions: insertions.parse().unwrap_or(0),
            deletions: deletions.parse().unwrap_or(0),
        });
    }
    stats
}

async fn gh(gh: &Path, root: &Path, args: &[&str], limit: Duration) -> Result<String> {
    let out = Tool {
        program: gh,
        cwd: root,
    }
    .run_bounded(args, limit, 2 * 1024 * 1024)
    .await
    .map_err(|e| match e.code.as_str() {
        "tool_missing" => AppError::new(
            "gh_missing",
            "Install GitHub CLI (gh) to create pull requests.",
        ),
        _ => e,
    })?;
    match out.code {
        Some(0) => Ok(out.stdout),
        // gh's exit code for a missing or expired login.
        Some(4) => Err(AppError::new(
            "gh_unauthenticated",
            "Run `gh auth login` to create pull requests.",
        )),
        _ => Err(AppError::new(
            "gh",
            match out.stderr.trim() {
                "" => out.stdout.trim(),
                stderr => stderr,
            },
        )),
    }
}
async fn pr_repository(root: &Path) -> Result<String> {
    let remote = git(root)
        .ok(&["config", "--get", "remote.origin.url"], LOCAL, "git")
        .await?;
    let (owner, name) = crate::pull_requests::repository(remote.trim())?;
    Ok(format!("github.com/{owner}/{name}"))
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    Pull {
        upstream: String,
    },
    FeatureStack {
        request: Box<CommitRequest>,
        tail: CommitTail,
        base: String,
    },
    Stack {
        commit: Option<CommitStep>,
        push: Option<PushTarget>,
        pr: Option<PrStep>,
    },
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CommitTail {
    Push,
    PushPr,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PreparedCommit {
    message: CommitMessage,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CommitStep {
    Requested(Box<CommitRequest>),
    Prepared(PreparedCommit),
}
struct StackTargets {
    push: Option<PushTarget>,
    pr: Option<PrStep>,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct PushTarget {
    pub remote: String,
    pub branch: String,
    pub set_upstream: bool,
    /// A `-u` push rewrites `branch.<name>.merge`, which may be where the base came from.
    pub record_base: Option<String>,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PrStep {
    Existing(PullRequest),
    Create { base: String, head: String },
}
pub(crate) fn plan(
    action: GitAction,
    status: &GitStatus,
    pr: Option<&PrLookup>,
) -> std::result::Result<Plan, GitFailure> {
    if let GitAction::CommitPush { request } | GitAction::CommitPushPr { request } = &action
        && request.destination == CommitDestination::NewBranch
    {
        if status.files.is_empty() {
            return Err(feature_no_changes());
        }
        let branch = status.branch.as_ref().ok_or_else(|| {
            refuse(
                GitPhase::Branch,
                "detached_head",
                "Check out a branch before creating a feature branch.",
            )
        })?;
        let tail = if matches!(action, GitAction::CommitPushPr { .. }) {
            CommitTail::PushPr
        } else {
            CommitTail::Push
        };
        return Ok(Plan::FeatureStack {
            request: Box::new(request.clone()),
            tail,
            base: branch.base.clone(),
        });
    }
    let (commit, pushes, opens) = match action {
        GitAction::Pull => return plan_pull(status),
        GitAction::Commit { request } => {
            (Some(CommitStep::Requested(Box::new(request))), false, false)
        }
        GitAction::CommitPush { request } => {
            (Some(CommitStep::Requested(Box::new(request))), true, false)
        }
        GitAction::CommitPushPr { request } => {
            (Some(CommitStep::Requested(Box::new(request))), true, true)
        }
        GitAction::Push => (None, true, false),
        GitAction::CreatePr => (None, false, true),
    };
    if commit.is_some() && status.files.is_empty() {
        return Err(refuse(
            GitPhase::Commit,
            "nothing_to_commit",
            "There are no changes to commit.",
        ));
    }
    if !pushes && !opens {
        return Ok(Plan::Stack {
            commit,
            push: None,
            pr: None,
        });
    }
    let StackTargets { push, pr } = stack_targets(commit.as_ref(), pushes, opens, status, pr)?;
    Ok(Plan::Stack { commit, push, pr })
}
fn stack_targets(
    commit: Option<&CommitStep>,
    pushes: bool,
    opens: bool,
    status: &GitStatus,
    pr: Option<&PrLookup>,
) -> std::result::Result<StackTargets, GitFailure> {
    let commits = commit.is_some();
    let upstream = status.branch.as_ref().and_then(|b| b.upstream.as_ref());
    let remote = upstream.map_or("origin", |u| u.remote.as_str());
    let phase = if pushes {
        GitPhase::Push {
            remote: remote.into(),
        }
    } else {
        GitPhase::Pr
    };
    let Some(branch) = &status.branch else {
        return Err(refuse(
            phase,
            "detached_head",
            "Check out a branch before pushing or opening a pull request.",
        ));
    };
    if let Some(up) = upstream.filter(|up| up.behind > 0) {
        return Err(refuse(
            phase,
            "behind_upstream",
            format!(
                "Pull the latest changes from {}/{} first.",
                up.remote, up.branch
            ),
        ));
    }
    if upstream.is_none() && !status.origin {
        return Err(refuse(
            phase,
            "no_remote",
            "Add an \"origin\" remote before pushing.",
        ));
    }
    let ahead = upstream.map_or(branch.ahead_of_base, |u| u.ahead);
    if pushes && !commits && ahead == 0 {
        return Err(refuse(
            phase,
            "nothing_to_push",
            "No local commits to push.",
        ));
    }
    let pr = if opens {
        Some(plan_pr(status, branch, commits, pr)?)
    } else {
        None
    };
    let push = (commits || pushes || upstream.is_none() || ahead > 0).then(|| {
        let set_upstream = upstream.is_none();
        PushTarget {
            remote: remote.into(),
            branch: branch.name.clone(),
            set_upstream,
            record_base: (set_upstream && branch.base != branch.name).then(|| branch.base.clone()),
        }
    });
    Ok(StackTargets { push, pr })
}
fn plan_pr(
    status: &GitStatus,
    branch: &BranchStatus,
    commits: bool,
    lookup: Option<&PrLookup>,
) -> std::result::Result<PrStep, GitFailure> {
    if !commits && !status.files.is_empty() {
        return Err(refuse(
            GitPhase::Pr,
            "uncommitted_changes",
            "Commit your changes before creating a pull request.",
        ));
    }
    if branch.name == branch.base {
        return Err(refuse(
            GitPhase::Pr,
            "default_branch",
            format!("Pull requests need a branch other than {}.", branch.base),
        ));
    }
    if !commits && branch.ahead_of_base == 0 {
        return Err(refuse(
            GitPhase::Pr,
            "no_commits",
            format!("{} has no commits ahead of {}.", branch.name, branch.base),
        ));
    }
    match lookup {
        Some(PrLookup::Open { pr }) => Ok(PrStep::Existing(pr.clone())),
        Some(PrLookup::Unavailable {
            reason: GhProblem::Missing,
            message,
        }) => Err(refuse(GitPhase::Pr, "gh_missing", message)),
        Some(PrLookup::Unavailable {
            reason: GhProblem::Unauthenticated,
            message,
        }) => Err(refuse(GitPhase::Pr, "gh_unauthenticated", message)),
        _ => Ok(PrStep::Create {
            base: branch.base.clone(),
            head: branch.name.clone(),
        }),
    }
}
fn plan_pull(status: &GitStatus) -> std::result::Result<Plan, GitFailure> {
    let Some(branch) = &status.branch else {
        return Err(refuse(
            GitPhase::Pull,
            "detached_head",
            "Check out a branch before pulling.",
        ));
    };
    let Some(up) = &branch.upstream else {
        return Err(refuse(
            GitPhase::Pull,
            "no_upstream",
            format!("{} has no upstream branch to pull from.", branch.name),
        ));
    };
    let upstream = format!("{}/{}", up.remote, up.branch);
    if up.ahead > 0 && up.behind > 0 {
        return Err(refuse(
            GitPhase::Pull,
            "diverged",
            format!(
                "{} has diverged from {upstream}. Rebase or merge first.",
                branch.name
            ),
        ));
    }
    Ok(Plan::Pull { upstream })
}
fn refuse(phase: GitPhase, code: &str, message: impl ToString) -> GitFailure {
    GitFailure {
        phase,
        error: AppError::new(code, message),
    }
}

pub(crate) struct Context {
    pub root: PathBuf,
    pub gh: PathBuf,
    pub network: Duration,
    pub codex: PathBuf,
    pub model: Option<String>,
    pub writing_style: crate::settings::WritingStyle,
    pub progress: Box<dyn Fn(GitProgress) + Send + Sync>,
}
pub(crate) async fn run(cx: &Context, action: GitAction) -> Result<GitOutcome> {
    let status = status(&cx.root).await?;
    let mut planned = plan(action.clone(), &status, None);
    if let (Ok(Plan::Stack { pr: Some(_), .. }), Some(branch)) = (&planned, &status.branch) {
        let lookup = crate::pull_requests::current_branch(&cx.gh, &cx.root, &branch.name).await;
        planned = plan(action, &status, Some(&lookup));
    }
    let mut out = GitOutcome::default();
    let ran = match planned {
        Err(failure) => Err(failure),
        Ok(plan) => steps(cx, plan, &mut out).await,
    };
    out.failure = ran.err();
    Ok(out)
}
async fn steps(
    cx: &Context,
    plan: Plan,
    out: &mut GitOutcome,
) -> std::result::Result<(), GitFailure> {
    let failed = |phase: GitPhase| move |error| GitFailure { phase, error };
    let (commit_message, push_target, pr_step) = match plan {
        Plan::Pull { upstream } => {
            (cx.progress)(GitProgress::Phase {
                phase: GitPhase::Pull,
            });
            out.pull = Some(
                pull(cx, upstream, &mut out.warnings)
                    .await
                    .map_err(failed(GitPhase::Pull))?,
            );
            return Ok(());
        }
        Plan::Stack { commit, push, pr } => (commit, push, pr),
        Plan::FeatureStack {
            request,
            tail,
            base,
        } => {
            (cx.progress)(GitProgress::Phase {
                phase: GitPhase::Branch,
            });
            let prepared = prepare_commit(cx, *request).await.map_err(|error| {
                if error.code == "nothing_to_commit" {
                    feature_no_changes()
                } else {
                    failed(GitPhase::Branch)(error)
                }
            })?;
            let branch = checkout_feature(cx, &prepared.message, out)
                .await
                .map_err(failed(GitPhase::Branch))?;
            git(&cx.root)
                .ok(
                    &["config", &repo::merge_base_key(&branch), &base],
                    LOCAL,
                    "git",
                )
                .await
                .map_err(failed(GitPhase::Branch))?;
            let status = status(&cx.root).await.map_err(failed(GitPhase::Branch))?;
            let commit = CommitStep::Prepared(prepared);
            let opens = tail == CommitTail::PushPr;
            let mut targets = stack_targets(Some(&commit), true, opens, &status, None)?;
            if targets.pr.is_some() {
                let lookup = crate::pull_requests::current_branch(&cx.gh, &cx.root, &branch).await;
                targets = stack_targets(Some(&commit), true, opens, &status, Some(&lookup))?;
            }
            (Some(commit), targets.push, targets.pr)
        }
    };
    if let Some(message) = commit_message {
        (cx.progress)(GitProgress::Phase {
            phase: GitPhase::Commit,
        });
        match message {
            CommitStep::Requested(request) => commit(cx, *request, out).await,
            CommitStep::Prepared(prepared) => commit_prepared(cx, prepared, out).await,
        }
        .map_err(failed(GitPhase::Commit))?;
    }
    if let Some(target) = push_target {
        let phase = GitPhase::Push {
            remote: target.remote.clone(),
        };
        (cx.progress)(GitProgress::Phase {
            phase: phase.clone(),
        });
        out.push = Some(
            push(cx, &target, &mut out.warnings)
                .await
                .map_err(failed(phase))?,
        );
    }
    if let Some(step) = pr_step {
        (cx.progress)(GitProgress::Phase {
            phase: GitPhase::Pr,
        });
        out.pr = Some(
            open_pr(cx, step, &mut out.warnings)
                .await
                .map_err(failed(GitPhase::Pr))?,
        );
    }
    Ok(())
}
fn feature_no_changes() -> GitFailure {
    refuse(
        GitPhase::Branch,
        "nothing_to_commit",
        "Cannot create a feature branch because there are no changes to commit.",
    )
}
async fn commit(cx: &Context, request: CommitRequest, out: &mut GitOutcome) -> Result<()> {
    let destination = request.destination.clone();
    let prepared = prepare_commit(cx, request).await?;
    if destination == CommitDestination::NewBranch {
        checkout_feature(cx, &prepared.message, out).await?;
    }
    commit_prepared(cx, prepared, out).await
}
async fn prepare_commit(cx: &Context, request: CommitRequest) -> Result<PreparedCommit> {
    let root = &cx.root;
    let git = git(root);
    let (_send, mut cancel) = tokio::sync::watch::channel(false);
    stage(root, &request.selection, None, &mut cancel).await?;
    if git.run(&["diff", "--cached", "--quiet"], LOCAL).await?.code == Some(0) {
        return Err(AppError::new(
            "nothing_to_commit",
            "There are no changes to commit.",
        ));
    }
    let message = match request.message {
        Some(message) => message,
        None => {
            let (_send, mut cancel) = tokio::sync::watch::channel(false);
            crate::text_generation::commit_message(
                &cx.codex,
                cx.model.as_deref(),
                root,
                None,
                &cx.writing_style,
                &mut cancel,
            )
            .await
            .map_err(|_| {
                AppError::new(
                    "commit_generation",
                    "Could not generate a commit message. Enter a commit message and try again.",
                )
            })?
        }
    };
    Ok(PreparedCommit { message })
}
async fn checkout_feature(
    cx: &Context,
    message: &CommitMessage,
    out: &mut GitOutcome,
) -> Result<String> {
    let git = git(&cx.root);
    let branch = new_branch_name(&cx.root, message.subject()).await?;
    let switched = git
        .run_observed(
            &["checkout", "--no-track", "-b", &branch],
            LOCAL,
            cx.progress.as_ref(),
        )
        .await;
    if git
        .ok(&["symbolic-ref", "--short", "HEAD"], LOCAL, "git")
        .await
        .is_ok_and(|current| current.trim() == branch)
    {
        out.branch = Some(branch.clone());
    }
    switched?.success(&mut out.warnings)?;
    if out.branch.as_ref() != Some(&branch) {
        return Err(AppError::new(
            "git",
            "Git did not check out the feature branch.",
        ));
    }
    Ok(branch)
}
async fn commit_prepared(
    cx: &Context,
    prepared: PreparedCommit,
    out: &mut GitOutcome,
) -> Result<()> {
    let root = &cx.root;
    let git = git(root);
    let message = prepared.message;
    let before = head(root).await.ok();
    let committed = git
        .run_observed(
            &["commit", "-m", message.as_str()],
            COMMIT,
            cx.progress.as_ref(),
        )
        .await;
    // Hooks may fail after HEAD moved. Report that landed commit before the failure.
    if let Ok(sha) = head(root).await
        && before.as_ref() != Some(&sha)
    {
        out.commit = Some(Committed {
            sha,
            subject: message.subject().into(),
        });
    }
    committed?.success(&mut out.warnings)?;
    if out.commit.is_none() {
        return Err(AppError::new("git", "Git did not create a commit."));
    }
    Ok(())
}
async fn push(cx: &Context, target: &PushTarget, warnings: &mut Vec<String>) -> Result<Pushed> {
    let git = git(&cx.root);
    if let Some(base) = &target.record_base {
        git.ok(
            &["config", &repo::merge_base_key(&target.branch), base],
            LOCAL,
            "git",
        )
        .await?;
    }
    let refspec = format!("HEAD:refs/heads/{}", target.branch);
    let mut args = vec!["push"];
    if target.set_upstream {
        args.push("-u");
    }
    args.extend([target.remote.as_str(), &refspec]);
    git.run_observed(&args, cx.network, cx.progress.as_ref())
        .await?
        .success(warnings)?;
    Ok(Pushed {
        sha: head(&cx.root).await?,
        upstream: format!("{}/{}", target.remote, target.branch),
        set_upstream: target.set_upstream,
    })
}
async fn pull(cx: &Context, upstream: String, warnings: &mut Vec<String>) -> Result<Pulled> {
    let before = head(&cx.root).await?;
    git(&cx.root)
        .run_observed(&["pull", "--ff-only"], cx.network, cx.progress.as_ref())
        .await?
        .success(warnings)?;
    Ok(Pulled {
        updated: head(&cx.root).await? != before,
        upstream,
    })
}
async fn open_pr(cx: &Context, step: PrStep, warnings: &mut Vec<String>) -> Result<PrOpened> {
    let (base, head) = match step {
        PrStep::Existing(pr) => return Ok(PrOpened { pr, created: false }),
        PrStep::Create { base, head } => (base, head),
    };
    let repository = pr_repository(&cx.root).await?;
    let (_send, mut cancel) = tokio::sync::watch::channel(false);
    let content = crate::text_generation::pr_content(
        &cx.codex,
        cx.model.as_deref(),
        &cx.root,
        &base,
        &head,
        &cx.writing_style,
        &mut cancel,
    )
    .await
    .and_then(|content| {
        let body_file = tempfile::NamedTempFile::new()?;
        std::fs::write(body_file.path(), content.body)?;
        Ok((content.title, body_file))
    });
    let generated_title = content.as_ref().ok().map(|(title, _)| title.clone());
    let body_path = content
        .as_ref()
        .ok()
        .map(|(_, file)| file.path().to_string_lossy());
    let mut args = vec![
        "pr",
        "create",
        "--repo",
        &repository,
        "--base",
        &base,
        "--head",
        &head,
    ];
    if let (Some(title), Some(path)) = (&generated_title, &body_path) {
        args.extend(["--title", title, "--body-file", path]);
    } else {
        warnings.push(
            "Could not generate pull request text. Used GitHub CLI's commit-based title and body."
                .into(),
        );
        args.insert(4, "--fill");
    }
    let created = gh(&cx.gh, &cx.root, &args, cx.network)
    .await.map_err(|error| {
        if error.code == "timeout" || error.code == "process_cleanup" || error.code == "io" {
            AppError::new("pr_creation_uncertain", "GitHub may have created this pull request. Refresh pull requests to confirm before starting another create action.")
        } else { error }
    })?;
    let url = created.lines().last().unwrap_or_default().trim();
    let key = crate::PullRequestKey::from_url(url)?;
    if format!("github.com/{}/{}", key.repository().0, key.repository().1) != repository {
        return Err(AppError::new(
            "pr_identity_mismatch",
            "GitHub returned a different repository.",
        ));
    }
    Ok(PrOpened {
        pr: PullRequest {
            number: key.number().parse().unwrap(),
            title: generated_title,
            url: key.url(),
            base,
            head,
        },
        created: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::time::Instant;

    #[test]
    fn porcelain_reads_branch_headers_and_every_kind_of_change() {
        let out = [
            "# branch.oid 1234",
            "# branch.head feature",
            "# branch.upstream origin/feature",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa bbb with space.txt",
            "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt",
            "old name.txt",
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
            "? untracked.txt",
            "",
        ]
        .join("\0");
        assert_eq!(
            parse_porcelain(&out),
            Porcelain {
                head: Some("feature".into()),
                unborn: false,
                ahead_behind: Some((2, 1)),
                renames: BTreeMap::from([("new name.txt".into(), "old name.txt".into())]),
                paths: vec![
                    "with space.txt".into(),
                    "new name.txt".into(),
                    "conflict.txt".into(),
                    "untracked.txt".into(),
                ],
            }
        );
        assert_eq!(
            parse_porcelain("# branch.oid (initial)\0# branch.head (detached)\0"),
            Porcelain {
                head: None,
                unborn: true,
                ahead_behind: None,
                paths: vec![],
                renames: BTreeMap::new(),
            }
        );
    }

    #[test]
    fn numstat_reports_renames_by_their_new_path_and_binaries_as_zero() {
        let out = [
            "3\t1\ta.txt",
            "-\t-\timage.png",
            "5\t0\t",
            "old.txt",
            "new.txt",
            "",
        ]
        .join("\0");
        let stat = |path: &str, insertions, deletions| FileStat {
            path: path.into(),
            insertions,
            deletions,
        };
        assert_eq!(
            parse_numstat(&out),
            [
                stat("a.txt", 3, 1),
                stat("image.png", 0, 0),
                stat("new.txt", 5, 0)
            ]
        );
    }

    fn feature(upstream: Option<Tracking>) -> GitStatus {
        GitStatus {
            branch: Some(BranchStatus {
                name: "feature".into(),
                is_default: false,
                base: "develop".into(),
                ahead_of_base: 1,
                upstream,
            }),
            origin: true,
            files: vec![],
        }
    }
    fn refusal(action: GitAction, status: &GitStatus) -> String {
        plan(action, status, None).unwrap_err().error.code
    }

    #[test]
    fn plans_refuse_what_cannot_finish() {
        let pull = GitAction::Pull;
        assert_eq!(refusal(pull.clone(), &feature(None)), "no_upstream");
        let lonely = GitStatus {
            origin: false,
            ..feature(None)
        };
        assert_eq!(refusal(GitAction::Push, &lonely), "no_remote");
        let mut main = feature(None);
        if let Some(branch) = &mut main.branch {
            branch.name = "develop".into();
        }
        assert_eq!(refusal(GitAction::CreatePr, &main), "default_branch");
        let mut level = feature(None);
        if let Some(branch) = &mut level.branch {
            branch.ahead_of_base = 0;
        }
        assert_eq!(refusal(GitAction::CreatePr, &level), "no_commits");
    }

    #[test]
    fn a_first_push_sets_the_upstream_and_keeps_the_base() {
        assert_eq!(
            plan(GitAction::CreatePr, &feature(None), Some(&PrLookup::None)),
            Ok(Plan::Stack {
                commit: None,
                push: Some(PushTarget {
                    remote: "origin".into(),
                    branch: "feature".into(),
                    set_upstream: true,
                    record_base: Some("develop".into()),
                }),
                pr: Some(PrStep::Create {
                    base: "develop".into(),
                    head: "feature".into(),
                }),
            })
        );
        let pushed = feature(Some(Tracking {
            remote: "fork".into(),
            branch: "feature".into(),
            ahead: 0,
            behind: 0,
        }));
        assert_eq!(
            plan(GitAction::CreatePr, &pushed, Some(&PrLookup::None)),
            Ok(Plan::Stack {
                commit: None,
                push: None,
                pr: Some(PrStep::Create {
                    base: "develop".into(),
                    head: "feature".into(),
                }),
            }),
            "an up-to-date branch opens its pull request without pushing"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_timed_out_tool_is_stopped_with_its_children() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("child.pid");
        let script = format!("sleep 300 & echo $! > {}; wait", pidfile.display());
        let sh = Tool {
            program: Path::new("/bin/sh"),
            cwd: dir.path(),
        };
        let started = Instant::now();
        let error = sh
            .run(&["-c", &script], Duration::from_secs(5))
            .await
            .err()
            .expect("the tool should time out");
        assert_eq!(error.code, "timeout");
        assert_eq!(error.message, "sh -c timed out.");
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "stopped within the grace period, took {:?}",
            started.elapsed()
        );
        let child: i32 = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut alive = true;
        for _ in 0..1500 {
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

    #[cfg(unix)]
    #[tokio::test]
    async fn oversized_tool_output_stops_the_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("child.pid");
        let script = format!("sleep 300 & echo $! > {}; yes x", pidfile.display());
        let sh = Tool {
            program: Path::new("/bin/sh"),
            cwd: dir.path(),
        };
        let started = Instant::now();
        let error = sh
            .run_bounded(&["-c", &script], Duration::from_secs(300), 1024)
            .await
            .err()
            .unwrap();
        assert!(error.message.contains("byte limit"));
        assert!(started.elapsed() < Duration::from_secs(30));
        let child: i32 = std::fs::read_to_string(pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        for _ in 0..1500 {
            if unsafe { libc::kill(child, 0) } != 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("bounded output left the tool's background child alive");
    }

    #[cfg(unix)]
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

pub(crate) async fn automatic_refresh(
    root: &Path,
    auto_pull: bool,
    fetch: bool,
    network: Duration,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<bool> {
    async fn command(
        root: &Path,
        args: &[&str],
        limit: Duration,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<String> {
        let out = git(root)
            .run_cancellable(args, limit, 100_000, cancel)
            .await?;
        if out.code != Some(0) {
            return Err(AppError::new("git", out.stderr.trim()));
        }
        Ok(out.stdout)
    }
    let remotes = command(root, &["remote"], LOCAL, cancel).await?;
    if remotes.trim().is_empty() {
        return Ok(false);
    }
    if fetch {
        command(
            root,
            &["fetch", "--all", "--prune", "--no-recurse-submodules"],
            network,
            cancel,
        )
        .await?;
    }
    if !auto_pull {
        return Ok(false);
    }
    let status = command(
        root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        LOCAL,
        cancel,
    )
    .await?;
    let status = parse_porcelain(&status);
    let Some(branch) = status
        .head
        .filter(|_| !status.unborn && status.paths.is_empty())
    else {
        return Ok(false);
    };
    if status
        .ahead_behind
        .is_none_or(|(ahead, behind)| ahead != 0 || behind == 0)
    {
        return Ok(false);
    }
    let default = command(
        root,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        LOCAL,
        cancel,
    )
    .await
    .ok()
    .and_then(|target| {
        target
            .trim()
            .strip_prefix("refs/remotes/origin/")
            .map(str::to_owned)
    });
    if default.as_deref() != Some(branch.as_str()) {
        return Ok(false);
    }
    for name in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
    ] {
        let path = command(
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", name],
            LOCAL,
            cancel,
        )
        .await?;
        if Path::new(path.trim()).exists() {
            return Ok(false);
        }
    }
    let merge = command(
        root,
        &["config", "--get", &format!("branch.{branch}.merge")],
        LOCAL,
        cancel,
    )
    .await?;
    if merge.trim() != format!("refs/heads/{branch}") {
        return Ok(false);
    }
    if !fetch {
        let remote = command(
            root,
            &["config", "--get", &format!("branch.{branch}.remote")],
            LOCAL,
            cancel,
        )
        .await?;
        if remote.trim() == "." || remote.trim().is_empty() {
            return Ok(false);
        }
        command(
            root,
            &["fetch", "--no-recurse-submodules", "--", remote.trim()],
            network,
            cancel,
        )
        .await?;
    }
    let upstream = command(
        root,
        &["rev-parse", "--verify", "@{upstream}^{commit}"],
        LOCAL,
        cancel,
    )
    .await?;
    let before = command(root, &["rev-parse", "--verify", "HEAD"], LOCAL, cancel).await?;
    let fresh = command(
        root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        LOCAL,
        cancel,
    )
    .await?;
    let fresh = parse_porcelain(&fresh);
    if !fresh.paths.is_empty()
        || fresh.head.as_deref() != Some(branch.as_str())
        || fresh
            .ahead_behind
            .is_none_or(|(ahead, behind)| ahead != 0 || behind == 0)
    {
        return Ok(false);
    }
    command(
        root,
        &["merge", "--ff-only", "--no-edit", upstream.trim()],
        network,
        cancel,
    )
    .await?;
    Ok(command(root, &["rev-parse", "--verify", "HEAD"], LOCAL, cancel).await? != before)
}

#[cfg(test)]
mod automatic_refresh_tests {
    use super::*;
    fn git(root: &Path, args: &[&str]) -> String {
        let out = crate::process::command("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().into()
    }
    struct Fixture {
        dir: tempfile::TempDir,
        local: PathBuf,
        other: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            git(dir.path(), &["init", "-q", "-b", "main", "source"]);
            let other = dir.path().join("source");
            git(&other, &["config", "user.name", "Test"]);
            git(&other, &["config", "user.email", "test@example.invalid"]);
            std::fs::write(other.join("file"), "initial").unwrap();
            git(&other, &["add", "."]);
            git(&other, &["commit", "-qm", "Initial"]);
            git(
                dir.path(),
                &["clone", "-q", "--bare", "source", "origin.git"],
            );
            git(
                &other,
                &[
                    "remote",
                    "add",
                    "origin",
                    dir.path().join("origin.git").to_str().unwrap(),
                ],
            );
            git(dir.path(), &["clone", "-q", "origin.git", "local"]);
            let local = dir.path().join("local");
            git(&local, &["config", "user.name", "Test"]);
            git(&local, &["config", "user.email", "test@example.invalid"]);
            std::fs::write(other.join("remote"), "advance").unwrap();
            git(&other, &["add", "."]);
            git(&other, &["commit", "-qm", "Advance remote"]);
            git(&other, &["push", "-q", "origin", "main"]);
            Self { dir, local, other }
        }
        async fn refresh(&self, enabled: bool) -> Result<bool> {
            let (_send, mut cancel) = tokio::sync::watch::channel(false);
            automatic_refresh(
                &self.local,
                enabled,
                true,
                Duration::from_secs(5),
                &mut cancel,
            )
            .await
        }
    }
    #[tokio::test]
    async fn startup_with_zero_interval_uses_cached_status_before_any_network_access() {
        let f = Fixture::new();
        let before = git(&f.local, &["rev-parse", "HEAD"]);
        let (_send, mut cancel) = tokio::sync::watch::channel(false);
        assert!(
            !automatic_refresh(&f.local, true, false, Duration::from_secs(5), &mut cancel)
                .await
                .unwrap()
        );
        assert_eq!(
            git(&f.local, &["rev-parse", "origin/main"]),
            before,
            "no uncached startup fetch"
        );
        git(&f.local, &["fetch", "-q", "origin"]);
        assert!(
            automatic_refresh(&f.local, true, false, Duration::from_secs(5), &mut cancel)
                .await
                .unwrap()
        );
    }
    #[tokio::test]
    async fn startup_does_not_guess_main_when_remote_default_is_unknown() {
        let f = Fixture::new();
        git(&f.local, &["fetch", "-q", "origin"]);
        git(
            &f.local,
            &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
        );
        let before = git(&f.local, &["rev-parse", "HEAD"]);
        let (_send, mut cancel) = tokio::sync::watch::channel(false);
        assert!(
            !automatic_refresh(&f.local, true, false, Duration::from_secs(5), &mut cancel)
                .await
                .unwrap()
        );
        assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), before);
    }
    #[tokio::test]
    async fn fetch_only_keeps_head_and_enabled_clean_default_fast_forwards() {
        let f = Fixture::new();
        let before = git(&f.local, &["rev-parse", "HEAD"]);
        assert!(!f.refresh(false).await.unwrap());
        assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), before);
        assert_ne!(git(&f.local, &["rev-parse", "origin/main"]), before);
        assert!(f.refresh(true).await.unwrap());
        assert_eq!(
            git(&f.local, &["rev-parse", "HEAD"]),
            git(&f.other, &["rev-parse", "HEAD"])
        );
        assert!(!f.refresh(true).await.unwrap());
    }
    #[tokio::test]
    async fn unsafe_or_unknown_checkouts_keep_their_head() {
        for case in [
            "disabled",
            "feature",
            "detached",
            "dirty",
            "staged",
            "untracked",
            "ahead",
            "no_upstream",
            "other_upstream",
            "unknown_default",
            "main_without_remote_head",
            "merge_in_progress",
        ] {
            let f = Fixture::new();
            match case {
                "feature" => {
                    git(&f.local, &["checkout", "-qb", "feature"]);
                }
                "detached" => {
                    git(&f.local, &["checkout", "-q", "--detach"]);
                }
                "dirty" => {
                    std::fs::write(f.local.join("file"), "dirty").unwrap();
                }
                "staged" => {
                    std::fs::write(f.local.join("file"), "staged").unwrap();
                    git(&f.local, &["add", "."]);
                }
                "untracked" => {
                    std::fs::write(f.local.join("untracked"), "text").unwrap();
                }
                "ahead" => {
                    std::fs::write(f.local.join("ahead"), "text").unwrap();
                    git(&f.local, &["add", "."]);
                    git(&f.local, &["commit", "-qm", "Local commit"]);
                }
                "no_upstream" => {
                    git(&f.local, &["branch", "--unset-upstream"]);
                }
                "other_upstream" => {
                    git(
                        &f.local,
                        &["config", "branch.main.merge", "refs/heads/other"],
                    );
                }
                "main_without_remote_head" => {
                    let origin = f.dir.path().join("origin.git");
                    git(
                        &origin,
                        &[
                            "update-ref",
                            "refs/heads/develop",
                            &git(&f.other, &["rev-parse", "HEAD"]),
                        ],
                    );
                    git(&origin, &["symbolic-ref", "HEAD", "refs/heads/develop"]);
                    git(
                        &f.local,
                        &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
                    );
                }
                "unknown_default" => {
                    git(&f.local, &["branch", "-m", "custom"]);
                    git(
                        &f.local,
                        &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
                    );
                }
                "merge_in_progress" => {
                    std::fs::write(
                        f.local.join(".git/MERGE_HEAD"),
                        git(&f.local, &["rev-parse", "HEAD"]),
                    )
                    .unwrap();
                }
                _ => {}
            }
            let before = git(&f.local, &["rev-parse", "HEAD"]);
            assert!(!f.refresh(case != "disabled").await.unwrap(), "{case}");
            assert_eq!(git(&f.local, &["rev-parse", "HEAD"]), before, "{case}");
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_stops_a_network_child_and_leaves_no_lock() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let marker = f.dir.path().join("ssh-started");
        let ssh = f.dir.path().join("ssh");
        std::fs::write(
            &ssh,
            format!("#!/bin/sh\ntouch '{}'\nexec sleep 30\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        git(
            &f.local,
            &["remote", "set-url", "origin", "ssh://fixture.invalid/repo"],
        );
        git(
            &f.local,
            &["config", "core.sshCommand", ssh.to_str().unwrap()],
        );
        let (sender, mut cancel) = tokio::sync::watch::channel(false);
        let path = f.local.clone();
        let job = tokio::spawn(async move {
            automatic_refresh(&path, true, true, Duration::from_secs(60), &mut cancel).await
        });
        for _ in 0..100 {
            if marker.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(marker.exists());
        sender.send(true).unwrap();
        let error = tokio::time::timeout(Duration::from_secs(5), job)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert!(!f.local.join(".git/index.lock").exists());
    }
}
