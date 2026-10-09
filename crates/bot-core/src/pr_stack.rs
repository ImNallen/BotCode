// Native stacks read follows pingdotgg/t3code v0.0.45 GitHubPullRequestCli.ts and gitHubPullRequestJson.ts (MIT).
pub(crate) mod actions;
use crate::{domain::*, pull_requests::PullRequestKey, vcs::Tool};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::Path,
    time::{Duration, Instant},
};
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrStackState {
    Open,
    Closed,
    Merged,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStackLayer {
    pub number: u64,
    pub title: Option<String>,
    pub is_draft: Option<bool>,
    pub head_sha: Option<String>,
    pub head_branch: String,
    pub state: PrStackState,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStack {
    pub id: String,
    pub number: u64,
    pub url: String,
    pub base: String,
    pub layers: Vec<PrStackLayer>,
    #[serde(default)]
    pub capabilities: actions::PrStackCapabilities,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStackMembership {
    pub number: u64,
    pub position: usize,
    pub size: usize,
    pub base: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPrStackLayer {
    pub number: u64,
    pub title: Option<String>,
    pub is_draft: Option<bool>,
    pub head_branch: String,
    pub state: PrStackState,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPrStack {
    pub id: String,
    pub number: u64,
    pub url: String,
    pub base: String,
    pub layers: Vec<SavedPrStackLayer>,
    pub observed_at: u64,
}
impl PrStack {
    pub fn membership(&self, number: u64) -> Option<PrStackMembership> {
        self.layers
            .iter()
            .position(|layer| layer.number == number)
            .map(|index| PrStackMembership {
                number: self.number,
                position: index + 1,
                size: self.layers.len(),
                base: self.base.clone(),
            })
    }
    pub(crate) fn saved(&self, observed_at: u64) -> SavedPrStack {
        SavedPrStack {
            id: self.id.clone(),
            number: self.number,
            url: self.url.clone(),
            base: self.base.clone(),
            observed_at,
            layers: self
                .layers
                .iter()
                .map(|layer| SavedPrStackLayer {
                    number: layer.number,
                    title: layer.title.clone(),
                    is_draft: layer.is_draft,
                    head_branch: layer.head_branch.clone(),
                    state: layer.state,
                })
                .collect(),
        }
    }
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Ref {
    Name(String),
    Object { r#ref: String },
}
impl Ref {
    fn name(self) -> String {
        match self {
            Self::Name(name) => name,
            Self::Object { r#ref } => r#ref,
        }
    }
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Id {
    Number(u64),
    Name(String),
}
#[derive(Deserialize)]
struct RawHead {
    r#ref: String,
    sha: Option<String>,
}
#[derive(Deserialize)]
struct RawLayer {
    number: u64,
    title: Option<String>,
    draft: Option<bool>,
    head: RawHead,
    state: Option<String>,
    merged_at: Option<String>,
}
#[derive(Deserialize)]
struct RawStack {
    id: Option<Id>,
    node_id: Option<String>,
    number: u64,
    url: String,
    html_url: Option<String>,
    base: Ref,
    pull_requests: Vec<RawLayer>,
}
impl RawStack {
    fn parsed(self, key: &PullRequestKey) -> Result<PrStack> {
        let id = match self.id {
            Some(Id::Number(number)) => number.to_string(),
            Some(Id::Name(name)) => name,
            None => self
                .node_id
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| self.number.to_string()),
        };
        let mut numbers = HashSet::new();
        let layers: Vec<_> = self
            .pull_requests
            .into_iter()
            .map(|layer| PrStackLayer {
                number: layer.number,
                title: layer.title,
                is_draft: layer.draft,
                head_sha: layer.head.sha,
                head_branch: layer.head.r#ref,
                state: if layer.merged_at.is_some()
                    || layer
                        .state
                        .as_deref()
                        .is_some_and(|s| s.eq_ignore_ascii_case("merged"))
                {
                    PrStackState::Merged
                } else if layer
                    .state
                    .as_deref()
                    .is_some_and(|s| s.eq_ignore_ascii_case("closed"))
                {
                    PrStackState::Closed
                } else {
                    PrStackState::Open
                },
            })
            .collect();
        let stack = PrStack {
            id,
            number: self.number,
            url: self
                .html_url
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(self.url),
            base: self.base.name(),
            layers,
            capabilities: Default::default(),
        };
        if stack.number == 0
            || stack.id.trim().is_empty()
            || stack.url.trim().is_empty()
            || stack.base.trim().is_empty()
            || stack.layers.len() > 128
            || stack.layers.iter().any(|layer| {
                layer.number == 0
                    || layer.head_branch.trim().is_empty()
                    || !numbers.insert(layer.number)
            })
            || !stack
                .layers
                .iter()
                .any(|layer| layer.number.to_string() == key.number())
        {
            return Err(AppError::new(
                "pr_stack_invalid",
                "GitHub returned an invalid pull request stack.",
            ));
        }
        Ok(stack)
    }
}
async fn get(
    program: &Path,
    endpoint: &str,
    deadline: Instant,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<String>> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(AppError::new(
            "pr_stack_unavailable",
            "Pull request stack read timed out.",
        ));
    }
    let output = Tool {
        program,
        cwd: Path::new("/"),
    }
    .run_cancellable(
        &["api", "--hostname", "github.com", endpoint],
        remaining.min(Duration::from_secs(15)),
        2 * 1024 * 1024,
        cancel,
    )
    .await?;
    if output.code != Some(0) {
        if output.stderr.contains("(HTTP 404)") {
            return Ok(None);
        }
        return Err(AppError::new(
            "pr_stack_unavailable",
            "GitHub could not load this stack. Check gh authentication and access, then refresh.",
        ));
    }
    Ok(Some(output.stdout))
}
pub(crate) async fn read(
    program: &Path,
    key: &PullRequestKey,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<PrStack>> {
    let deadline = Instant::now() + timeout.min(Duration::from_secs(30));
    let (owner, name) = key.repository();
    let endpoint = format!("repos/{owner}/{name}/stacks?pull_request={}", key.number());
    let Some(listing) = get(program, &endpoint, deadline, cancel).await? else {
        return Ok(None);
    };
    let stacks: Vec<RawStack> = serde_json::from_str(&listing)?;
    let Some(stack) = stacks.into_iter().next() else {
        return Ok(None);
    };
    let stack = stack.parsed(key)?;
    let endpoint = format!("repos/{owner}/{name}/stacks/{}", stack.number);
    let Some(detail) = get(program, &endpoint, deadline, cancel).await? else {
        return Ok(None);
    };
    let detailed = serde_json::from_str::<RawStack>(&detail)?.parsed(key)?;
    if detailed.number != stack.number || detailed.id != stack.id {
        return Err(AppError::new(
            "pr_stack_stale",
            "The pull request stack changed. Refresh before continuing.",
        ));
    }
    let mut detailed = detailed;
    match actions::permissions(program, key, deadline, cancel).await {
        Ok(permissions) => detailed.capabilities = permissions.capabilities(),
        Err(error) if *cancel.borrow() || error.code == "process_cleanup" => return Err(error),
        Err(_) => {}
    }
    Ok(Some(detailed))
}
