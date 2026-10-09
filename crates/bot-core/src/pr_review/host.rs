mod lifecycle;
mod mutation;
use super::*;
use crate::{
    pull_requests::{FIELDS, Row},
    vcs::Tool,
};
pub(crate) use lifecycle::{Confirmation, acknowledge_update, confirm};
pub(crate) use mutation::change;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::Path,
    time::{Duration, Instant},
};
use tokio::sync::watch;

const PAGE_INFO: &str = "pageInfo { hasNextPage endCursor }";
const COMMENT: &str = "id body url author { login } createdAt updatedAt";
const INLINE: &str = "originalCommit { oid } diffHunk path originalLine";
const MAX_PAGES: usize = 4;
struct Fetch<'a> {
    program: &'a Path,
    deadline: Instant,
    bytes: usize,
    calls: usize,
    section_deadline: Option<Instant>,
    cancel: &'a mut watch::Receiver<bool>,
}
impl Fetch<'_> {
    async fn call(&mut self, args: &[&str]) -> Result<Value> {
        if let Some(deadline) = self.section_deadline
            && (Instant::now() >= deadline || self.calls >= 30 || self.bytes >= 14 * 1024 * 1024)
        {
            return Err(AppError::new(
                "pr_review_limit",
                "Read limit reached. Open GitHub for the rest.",
            ));
        }
        self.calls += 1;
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if self.calls > 32 || remaining.is_zero() {
            return Err(unavailable(
                "Pull request read limit reached. Refresh or open GitHub.",
            ));
        }
        let output_limit = if self.section_deadline.is_some() {
            (14 * 1024 * 1024 - self.bytes).min(2 * 1024 * 1024)
        } else {
            2 * 1024 * 1024
        };
        let out = Tool {
            program: self.program,
            cwd: Path::new("/"),
        }
        .run_cancellable(
            args,
            self.section_deadline
                .map_or(remaining, |deadline| {
                    deadline.saturating_duration_since(Instant::now())
                })
                .min(Duration::from_secs(15)),
            output_limit as u64,
            self.cancel,
        )
        .await;
        let out = match out {
            Ok(out) => {
                self.bytes += out.stdout.len();
                out
            }
            Err(error) => {
                self.bytes += output_limit;
                return Err(error);
            }
        };
        if out.code != Some(0) {
            return Err(unavailable(
                "GitHub could not load this pull request. Check gh authentication and access, then refresh.",
            ));
        }
        if self.bytes > 16 * 1024 * 1024 {
            return Err(unavailable("Pull request responses exceeded 16 MiB."));
        }
        let value: Value = serde_json::from_str(&out.stdout)?;
        if value.get("errors").is_some() {
            return Err(unavailable(
                "GitHub refused this read. Refresh or open GitHub.",
            ));
        }
        Ok(value)
    }
    async fn query(&mut self, query: &str, variables: &[(&str, String)]) -> Result<Value> {
        let mut args = vec![
            "api".into(),
            "graphql".into(),
            "--hostname".into(),
            "github.com".into(),
            "-f".into(),
            format!("query={query}"),
        ];
        for (name, value) in variables {
            args.extend(["-F".into(), format!("{name}={value}")]);
        }
        self.call(&args.iter().map(String::as_str).collect::<Vec<_>>())
            .await
    }
    async fn pr(
        &mut self,
        key: &PullRequestKey,
        operation: &str,
        fields: &str,
        cursor: Option<&str>,
    ) -> Result<Value> {
        let (owner, name) = key.repository();
        let mut variables = vec![
            ("owner", owner.into()),
            ("name", name.into()),
            ("number", key.number().into()),
        ];
        if let Some(cursor) = cursor {
            variables.push(("cursor", cursor.into()));
        }
        let paged = fields.contains("$cursor");
        let query = format!(
            "query {operation}($owner:String!,$name:String!,$number:Int!{}){{repository(owner:$owner,name:$name){{pullRequest(number:$number){{{fields}}}}}}}",
            if paged { ",$cursor:String" } else { "" }
        );
        let value = self.query(&query, &variables).await?;
        Ok(value["data"]["repository"]["pullRequest"].clone())
    }
    async fn meta(&mut self, key: &PullRequestKey) -> Result<Meta> {
        let (owner, name) = key.repository();
        let query = format!(
            "query BotReviewMeta($owner:String!,$name:String!,$number:Int!){{viewer{{login}} repository(owner:$owner,name:$name){{mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed viewerPermission pullRequest(number:$number){{{FIELDS} mergeable mergeStateStatus isMergeQueueEnabled mergeQueueEntry {{ id }} autoMergeRequest {{ mergeMethod }} viewerCanClose viewerCanReopen viewerCanUpdate viewerCanUpdateBranch viewerCanEnableAutoMerge viewerCanDisableAutoMerge body reviewDecision locked viewerDidAuthor createdAt additions deletions changedFiles author {{ login avatarUrl }} labels(first:100) {{ nodes {{ name color }} }} reviewRequests(first:100) {{ nodes {{ requestedReviewer {{ __typename ... on Actor {{ login avatarUrl }} ... on Team {{ combinedSlug avatarUrl }} }} }} }} latestReviews(first:100) {{ nodes {{ state author {{ login avatarUrl }} }} }}}}}}}}"
        );
        let value = self
            .query(
                &query,
                &[
                    ("owner", owner.into()),
                    ("name", name.into()),
                    ("number", key.number().into()),
                ],
            )
            .await?;
        let pr = &value["data"]["repository"]["pullRequest"];
        let snapshot = serde_json::from_value::<Row>(pr.clone())?.parsed(key)?;
        let viewer = required(&value["data"]["viewer"], "login")?;
        let locked = pr["locked"]
            .as_bool()
            .ok_or_else(|| unavailable("Missing review permissions."))?;
        let author = pr["viewerDidAuthor"]
            .as_bool()
            .ok_or_else(|| unavailable("Missing review permissions."))?;
        let verdicts = if locked || !matches!(snapshot.lifecycle, crate::PrLifecycle::Open { .. }) {
            vec![]
        } else if author {
            vec![ReviewVerdict::Comment]
        } else {
            vec![
                ReviewVerdict::Comment,
                ReviewVerdict::Approve,
                ReviewVerdict::RequestChanges,
            ]
        };
        Ok(Meta {
            observation: PrObservation {
                key: key.clone(),
                node_id: snapshot.node_id.clone(),
                head_oid: snapshot.head_oid.clone(),
                viewer,
            },
            capabilities: lifecycle::capabilities(&value["data"]["repository"], pr, &snapshot),
            queued: pr["mergeQueueEntry"]["id"].as_str().is_some(),
            auto_merge: pr["autoMergeRequest"]["mergeMethod"]
                .as_str()
                .map(str::to_owned),
            snapshot,
            body: required(pr, "body")?,
            review_decision: pr["reviewDecision"].as_str().map(str::to_owned),
            verdicts,
            merged_at: pr["mergedAt"].as_str().map(str::to_owned),
            closed_at: pr["closedAt"].as_str().map(str::to_owned),
            created_at: pr["createdAt"].as_str().map(str::to_owned),
            author: actor(&pr["author"]),
            labels: pr["labels"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|label| {
                    Some(PrLabel {
                        name: label["name"].as_str()?.into(),
                        color: label["color"].as_str()?.into(),
                    })
                })
                .collect(),
            reviewers: reviewers(pr),
            additions: total(pr, "additions")?,
            deletions: total(pr, "deletions")?,
            changed_files: total(pr, "changedFiles")?,
        })
    }
    async fn connection(
        &mut self,
        target: &PrObservation,
        section: PrSection,
        operation: &str,
        field: &str,
        node_fields: &str,
        problems: &mut Vec<PrSectionProblem>,
    ) -> Result<Vec<Value>> {
        let mut nodes = vec![];
        let mut cursor = None;
        let mut seen = HashSet::new();
        for _ in 0..MAX_PAGES {
            if self.calls >= 24 {
                record_problem(
                    problems,
                    PrSectionProblem::Limited {
                        section,
                        message: "Read limit reached. Open GitHub for the rest.".into(),
                    },
                );
                return Ok(nodes);
            }
            let selection =
                format!("{field}(first:100,after:$cursor){{nodes{{{node_fields}}} {PAGE_INFO}}}");
            let fields = if field == "contexts" {
                format!("id headRefOid statusCheckRollup{{{selection}}}")
            } else {
                format!("id headRefOid {selection}")
            };
            let pr = self
                .pr(&target.key, operation, &fields, cursor.as_deref())
                .await?;
            ensure_target(&pr, target)?;
            let connection = if field == "contexts" {
                if pr["statusCheckRollup"].is_null() {
                    return Ok(nodes);
                }
                &pr["statusCheckRollup"][field]
            } else {
                &pr[field]
            };
            let page: Connection = serde_json::from_value(connection.clone())?;
            nodes.extend(page.nodes);
            if !page.page_info.has_next_page {
                return Ok(nodes);
            }
            let next = page
                .page_info
                .end_cursor
                .filter(|c| !c.is_empty())
                .ok_or_else(|| unavailable("GitHub omitted a pagination cursor."))?;
            if !seen.insert(next.clone()) {
                return Err(unavailable("GitHub repeated a pagination cursor."));
            }
            cursor = Some(next);
        }
        record_problem(
            problems,
            PrSectionProblem::Limited {
                section,
                message: format!("Incomplete after {MAX_PAGES} pages. Open GitHub for the rest."),
            },
        );
        Ok(nodes)
    }
    async fn files(
        &mut self,
        key: &PullRequestKey,
        problems: &mut Vec<PrSectionProblem>,
    ) -> Result<Vec<PrFile>> {
        let (owner, name) = key.repository();
        self.file_pages(
            &format!("repos/{owner}/{name}/pulls/{}/files", key.number()),
            false,
            problems,
        )
        .await
    }
    async fn file_pages(
        &mut self,
        path: &str,
        commit: bool,
        problems: &mut Vec<PrSectionProblem>,
    ) -> Result<Vec<PrFile>> {
        let mut files = vec![];
        for page in 1..=MAX_PAGES {
            let endpoint = format!("{path}?per_page=100&page={page}");
            let value = match self
                .call(&["api", &endpoint, "--hostname", "github.com"])
                .await
            {
                Ok(value) => value,
                Err(error)
                    if commit
                        && page > 1
                        && error.code != "process_cleanup"
                        && error.code != "cancelled" =>
                {
                    record_problem(
                        problems,
                        PrSectionProblem::Failed {
                            section: PrSection::Files,
                            message: error.message,
                        },
                    );
                    return Ok(files);
                }
                Err(error) => return Err(error),
            };
            let rows: Vec<FileRow> = if commit {
                #[derive(Deserialize)]
                struct CommitFilesResponse {
                    #[serde(default)]
                    files: Vec<FileRow>,
                }
                serde_json::from_value::<CommitFilesResponse>(value)?.files
            } else {
                serde_json::from_value(value)?
            };
            let count = rows.len();
            for row in rows {
                let patch = row.patch.filter(|s| s.len() <= 256 * 1024);
                let mut anchors = patch.as_deref().map(parse_patch).unwrap_or_default();
                let unavailable = if patch.is_none() {
                    Some("Patch unavailable, binary or oversized.".into())
                } else if anchors.iter().filter(|l| l.text.starts_with('+')).count() as u64
                    != row.additions
                    || anchors.iter().filter(|l| l.text.starts_with('-')).count() as u64
                        != row.deletions
                {
                    Some(
                        "GitHub returned an incomplete patch. Line comments are unavailable."
                            .into(),
                    )
                } else {
                    None
                };
                if unavailable.is_some() {
                    record_problem(problems, PrSectionProblem::Limited { section: PrSection::Files, message: "One or more file patches are unavailable or incomplete. Open GitHub for the full changes.".into() });
                    anchors.clear();
                }
                files.push(PrFile {
                    path: row.filename,
                    status: row.status,
                    additions: row.additions,
                    deletions: row.deletions,
                    patch,
                    anchors,
                    unavailable,
                });
            }
            if count < 100 {
                return Ok(files);
            }
        }
        record_problem(
            problems,
            PrSectionProblem::Limited {
                section: PrSection::Files,
                message: "Files are incomplete after 400 files. Open GitHub for the rest.".into(),
            },
        );
        Ok(files)
    }
}
struct Meta {
    capabilities: PrCapabilities,
    queued: bool,
    auto_merge: Option<String>,
    observation: PrObservation,
    snapshot: PrSnapshot,
    body: String,
    review_decision: Option<String>,
    verdicts: Vec<ReviewVerdict>,
    merged_at: Option<String>,
    closed_at: Option<String>,
    created_at: Option<String>,
    author: Option<PrActor>,
    labels: Vec<PrLabel>,
    reviewers: Vec<PrReviewer>,
    additions: u64,
    deletions: u64,
    changed_files: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    nodes: Vec<Value>,
    page_info: PageInfo,
}
#[derive(Deserialize)]
struct FileRow {
    filename: String,
    status: String,
    additions: u64,
    deletions: u64,
    patch: Option<String>,
}
fn unavailable(message: impl ToString) -> AppError {
    AppError::new("pr_review_unavailable", message)
}
fn required(value: &Value, key: &str) -> Result<String> {
    value[key]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| unavailable(format!("GitHub omitted {key}.")))
}
fn total(value: &Value, key: &str) -> Result<u64> {
    value[key]
        .as_u64()
        .ok_or_else(|| unavailable(format!("GitHub omitted {key}.")))
}
fn actor(value: &Value) -> Option<PrActor> {
    Some(PrActor {
        login: value["login"].as_str()?.into(),
        avatar_url: value["avatarUrl"].as_str().map(str::to_owned),
    })
}
fn reviewers(pr: &Value) -> Vec<PrReviewer> {
    let nodes = |field: &str| pr[field]["nodes"].as_array().cloned().unwrap_or_default();
    let reviews: Vec<_> = nodes("latestReviews")
        .iter()
        .map(|review| {
            let author = actor(&review["author"]).unwrap_or(PrActor {
                login: "ghost".into(),
                avatar_url: None,
            });
            (author, review["state"].as_str().map(str::to_owned))
        })
        .collect();
    let mut reviewers: Vec<PrReviewer> = vec![];
    let requested = nodes("reviewRequests").into_iter().filter_map(|request| {
        let reviewer = &request["requestedReviewer"];
        Some(PrActor {
            login: reviewer["login"]
                .as_str()
                .or(reviewer["combinedSlug"].as_str())?
                .into(),
            avatar_url: reviewer["avatarUrl"].as_str().map(str::to_owned),
        })
    });
    for actor in requested.chain(reviews.iter().map(|(author, _)| author.clone())) {
        if reviewers
            .iter()
            .any(|reviewer| reviewer.login.eq_ignore_ascii_case(&actor.login))
        {
            continue;
        }
        let outcome = reviews
            .iter()
            .find(|(author, _)| author.login.eq_ignore_ascii_case(&actor.login))
            .and_then(|(_, state)| state.clone());
        reviewers.push(PrReviewer {
            login: actor.login,
            avatar_url: actor.avatar_url,
            outcome,
        });
    }
    reviewers
}
fn ensure_target(value: &Value, target: &PrObservation) -> Result<()> {
    if value["id"].as_str() != Some(&target.node_id)
        || value["headRefOid"].as_str() != Some(&target.head_oid)
    {
        return Err(AppError::new(
            "pr_review_identity",
            "The PR head changed. Refresh before reviewing.",
        ));
    }
    Ok(())
}
fn comment(value: Value) -> Result<ReviewComment> {
    Ok(ReviewComment {
        id: required(&value, "id")?,
        body: required(&value, "body")?,
        url: required(&value, "url")?,
        author: value["author"]["login"].as_str().map(str::to_owned),
        created_at: required(&value, "createdAt")?,
        updated_at: required(&value, "updatedAt")?,
        context: Some(ReviewContext {
            original_commit: value["originalCommit"]["oid"]
                .as_str()
                .or_else(|| value["commit"]["oid"].as_str())
                .map(str::to_owned),
            path: value["path"].as_str().map(str::to_owned),
            original_line: value["originalLine"].as_u64(),
            diff_hunk: value["diffHunk"].as_str().map(str::to_owned),
        }),
    })
}
fn finding(
    target: &PrObservation,
    id: String,
    source: ReviewSource,
    comments: Vec<ReviewComment>,
) -> Result<ReviewFinding> {
    let digest = Sha256::digest(serde_json::to_vec(&(&source, &comments))?);
    let observation = ReviewObservation {
        pr_id: target.node_id.clone(),
        finding_id: id,
        head_sha: target.head_oid.clone(),
        content_digest: format!("{digest:x}"),
    };
    observation.validate()?;
    Ok(ReviewFinding {
        observation,
        source,
        comments,
        saved: None,
    })
}
impl Fetch<'_> {
    async fn threads(
        &mut self,
        target: &PrObservation,
        problems: &mut Vec<PrSectionProblem>,
    ) -> Result<Vec<PrFinding>> {
        let mut findings = vec![];
        let fields = format!(
            "id isResolved isOutdated viewerCanReply viewerCanResolve viewerCanUnresolve comments(first:100){{nodes{{{COMMENT} {INLINE}}} {PAGE_INFO}}}"
        );
        for row in self
            .connection(
                target,
                PrSection::Threads,
                "BotReviewThreads",
                "reviewThreads",
                &fields,
                problems,
            )
            .await?
        {
            let id = required(&row, "id")?;
            let mut connection: Connection = serde_json::from_value(row["comments"].clone())?;
            let mut comments = vec![];
            let mut seen = HashSet::new();
            for page in 0..MAX_PAGES {
                for value in connection.nodes {
                    comments.push(comment(value)?);
                }
                if !connection.page_info.has_next_page {
                    break;
                }
                if page + 1 == MAX_PAGES || self.calls >= 24 {
                    record_problem(
                        problems,
                        PrSectionProblem::Limited {
                            section: PrSection::Threads,
                            message: format!(
                                "Replies in {id} are incomplete. Open GitHub for the rest."
                            ),
                        },
                    );
                    break;
                }
                let cursor = connection
                    .page_info
                    .end_cursor
                    .filter(|c| !c.is_empty())
                    .ok_or_else(|| unavailable("Missing reply cursor."))?;
                if !seen.insert(cursor.clone()) {
                    return Err(unavailable("Repeated reply cursor."));
                }
                let query="query BotReviewReplies($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{id pullRequest{id} comments(first:100,after:$cursor){nodes{COMMENT INLINE} PAGE_INFO}}}}".replace("COMMENT",COMMENT).replace("INLINE",INLINE).replace("PAGE_INFO",PAGE_INFO);
                let value = self
                    .query(&query, &[("id", id.clone()), ("cursor", cursor)])
                    .await?;
                let node = &value["data"]["node"];
                if node["id"].as_str() != Some(&id)
                    || node["pullRequest"]["id"].as_str() != Some(&target.node_id)
                {
                    return Err(AppError::new(
                        "pr_review_identity",
                        "Review thread belongs to another PR.",
                    ));
                }
                connection = serde_json::from_value(node["comments"].clone())?;
            }
            if comments.is_empty() {
                return Err(unavailable("Review thread has no comments."));
            }
            findings.push(PrFinding {
                finding: finding(
                    target,
                    id,
                    ReviewSource::Thread {
                        resolved: row["isResolved"].as_bool().unwrap_or(false),
                        outdated: row["isOutdated"].as_bool().unwrap_or(false),
                    },
                    comments,
                )?,
                outcome: None,
                can_reply: row["viewerCanReply"].as_bool() == Some(true),
                can_resolve: row["viewerCanResolve"].as_bool() == Some(true),
                can_unresolve: row["viewerCanUnresolve"].as_bool() == Some(true),
            });
        }
        Ok(findings)
    }
    async fn comments(
        &mut self,
        target: &PrObservation,
        section: PrSection,
        problems: &mut Vec<PrSectionProblem>,
    ) -> Result<Vec<PrFinding>> {
        let (op, field, source, extra) = match section {
            PrSection::ConversationComments => (
                "BotReviewConversation",
                "comments",
                ReviewSource::Conversation,
                "",
            ),
            PrSection::Reviews => (
                "BotReviewSummaries",
                "reviews",
                ReviewSource::Review,
                "state commit { oid }",
            ),
            _ => unreachable!(),
        };
        self.connection(
            target,
            section,
            op,
            field,
            &format!("{COMMENT} {extra}"),
            problems,
        )
        .await?
        .into_iter()
        .map(|row| {
            let id = required(&row, "id")?;
            let outcome = row["state"].as_str().map(str::to_owned);
            Ok(PrFinding {
                finding: finding(target, id, source.clone(), vec![comment(row)?])?,
                outcome,
                can_reply: false,
                can_resolve: false,
                can_unresolve: false,
            })
        })
        .collect()
    }
    async fn checks(
        &mut self,
        target: &PrObservation,
        problems: &mut Vec<PrSectionProblem>,
    ) -> Result<Vec<PrCheck>> {
        self.connection(target, PrSection::Checks, "BotReviewChecks", "contexts", "__typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl }", problems).await?.into_iter().map(|row| {
            let check = row["__typename"] == "CheckRun";
            Ok(PrCheck { name: required(&row, if check { "name" } else { "context" })?, state: if check { row["conclusion"].as_str().unwrap_or(row["status"].as_str().unwrap_or("UNKNOWN")).into() } else { required(&row,"state")? }, url: row[if check { "detailsUrl" } else { "targetUrl" }].as_str().map(str::to_owned) })
        }).collect()
    }
    async fn commits(
        &mut self,
        target: &PrObservation,
        problems: &mut Vec<PrSectionProblem>,
    ) -> Result<Vec<PrTimelineEntry>> {
        self.connection(
            target,
            PrSection::Commits,
            "BotReviewCommits",
            "commits",
            "commit { oid messageHeadline committedDate author { name user { login } } }",
            problems,
        )
        .await?
        .into_iter()
        .map(|row| {
            let commit = &row["commit"];
            Ok(timeline_entry(
                commit["committedDate"].as_str(),
                PrTimelineEvent::Commit {
                    oid: required(commit, "oid")?,
                    headline: required(commit, "messageHeadline")?,
                    author: commit["author"]["user"]["login"]
                        .as_str()
                        .or_else(|| commit["author"]["name"].as_str())
                        .map(str::to_owned),
                },
            ))
        })
        .collect()
    }
}
fn record_problem(problems: &mut Vec<PrSectionProblem>, problem: PrSectionProblem) {
    let section = |p: &PrSectionProblem| match p {
        PrSectionProblem::Failed { section, .. } | PrSectionProblem::Limited { section, .. } => {
            *section
        }
    };
    if let Some(existing) = problems
        .iter_mut()
        .find(|p| section(p) == section(&problem))
    {
        if matches!(problem, PrSectionProblem::Failed { .. }) {
            *existing = problem;
        }
    } else {
        problems.push(problem);
    }
}
fn section_data<T: Default>(
    result: Result<T>,
    section: PrSection,
    problems: &mut Vec<PrSectionProblem>,
) -> Result<T> {
    match result {
        Ok(data) => Ok(data),
        Err(error)
            if matches!(
                error.code.as_str(),
                "pr_review_identity" | "cancelled" | "process_cleanup"
            ) =>
        {
            Err(error)
        }
        Err(error) => {
            let message = error.message.chars().take(500).collect();
            record_problem(
                problems,
                if error.code == "pr_review_limit" {
                    PrSectionProblem::Limited { section, message }
                } else {
                    PrSectionProblem::Failed { section, message }
                },
            );
            Ok(T::default())
        }
    }
}
fn timeline_entry(at: Option<&str>, event: PrTimelineEvent) -> PrTimelineEntry {
    PrTimelineEntry {
        at: at
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .map(|date| date.with_timezone(&chrono::Utc).to_rfc3339()),
        event,
    }
}
pub(crate) async fn read_commit_files(
    program: &Path,
    input: &PrCommitFilesRequest,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<PrCommitFiles> {
    input.validate()?;
    let timeout = timeout.min(Duration::from_secs(90));
    let deadline = Instant::now() + timeout;
    let mut fetch = Fetch {
        program,
        deadline,
        bytes: 0,
        calls: 0,
        section_deadline: None,
        cancel,
    };
    let initial = fetch.meta(&input.target.key).await?;
    let identity_error = || {
        AppError::new(
            "pr_review_identity",
            "The PR head or signed-in account changed. Refresh before reviewing.",
        )
    };
    if initial.observation != input.target {
        return Err(identity_error());
    }
    fetch.section_deadline = Some(deadline - (timeout / 4).min(Duration::from_secs(15)));
    let mut membership_problems = vec![];
    let commits = fetch
        .commits(&input.target, &mut membership_problems)
        .await?;
    if !commits.iter().any(|entry| matches!(&entry.event, PrTimelineEvent::Commit { oid, .. } if oid.eq_ignore_ascii_case(&input.commit_oid))) {
        return Err(AppError::new("pr_commit_missing", "This commit could not be established as part of the current pull request. Refresh and select a current commit."));
    }
    let (owner, name) = input.target.key.repository();
    let mut problems = vec![];
    let files = fetch
        .file_pages(
            &format!("repos/{owner}/{name}/commits/{}", input.commit_oid),
            true,
            &mut problems,
        )
        .await?;
    fetch.section_deadline = None;
    if fetch.meta(&input.target.key).await?.observation != input.target {
        return Err(identity_error());
    }
    Ok(PrCommitFiles {
        target: input.target.clone(),
        commit_oid: input.commit_oid.clone(),
        files,
        problems,
    })
}

pub(crate) async fn read(
    program: &Path,
    key: &PullRequestKey,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<PrReviewDetail> {
    let timeout = timeout.min(Duration::from_secs(90));
    let deadline = Instant::now() + timeout;
    let mut fetch = Fetch {
        program,
        deadline,
        bytes: 0,
        calls: 0,
        section_deadline: None,
        cancel,
    };
    let meta = fetch.meta(key).await?;
    fetch.section_deadline = Some(deadline - (timeout / 4).min(Duration::from_secs(15)));
    let target = &meta.observation;
    let mut problems = vec![];
    let result = fetch.threads(target, &mut problems).await;
    let mut findings = section_data(result, PrSection::Threads, &mut problems)?;
    for section in [PrSection::ConversationComments, PrSection::Reviews] {
        let result = fetch.comments(target, section, &mut problems).await;
        findings.extend(section_data(result, section, &mut problems)?);
    }
    let result = fetch.checks(target, &mut problems).await;
    let checks = section_data(result, PrSection::Checks, &mut problems)?;
    let result = fetch.files(key, &mut problems).await;
    let files = section_data(result, PrSection::Files, &mut problems)?;
    let result = fetch.commits(target, &mut problems).await;
    let mut timeline = section_data(result, PrSection::Commits, &mut problems)?;
    fetch.section_deadline = None;
    let final_meta = fetch.meta(key).await?;
    if final_meta.observation != meta.observation {
        return Err(AppError::new(
            "pr_review_identity",
            "The PR head or signed-in account changed. Refresh before reviewing.",
        ));
    }
    timeline.push(timeline_entry(
        final_meta.created_at.as_deref(),
        PrTimelineEvent::Opened {
            author: final_meta
                .author
                .as_ref()
                .map(|author| author.login.clone()),
        },
    ));
    for entry in &findings {
        let finding_id = entry.finding.observation.finding_id.clone();
        let event = match entry.finding.source {
            ReviewSource::Review => PrTimelineEvent::Review { finding_id },
            _ => PrTimelineEvent::Comment { finding_id },
        };
        timeline.push(timeline_entry(
            entry
                .finding
                .comments
                .first()
                .map(|comment| comment.created_at.as_str()),
            event,
        ));
    }
    if final_meta.merged_at.is_some()
        || matches!(
            final_meta.snapshot.lifecycle,
            crate::PrLifecycle::Merged { .. }
        )
    {
        timeline.push(timeline_entry(
            final_meta.merged_at.as_deref(),
            PrTimelineEvent::Merged,
        ));
    } else if final_meta.closed_at.is_some()
        || matches!(
            final_meta.snapshot.lifecycle,
            crate::PrLifecycle::Closed { .. }
        )
    {
        timeline.push(timeline_entry(
            final_meta.closed_at.as_deref(),
            PrTimelineEvent::Closed,
        ));
    }
    timeline.sort_by_key(|entry| {
        std::cmp::Reverse(
            entry
                .at
                .as_ref()
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()),
        )
    });
    Ok(PrReviewDetail {
        observation: final_meta.observation,
        snapshot: final_meta.snapshot,
        body: final_meta.body,
        author: final_meta.author,
        labels: final_meta.labels,
        reviewers: final_meta.reviewers,
        additions: final_meta.additions,
        deletions: final_meta.deletions,
        changed_files: final_meta.changed_files,
        auto_merge_method: final_meta
            .auto_merge
            .as_deref()
            .and_then(MergeMethod::from_wire),
        review_decision: final_meta.review_decision,
        verdicts: final_meta.verdicts,
        findings,
        checks,
        files,
        problems,
        timeline,
        capabilities: final_meta.capabilities,
        operations: vec![],
    })
}
fn parse_patch(patch: &str) -> Vec<PrLine> {
    let mut result = vec![];
    let mut position = None;
    for text in patch.lines() {
        if text.starts_with("@@ ") {
            let mut parts = text.split_whitespace();
            parts.next();
            position = parts.next().zip(parts.next()).and_then(|(left, right)| {
                Some((
                    left.strip_prefix('-')?
                        .split(',')
                        .next()?
                        .parse::<u64>()
                        .ok()?,
                    right
                        .strip_prefix('+')?
                        .split(',')
                        .next()?
                        .parse::<u64>()
                        .ok()?,
                ))
            });
            continue;
        }
        let Some((left, right)) = position.as_mut() else {
            continue;
        };
        match text.as_bytes().first() {
            Some(b'-') => {
                result.push(PrLine {
                    side: PrSide::Left,
                    line: *left,
                    text: text.into(),
                });
                *left += 1;
            }
            Some(b'+') => {
                result.push(PrLine {
                    side: PrSide::Right,
                    line: *right,
                    text: text.into(),
                });
                *right += 1;
            }
            Some(b' ') => {
                result.push(PrLine {
                    side: PrSide::Right,
                    line: *right,
                    text: text.into(),
                });
                *left += 1;
                *right += 1;
            }
            _ => {}
        }
    }
    result
}

pub(crate) async fn checkout_snapshot(
    program: &Path,
    target: &PrObservation,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<PrSnapshot> {
    let mut fetch = Fetch {
        program,
        deadline: Instant::now() + timeout.min(Duration::from_secs(30)),
        bytes: 0,
        calls: 0,
        section_deadline: None,
        cancel,
    };
    let meta = fetch.meta(&target.key).await?;
    if meta.observation != *target {
        return Err(AppError::new(
            "pr_review_stale",
            "The pull request head or GitHub account changed. Refresh before checking it out.",
        ));
    }
    Ok(meta.snapshot)
}
