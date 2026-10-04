use crate::{domain::*, repo};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Child};

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
}
impl Tool<'_> {
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

const LOCAL: Duration = Duration::from_secs(30);
/// `git commit` runs the repository's hooks, which may lint or test.
const COMMIT: Duration = Duration::from_secs(600);
const LOOKUP: Duration = Duration::from_secs(15);
const PR_FIELDS: &str = "number,title,url,baseRefName,headRefName,isCrossRepository";

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
    files.extend(
        parse_numstat(&numstat)
            .into_iter()
            .map(|stat| (stat.path.clone(), stat)),
    );
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
                records.next();
                record.splitn(10, ' ').nth(9)
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrRow {
    number: u64,
    title: String,
    url: String,
    base_ref_name: String,
    head_ref_name: String,
    #[serde(default)]
    is_cross_repository: bool,
}
impl From<PrRow> for PullRequest {
    fn from(row: PrRow) -> Self {
        Self {
            number: row.number,
            title: row.title,
            url: row.url,
            base: row.base_ref_name,
            head: row.head_ref_name,
        }
    }
}
async fn gh(gh: &Path, root: &Path, args: &[&str], limit: Duration) -> Result<String> {
    let out = Tool {
        program: gh,
        cwd: root,
    }
    .run(args, limit)
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
pub(crate) async fn pull_request(program: &Path, root: &Path, branch: &str) -> PrLookup {
    let found = async {
        let out = gh(
            program,
            root,
            &[
                "pr", "list", "--head", branch, "--state", "open", "--limit", "20", "--json",
                PR_FIELDS,
            ],
            LOOKUP,
        )
        .await?;
        let rows: Vec<PrRow> = serde_json::from_str(&out)?;
        Ok::<_, AppError>(
            rows.into_iter()
                .find(|row| row.head_ref_name == branch && !row.is_cross_repository),
        )
    };
    match found.await {
        Ok(Some(row)) => PrLookup::Open { pr: row.into() },
        Ok(None) => PrLookup::None,
        Err(error) => PrLookup::Unavailable {
            reason: match error.code.as_str() {
                "gh_missing" => GhProblem::Missing,
                "gh_unauthenticated" => GhProblem::Unauthenticated,
                _ => GhProblem::Failed,
            },
            message: error.message,
        },
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    Pull {
        upstream: String,
    },
    Stack {
        commit: Option<CommitMessage>,
        push: Option<PushTarget>,
        pr: Option<PrStep>,
    },
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
    let (commit, pushes, opens) = match action {
        GitAction::Pull => return plan_pull(status),
        GitAction::Commit { message } => (Some(message), false, false),
        GitAction::CommitPush { message } => (Some(message), true, false),
        GitAction::CommitPushPr { message } => (Some(message), true, true),
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
    if pushes && commit.is_none() && ahead == 0 {
        return Err(refuse(
            phase,
            "nothing_to_push",
            "No local commits to push.",
        ));
    }
    let pr = if opens {
        Some(plan_pr(status, branch, commit.is_some(), pr)?)
    } else {
        None
    };
    let push = (commit.is_some() || pushes || upstream.is_none() || ahead > 0).then(|| {
        let set_upstream = upstream.is_none();
        PushTarget {
            remote: remote.into(),
            branch: branch.name.clone(),
            set_upstream,
            record_base: (set_upstream && branch.base != branch.name).then(|| branch.base.clone()),
        }
    });
    Ok(Plan::Stack { commit, push, pr })
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
    pub progress: Box<dyn Fn(GitPhase) + Send + Sync>,
}
pub(crate) async fn run(cx: &Context, action: GitAction) -> Result<GitOutcome> {
    let status = status(&cx.root).await?;
    let mut planned = plan(action.clone(), &status, None);
    if let (Ok(Plan::Stack { pr: Some(_), .. }), Some(branch)) = (&planned, &status.branch) {
        let lookup = pull_request(&cx.gh, &cx.root, &branch.name).await;
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
            (cx.progress)(GitPhase::Pull);
            out.pull = Some(pull(cx, upstream).await.map_err(failed(GitPhase::Pull))?);
            return Ok(());
        }
        Plan::Stack { commit, push, pr } => (commit, push, pr),
    };
    if let Some(message) = commit_message {
        (cx.progress)(GitPhase::Commit);
        out.commit = Some(
            commit(&cx.root, &message)
                .await
                .map_err(failed(GitPhase::Commit))?,
        );
    }
    if let Some(target) = push_target {
        let phase = GitPhase::Push {
            remote: target.remote.clone(),
        };
        (cx.progress)(phase.clone());
        out.push = Some(push(cx, &target).await.map_err(failed(phase))?);
    }
    if let Some(step) = pr_step {
        (cx.progress)(GitPhase::Pr);
        out.pr = Some(open_pr(cx, step).await.map_err(failed(GitPhase::Pr))?);
    }
    Ok(())
}
async fn commit(root: &Path, message: &CommitMessage) -> Result<Committed> {
    let git = git(root);
    git.ok(&["add", "-A"], LOCAL, "git").await?;
    if git.run(&["diff", "--cached", "--quiet"], LOCAL).await?.code == Some(0) {
        return Err(AppError::new(
            "nothing_to_commit",
            "There are no changes to commit.",
        ));
    }
    git.ok(&["commit", "-m", message.as_str()], COMMIT, "git")
        .await?;
    Ok(Committed {
        sha: head(root).await?,
        subject: message.subject().into(),
    })
}
async fn push(cx: &Context, target: &PushTarget) -> Result<Pushed> {
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
    git.ok(&args, cx.network, "git").await?;
    Ok(Pushed {
        sha: head(&cx.root).await?,
        upstream: format!("{}/{}", target.remote, target.branch),
        set_upstream: target.set_upstream,
    })
}
async fn pull(cx: &Context, upstream: String) -> Result<Pulled> {
    let before = head(&cx.root).await?;
    git(&cx.root)
        .ok(&["pull", "--ff-only"], cx.network, "git")
        .await?;
    Ok(Pulled {
        updated: head(&cx.root).await? != before,
        upstream,
    })
}
async fn open_pr(cx: &Context, step: PrStep) -> Result<PrOpened> {
    let (base, head) = match step {
        PrStep::Existing(pr) => return Ok(PrOpened { pr, created: false }),
        PrStep::Create { base, head } => (base, head),
    };
    let created = gh(
        &cx.gh,
        &cx.root,
        &["pr", "create", "--fill", "--base", &base, "--head", &head],
        cx.network,
    )
    .await?;
    let url = created.lines().last().unwrap_or_default().trim();
    let view = gh(
        &cx.gh,
        &cx.root,
        &["pr", "view", url, "--json", PR_FIELDS],
        LOOKUP,
    )
    .await?;
    let row: PrRow = serde_json::from_str(&view)?;
    Ok(PrOpened {
        pr: row.into(),
        created: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
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
