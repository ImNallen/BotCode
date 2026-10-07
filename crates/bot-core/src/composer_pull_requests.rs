// Ported from T3 Code v0.0.45 apps/server/src/pullRequest/GitHubPullRequestCli.ts.
use crate::{
    PullRequestContextMetadata, PullRequestContextState, domain::*, pull_requests::repository,
    vcs::Tool,
};
use serde::Deserialize;
use std::{path::Path, time::Duration};

const FIELDS: &str = "number,title,url,headRefName,baseRefName,state,isDraft";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    number: u64,
    title: String,
    url: String,
    head_ref_name: String,
    base_ref_name: String,
    state: String,
    is_draft: bool,
}
impl Row {
    fn metadata(self, owner: &str, name: &str) -> Result<PullRequestContextMetadata> {
        let key = crate::PullRequestKey::from_url(&self.url)?;
        if key.repository() != (owner, name)
            || key.number().parse::<u64>().ok() != Some(self.number)
        {
            return Err(AppError::new(
                "pr_fetch",
                "GitHub returned a different pull request repository or number.",
            ));
        }
        let state = match self.state.to_ascii_lowercase().as_str() {
            "open" => PullRequestContextState::Open,
            "closed" => PullRequestContextState::Closed,
            "merged" => PullRequestContextState::Merged,
            _ => {
                return Err(AppError::new(
                    "pr_fetch",
                    "GitHub returned an unknown pull request state.",
                ));
            }
        };
        let result = PullRequestContextMetadata {
            number: self.number,
            title: self.title,
            url: self.url,
            head_branch: self.head_ref_name,
            base_branch: self.base_ref_name,
            state,
            is_draft: self.is_draft,
        };
        if !result.valid() {
            return Err(AppError::new(
                "pr_fetch",
                "GitHub returned oversized pull request metadata.",
            ));
        }
        Ok(result)
    }
}
pub(crate) async fn search(
    program: &Path,
    root: &Path,
    query: &str,
    timeout: Duration,
) -> Result<Vec<PullRequestContextMetadata>> {
    let query = query.trim();
    if query.encode_utf16().count() > 256 || query.contains(['\0', '\r', '\n']) {
        return Err(AppError::new(
            "invalid_pr_query",
            "Pull request searches must fit on one line up to 256 characters.",
        ));
    }
    let git = Tool {
        program: Path::new("git"),
        cwd: root,
    };
    let upstream = git
        .run_bounded(
            &["config", "--get", "remote.upstream.url"],
            Duration::from_secs(10),
            16_384,
        )
        .await?;
    let remote = if upstream.code == Some(0) {
        upstream.stdout
    } else {
        let origin = git
            .run_bounded(
                &["config", "--get", "remote.origin.url"],
                Duration::from_secs(10),
                16_384,
            )
            .await?;
        if origin.code != Some(0) {
            return Err(AppError::new(
                "pr_repository",
                "This checkout has no GitHub repository remote.",
            ));
        }
        origin.stdout
    };
    let (owner, name) = repository(remote.trim())?;
    let repository = format!("{owner}/{name}");
    let numeric = !query.is_empty() && query.bytes().all(|b| b.is_ascii_digit());
    let number = if numeric {
        Some(
            query
                .parse::<u64>()
                .ok()
                .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
                .ok_or_else(|| {
                    AppError::new("invalid_pr_query", "Enter a valid pull request number.")
                })?,
        )
    } else {
        None
    };
    let mut args = vec![
        "pr",
        "list",
        "--repo",
        &repository,
        "--state",
        "all",
        "--limit",
        "99",
        "--json",
        FIELDS,
    ];
    if !query.is_empty() && !numeric {
        args.extend(["--search", query]);
    }
    let gh = Tool { program, cwd: root };
    let output = gh.run_bounded(&args, timeout, 2 * 1024 * 1024).await?;
    check_output(&output)?;
    let rows: Vec<Row> = serde_json::from_str(&output.stdout)?;
    if rows.len() > 99 {
        return Err(AppError::new(
            "pr_fetch",
            "GitHub returned too many pull requests.",
        ));
    }
    let mut results = rows
        .into_iter()
        .map(|row| row.metadata(&owner, &name))
        .collect::<Result<Vec<_>>>()?;
    if let Some(number) = number {
        results.retain(|row| row.number == number);
        if results.is_empty() {
            let number = number.to_string();
            let output = gh
                .run_bounded(
                    &[
                        "pr",
                        "view",
                        &number,
                        "--repo",
                        &repository,
                        "--json",
                        FIELDS,
                    ],
                    timeout,
                    2 * 1024 * 1024,
                )
                .await?;
            if output.code != Some(0)
                && (output.stderr.contains("no pull requests found")
                    || output.stderr.contains("Could not resolve to a PullRequest"))
            {
                return Ok(vec![]);
            }
            check_output(&output)?;
            let row: Row = serde_json::from_str(&output.stdout)?;
            if row.number.to_string() != number {
                return Err(AppError::new(
                    "pr_fetch",
                    "GitHub returned a different pull request number.",
                ));
            }
            results.push(row.metadata(&owner, &name)?);
        }
    }
    Ok(results)
}
fn check_output(output: &crate::vcs::Output) -> Result<()> {
    if output.code == Some(0) {
        return Ok(());
    }
    Err(AppError::new(
        if output.code == Some(4) {
            "gh_unauthenticated"
        } else {
            "pr_fetch"
        },
        output.stderr.trim(),
    ))
}
