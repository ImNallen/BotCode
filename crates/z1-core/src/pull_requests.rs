use crate::{domain::*, vcs::Tool};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use tokio::sync::watch;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct PullRequestKey(String);
impl PullRequestKey {
    pub fn from_url(url: &str) -> Result<Self> {
        let rest = url
            .strip_prefix("https://github.com/")
            .ok_or_else(invalid_identity)?;
        let parts: Vec<_> = rest.trim_end_matches('/').split('/').collect();
        if parts.len() != 4 || parts[2] != "pull" {
            return Err(invalid_identity());
        }
        Self::new(
            parts[0],
            parts[1],
            parts[3].parse().map_err(|_| invalid_identity())?,
        )
    }
    pub fn new(owner: &str, name: &str, number: u64) -> Result<Self> {
        if number == 0 || !component(owner) || !component(name) {
            return Err(invalid_identity());
        }
        Ok(Self(format!(
            "github.com/{}/{}/{number}",
            owner.to_ascii_lowercase(),
            name.to_ascii_lowercase()
        )))
    }
    pub fn repository(&self) -> (&str, &str) {
        let mut parts = self.0.split('/');
        parts.next();
        (parts.next().unwrap(), parts.next().unwrap())
    }
    pub fn number(&self) -> &str {
        self.0.rsplit('/').next().unwrap()
    }
    pub fn url(&self) -> String {
        let (owner, name) = self.repository();
        format!("https://github.com/{owner}/{name}/pull/{}", self.number())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<String> for PullRequestKey {
    type Error = AppError;
    fn try_from(value: String) -> Result<Self> {
        let parts: Vec<_> = value.split('/').collect();
        if parts.len() != 4 || parts[0] != "github.com" {
            return Err(invalid_identity());
        }
        Self::new(
            parts[1],
            parts[2],
            parts[3].parse().map_err(|_| invalid_identity())?,
        )
    }
}
impl From<PullRequestKey> for String {
    fn from(key: PullRequestKey) -> Self {
        key.0
    }
}
fn component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
fn invalid_identity() -> AppError {
    AppError::new(
        "invalid_pull_request",
        "Enter a GitHub.com pull request URL, such as https://github.com/owner/repo/pull/42.",
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrLifecycle {
    Open { draft: bool },
    Closed { closed_at: Option<String> },
    Merged { merged_at: Option<String> },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSnapshot {
    pub node_id: String,
    pub title: String,
    pub lifecycle: PrLifecycle,
    pub base: String,
    pub head: String,
    pub head_repository: String,
    pub head_oid: String,
    pub host_updated_at: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrFreshness {
    NeverLoaded,
    Current {
        fetched_at: u64,
    },
    Stale {
        last_success: Option<u64>,
        message: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPr {
    pub key: PullRequestKey,
    pub snapshot: Option<PrSnapshot>,
    pub revision: u64,
    pub freshness: PrFreshness,
}
impl CachedPr {
    pub fn unknown(key: PullRequestKey) -> Self {
        Self {
            key,
            snapshot: None,
            revision: 0,
            freshness: PrFreshness::NeverLoaded,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrLinkSource {
    Manual,
    GitCreated,
    GitReused,
    AgentDiscovered,
    BranchDiscovery,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPrSummary {
    pub pr: CachedPr,
    pub source: PrLinkSource,
    pub linked_at: u64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPrSummary {
    pub sequence: u64,
    pub links: Vec<LinkedPrSummary>,
    pub discovering: bool,
    pub discovery_error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Membership {
    pub thread: ThreadId,
    pub key: PullRequestKey,
    pub generation: u64,
    pub source: Option<PrLinkSource>,
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CheckoutContext {
    pub branch: String,
    pub oid: String,
    pub remote: String,
    pub head_remote: String,
    pub upstream: String,
}
pub(crate) async fn checkout(
    root: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<CheckoutContext> {
    let git = Tool {
        program: Path::new("git"),
        cwd: root,
    };
    async fn read(
        git: &Tool<'_>,
        args: &[&str],
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<String> {
        let out = git
            .run_cancellable(args, Duration::from_secs(10), 16384, cancel)
            .await?;
        if out.code != Some(0) {
            return Err(AppError::new(
                "pr_discovery",
                "Git checkout context is unavailable.",
            ));
        }
        Ok(out.stdout.trim().to_owned())
    }
    let branch = read(&git, &["symbolic-ref", "--short", "HEAD"], cancel).await?;
    let oid = read(&git, &["rev-parse", "HEAD"], cancel).await?;
    let origin = read(&git, &["config", "--get", "remote.origin.url"], cancel).await?;
    let branch_remote = git
        .run_cancellable(
            &["config", "--get", &format!("branch.{branch}.remote")],
            Duration::from_secs(10),
            16384,
            cancel,
        )
        .await?
        .stdout
        .trim()
        .to_owned();
    let head_remote = if !branch_remote.is_empty() && branch_remote != "." {
        read(
            &git,
            &["config", "--get", &format!("remote.{branch_remote}.url")],
            cancel,
        )
        .await?
    } else {
        origin.clone()
    };
    let upstream_remote = git
        .run_cancellable(
            &["config", "--get", "remote.upstream.url"],
            Duration::from_secs(10),
            16384,
            cancel,
        )
        .await?;
    let remote = if upstream_remote.code == Some(0) {
        upstream_remote.stdout.trim().to_owned()
    } else {
        origin
    };
    let upstream = git
        .run_cancellable(
            &["rev-parse", "--abbrev-ref", "@{upstream}"],
            Duration::from_secs(10),
            16384,
            cancel,
        )
        .await?
        .stdout
        .trim()
        .to_owned();
    repository(&remote)?;
    repository(&head_remote)?;
    Ok(CheckoutContext {
        branch,
        oid,
        remote,
        head_remote,
        upstream,
    })
}
pub(crate) fn repository(remote: &str) -> Result<(String, String)> {
    let rest = remote
        .strip_prefix("https://github.com/")
        .or_else(|| remote.strip_prefix("git@github.com:"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))
        .ok_or_else(invalid_identity)?;
    let mut parts = rest
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .split('/');
    let (owner, name) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    if parts.next().is_some() {
        return Err(invalid_identity());
    }
    let key = PullRequestKey::new(owner, name, 1)?;
    let (owner, name) = key.repository();
    Ok((owner.into(), name.into()))
}
const FIELDS: &str = "id number url title state isDraft baseRefName headRefName headRefOid headRepository { nameWithOwner } baseRepository { nameWithOwner } updatedAt closedAt mergedAt";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: String,
    number: u64,
    url: String,
    title: String,
    state: String,
    is_draft: bool,
    base_ref_name: String,
    head_ref_name: String,
    head_ref_oid: String,
    head_repository: Option<Repository>,
    base_repository: Repository,
    updated_at: String,
    closed_at: Option<String>,
    merged_at: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Repository {
    name_with_owner: String,
}
impl Row {
    fn parsed(self, key: &PullRequestKey) -> Result<PrSnapshot> {
        let (owner, name) = key.repository();
        if PullRequestKey::from_url(&self.url)? != *key
            || self.number.to_string() != key.number()
            || !self
                .base_repository
                .name_with_owner
                .eq_ignore_ascii_case(&format!("{owner}/{name}"))
            || self.id.is_empty()
            || self.head_ref_oid.len() != 40
            || !self.head_ref_oid.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(AppError::new(
                "pr_identity_mismatch",
                "GitHub returned a different pull request identity or an invalid head.",
            ));
        }
        let lifecycle = match self.state.as_str() {
            "OPEN" => PrLifecycle::Open {
                draft: self.is_draft,
            },
            "CLOSED" => PrLifecycle::Closed {
                closed_at: self.closed_at,
            },
            "MERGED" => PrLifecycle::Merged {
                merged_at: self.merged_at,
            },
            _ => {
                return Err(AppError::new(
                    "pr_response",
                    "Unknown pull request lifecycle.",
                ));
            }
        };
        Ok(PrSnapshot {
            node_id: self.id,
            title: self.title,
            lifecycle,
            base: self.base_ref_name,
            head: self.head_ref_name,
            head_oid: self.head_ref_oid,
            head_repository: self
                .head_repository
                .map(|r| r.name_with_owner.to_ascii_lowercase())
                .unwrap_or_default(),
            host_updated_at: self.updated_at,
        })
    }
}
async fn query(
    program: &Path,
    query: &str,
    variables: &[(&str, &str)],
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<serde_json::Value> {
    let mut owned = vec![
        "api".to_owned(),
        "graphql".into(),
        "--hostname".into(),
        "github.com".into(),
        "-f".into(),
        format!("query={query}"),
    ];
    for (key, value) in variables {
        owned.extend(["-F".into(), format!("{key}={value}")]);
    }
    let args: Vec<_> = owned.iter().map(String::as_str).collect();
    let out = Tool {
        program,
        cwd: Path::new("/"),
    }
    .run_cancellable(&args, timeout, 2 * 1024 * 1024, cancel)
    .await?;
    if out.code != Some(0) {
        return Err(AppError::new("pr_fetch", out.stderr.trim()));
    }
    let value: serde_json::Value = serde_json::from_str(&out.stdout)?;
    if value.get("errors").is_some() {
        return Err(AppError::new(
            "pr_fetch",
            "GitHub could not load this pull request. Check access and refresh.",
        ));
    }
    Ok(value)
}
pub(crate) async fn fetch(
    program: &Path,
    key: &PullRequestKey,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<PrSnapshot> {
    let (owner, name) = key.repository();
    let value = query(program, &format!("query Z1PullRequest($owner:String!,$name:String!,$number:Int!){{repository(owner:$owner,name:$name){{pullRequest(number:$number){{{FIELDS}}}}}}}"), &[("owner", owner), ("name", name), ("number", key.number())], timeout, cancel).await?;
    let row: Row = serde_json::from_value(value["data"]["repository"]["pullRequest"].clone())?;
    row.parsed(key)
}
pub(crate) async fn discover(
    program: &Path,
    context: &CheckoutContext,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<(PullRequestKey, PrSnapshot)>> {
    let (owner, name) = repository(&context.remote)?;
    let (head_owner, head_name) = repository(&context.head_remote)?;
    let value = query(program, &format!("query Z1Discover($owner:String!,$name:String!,$head:String!){{repository(owner:$owner,name:$name){{pullRequests(headRefName:$head,states:OPEN,first:20){{nodes{{{FIELDS}}} pageInfo{{hasNextPage}}}}}}}}"), &[("owner", &owner), ("name", &name), ("head", &context.branch)], timeout, cancel).await?;
    let connection = &value["data"]["repository"]["pullRequests"];
    if connection["pageInfo"]["hasNextPage"].as_bool() != Some(false) {
        return Err(AppError::new(
            "pr_ambiguous",
            "More pull requests match this branch. Link the intended PR by URL.",
        ));
    }
    let rows: Vec<Row> = serde_json::from_value(connection["nodes"].clone())?;
    let mut matches = Vec::new();
    for row in rows {
        if row.head_ref_name == context.branch
            && row.head_repository.as_ref().is_some_and(|r| {
                r.name_with_owner
                    .eq_ignore_ascii_case(&format!("{head_owner}/{head_name}"))
            })
        {
            let key = PullRequestKey::from_url(&row.url)?;
            if key.repository() != (owner.as_str(), name.as_str()) {
                return Err(AppError::new(
                    "pr_identity_mismatch",
                    "GitHub returned a different repository.",
                ));
            }
            let snapshot = row.parsed(&key)?;
            matches.push((key, snapshot));
        }
    }
    if matches.len() > 1 {
        return Err(AppError::new(
            "pr_ambiguous",
            "Several pull requests match this checkout. Link the intended PR by URL.",
        ));
    }
    Ok(matches.pop())
}
