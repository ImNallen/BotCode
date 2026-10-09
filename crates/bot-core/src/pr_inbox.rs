// Listing behavior ported from T3 Code v0.0.45 GitHubPullRequestCli.ts (MIT).
use crate::{PullRequestKey, domain::*, pull_requests::repository, vcs::Tool};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInboxInput {
    pub workspace_id: Option<WorkspaceId>,
    pub state: PrInboxState,
    pub query: String,
    pub limit: usize,
    #[serde(default)]
    pub cursors: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub continuation: bool,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrInboxState {
    All,
    Open,
    Closed,
    Merged,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInboxActor {
    pub login: String,
    pub avatar_url: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrInboxLabel {
    pub name: String,
    pub color: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInboxEntry {
    pub key: PullRequestKey,
    pub provider: String,
    pub host: String,
    pub project_id: WorkspaceId,
    pub project_title: String,
    pub repository: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: Option<PrInboxActor>,
    pub head_branch: String,
    pub base_branch: String,
    pub state: PrInboxState,
    pub is_draft: bool,
    pub mergeability: String,
    pub additions: u64,
    pub deletions: u64,
    pub created_at: String,
    pub updated_at: String,
    pub viewer_review_requested: bool,
    pub labels: Vec<PrInboxLabel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checks_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<crate::PrStackMembership>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInboxError {
    pub project_id: WorkspaceId,
    pub project_title: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInboxResult {
    pub entries: Vec<PrInboxEntry>,
    pub viewer: String,
    pub errors: Vec<PrInboxError>,
    pub limited: bool,
    pub cursors: std::collections::BTreeMap<String, String>,
}
pub(crate) async fn repository_identity(root: &Path) -> Result<String> {
    let git = Tool {
        program: Path::new("git"),
        cwd: root,
    };
    for remote in ["remote.upstream.url", "remote.origin.url"] {
        let out = git
            .run_bounded(
                &["config", "--get", remote],
                Duration::from_secs(10),
                16_384,
            )
            .await?;
        if out.code == Some(0) {
            let (owner, name) = repository(out.stdout.trim())?;
            return Ok(format!("{owner}/{name}").to_ascii_lowercase());
        }
    }
    Err(AppError::new(
        "pr_repository",
        "This project has no GitHub repository remote.",
    ))
}
async fn call(program: &Path, args: &[&str], timeout: Duration) -> Result<Value> {
    let out = Tool {
        program,
        cwd: Path::new("/"),
    }
    .run_bounded(args, timeout, 4 * 1024 * 1024)
    .await?;
    if out.code != Some(0) {
        return Err(AppError::new(
            "pr_inbox",
            "GitHub could not list pull requests. Check gh authentication and access, then refresh.",
        ));
    }
    Ok(serde_json::from_str(&out.stdout)?)
}
pub(crate) async fn viewer(program: &Path, timeout: Duration) -> Result<String> {
    let value = call(
        program,
        &[
            "api",
            "graphql",
            "--hostname",
            "github.com",
            "-f",
            "query=query BotInboxViewer { viewer { login } }",
        ],
        timeout,
    )
    .await?;
    value["data"]["viewer"]["login"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| AppError::new("pr_inbox", "GitHub did not identify the signed-in account."))
}
pub(crate) async fn list(
    program: &Path,
    workspace: &Workspace,
    repository: &str,
    viewer: &str,
    input: &PrInboxInput,
    cursor: Option<&str>,
    timeout: Duration,
) -> Result<(Vec<PrInboxEntry>, Option<String>)> {
    let fields = "number title url author { login avatarUrl } headRefName baseRefName state isDraft mergeable additions deletions createdAt updatedAt reviewDecision labels(first:100) { nodes { name color } } reviewRequests(first:100) { nodes { requestedReviewer { ... on User { login } } } } commits(last:1) { nodes { commit { statusCheckRollup { state } } } }";
    let query = format!(
        "query BotInboxList($search:String!,$first:Int!,$cursor:String) {{ search(query:$search,type:ISSUE,first:$first,after:$cursor) {{ pageInfo {{ hasNextPage endCursor }} nodes {{ ... on PullRequest {{ {fields} }} }} }} }}"
    );
    let state = match input.state {
        PrInboxState::All => "",
        PrInboxState::Open => "is:open",
        PrInboxState::Closed => "is:closed -is:merged",
        PrInboxState::Merged => "is:merged",
    };
    let search = format!(
        "repo:{repository} is:pr {state} {} sort:updated-desc",
        input.query
    );
    let query_arg = format!("query={query}");
    let search_arg = format!("search={search}");
    let first_arg = format!("first={}", input.limit);
    let cursor_arg = cursor.map(|cursor| format!("cursor={cursor}"));
    let mut args = vec![
        "api",
        "graphql",
        "--hostname",
        "github.com",
        "-f",
        &query_arg,
        "-f",
        &search_arg,
        "-F",
        &first_arg,
    ];
    if let Some(cursor) = &cursor_arg {
        args.extend(["-f", cursor]);
    }
    let deadline = Instant::now() + timeout;
    let value = call(program, &args, timeout).await?;
    if value.get("errors").is_some() {
        return Err(AppError::new(
            "pr_inbox",
            "GitHub refused this pull request search.",
        ));
    }
    let search = &value["data"]["search"];
    let rows = search["nodes"].as_array().ok_or_else(|| {
        AppError::new("pr_inbox", "GitHub returned an invalid pull request list.")
    })?;
    let next = if search["pageInfo"]["hasNextPage"].as_bool() == Some(true) {
        Some(
            search["pageInfo"]["endCursor"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 1000)
                .ok_or_else(|| {
                    AppError::new("pr_inbox", "GitHub omitted the continuation cursor.")
                })?
                .to_owned(),
        )
    } else {
        None
    };
    let mut entries = Vec::new();
    for row in rows {
        let url = row["url"].as_str().unwrap_or("");
        let key = PullRequestKey::from_url(url)?;
        let (owner, name) = key.repository();
        if format!("{owner}/{name}") != repository
            || row["number"].as_u64().map(|n| n.to_string()).as_deref() != Some(key.number())
        {
            return Err(AppError::new(
                "pr_inbox",
                "GitHub returned a different repository or pull request number.",
            ));
        }
        let checks = row["commits"]["nodes"]
            .as_array()
            .and_then(|nodes| nodes.last())
            .and_then(|last| last["commit"]["statusCheckRollup"]["state"].as_str());
        let review = match row["reviewDecision"].as_str() {
            Some("APPROVED") => Some("approved"),
            Some("CHANGES_REQUESTED") => Some("changes-requested"),
            Some("REVIEW_REQUIRED") => Some("review-required"),
            _ => None,
        };
        let requested = row["reviewRequests"]["nodes"]
            .as_array()
            .is_some_and(|requests| {
                requests.iter().any(|r| {
                    r["requestedReviewer"]["login"]
                        .as_str()
                        .is_some_and(|login| login.eq_ignore_ascii_case(viewer))
                })
            });
        let state = row["state"].as_str().unwrap_or("").to_ascii_lowercase();
        if !["open", "closed", "merged"].contains(&state.as_str()) {
            return Err(AppError::new(
                "pr_inbox",
                "GitHub returned an invalid pull request state.",
            ));
        }
        let mut entry = json!({"key":key,"provider":"github","host":"github.com","projectId":workspace.id,"projectTitle":workspace.label,"repository":repository,"number":row["number"],"title":row["title"],"url":url,"author":row["author"],"headBranch":row["headRefName"],"baseBranch":row["baseRefName"],"state":state,"isDraft":row["isDraft"],"mergeability":match row["mergeable"].as_str() { Some("MERGEABLE")=>"mergeable",Some("CONFLICTING")=>"conflicting",_=>"unknown"},"additions":row["additions"],"deletions":row["deletions"],"createdAt":row["createdAt"],"updatedAt":row["updatedAt"],"viewerReviewRequested":requested,"labels":row["labels"]["nodes"]});
        if let Some(review) = review {
            entry["reviewDecision"] = json!(review);
        }
        if let Some(checks) = checks {
            entry["checksState"] = json!(match checks {
                "SUCCESS" => "passing",
                "FAILURE" | "ERROR" => "failing",
                _ => "pending",
            });
        }
        entries.push(serde_json::from_value(entry)?);
    }
    if let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        enrich_stack_memberships(program, repository, &mut entries, remaining).await;
    }
    Ok((entries, next))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawStackMembership {
    number: u64,
    size: usize,
    base_ref_name: String,
}
#[derive(Deserialize)]
struct RawStackEntry {
    position: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMembershipPullRequest {
    stack: Option<RawStackMembership>,
    stack_entry: Option<RawStackEntry>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMembershipRepository {
    pull_request: Option<RawMembershipPullRequest>,
}

async fn enrich_stack_memberships(
    program: &Path,
    repository: &str,
    entries: &mut [PrInboxEntry],
    timeout: Duration,
) {
    let Some((owner, name)) = repository.split_once('/') else {
        return;
    };
    if [owner, name].iter().any(|part| {
        part.is_empty()
            || !part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    }) {
        return;
    }
    let deadline = Instant::now() + timeout;
    for chunk in entries.chunks_mut(25) {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        let selections = chunk.iter().enumerate().map(|(index, row)| format!(
            "  s{index}: repository(owner: \"{owner}\", name: \"{name}\") {{ pullRequest(number: {}) {{ stack {{ number size baseRefName }} stackEntry {{ position }} }} }}", row.number
        )).collect::<Vec<_>>().join("\n");
        let query = format!("query PullRequestStackMemberships {{\n{selections}\n}}");
        let argument = format!("query={query}");
        let Ok(value) = call(
            program,
            &[
                "api",
                "graphql",
                "--hostname",
                "github.com",
                "-f",
                &argument,
            ],
            remaining,
        )
        .await
        else {
            continue;
        };
        if value.get("errors").is_some() {
            continue;
        }
        let Ok(data) = serde_json::from_value::<
            std::collections::BTreeMap<String, Option<RawMembershipRepository>>,
        >(value["data"].clone()) else {
            continue;
        };
        for (index, row) in chunk.iter_mut().enumerate() {
            let Some(pr) = data
                .get(&format!("s{index}"))
                .and_then(Option::as_ref)
                .and_then(|repo| repo.pull_request.as_ref())
            else {
                continue;
            };
            if let (Some(stack), Some(entry)) = (&pr.stack, &pr.stack_entry) {
                if stack.number > 0
                    && stack.size > 0
                    && entry.position > 0
                    && entry.position <= stack.size
                    && !stack.base_ref_name.trim().is_empty()
                {
                    row.stack = Some(crate::PrStackMembership {
                        number: stack.number,
                        size: stack.size,
                        base: stack.base_ref_name.clone(),
                        position: entry.position,
                    });
                }
            }
        }
    }
}
