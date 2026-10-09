// Candidate behavior ported from T3 Code v0.0.45 gitHubPullRequestJson.ts (MIT).
use super::*;
use serde_json::json;

fn allowed(meta: &Meta, kind: PrCandidateKind) -> bool {
    match kind {
        PrCandidateKind::Labels => meta.capabilities.labels,
        PrCandidateKind::Reviewers => meta.capabilities.request_reviewers,
    }
}
fn identity(meta: &Meta, target: &PrObservation) -> Result<()> {
    if meta.observation.key != target.key
        || meta.observation.node_id != target.node_id
        || meta.observation.viewer != target.viewer
    {
        return Err(unavailable(
            "The pull request or signed-in account changed. Refresh.",
        ));
    }
    Ok(())
}
pub(crate) async fn read_candidates(
    program: &Path,
    target: &PrObservation,
    kind: PrCandidateKind,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<PrCandidates> {
    let mut fetch = Fetch {
        program,
        deadline: Instant::now() + timeout.min(Duration::from_secs(60)),
        bytes: 0,
        calls: 0,
        section_deadline: None,
        cancel,
    };
    let meta = fetch.meta(&target.key).await?;
    identity(&meta, target)?;
    if !allowed(&meta, kind) {
        return Err(unavailable(
            "GitHub does not permit changing these pull request details.",
        ));
    }
    let (owner, name) = target.key.repository();
    let (operation, fields) = match kind {
        PrCandidateKind::Labels => (
            "BotLabelCandidates",
            "labels(first:100,orderBy:{field:NAME,direction:ASC}){pageInfo{hasNextPage} nodes{name color description}} pullRequest(number:$number){labels(first:100){nodes{name}}}",
        ),
        PrCandidateKind::Reviewers => (
            "BotReviewerCandidates",
            "assignableUsers(first:100){pageInfo{hasNextPage} nodes{login name avatarUrl}} pullRequest(number:$number){author{login} reviewRequests(first:100){nodes{requestedReviewer{... on User{login name avatarUrl} ... on Team{slug name avatarUrl} ... on Bot{login avatarUrl}}}}}",
        ),
    };
    let query = format!(
        "query {operation}($owner:String!,$name:String!,$number:Int!){{repository(owner:$owner,name:$name){{{fields}}}}}"
    );
    let owner = format!("owner={owner}");
    let name = format!("name={name}");
    let number = format!("number={}", target.key.number());
    let value = fetch
        .call(&[
            "api",
            "graphql",
            "--hostname",
            "github.com",
            "-f",
            &format!("query={query}"),
            "-f",
            &owner,
            "-f",
            &name,
            "-F",
            &number,
        ])
        .await?;
    let repo = &value["data"]["repository"];
    if !repo["pullRequest"].is_object() {
        return Err(unavailable("GitHub could not read this pull request."));
    }
    let mut result = PrCandidates {
        labels: vec![],
        reviewers: vec![],
        truncated: false,
    };
    match kind {
        PrCandidateKind::Labels => {
            let applied: Vec<_> = repo["pullRequest"]["labels"]["nodes"]
                .as_array()
                .ok_or_else(|| unavailable("Invalid labels response."))?
                .iter()
                .filter_map(|node| node["name"].as_str())
                .collect();
            let nodes = repo["labels"]["nodes"]
                .as_array()
                .ok_or_else(|| unavailable("Invalid repository labels response."))?;
            for node in nodes {
                if let Some(name) = node["name"].as_str().filter(|name| !name.is_empty()) {
                    result.labels.push(PrLabelCandidate {
                        name: name.into(),
                        color: node["color"].as_str().map(str::to_owned),
                        description: node["description"].as_str().map(str::to_owned),
                        is_applied: applied.contains(&name),
                    });
                }
            }
            let missing: Vec<_> = applied
                .into_iter()
                .filter(|name| {
                    !result
                        .labels
                        .iter()
                        .any(|candidate| candidate.name == *name)
                })
                .map(|name| PrLabelCandidate {
                    name: name.into(),
                    color: None,
                    description: None,
                    is_applied: true,
                })
                .collect();
            result.labels.splice(0..0, missing);
            result.truncated = repo["labels"]["pageInfo"]["hasNextPage"].as_bool() == Some(true);
        }
        PrCandidateKind::Reviewers => {
            for node in repo["pullRequest"]["reviewRequests"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let actor = &node["requestedReviewer"];
                let (kind, id) = match actor["slug"].as_str() {
                    Some(id) => (PrReviewerKind::Team, Some(id)),
                    None => (PrReviewerKind::User, actor["login"].as_str()),
                };
                if let Some(id) = id.filter(|id| !id.is_empty()) {
                    if result
                        .reviewers
                        .iter()
                        .any(|candidate| candidate.kind == kind && candidate.id == id)
                    {
                        continue;
                    }
                    result.reviewers.push(PrReviewerCandidate {
                        id: id.into(),
                        kind,
                        login: id.into(),
                        name: actor["name"].as_str().map(str::to_owned),
                        avatar_url: actor["avatarUrl"].as_str().map(str::to_owned),
                        is_requested: true,
                    });
                }
            }
            let author = repo["pullRequest"]["author"]["login"].as_str();
            for actor in repo["assignableUsers"]["nodes"]
                .as_array()
                .ok_or_else(|| unavailable("Invalid reviewer candidates response."))?
            {
                if let Some(login) = actor["login"].as_str().filter(|login| {
                    Some(*login) != author
                        && !result.reviewers.iter().any(|candidate| {
                            candidate.kind == PrReviewerKind::User && candidate.id == *login
                        })
                }) {
                    result.reviewers.push(PrReviewerCandidate {
                        id: login.into(),
                        kind: PrReviewerKind::User,
                        login: login.into(),
                        name: actor["name"].as_str().map(str::to_owned),
                        avatar_url: actor["avatarUrl"].as_str().map(str::to_owned),
                        is_requested: false,
                    });
                }
            }
            result.truncated =
                repo["assignableUsers"]["pageInfo"]["hasNextPage"].as_bool() == Some(true);
        }
    }
    let final_meta = fetch.meta(&target.key).await?;
    identity(&final_meta, target)?;
    if !allowed(&final_meta, kind) {
        return Err(unavailable(
            "Permissions changed while loading candidates. Refresh.",
        ));
    }
    Ok(result)
}
pub(super) async fn change_picker(
    program: &Path,
    input: &PrReviewChange,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<PrChangeResult> {
    let prepared = async {
        let kind = match input.action {
            PrReviewAction::SetLabel { .. } => PrCandidateKind::Labels,
            _ => PrCandidateKind::Reviewers,
        };
        let candidates = read_candidates(program, &input.target, kind, timeout, cancel).await?;
        let (owner, name) = input.target.key.repository();
        let number = input.target.key.number();
        match &input.action {
            PrReviewAction::SetLabel {
                name: label,
                applied,
            } => {
                if !candidates
                    .labels
                    .iter()
                    .any(|candidate| candidate.name == *label)
                {
                    return Err(unavailable("This label is no longer available. Refresh."));
                }
                let path = format!("repos/{owner}/{name}/issues/{number}/labels");
                if *applied {
                    Ok(("POST", path, json!({"labels":[label]})))
                } else {
                    let encoded: String = label
                        .bytes()
                        .map(|byte| {
                            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                                (byte as char).to_string()
                            } else {
                                format!("%{byte:02X}")
                            }
                        })
                        .collect();
                    Ok(("DELETE", format!("{path}/{encoded}"), json!({})))
                }
            }
            PrReviewAction::RequestReviewer {
                id,
                reviewer_kind,
                requested,
            } => {
                if !candidates
                    .reviewers
                    .iter()
                    .any(|candidate| candidate.id == *id && candidate.kind == *reviewer_kind)
                {
                    return Err(unavailable("This reviewer no longer has access. Refresh."));
                }
                let (users, teams) = match reviewer_kind {
                    PrReviewerKind::User => (vec![id], vec![]),
                    PrReviewerKind::Team => (vec![], vec![id]),
                };
                Ok((
                    if *requested { "POST" } else { "DELETE" },
                    format!("repos/{owner}/{name}/pulls/{number}/requested_reviewers"),
                    json!({"reviewers":users,"team_reviewers":teams}),
                ))
            }
            _ => Err(unavailable("Invalid picker action.")),
        }
    }
    .await;
    let (method, path, body) = match prepared {
        Ok(value) => value,
        Err(error) if error.code == "process_cleanup" => return Err(error),
        Err(error) => {
            return Ok(PrChangeResult::Refused {
                message: error.message,
            });
        }
    };
    let file = match super::mutation::input_file(&body) {
        Ok(file) => file,
        Err(error) => {
            return Ok(PrChangeResult::Refused {
                message: error.message,
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
            "--method",
            method,
            "--hostname",
            "github.com",
            &path,
            "--input",
            file.0.to_str().unwrap(),
        ],
        timeout.min(Duration::from_secs(30)),
        2 * 1024 * 1024,
        cancel,
    )
    .await;
    match out {
        Err(error) if error.code == "process_cleanup" => Err(error),
        Ok(out) => match serde_json::from_str::<Value>(&out.stdout) {
            Ok(value) if value.is_array() || value["requested_reviewers"].is_array() => {
                Ok(PrChangeResult::Applied {
                    host_id: input.target.node_id.clone(),
                })
            }
            Ok(value) if value["message"].is_string() => Ok(PrChangeResult::Refused {
                message: value["message"].as_str().unwrap().into(),
            }),
            _ => Ok(PrChangeResult::Uncertain {
                message: "GitHub acceptance is uncertain. Check GitHub before submitting again."
                    .into(),
            }),
        },
        Err(_) => Ok(PrChangeResult::Uncertain {
            message: "GitHub acceptance is uncertain. Check GitHub before submitting again.".into(),
        }),
    }
}
