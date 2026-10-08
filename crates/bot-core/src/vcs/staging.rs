use super::*;

pub(crate) async fn stage(
    root: &Path,
    selection: &CommitSelection,
    index: Option<&Path>,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let env: Vec<_> = index
        .into_iter()
        .map(|path| ("GIT_INDEX_FILE", path.as_os_str()))
        .collect();
    let git = git(root);
    let mut paths = Vec::new();
    if let CommitSelection::Paths { paths: selected } = selection {
        let current = parse_porcelain(
            &git.ok(
                &[
                    "--no-optional-locks",
                    "status",
                    "--porcelain=v2",
                    "-z",
                    "--untracked-files=all",
                ],
                LOCAL,
                "git",
            )
            .await?,
        );
        for path in selected.iter() {
            if !current.paths.iter().any(|current| current == path.as_str()) {
                return Err(AppError::new(
                    "stale_commit_selection",
                    format!(
                        "{} is no longer a changed file. Review the files and try again.",
                        path.as_str()
                    ),
                ));
            }
            paths.push(path.as_str().to_owned());
            if let Some(original) = current.renames.get(path.as_str()) {
                paths.push(original.clone());
            }
        }
        let args = if git
            .run(&["rev-parse", "--verify", "HEAD"], LOCAL)
            .await?
            .code
            == Some(0)
        {
            vec!["read-tree", "HEAD"]
        } else {
            vec!["read-tree", "--empty"]
        };
        let out = git
            .run_with_env_input(&args, LOCAL, 1024 * 1024, cancel, None, &env)
            .await?;
        if out.code != Some(0) {
            return Err(AppError::new("git", out.stderr.trim()));
        }
    }
    let mut args = vec!["--literal-pathspecs", "add", "-A"];
    if !paths.is_empty() {
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
    }
    let out = git
        .run_with_env_input(&args, LOCAL, 1024 * 1024, cancel, None, &env)
        .await?;
    if out.code != Some(0) {
        return Err(AppError::new("git", out.stderr.trim()));
    }
    Ok(())
}

// Branch naming ports pingdotgg/t3code v0.0.45 packages/shared/src/git.ts (MIT).
pub(super) async fn new_branch_name(root: &Path, subject: &str) -> Result<String> {
    let mut fragment = String::new();
    for c in subject.trim().to_lowercase().chars() {
        if matches!(c, '\'' | '"' | '`') {
            continue;
        }
        let c = if c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-') {
            c
        } else {
            '-'
        };
        if matches!(c, '/' | '-') && fragment.ends_with(c) {
            continue;
        }
        fragment.push(c);
    }
    let fragment: String = fragment
        .trim_matches(['/', '_', '-'])
        .chars()
        .take(64)
        .collect();
    let fragment = fragment.trim_end_matches(['/', '_', '-']);
    let fragment = if fragment.is_empty() {
        "update"
    } else {
        fragment
    };
    let base = if fragment.starts_with("feature/") {
        fragment.to_owned()
    } else {
        format!("feature/{fragment}")
    };
    let branches = git(root)
        .ok(
            &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
            LOCAL,
            "git",
        )
        .await?
        .to_lowercase();
    let mut branch = base.clone();
    let mut suffix = 2;
    while branches.lines().any(|existing| existing == branch) {
        branch = format!("{base}-{suffix}");
        suffix += 1;
    }
    Ok(branch)
}
