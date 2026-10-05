use crate::{domain::*, vcs::Tool};
use serde::{Deserialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    time::{Duration, Instant},
};

const PAGE_BYTES: u64 = 2 * 1024 * 1024;
const TOTAL_BYTES: usize = 16 * 1024 * 1024;
const MAX_CALLS: usize = 200;
const COMMENT_FIELDS: &str = "id body url author { login } createdAt updatedAt";
const INLINE_FIELDS: &str = "originalCommit { oid } diffHunk path originalLine";
const PAGE_INFO: &str = "pageInfo { hasNextPage endCursor }";

pub(crate) async fn checkout_identity(root: &Path) -> Result<(String, String)> {
    let git = Tool {
        program: Path::new("git"),
        cwd: root,
    };
    let branch = git
        .run(
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
            Duration::from_secs(15),
        )
        .await?;
    if branch.code != Some(0) {
        return Err(AppError::new(
            "review_checkout",
            "Check out a branch before loading PR reviews.",
        ));
    }
    let head = git
        .ok(
            &["rev-parse", "HEAD"],
            Duration::from_secs(15),
            "review_checkout",
        )
        .await?;
    Ok((branch.stdout.trim().into(), head.trim().into()))
}
struct Fetch<'a> {
    gh: Tool<'a>,
    deadline: Instant,
    calls: usize,
    bytes: usize,
}
impl Fetch<'_> {
    async fn call<T: DeserializeOwned>(&mut self, args: &[&str]) -> Result<T> {
        self.calls += 1;
        if self.calls > MAX_CALLS {
            return Err(unavailable("Review pagination exceeded 200 requests."));
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(unavailable(
                "Review loading timed out. Retry to fetch a complete review.",
            ));
        }
        let out = self
            .gh
            .run_bounded(args, remaining.min(Duration::from_secs(15)), PAGE_BYTES)
            .await
            .map_err(|error| {
                if error.code == "tool_missing" {
                    AppError::new("gh_missing", "Install GitHub CLI (gh) to load PR reviews.")
                } else {
                    error
                }
            })?;
        if out.code != Some(0) {
            return Err(match out.code {
                Some(4) => AppError::new(
                    "gh_unauthenticated",
                    "Run `gh auth login` to load PR reviews.",
                ),
                _ => unavailable(if out.stderr.trim().is_empty() {
                    out.stdout.trim()
                } else {
                    out.stderr.trim()
                }),
            });
        }
        self.bytes += out.stdout.len();
        if self.bytes > TOTAL_BYTES {
            return Err(unavailable("Review responses exceeded 16 MiB."));
        }
        serde_json::from_str(&out.stdout)
            .map_err(|error| unavailable(format!("Invalid GitHub response: {error}")))
    }
    async fn node<T: DeserializeOwned>(
        &mut self,
        operation: &str,
        id: &str,
        body: &str,
        cursor: Option<&str>,
        paginated: bool,
    ) -> Result<T> {
        let cursor_arg = if paginated { ", $cursor: String" } else { "" };
        let query =
            format!("query {operation}($id: ID!{cursor_arg}) {{ node(id: $id) {{ {body} }} }}");
        let query_arg = format!("query={query}");
        let id_arg = format!("id={id}");
        let cursor_arg = cursor.map(|cursor| format!("cursor={cursor}"));
        let mut args = vec![
            "api",
            "graphql",
            "--hostname",
            "github.com",
            "-f",
            &query_arg,
            "-f",
            &id_arg,
        ];
        if let Some(cursor) = &cursor_arg {
            args.extend(["-f", cursor]);
        }
        let response: GraphResponse<T> = self.call(&args).await?;
        if !response.errors.is_empty() {
            return Err(unavailable(
                response
                    .errors
                    .into_iter()
                    .map(|error| error.message)
                    .collect::<Vec<_>>()
                    .join("; "),
            ));
        }
        response.data.and_then(|data| data.node).ok_or_else(|| {
            unavailable(
                "GitHub returned no review node. The pull request may no longer be available.",
            )
        })
    }
}
fn unavailable(message: impl ToString) -> AppError {
    AppError::new("reviews_unavailable", message)
}
#[derive(Deserialize)]
struct GraphResponse<T> {
    data: Option<GraphData<T>>,
    #[serde(default)]
    errors: Vec<GraphError>,
}
#[derive(Deserialize)]
struct GraphData<T> {
    node: Option<T>,
}
#[derive(Deserialize)]
struct GraphError {
    message: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection<T> {
    nodes: Vec<T>,
    page_info: PageInfo,
}
#[derive(Default)]
struct Pages {
    cursor: Option<String>,
    seen: HashSet<String>,
}
impl Pages {
    fn advance(&mut self, info: PageInfo) -> Result<bool> {
        if !info.has_next_page {
            return Ok(false);
        }
        let cursor = info
            .end_cursor
            .filter(|cursor| !cursor.is_empty())
            .ok_or_else(|| unavailable("GitHub pagination omitted its cursor."))?;
        if !self.seen.insert(cursor.clone()) {
            return Err(unavailable("GitHub repeated a pagination cursor."));
        }
        self.cursor = Some(cursor);
        Ok(true)
    }
}
#[derive(Deserialize)]
struct Author {
    login: String,
}
#[derive(Deserialize)]
struct Commit {
    oid: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Comment {
    id: String,
    body: String,
    url: String,
    author: Option<Author>,
    created_at: String,
    updated_at: String,
    original_commit: Option<Commit>,
    commit: Option<Commit>,
    diff_hunk: Option<String>,
    path: Option<String>,
    original_line: Option<u64>,
}
impl Comment {
    fn into_comment(self) -> ReviewComment {
        let original_commit = self
            .original_commit
            .or(self.commit)
            .map(|commit| commit.oid);
        let context =
            (original_commit.is_some() || self.path.is_some() || self.diff_hunk.is_some())
                .then_some(ReviewContext {
                    original_commit,
                    path: self.path,
                    original_line: self.original_line,
                    diff_hunk: self.diff_hunk,
                });
        ReviewComment {
            id: self.id,
            body: self.body,
            url: self.url,
            author: self.author.map(|author| author.login),
            created_at: self.created_at,
            updated_at: self.updated_at,
            context,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Thread {
    id: String,
    is_resolved: bool,
    is_outdated: bool,
    comments: Connection<Comment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Threads {
    review_threads: Connection<Thread>,
}
#[derive(Deserialize)]
struct Comments {
    comments: Connection<Comment>,
}
#[derive(Deserialize)]
struct Reviews {
    reviews: Connection<Comment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Head {
    id: String,
    head_ref_oid: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pr {
    id: String,
    number: u64,
    title: String,
    url: String,
    head_ref_oid: String,
    head_ref_name: String,
    #[serde(default)]
    is_cross_repository: bool,
}
fn insert_comment(comments: &mut BTreeMap<String, ReviewComment>, comment: Comment) -> Result<()> {
    let comment = comment.into_comment();
    if let Some(old) = comments.get(&comment.id) {
        if old != &comment {
            return Err(unavailable(
                "GitHub returned conflicting copies of a review comment.",
            ));
        }
    } else {
        comments.insert(comment.id.clone(), comment);
    }
    Ok(())
}
fn finding(
    pr: &ReviewPullRequest,
    id: String,
    source: ReviewSource,
    comments: BTreeMap<String, ReviewComment>,
) -> Result<ReviewFinding> {
    let mut comments: Vec<_> = comments.into_values().collect();
    comments.sort_by(|a, b| (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id)));
    let digest = Sha256::digest(serde_json::to_vec(&(&source, &comments))?);
    let observation = ReviewObservation {
        pr_id: pr.id.clone(),
        finding_id: id,
        head_sha: pr.head_sha.clone(),
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
fn insert_finding(
    findings: &mut BTreeMap<String, ReviewFinding>,
    finding: ReviewFinding,
) -> Result<()> {
    let id = &finding.observation.finding_id;
    if let Some(old) = findings.get(id) {
        if old.observation != finding.observation {
            return Err(unavailable(
                "GitHub returned conflicting copies of a finding.",
            ));
        }
    } else {
        findings.insert(id.clone(), finding);
    }
    Ok(())
}
pub(crate) async fn fetch(
    program: &Path,
    root: &Path,
    timeout: Duration,
) -> Result<ReviewFindings> {
    let (branch, checkout_head) = checkout_identity(root).await?;
    let mut fetch = Fetch {
        gh: Tool { program, cwd: root },
        deadline: Instant::now() + timeout.min(Duration::from_secs(90)),
        calls: 0,
        bytes: 0,
    };
    let prs: Vec<Pr> = fetch
        .call(&[
            "pr",
            "list",
            "--head",
            &branch,
            "--state",
            "open",
            "--limit",
            "20",
            "--json",
            "number,title,url,baseRefName,headRefName,isCrossRepository,id,headRefOid",
        ])
        .await?;
    let mut matching = prs
        .into_iter()
        .filter(|pr| pr.head_ref_name == branch && !pr.is_cross_repository);
    let Some(row) = matching.next() else {
        ensure_checkout(root, &branch, &checkout_head).await?;
        return Ok(ReviewFindings::None { branch });
    };
    if matching.next().is_some() {
        return Err(unavailable("Several open pull requests match this branch."));
    }
    let pr = ReviewPullRequest {
        id: row.id,
        number: row.number,
        title: row.title,
        url: row.url,
        head_sha: row.head_ref_oid,
    };
    if !pr.url.starts_with("https://github.com/") {
        return Err(AppError::new(
            "review_host_unsupported",
            "PR reviews currently support github.com repositories.",
        ));
    }
    if pr.head_sha.len() != 40
        || !pr.head_sha.bytes().all(|byte| byte.is_ascii_hexdigit())
        || pr.id.is_empty()
    {
        return Err(unavailable(
            "GitHub returned an invalid PR identity or head.",
        ));
    }
    let mut findings = BTreeMap::new();
    let mut pages = Pages::default();
    loop {
        let body = format!(
            "... on PullRequest {{ reviewThreads(first: 100, after: $cursor) {{ nodes {{ id isResolved isOutdated comments(first: 100) {{ nodes {{ {COMMENT_FIELDS} {INLINE_FIELDS} }} {PAGE_INFO} }} }} {PAGE_INFO} }} }}"
        );
        let node: Threads = fetch
            .node(
                "ReviewsThreads",
                &pr.id,
                &body,
                pages.cursor.as_deref(),
                true,
            )
            .await?;
        for thread in node.review_threads.nodes {
            let mut comments = BTreeMap::new();
            for comment in thread.comments.nodes {
                insert_comment(&mut comments, comment)?;
            }
            let mut replies = Pages::default();
            let mut more = replies.advance(thread.comments.page_info)?;
            while more {
                let body = format!(
                    "... on PullRequestReviewThread {{ comments(first: 100, after: $cursor) {{ nodes {{ {COMMENT_FIELDS} {INLINE_FIELDS} }} {PAGE_INFO} }} }}"
                );
                let node: Comments = fetch
                    .node(
                        "ReviewReplies",
                        &thread.id,
                        &body,
                        replies.cursor.as_deref(),
                        true,
                    )
                    .await?;
                for comment in node.comments.nodes {
                    insert_comment(&mut comments, comment)?;
                }
                more = replies.advance(node.comments.page_info)?;
            }
            if comments.is_empty() {
                return Err(unavailable(
                    "GitHub returned a review thread without comments.",
                ));
            }
            insert_finding(
                &mut findings,
                finding(
                    &pr,
                    thread.id,
                    ReviewSource::Thread {
                        resolved: thread.is_resolved,
                        outdated: thread.is_outdated,
                    },
                    comments,
                )?,
            )?;
        }
        if !pages.advance(node.review_threads.page_info)? {
            break;
        }
    }
    for review in [true, false] {
        let mut pages = Pages::default();
        loop {
            let (operation, field, extra) = if review {
                ("ReviewSummaries", "reviews", "commit { oid }")
            } else {
                ("ReviewConversation", "comments", "")
            };
            let body = format!(
                "... on PullRequest {{ {field}(first: 100, after: $cursor) {{ nodes {{ {COMMENT_FIELDS} {extra} }} {PAGE_INFO} }} }}"
            );
            let connection = if review {
                fetch
                    .node::<Reviews>(operation, &pr.id, &body, pages.cursor.as_deref(), true)
                    .await?
                    .reviews
            } else {
                fetch
                    .node::<Comments>(operation, &pr.id, &body, pages.cursor.as_deref(), true)
                    .await?
                    .comments
            };
            for comment in connection.nodes {
                if review && comment.body.trim().is_empty() {
                    continue;
                }
                let id = comment.id.clone();
                let mut comments = BTreeMap::new();
                insert_comment(&mut comments, comment)?;
                insert_finding(
                    &mut findings,
                    finding(
                        &pr,
                        id,
                        if review {
                            ReviewSource::Review
                        } else {
                            ReviewSource::Conversation
                        },
                        comments,
                    )?,
                )?;
            }
            if !pages.advance(connection.page_info)? {
                break;
            }
        }
    }
    let head: Head = fetch
        .node(
            "ReviewHead",
            &pr.id,
            "... on PullRequest { id headRefOid }",
            None,
            false,
        )
        .await?;
    if head.id != pr.id || head.head_ref_oid != pr.head_sha {
        return Err(unavailable(
            "The PR head changed while reviews loaded. Retry to fetch current findings.",
        ));
    }
    ensure_checkout(root, &branch, &checkout_head).await?;
    Ok(ReviewFindings::Ready {
        branch,
        checkout_head,
        pr,
        findings: findings.into_values().collect(),
    })
}
pub(crate) async fn ensure_checkout(root: &Path, branch: &str, head: &str) -> Result<()> {
    if checkout_identity(root).await? != (branch.to_owned(), head.to_owned()) {
        return Err(AppError::new(
            "review_checkout_changed",
            "The checkout changed while reviews loaded. Refresh reviews.",
        ));
    }
    Ok(())
}
