use super::*;
use serde_json::json;
use std::{io::Write, os::unix::fs::OpenOptionsExt, path::PathBuf};

struct PrivateInput(PathBuf);
impl Drop for PrivateInput {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn input_file(value: &Value) -> Result<PrivateInput> {
    let path = std::env::temp_dir().join(format!("z1-pr-{}.json", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    let input = PrivateInput(path);
    file.write_all(&serde_json::to_vec(value)?)?;
    Ok(input)
}
pub(crate) async fn change(
    program: &Path,
    input: &PrReviewChange,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<PrChangeResult> {
    Ok(match prepare(program, input, timeout, cancel).await {
        Ok(payload) => {
            let file = match input_file(&payload) {
                Ok(file) => file,
                Err(_) => {
                    return Ok(PrChangeResult::Refused {
                        message: "Could not prepare private review input.".into(),
                    });
                }
            };
            let out = Tool {
                program,
                cwd: Path::new("/"),
            }
            .run_cancellable(
                &[
                    "api",
                    "graphql",
                    "--hostname",
                    "github.com",
                    "--input",
                    file.0.to_str().unwrap(),
                ],
                timeout.min(Duration::from_secs(30)),
                2 * 1024 * 1024,
                cancel,
            )
            .await;
            if let Err(error) = &out
                && error.code == "process_cleanup"
            {
                return Err(error.clone());
            }
            if let Ok(out) = out
                && let Ok(value) = serde_json::from_str::<Value>(&out.stdout)
            {
                let (field, child) = match input.action {
                    PrReviewAction::Merge { .. } => ("mergePullRequest", "pullRequest"),
                    PrReviewAction::Enqueue => ("enqueuePullRequest", "mergeQueueEntry"),
                    PrReviewAction::EnableAutoMerge { .. } => {
                        ("enablePullRequestAutoMerge", "pullRequest")
                    }
                    PrReviewAction::DisableAutoMerge => {
                        ("disablePullRequestAutoMerge", "pullRequest")
                    }
                    PrReviewAction::SetDraft { draft: true } => {
                        ("convertPullRequestToDraft", "pullRequest")
                    }
                    PrReviewAction::SetDraft { draft: false } => {
                        ("markPullRequestReadyForReview", "pullRequest")
                    }
                    PrReviewAction::SetClosed { closed: true } => {
                        ("closePullRequest", "pullRequest")
                    }
                    PrReviewAction::SetClosed { closed: false } => {
                        ("reopenPullRequest", "pullRequest")
                    }
                    PrReviewAction::UpdateBranch { .. } => {
                        ("updatePullRequestBranch", "pullRequest")
                    }
                    PrReviewAction::SubmitReview { .. } => {
                        ("addPullRequestReview", "pullRequestReview")
                    }
                    PrReviewAction::Reply { .. } => ("addPullRequestReviewThreadReply", "comment"),
                    PrReviewAction::SetResolved { resolved: true, .. } => {
                        ("resolveReviewThread", "thread")
                    }
                    PrReviewAction::SetResolved {
                        resolved: false, ..
                    } => ("unresolveReviewThread", "thread"),
                    PrReviewAction::EditTitle { .. } | PrReviewAction::EditBody { .. } => {
                        ("updatePullRequest", "pullRequest")
                    }
                };
                if let Some(id) = value["data"][field][child]["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                {
                    return Ok(PrChangeResult::Applied { host_id: id.into() });
                }
                if value.get("errors").is_some() {
                    return Ok(PrChangeResult::Refused{message:"GitHub refused this operation. The head or permissions may have changed. Refresh before retrying.".into()});
                }
            }
            PrChangeResult::Uncertain{message:"GitHub acceptance is uncertain. Check GitHub before submitting again. The draft is retained.".into()}
        }
        Err(error) if error.code == "process_cleanup" => return Err(error),
        Err(error) => PrChangeResult::Refused {
            message: error.message,
        },
    })
}
/// Edits do not depend on the head commit, and the agent pushes commits
/// constantly, so only the pull request and the account must still match.
fn still_target(action: &PrReviewAction, observed: &PrObservation, target: &PrObservation) -> bool {
    if action.is_edit() {
        observed.key == target.key
            && observed.node_id == target.node_id
            && observed.viewer == target.viewer
    } else {
        observed == target
    }
}
async fn prepare(
    program: &Path,
    input: &PrReviewChange,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Value> {
    let mut fetch = Fetch {
        program,
        deadline: Instant::now() + timeout.min(Duration::from_secs(60)),
        bytes: 0,
        calls: 0,
        section_deadline: None,
        cancel,
    };
    let meta = fetch.meta(&input.target.key).await?;
    if !still_target(&input.action, &meta.observation, &input.target) {
        return Err(unavailable(
            "The PR head or signed-in account changed. Refresh. Your draft is retained.",
        ));
    }
    if input.action.is_lifecycle() && !meta.capabilities.actions.contains(&input.action) {
        return Err(unavailable(
            "GitHub does not permit this lifecycle action or method. Refresh.",
        ));
    }
    if input.action.is_edit() && !meta.capabilities.edit {
        return Err(unavailable(
            "GitHub does not permit editing this pull request.",
        ));
    }
    let (operation, field, typ, body, child) = match &input.action {
        PrReviewAction::Merge { method } => (
            "Z1Merge",
            "mergePullRequest",
            "MergePullRequestInput",
            json!({"pullRequestId":input.target.node_id,"expectedHeadOid":input.target.head_oid,"mergeMethod":method.wire()}),
            "pullRequest",
        ),
        PrReviewAction::Enqueue => (
            "Z1Enqueue",
            "enqueuePullRequest",
            "EnqueuePullRequestInput",
            json!({"pullRequestId":input.target.node_id,"expectedHeadOid":input.target.head_oid}),
            "mergeQueueEntry",
        ),
        PrReviewAction::EnableAutoMerge { method } => (
            "Z1EnableAutoMerge",
            "enablePullRequestAutoMerge",
            "EnablePullRequestAutoMergeInput",
            json!({"pullRequestId":input.target.node_id,"expectedHeadOid":input.target.head_oid,"mergeMethod":method.wire()}),
            "pullRequest",
        ),
        PrReviewAction::DisableAutoMerge => (
            "Z1DisableAutoMerge",
            "disablePullRequestAutoMerge",
            "DisablePullRequestAutoMergeInput",
            json!({"pullRequestId":input.target.node_id}),
            "pullRequest",
        ),
        PrReviewAction::SetDraft { draft: true } => (
            "Z1Draft",
            "convertPullRequestToDraft",
            "ConvertPullRequestToDraftInput",
            json!({"pullRequestId":input.target.node_id}),
            "pullRequest",
        ),
        PrReviewAction::SetDraft { draft: false } => (
            "Z1Ready",
            "markPullRequestReadyForReview",
            "MarkPullRequestReadyForReviewInput",
            json!({"pullRequestId":input.target.node_id}),
            "pullRequest",
        ),
        PrReviewAction::SetClosed { closed: true } => (
            "Z1Close",
            "closePullRequest",
            "ClosePullRequestInput",
            json!({"pullRequestId":input.target.node_id}),
            "pullRequest",
        ),
        PrReviewAction::SetClosed { closed: false } => (
            "Z1Reopen",
            "reopenPullRequest",
            "ReopenPullRequestInput",
            json!({"pullRequestId":input.target.node_id}),
            "pullRequest",
        ),
        PrReviewAction::UpdateBranch { method } => (
            "Z1UpdateBranch",
            "updatePullRequestBranch",
            "UpdatePullRequestBranchInput",
            json!({"pullRequestId":input.target.node_id,"expectedHeadOid":input.target.head_oid,"updateMethod":match method { BranchUpdateMethod::Merge => "MERGE", BranchUpdateMethod::Rebase => "REBASE" }}),
            "pullRequest",
        ),
        PrReviewAction::EditTitle { title } => (
            "Z1EditTitle",
            "updatePullRequest",
            "UpdatePullRequestInput",
            json!({"pullRequestId":input.target.node_id,"title":title}),
            "pullRequest",
        ),
        PrReviewAction::EditBody { body } => (
            "Z1EditBody",
            "updatePullRequest",
            "UpdatePullRequestInput",
            json!({"pullRequestId":input.target.node_id,"body":body}),
            "pullRequest",
        ),
        PrReviewAction::SubmitReview {
            verdict,
            body,
            comments,
        } => {
            if !meta.verdicts.contains(verdict) {
                return Err(unavailable(
                    "This review verdict is not permitted for the signed-in account.",
                ));
            }
            if !comments.is_empty() {
                let files = fetch.files(&input.target.key, &mut vec![]).await?;
                for comment in comments {
                    if !files.iter().any(|file| {
                        file.path == comment.path
                            && file
                                .anchors
                                .iter()
                                .any(|line| line.line == comment.line && line.side == comment.side)
                    }) {
                        return Err(unavailable(
                            "A line comment does not belong to the viewed remote diff. Refresh or discard it.",
                        ));
                    }
                }
            }
            (
                "Z1SubmitReview",
                "addPullRequestReview",
                "AddPullRequestReviewInput",
                json!({"pullRequestId":input.target.node_id,"commitOID":input.target.head_oid,"event":match verdict {ReviewVerdict::Comment=>"COMMENT",ReviewVerdict::Approve=>"APPROVE",ReviewVerdict::RequestChanges=>"REQUEST_CHANGES"},"body":body,"threads":comments.iter().map(|c|json!({"path":c.path,"line":c.line,"side":c.side,"body":c.body})).collect::<Vec<_>>()}),
                "pullRequestReview",
            )
        }
        PrReviewAction::Reply { thread_id, .. } | PrReviewAction::SetResolved { thread_id, .. } => {
            let query = "query Z1ReviewThread($id:ID!){node(id:$id){... on PullRequestReviewThread{id pullRequest{id} viewerCanReply viewerCanResolve viewerCanUnresolve isResolved}}}";
            let value = fetch.query(query, &[("id", thread_id.clone())]).await?;
            let node = &value["data"]["node"];
            if node["id"].as_str() != Some(thread_id)
                || node["pullRequest"]["id"].as_str() != Some(&input.target.node_id)
            {
                return Err(unavailable(
                    "This conversation belongs to another pull request.",
                ));
            }
            let capability = match input.action {
                PrReviewAction::Reply { .. } => "viewerCanReply",
                PrReviewAction::SetResolved { resolved: true, .. } => "viewerCanResolve",
                _ => "viewerCanUnresolve",
            };
            if node[capability].as_bool() != Some(true) {
                return Err(unavailable(
                    "GitHub does not permit this conversation action.",
                ));
            }
            match &input.action {
                PrReviewAction::Reply { body, .. } => (
                    "Z1Reply",
                    "addPullRequestReviewThreadReply",
                    "AddPullRequestReviewThreadReplyInput",
                    json!({"pullRequestReviewThreadId":thread_id,"body":body}),
                    "comment",
                ),
                PrReviewAction::SetResolved { resolved: true, .. } => (
                    "Z1Resolve",
                    "resolveReviewThread",
                    "ResolveReviewThreadInput",
                    json!({"threadId":thread_id}),
                    "thread",
                ),
                _ => (
                    "Z1Unresolve",
                    "unresolveReviewThread",
                    "UnresolveReviewThreadInput",
                    json!({"threadId":thread_id}),
                    "thread",
                ),
            }
        }
    };
    let final_meta = fetch.meta(&input.target.key).await?;
    if !still_target(&input.action, &final_meta.observation, &input.target) {
        return Err(unavailable(
            "The PR head or signed-in account changed during validation. Refresh.",
        ));
    }
    if input.action.is_lifecycle() && !final_meta.capabilities.actions.contains(&input.action) {
        return Err(unavailable(
            "Lifecycle permissions changed during validation. Refresh.",
        ));
    }
    if input.action.is_edit() && !final_meta.capabilities.edit {
        return Err(unavailable(
            "Edit permissions changed during validation. Refresh.",
        ));
    }
    if let PrReviewAction::SubmitReview { verdict, .. } = &input.action
        && !final_meta.verdicts.contains(verdict)
    {
        return Err(unavailable(
            "Review permissions changed during validation. Refresh before submitting.",
        ));
    }
    Ok(
        json!({"query":format!("mutation {operation}($input:{typ}!){{{field}(input:$input){{{child}{{id}}}}}}"),"variables":{"input":body}}),
    )
}
