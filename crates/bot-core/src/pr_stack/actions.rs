use super::*;
use crate::{MergeMethod, PrObservation};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStackCapabilities {
    pub merge_methods: Vec<MergeMethod>,
    pub can_rebase: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStackHead {
    pub number: u64,
    pub head_sha: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrStackAction {
    Merge { method: MergeMethod },
    Rebase,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStackChange {
    pub request_id: String,
    pub target: PrObservation,
    pub stack_number: u64,
    pub expected_stack_heads: Vec<PrStackHead>,
    pub action: PrStackAction,
}
impl PrStackChange {
    pub(crate) fn validate(&self) -> Result<()> {
        self.target.validate()?;
        let mut numbers = HashSet::new();
        if self.request_id.is_empty()
            || self.request_id.len() > 256
            || self.stack_number == 0
            || self.expected_stack_heads.is_empty()
            || self.expected_stack_heads.len() > 128
            || self.expected_stack_heads.iter().any(|h| {
                h.number == 0
                    || !numbers.insert(h.number)
                    || h.head_sha.len() != 40
                    || !h.head_sha.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err(AppError::new(
                "pr_stack_invalid",
                "Invalid stack operation identity.",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStackProgress {
    pub number: u64,
    pub node_id: String,
    pub head_sha: String,
    pub updated: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrStackOutcome {
    Merged,
    Enqueued,
    Rebased,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PrStackResult {
    Completed { outcome: PrStackOutcome },
    Refused { message: String },
    Uncertain { message: String },
    Pending { message: String },
    Accepted { outcome: PrStackOutcome },
}
impl PrStackResult {
    pub(crate) fn unresolved(&self) -> bool {
        matches!(
            self,
            Self::Uncertain { .. } | Self::Pending { .. } | Self::Accepted { .. }
        )
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStackOperation {
    pub input: PrStackChange,
    pub affected_keys: Vec<PullRequestKey>,
    pub progress: Vec<PrStackProgress>,
    pub dispatched_layer: Option<u64>,
    pub merge_uuid: Option<String>,
    pub result: PrStackResult,
}
pub(crate) type Save = mpsc::Sender<(PrStackOperation, oneshot::Sender<Result<()>>)>;
async fn save(
    sink: &Save,
    operation: &PrStackOperation,
    cancel: &mut watch::Receiver<bool>,
) -> Result<()> {
    if *cancel.borrow() {
        return Err(AppError::new("shutdown", "Stack receipt storage stopped."));
    }
    let (tx, rx) = oneshot::channel();
    tokio::select! {
        result=sink.send((operation.clone(),tx))=>result.map_err(|_|AppError::new("shutdown","Stack receipt storage stopped."))?,
        _=cancel.changed()=>return Err(AppError::new("shutdown","Stack receipt storage stopped.")),
    }
    tokio::select! {
        result=rx=>result.map_err(|_|AppError::new("shutdown","Stack receipt storage stopped."))?,
        _=cancel.changed()=>Err(AppError::new("shutdown","Stack receipt storage stopped.")),
    }
}
fn changed() -> AppError {
    AppError::new(
        "pr_stack_stale",
        "The stack changed. Refresh it before trying again.",
    )
}
async fn call(
    program: &Path,
    args: Vec<String>,
    deadline: Instant,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(AppError::new(
            "pr_stack_timeout",
            "The stack operation timed out.",
        ));
    }
    let output = Tool {
        program,
        cwd: Path::new("/"),
    }
    .run_cancellable(
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        remaining.min(Duration::from_secs(15)),
        2 * 1024 * 1024,
        cancel,
    )
    .await?;
    if output.code != Some(0) {
        return Err(AppError::new(
            "pr_stack_host",
            "GitHub could not complete the stack operation.",
        ));
    }
    let value: Value = serde_json::from_str(&output.stdout)?;
    if value.get("errors").is_some() {
        return Err(AppError::new(
            "pr_stack_rejected",
            "GitHub refused the stack operation.",
        ));
    }
    Ok(value)
}
async fn query(
    program: &Path,
    key: &PullRequestKey,
    query: String,
    fields: Vec<String>,
    deadline: Instant,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value> {
    let (owner, name) = key.repository();
    let mut args = vec![
        "api".into(),
        "--hostname".into(),
        "github.com".into(),
        "graphql".into(),
        "-f".into(),
        format!("owner={owner}"),
        "-f".into(),
        format!("name={name}"),
        "-F".into(),
        format!("number={}", key.number()),
        "-f".into(),
        format!("query={query}"),
    ];
    for f in fields {
        args.extend(["-f".into(), f]);
    }
    call(program, args, deadline, cancel).await
}
pub(crate) struct Permissions {
    viewer: String,
    node_id: String,
    head: String,
    methods: Vec<MergeMethod>,
    write: bool,
}
impl Permissions {
    pub(crate) fn capabilities(&self) -> PrStackCapabilities {
        PrStackCapabilities {
            merge_methods: self.methods.clone(),
            can_rebase: self.write,
        }
    }
}
pub(crate) async fn permissions(
    program: &Path,
    key: &PullRequestKey,
    deadline: Instant,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Permissions> {
    let v = query(program,key,"query BotStackPermissions($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed pullRequest(number:$number){id headRefOid}}}".into(),vec![],deadline,cancel).await?;
    let repo = &v["data"]["repository"];
    let text = |value: &Value| {
        value
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or_else(changed)
    };
    let write = matches!(
        repo["viewerPermission"].as_str(),
        Some("WRITE" | "MAINTAIN" | "ADMIN")
    );
    let methods = [
        ("mergeCommitAllowed", MergeMethod::Merge),
        ("squashMergeAllowed", MergeMethod::Squash),
        ("rebaseMergeAllowed", MergeMethod::Rebase),
    ]
    .into_iter()
    .filter_map(|(f, m)| (write && repo[f].as_bool() == Some(true)).then_some(m))
    .collect();
    Ok(Permissions {
        viewer: text(&v["data"]["viewer"]["login"])?,
        node_id: text(&repo["pullRequest"]["id"])?,
        head: text(&repo["pullRequest"]["headRefOid"])?,
        methods,
        write,
    })
}
fn check_identity(p: &Permissions, input: &PrStackChange) -> Result<()> {
    if p.viewer != input.target.viewer
        || p.node_id != input.target.node_id
        || p.head != input.target.head_oid
    {
        return Err(changed());
    }
    if !p.write
        || matches!(&input.action,PrStackAction::Merge {method} if !p.methods.contains(method))
    {
        return Err(AppError::new(
            "pr_stack_permission",
            "You cannot perform this stack operation. Check repository write access and allowed merge methods.",
        ));
    }
    Ok(())
}
fn check_heads(
    stack: &PrStack,
    input: &PrStackChange,
    progressed: &[PrStackProgress],
) -> Result<()> {
    if stack.number != input.stack_number {
        return Err(changed());
    }
    let selected = stack
        .layers
        .iter()
        .position(|l| l.number.to_string() == input.target.key.number())
        .ok_or_else(changed)?;
    let end = if matches!(input.action, PrStackAction::Merge { .. }) {
        selected + 1
    } else {
        stack.layers.len()
    };
    let live: Vec<_> = stack.layers[..end]
        .iter()
        .filter(|l| l.state != PrStackState::Merged)
        .collect();
    if live.len() != input.expected_stack_heads.len()
        || live.is_empty()
        || live.iter().any(|l| {
            let head = progressed
                .iter()
                .find(|p| p.number == l.number)
                .map(|p| p.head_sha.as_str())
                .or_else(|| {
                    input
                        .expected_stack_heads
                        .iter()
                        .find(|h| h.number == l.number)
                        .map(|h| h.head_sha.as_str())
                });
            l.state != PrStackState::Open
                || l.head_sha.as_deref() != head
                || head.is_none()
                || (matches!(input.action, PrStackAction::Merge { .. }) && l.is_draft == Some(true))
        })
    {
        return Err(changed());
    }
    if matches!(input.action, PrStackAction::Merge { .. })
        && stack.layers[selected].state != PrStackState::Open
    {
        return Err(changed());
    }
    Ok(())
}
async fn fresh(
    program: &Path,
    input: &PrStackChange,
    progress: &[PrStackProgress],
    deadline: Instant,
    cancel: &mut watch::Receiver<bool>,
) -> Result<PrStack> {
    let stack = super::read(
        program,
        &input.target.key,
        deadline.saturating_duration_since(Instant::now()),
        cancel,
    )
    .await?
    .ok_or_else(changed)?;
    check_heads(&stack, input, progress)?;
    let permissions = permissions(program, &input.target.key, deadline, cancel).await?;
    let mut identity = input.clone();
    if let Some(p) = progress
        .iter()
        .find(|p| p.number.to_string() == input.target.key.number())
    {
        identity.target.head_oid = p.head_sha.clone();
    }
    check_identity(&permissions, &identity)?;
    Ok(stack)
}
fn check_membership(stack: &PrStack, operation: &PrStackOperation) -> Result<()> {
    let (owner, name) = operation.input.target.key.repository();
    let keys = stack
        .layers
        .iter()
        .filter(|l| l.state != PrStackState::Merged)
        .map(|l| PullRequestKey::new(owner, name, l.number))
        .collect::<Result<Vec<_>>>()?;
    if keys != operation.affected_keys {
        return Err(changed());
    }
    Ok(())
}
fn merge_result(value: &Value) -> Result<PrStackResult> {
    match value["status"].as_str() {
        Some("merged")=>Ok(PrStackResult::Completed {outcome:PrStackOutcome::Merged}),
        Some("enqueued")=>Ok(PrStackResult::Accepted {outcome:PrStackOutcome::Enqueued}),
        Some("failed")=>Ok(PrStackResult::Refused {message:"GitHub refused the stack merge. Check the stack's branch rules and merge requirements.".into()}),
        Some("pending")=>Ok(PrStackResult::Pending {message:"The merge is still running on GitHub. Check its status there before submitting another request.".into()}),
        _=>Err(AppError::new("pr_stack_response","GitHub returned an unreadable stack operation response.")),
    }
}
pub(crate) async fn reconcile(
    program: &Path,
    operation: &mut PrStackOperation,
    deadline: Instant,
    cancel: &mut watch::Receiver<bool>,
) -> Result<()> {
    let p = permissions(program, &operation.input.target.key, deadline, cancel).await?;
    if p.viewer != operation.input.target.viewer {
        return Err(changed());
    }
    if p.node_id != operation.input.target.node_id {
        return Err(changed());
    }
    if matches!(operation.result, PrStackResult::Accepted { .. }) && operation.merge_uuid.is_none()
    {
        let fields = operation
            .input
            .expected_stack_heads
            .iter()
            .map(|head| {
                format!(
                    "pr{}:pullRequest(number:{}){{id state headRefOid mergeQueueEntry{{id}}}}",
                    head.number, head.number
                )
            })
            .collect::<Vec<_>>()
            .join(" ");
        let status=query(program,&operation.input.target.key,format!("query BotStackQueueStatus($owner:String!,$name:String!){{repository(owner:$owner,name:$name){{{fields}}}}}"),vec![],deadline,cancel).await?;
        let repo = &status["data"]["repository"];
        let prefix = &operation.input.expected_stack_heads;
        if prefix.iter().any(|h| {
            let layer = &repo[format!("pr{}", h.number)];
            layer["id"].as_str().filter(|id| !id.is_empty()).is_none()
                || !matches!(layer["state"].as_str(), Some("OPEN" | "CLOSED" | "MERGED"))
                || layer.get("mergeQueueEntry").is_none()
                || (!layer["mergeQueueEntry"].is_null()
                    && layer["mergeQueueEntry"]["id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .is_none())
                || layer["headRefOid"]
                    .as_str()
                    .filter(|head| head.len() == 40 && head.bytes().all(|b| b.is_ascii_hexdigit()))
                    .is_none()
        }) {
            return Err(changed());
        }
        let selected = &repo[format!("pr{}", operation.input.target.key.number())];
        if selected["id"].as_str() != Some(operation.input.target.node_id.as_str()) {
            return Err(changed());
        }
        if prefix
            .iter()
            .all(|h| repo[format!("pr{}", h.number)]["state"].as_str() == Some("MERGED"))
        {
            operation.result = PrStackResult::Completed {
                outcome: PrStackOutcome::Merged,
            };
        } else {
            let selected = &repo[format!("pr{}", operation.input.target.key.number())];
            if selected["id"].as_str() != Some(operation.input.target.node_id.as_str()) {
                return Err(changed());
            }
            if selected["mergeQueueEntry"].is_null() {
                operation.result=PrStackResult::Refused {message:"The stack merge request is no longer in GitHub's merge queue. Refresh before trying again.".into()};
            }
        }
        return Ok(());
    }
    if operation.dispatched_layer.is_none() && operation.merge_uuid.is_none() {
        operation.result = PrStackResult::Refused {
            message: if operation.progress.is_empty() {
                "The stack operation was interrupted before dispatch. Refresh before trying again."
                    .into()
            } else {
                format!(
                    "Stack rebase stopped after {} layers. Earlier updates remain on GitHub. Refresh before trying again.",
                    operation.progress.len()
                )
            },
        };
        return Ok(());
    }
    if let Some(uuid) = &operation.merge_uuid {
        let (owner, name) = operation.input.target.key.repository();
        let v = call(
            program,
            vec![
                "api".into(),
                "--hostname".into(),
                "github.com".into(),
                format!(
                    "repos/{owner}/{name}/pulls/{}/merge-async/{uuid}",
                    operation.input.target.key.number()
                ),
            ],
            deadline,
            cancel,
        )
        .await?;
        operation.result = merge_result(&v)?;
    }
    Ok(())
}
pub(crate) async fn run(
    program: &Path,
    operation: &mut PrStackOperation,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
    sink: &Save,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(300);
    let network_deadline = || deadline.min(Instant::now() + timeout);
    let stack = fresh(program, &operation.input, &[], network_deadline(), cancel).await?;
    let (owner, name) = operation.input.target.key.repository();
    operation.affected_keys = stack
        .layers
        .iter()
        .filter(|l| l.state != PrStackState::Merged)
        .map(|l| PullRequestKey::new(owner, name, l.number))
        .collect::<Result<_>>()?;
    save(sink, operation, cancel).await?;
    match operation.input.action {
        PrStackAction::Merge { method } => {
            let current = fresh(program, &operation.input, &[], network_deadline(), cancel).await?;
            check_membership(&current, operation)?;
            operation.dispatched_layer = Some(
                operation
                    .input
                    .target
                    .key
                    .number()
                    .parse()
                    .map_err(|_| changed())?,
            );
            save(sink, operation, cancel).await?;
            let v = call(
                program,
                vec![
                    "api".into(),
                    "--hostname".into(),
                    "github.com".into(),
                    "--method".into(),
                    "PUT".into(),
                    format!(
                        "repos/{owner}/{name}/pulls/{}/merge-async",
                        operation.input.target.key.number()
                    ),
                    "-f".into(),
                    format!("merge_method={}", method.wire().to_ascii_lowercase()),
                    "-f".into(),
                    "merge_action=default".into(),
                    "-f".into(),
                    format!("sha={}", operation.input.target.head_oid),
                ],
                network_deadline(),
                cancel,
            )
            .await?;
            operation.result = merge_result(&v)?;
            operation.merge_uuid = v["details"]["uuid"]
                .as_str()
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 256
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
                })
                .map(str::to_owned);
            if matches!(operation.result, PrStackResult::Pending { .. })
                && operation.merge_uuid.is_none()
            {
                return Err(AppError::new(
                    "pr_stack_response",
                    "GitHub returned an unreadable stack operation response.",
                ));
            }
            save(sink, operation, cancel).await?;
            for attempt in 0..40 {
                if !matches!(operation.result, PrStackResult::Pending { .. })
                    || deadline.saturating_duration_since(Instant::now())
                        < Duration::from_millis(100)
                {
                    break;
                }
                tokio::select! {
                    _=tokio::time::sleep(Duration::from_millis(1000u64.saturating_mul(1<<attempt).min(10000)).min(deadline.saturating_duration_since(Instant::now())))=>{},
                    _=cancel.changed()=>return Err(AppError::new("shutdown","The stack operation was interrupted.")),
                }
                reconcile(program, operation, network_deadline(), cancel).await?;
                save(sink, operation, cancel).await?;
            }
        }
        PrStackAction::Rebase => {
            let open: Vec<_> = stack
                .layers
                .iter()
                .filter(|l| l.state != PrStackState::Merged)
                .collect();
            let fields=open.iter().map(|l|format!("pr{}:pullRequest(number:{}){{headRepository{{viewerPermission}} maintainerCanModify}}",l.number,l.number)).collect::<Vec<_>>().join(" ");
            let access=query(program,&operation.input.target.key,format!("query BotStackBranchAccess($owner:String!,$name:String!){{repository(owner:$owner,name:$name){{{fields}}}}}"),vec![],network_deadline(),cancel).await?;
            if open.iter().any(|l| {
                let p = &access["data"]["repository"][format!("pr{}", l.number)];
                p["headRepository"].is_null()
                    || (!matches!(
                        p["headRepository"]["viewerPermission"].as_str(),
                        Some("ADMIN" | "MAINTAIN" | "WRITE")
                    ) && p["maintainerCanModify"].as_bool() != Some(true))
            }) {
                return Err(AppError::new(
                    "pr_stack_permission",
                    "You cannot update every branch in this stack. Check write access and fork maintainer permissions before retrying.",
                ));
            }
            for layer in open {
                let current = fresh(
                    program,
                    &operation.input,
                    &operation.progress,
                    network_deadline(),
                    cancel,
                )
                .await?;
                check_membership(&current, operation)?;
                let processed = if operation.progress.is_empty() {
                    String::new()
                } else {
                    format!(
                        "processed:nodes(ids:{}){{... on PullRequest{{headRefOid}}}}",
                        serde_json::to_string(
                            &operation
                                .progress
                                .iter()
                                .map(|p| &p.node_id)
                                .collect::<Vec<_>>()
                        )?
                    )
                };
                let key = PullRequestKey::new(owner, name, layer.number)?;
                let v=query(program,&key,format!("query BotStackRebaseBranch($owner:String!,$name:String!,$number:Int!,$sha:String!){{{processed} repository(owner:$owner,name:$name){{pullRequest(number:$number){{id headRefOid baseRef{{compare(headRef:$sha){{behindBy}}}}}}}}}}"),vec![format!("sha={}",layer.head_sha.as_deref().ok_or_else(changed)?)],network_deadline(),cancel).await?;
                let pr = &v["data"]["repository"]["pullRequest"];
                if operation.progress.iter().enumerate().any(|(i, p)| {
                    v["data"]["processed"][i]["headRefOid"].as_str() != Some(p.head_sha.as_str())
                }) || pr["headRefOid"].as_str() != layer.head_sha.as_deref()
                {
                    return Err(changed());
                }
                let id = pr["id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(changed)?
                    .to_owned();
                let behind = pr["baseRef"]["compare"]["behindBy"]
                    .as_u64()
                    .ok_or_else(changed)?;
                let head = if behind == 0 {
                    layer.head_sha.clone().ok_or_else(changed)?
                } else {
                    operation.dispatched_layer = Some(layer.number);
                    save(sink, operation, cancel).await?;
                    let updated=query(program,&key,"mutation BotStackRebase($id:ID!,$sha:GitObjectID!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$sha,updateMethod:REBASE}){pullRequest{headRefOid}}}".into(),vec![format!("id={id}"),format!("sha={}",layer.head_sha.as_deref().ok_or_else(changed)?)],network_deadline(),cancel).await?;
                    updated["data"]["updatePullRequestBranch"]["pullRequest"]["headRefOid"]
                        .as_str()
                        .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                        .ok_or_else(changed)?
                        .to_owned()
                };
                operation.progress.push(PrStackProgress {
                    number: layer.number,
                    node_id: id,
                    head_sha: head,
                    updated: behind != 0,
                });
                operation.dispatched_layer = None;
                save(sink, operation, cancel).await?;
            }
            operation.result = PrStackResult::Completed {
                outcome: PrStackOutcome::Rebased,
            };
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stack_receipt_ack_wait_is_cancelled_when_the_owner_stops() {
        let key = PullRequestKey::new("fixture", "project", 41).unwrap();
        let operation = PrStackOperation {
            input: PrStackChange {
                request_id: "test".into(),
                target: PrObservation {
                    key: key.clone(),
                    node_id: "PR_fixture_41".into(),
                    head_oid: "a".repeat(40),
                    viewer: "fixture-viewer".into(),
                },
                stack_number: 50,
                expected_stack_heads: vec![PrStackHead {
                    number: 41,
                    head_sha: "a".repeat(40),
                }],
                action: PrStackAction::Rebase,
            },
            affected_keys: vec![key],
            progress: vec![],
            dispatched_layer: Some(41),
            merge_uuid: None,
            result: PrStackResult::Uncertain {
                message: "Awaiting dispatch acknowledgement".into(),
            },
        };
        let (sink, mut receiver) = mpsc::channel(1);
        let (cancel, mut watched) = watch::channel(false);
        let saving = save(&sink, &operation, &mut watched);
        let stop = async {
            let (_, ack) = receiver.recv().await.unwrap();
            cancel.send(true).unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            drop(ack);
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(30), async {
            tokio::join!(saving, stop)
        })
        .await
        .unwrap();
        assert_eq!(result.unwrap_err().code, "shutdown");
    }
}
