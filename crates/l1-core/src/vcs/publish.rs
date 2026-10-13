use super::{Output, Tool};
use crate::domain::*;
use std::{ffi::OsStr, path::Path, time::Duration};

const LIMIT: u64 = 64 * 1024;
const SETUP: &str = "Install GitHub CLI from https://cli.github.com, then run gh auth login --hostname github.com on this server.";

struct RepositoryName(String);
impl RepositoryName {
    fn parse(value: &str) -> Result<Self> {
        let value = value.trim();
        let Some((owner, name)) = value.split_once('/') else {
            return Err(AppError::new(
                "publish_input",
                "Enter a repository as owner/name.",
            ));
        };
        if owner.is_empty()
            || owner.len() > 39
            || owner.starts_with('-')
            || owner.ends_with('-')
            || !owner
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || name.is_empty()
            || name.len() > 100
            || name == "."
            || name == ".."
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(AppError::new(
                "publish_input",
                "Enter a valid GitHub owner/name.",
            ));
        }
        Ok(Self(value.to_owned()))
    }
    fn from_url(value: &str) -> Option<Self> {
        let path = if let Some(scp) = value.strip_prefix("git@") {
            let (host, path) = scp.split_once(':')?;
            if !host.eq_ignore_ascii_case("github.com") {
                return None;
            }
            path.to_owned()
        } else {
            let url = reqwest::Url::parse(value).ok()?;
            if !url.host_str()?.eq_ignore_ascii_case("github.com")
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return None;
            }
            match url.scheme() {
                "https"
                    if url.username().is_empty() && url.port_or_known_default() == Some(443) => {}
                "http" if url.username().is_empty() && url.port_or_known_default() == Some(80) => {}
                "ssh" if url.username() == "git" && url.port().is_none_or(|port| port == 22) => {}
                _ => return None,
            }
            url.path().strip_prefix('/')?.to_owned()
        };
        let path = path.trim_end_matches('/');
        Self::parse(path.strip_suffix(".git").unwrap_or(path)).ok()
    }
    fn repository(&self) -> PublishedRepository {
        PublishedRepository {
            name_with_owner: self.0.clone(),
            url: format!("https://github.com/{}", self.0),
        }
    }
    fn clone_url(&self, protocol: &CloneProtocol) -> String {
        match protocol {
            CloneProtocol::Ssh => format!("git@github.com:{}.git", self.0),
            CloneProtocol::Https => format!("https://github.com/{}.git", self.0),
        }
    }
}

async fn gh(root: &Path, binary: &Path, timeout: Duration, args: &[&str]) -> Result<Output> {
    let (_send, mut cancel) = tokio::sync::watch::channel(false);
    Tool {
        program: binary,
        cwd: root,
    }
    .run_with_env_input(
        args,
        timeout,
        LIMIT,
        &mut cancel,
        None,
        &[("GH_HOST", OsStr::new("github.com"))],
    )
    .await
}

pub(crate) async fn readiness(root: &Path, binary: &Path, timeout: Duration) -> PublishReadiness {
    let unavailable = |reason, hint: String| PublishReadiness::Unavailable { reason, hint };
    match gh(
        root,
        binary,
        timeout,
        &["auth", "status", "--hostname", "github.com"],
    )
    .await
    {
        Err(error) if error.code == "tool_missing" => {
            return unavailable(PublishUnavailable::Missing, SETUP.into());
        }
        Err(_) => return unavailable(
            PublishUnavailable::Failed,
            "GitHub CLI could not verify authentication. Check the server environment and rescan."
                .into(),
        ),
        Ok(output) if output.code == Some(1) => {
            return unavailable(
                PublishUnavailable::Unauthenticated,
                "Run gh auth login --hostname github.com on this server, then rescan.".into(),
            );
        }
        Ok(output) if output.code != Some(0) => return unavailable(
            PublishUnavailable::Failed,
            "GitHub CLI could not verify authentication. Check the server environment and rescan."
                .into(),
        ),
        Ok(_) => {}
    }
    match gh(
        root,
        binary,
        timeout,
        &["api", "--hostname", "github.com", "user", "--jq", ".login"],
    )
    .await
    {
        Ok(output) if output.code == Some(0) => {
            let account = output.stdout.trim();
            if RepositoryName::parse(&format!("{account}/repository")).is_ok() {
                PublishReadiness::Ready {
                    account: account.into(),
                }
            } else {
                unavailable(
                    PublishUnavailable::Failed,
                    "GitHub returned an invalid account. Rescan the server environment.".into(),
                )
            }
        }
        _ => unavailable(
            PublishUnavailable::Failed,
            "Could not read the authenticated GitHub account. Check the connection and rescan."
                .into(),
        ),
    }
}

async fn git(root: &Path, timeout: Duration, args: &[&str]) -> Result<Output> {
    Tool {
        program: Path::new("git"),
        cwd: root,
    }
    .run_bounded(args, timeout, LIMIT)
    .await
}
async fn checked(root: &Path, timeout: Duration, args: &[&str]) -> Result<String> {
    git(root, timeout, args).await?.success(&mut Vec::new())
}

struct RemoteName(String);

#[derive(PartialEq, Eq)]
struct BranchName(String);
#[derive(PartialEq, Eq)]
struct CommitId(String);
#[derive(PartialEq, Eq)]
struct CheckoutSnapshot {
    branch: BranchName,
    commit: Option<CommitId>,
}
struct Preflight {
    repository: RepositoryName,
    remote: RemoteName,
    checkout: CheckoutSnapshot,
}
async fn preflight(root: &Path, timeout: Duration, input: &PublishInput) -> Result<Preflight> {
    let repository = RepositoryName::parse(&input.repository)?;
    let remote = match input.remote_name.trim() {
        "" => "origin",
        name => name,
    };
    if remote.starts_with('-') || remote.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::new("publish_input", "Enter a valid remote name."));
    }
    checked(
        root,
        timeout,
        &["check-ref-format", &format!("refs/remotes/{remote}/probe")],
    )
    .await?;
    Ok(Preflight {
        repository,
        remote: RemoteName(remote.into()),
        checkout: inspect_checkout(root, timeout).await?,
    })
}
async fn inspect_checkout(root: &Path, timeout: Duration) -> Result<CheckoutSnapshot> {
    let branch = checked(
        root,
        timeout,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .await
    .map_err(|_| {
        AppError::new(
            "publish_branch",
            "Check out a branch before publishing the repository.",
        )
    })?
    .trim()
    .to_owned();
    checked(root, timeout, &["check-ref-format", "--branch", &branch]).await?;
    let head = git(
        root,
        timeout,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    )
    .await?;
    let commit = if head.code == Some(0) {
        Some(CommitId(head.stdout.trim().to_owned()))
    } else {
        // An absent branch ref is unborn; an existing unreadable ref is not an empty repository.
        let reference = git(
            root,
            timeout,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .await?;
        if head.code != Some(1) || reference.code != Some(1) {
            return Err(AppError::new(
                "publish_branch",
                "Could not read the current branch's commit.",
            ));
        }
        None
    };
    Ok(CheckoutSnapshot {
        branch: BranchName(branch),
        commit,
    })
}

struct Remote {
    name: String,
    urls: Vec<String>,
    push_urls: Vec<String>,
}
async fn remotes(root: &Path, timeout: Duration) -> Result<Vec<Remote>> {
    let names = checked(root, timeout, &["remote"]).await?;
    let mut remotes = Vec::new();
    for name in names.lines() {
        let read = async |key: String| -> Result<Vec<String>> {
            let output = git(root, timeout, &["config", "--null", "--get-all", &key]).await?;
            if output.code == Some(1) {
                return Ok(Vec::new());
            }
            let text = output.success(&mut Vec::new())?;
            Ok(text.split_terminator('\0').map(str::to_owned).collect())
        };
        remotes.push(Remote {
            name: name.into(),
            urls: read(format!("remote.{name}.url")).await?,
            push_urls: read(format!("remote.{name}.pushurl")).await?,
        });
    }
    Ok(remotes)
}
async fn ensure_remote(
    root: &Path,
    timeout: Duration,
    repository: &RepositoryName,
    preferred: &RemoteName,
    url: &str,
) -> Result<(String, String)> {
    let mut attempts = 0;
    loop {
        attempts += 1;
        let inventory = remotes(root, timeout).await?;
        if let Some(remote) = inventory.iter().find(|r| {
            !r.urls.is_empty()
                && r.urls.iter().chain(&r.push_urls).all(|url| {
                    RepositoryName::from_url(url)
                        .is_some_and(|name| name.0.eq_ignore_ascii_case(&repository.0))
                })
        }) {
            return Ok((remote.name.clone(), remote.urls[0].clone()));
        }
        let mut name = preferred.0.clone();
        for suffix in 1..=inventory.len() + 1 {
            if !inventory.iter().any(|remote| remote.name == name) {
                break;
            }
            name = format!("{}-{suffix}", preferred.0);
        }
        let added = git(root, timeout, &["remote", "add", "--", &name, url]).await?;
        let config_locked = added.stderr.contains("could not lock config file")
            || added.stderr.contains("could not lock config");
        let error = match added.success(&mut Vec::new()) {
            Ok(_) => return Ok((name, url.into())),
            Err(error) => error,
        };
        if attempts == 8 {
            return Err(error);
        }
        if config_locked {
            tokio::time::sleep(Duration::from_millis(25)).await;
            continue;
        }
        let fresh = remotes(root, timeout).await?;
        if !fresh.iter().any(|remote| remote.name == name) {
            return Err(error);
        }
    }
}
fn rejected_creation(output: &Output) -> Option<&'static str> {
    let detail = format!("{}\n{}", output.stderr, output.stdout).to_ascii_lowercase();
    [
        ("http 401", "GitHub requires authentication. Sign in with gh auth login --hostname github.com."),
        ("authentication required", "GitHub requires authentication. Sign in with gh auth login --hostname github.com."),
        ("http 403", "GitHub denied permission to create this repository. Check the account's repository creation permissions."),
        ("permission denied", "GitHub denied permission to create this repository. Check the account's repository creation permissions."),
        ("not authorized", "GitHub denied permission to create this repository. Check the account's repository creation permissions."),
        ("resource not accessible", "GitHub denied access to the repository owner. Check the account's permissions."),
        ("cannot create repositories", "GitHub does not permit this account to create repositories for the selected owner."),
        ("http 409", "GitHub reported a repository name conflict. Check whether the repository already exists."),
        ("name already exists", "A repository with this name already exists. Choose another name."),
        ("name has been taken", "A repository with this name already exists. Choose another name."),
        ("invalid repository name", "GitHub rejected the repository name. Choose a valid repository name."),
        ("could not resolve to a user", "GitHub could not find the selected user. Check the repository owner."),
        ("could not resolve to an organization", "GitHub could not find the selected organization. Check the repository owner and account access."),
        ("http 404", "GitHub could not find or access the selected owner. Check the owner and account access."),
        ("http 400", "GitHub rejected the repository creation request as invalid. Check the owner and repository name."),
        ("http 422", "GitHub rejected repository creation validation. Check the owner, repository name, and whether it already exists."),
    ]
    .into_iter()
    .find_map(|(reason, message)| detail.contains(reason).then_some(message))
}
fn interrupted_creation(output: &Output) -> &'static str {
    let detail = format!("{}\n{}", output.stderr, output.stdout).to_ascii_lowercase();
    if detail.contains("timeout") || detail.contains("timed out") {
        "The GitHub creation request timed out."
    } else if detail.contains("unexpected eof") || detail.contains("connection") {
        "The connection to GitHub ended before creation could be confirmed."
    } else {
        "GitHub CLI did not confirm repository creation."
    }
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) async fn publish(
    root: &Path,
    binary: &Path,
    timeout: Duration,
    input: PublishInput,
) -> Result<PublishOutcome> {
    let preflight = preflight(root, timeout, &input).await?;
    if let PublishReadiness::Unavailable { hint, .. } = readiness(root, binary, timeout).await {
        return Err(AppError::new("publish_auth", hint));
    }
    let visibility = match input.visibility {
        RepositoryVisibility::Private => "--private",
        RepositoryVisibility::Public => "--public",
    };
    let create = gh(
        root,
        binary,
        timeout,
        &["repo", "create", &preflight.repository.0, visibility],
    )
    .await;
    let uncertain = |cause: &str| PublishOutcome::CreationUncertain {
        repository: preflight.repository.0.clone(),
        message: format!("{cause} Check GitHub before retrying; the repository may already exist."),
    };
    let output = match create {
        Err(error) if error.code == "tool_missing" => {
            return Ok(PublishOutcome::Failed {
                message: SETUP.into(),
                completed: PublishCompleted::Nothing,
            });
        }
        Err(error) => {
            return Ok(uncertain(if error.code == "timeout" {
                "The GitHub creation request timed out."
            } else {
                "GitHub CLI could not complete the creation request."
            }));
        }
        Ok(output) if output.code != Some(0) => {
            if let Some(message) = rejected_creation(&output).filter(|_| output.code.is_some()) {
                return Ok(PublishOutcome::Failed {
                    message: message.into(),
                    completed: PublishCompleted::Nothing,
                });
            }
            return Ok(uncertain(interrupted_creation(&output)));
        }
        Ok(output) => output,
    };
    let Some(repository) = output.stdout.split_whitespace().find_map(|word| {
        word.strip_prefix("https://github.com/")
            .and_then(|path| RepositoryName::parse(path.trim_end_matches('/')).ok())
    }) else {
        return Ok(uncertain(
            "GitHub CLI returned no usable GitHub.com repository URL.",
        ));
    };
    let created = repository.repository();
    let url = repository.clone_url(&input.protocol);
    let (remote_name, remote_url) = match ensure_remote(
        root,
        timeout,
        &repository,
        &preflight.remote,
        &url,
    )
    .await
    {
        Ok(remote) => remote,
        Err(error) => {
            return Ok(PublishOutcome::Failed {
                message: format!(
                    "Created {}. Could not add a remote. Add {} as a remote manually; do not create the repository again. Git reported: {}",
                    created.name_with_owner, url, error.message
                ),
                completed: PublishCompleted::RepositoryCreated {
                    repository: created,
                },
            });
        }
    };
    let remote = PublishedRemote {
        repository: created,
        remote_name,
        remote_url,
    };
    let changed = match inspect_checkout(root, timeout).await {
        Ok(current) if current == preflight.checkout => None,
        Ok(_) => Some("The branch or commit changed during repository creation.".to_owned()),
        Err(error) => Some(format!(
            "Could not recheck the checkout after repository creation: {}",
            error.message
        )),
    };
    if let Some(cause) = changed {
        return Ok(PublishOutcome::Failed {
            message: format!(
                "Created {} and configured remote {}. {cause} Nothing was pushed by this operation. Inspect this checkout with git status and git log, then confirm branch {} and its intended commit before pushing to remote {}. Do not create the repository again.",
                remote.repository.name_with_owner,
                quote(&remote.remote_name),
                quote(&preflight.checkout.branch.0),
                quote(&remote.remote_name),
            ),
            completed: PublishCompleted::RemoteAdded { remote },
        });
    }
    let branch = preflight.checkout.branch.0;
    if preflight.checkout.commit.is_none() {
        return Ok(PublishOutcome::Succeeded {
            result: PublishResult::RemoteAdded { remote, branch },
        });
    }
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let pushed = checked(
        root,
        timeout,
        &[
            "push",
            "--set-upstream",
            "--",
            &remote.remote_name,
            &refspec,
        ],
    )
    .await;
    match pushed {
        Ok(_) => Ok(PublishOutcome::Succeeded {
            result: PublishResult::Pushed {
                upstream_branch: format!("{}/{}", remote.remote_name, branch),
                remote,
                branch,
            },
        }),
        Err(error) => Ok(PublishOutcome::Failed {
            message: format!(
                "Created {} and configured remote {}. The branch was not confirmed pushed. Check the remote, then run git push --set-upstream -- {} {} from this checkout. Do not create the repository again. Git reported: {}",
                remote.repository.name_with_owner,
                quote(&remote.remote_name),
                quote(&remote.remote_name),
                quote(&refspec),
                error.message
            ),
            completed: PublishCompleted::RemoteAdded { remote },
        }),
    }
}
