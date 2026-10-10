use super::pr_review::ReviewCompletion;
use super::*;

pub(super) struct Completion {
    input: PreparePullRequestThread,
    workspace: WorkspaceId,
    generation: u64,
    path: PathBuf,
    pub(super) result: Result<bool>,
    reply: Reply<ThreadSnapshot>,
}

impl App {
    pub async fn list_worktrees(&self, id: WorkspaceId) -> Result<Vec<RegisteredWorktree>> {
        self.call(|r| Command::Worktrees(id, r)).await
    }
    pub async fn prepare_pull_request_thread(
        &self,
        input: PreparePullRequestThread,
    ) -> Result<ThreadSnapshot> {
        self.call(|r| Command::PreparePr(input, r)).await
    }
}

impl Owner {
    pub(super) fn prepare_pr_checkout(
        &mut self,
        input: PreparePullRequestThread,
        reply: Reply<ThreadSnapshot>,
    ) {
        let admitted = (|| {
            let workspace = self.review_member(&input.source_thread_id, &input.target.key)?;
            if self.stack_pending_key(&input.target.key) {
                return Err(AppError::new(
                    "pr_pending",
                    "Reconcile the pending stack operation before starting another.",
                ));
            }
            if self.review_work.changing.contains(&input.target.key)
                || self.review_work.reads.contains_key(&input.target.key)
                || self.review_work.active.len() >= 4
            {
                return Err(AppError::new(
                    "pr_busy",
                    "Wait for the current pull request operation to finish.",
                ));
            }
            let root = self.workspace(&workspace)?.root.clone();
            let path = match &input.destination {
                PrCheckoutDestination::Existing { path } => {
                    repo::registered_worktree(&root, path)?.path
                }
                PrCheckoutDestination::Dedicated => {
                    let parent = self.config.data_dir.join("worktrees").join("pull-requests");
                    std::fs::create_dir_all(&parent)?;
                    dunce::canonicalize(&parent)?.join(uuid::Uuid::new_v4().to_string())
                }
            };
            self.claim_path(path.clone(), Hold::PullRequest)?;
            Ok((workspace, root, path))
        })();
        let (workspace, root, path) = match admitted {
            Ok(value) => value,
            Err(error) => {
                let _ = reply.send(Err(error));
                return;
            }
        };
        self.review_work
            .checkout_workspaces
            .insert(path.clone(), workspace.clone());
        self.review_work.changing.insert(input.target.key.clone());
        let generation = self.review_generation(&input.source_thread_id);
        let program = self.config.gh_binary.clone();
        let timeout = self.config.network_timeout;
        let mut cancel = self.review_work.cancel.subscribe();
        self.review_work.active.spawn(async move {
            let result = prepare(&root, &path, &input, &program, timeout, &mut cancel).await;
            ReviewCompletion::Checkout(Box::new(Completion {
                input,
                workspace,
                generation,
                path,
                result,
                reply,
            }))
        });
    }
    pub(super) fn finish_pr_checkout(&mut self, done: Completion) {
        let Completion {
            input,
            workspace,
            generation,
            path,
            result,
            reply,
        } = done;
        self.review_work.changing.remove(&input.target.key);
        self.review_work.checkout_workspaces.remove(&path);
        let current = self
            .workspace(&workspace)
            .and_then(|w| repo::registered_worktree(&w.root, &path));
        let mut saved = Ok(());
        if let Ok(row) = &current {
            let branch = row.branch.clone().unwrap_or_else(|| "HEAD".into());
            let owners: Vec<_> = self.threads.values().filter(|t| matches!(&t.checkout, Checkout::Worktree { path: owner, .. } if *owner == path)).map(|t| t.id.clone()).collect();
            for id in owners {
                if let Checkout::Worktree {
                    branch: previous, ..
                } = &mut self.threads.get_mut(&id).unwrap().checkout
                {
                    *previous = branch.clone();
                }
                if let Err(error) = self.commit(&id) {
                    saved = Err(error);
                }
            }
        }
        self.checkout_changed(&path);
        let response = result
            .and_then(|moved| {
                saved?;
                self.review_member(&input.source_thread_id, &input.target.key)?;
                if self.review_generation(&input.source_thread_id) != generation {
                    return Err(AppError::new(
                        "pr_review_stale",
                        "The source conversation PR association changed.",
                    ));
                }
                let row = current?;
                if row.head != input.target.head_oid {
                    return Err(AppError::new(
                        "pr_review_stale",
                        "The prepared checkout changed. Refresh and try again.",
                    ));
                }
                let prepared = !moved
                    && self.threads.values().any(|thread| {
                        thread.root(&self.workspaces[&thread.workspace_id]) == path
                            && thread.worktree_setup.as_ref().is_some_and(|setup| {
                                setup.head_oid.as_ref() == Some(&row.head)
                                    && matches!(setup.state, crate::SetupState::Succeeded)
                            })
                    });
                let config = if prepared {
                    None
                } else {
                    Some(crate::project::resolve(
                        &self.workspace(&workspace)?.root,
                        &self.config.data_dir.join("settings.json"),
                        &workspace,
                    )?)
                };
                let checkout = if path == self.workspace(&workspace)?.root {
                    Checkout::Local
                } else {
                    Checkout::Worktree {
                        path: path.clone(),
                        branch: row.branch.unwrap_or_else(|| "HEAD".into()),
                    }
                };
                let thread =
                    self.new_thread(workspace, checkout, SessionSettings::default(), config)?;
                self.pr_membership(&thread.id, input.target.key, Some(PrLinkSource::Manual))
                .map_err(|error| {
                    AppError::new(&error.code, format!(
                        "Conversation {} was created in {} but its PR link could not be saved: {}",
                        thread.id.0, path.display(), error.message
                    ))
                })?;
                self.begin_setup(&thread.id);
                self.thread(&thread.id).cloned()
            })
            .map_err(|mut error| {
                if path.exists() {
                    error.message.push_str(&format!(
                        " The checkout at {} was retained.",
                        path.display()
                    ));
                }
                error
            });
        self.held.remove(&path);
        let _ = reply.send(response);
    }
}

async fn git(
    root: &Path,
    args: &[&str],
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<String> {
    let out = vcs::Tool {
        program: Path::new("git"),
        cwd: root,
    }
    .run_cancellable(args, timeout, 2 * 1024 * 1024, cancel)
    .await?;
    if out.code != Some(0) {
        return Err(AppError::new("git", out.stderr));
    }
    Ok(out.stdout.trim().to_owned())
}
async fn prepare(
    root: &Path,
    path: &Path,
    input: &PreparePullRequestThread,
    program: &Path,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Result<bool> {
    let snapshot =
        crate::pr_review::checkout_snapshot(program, &input.target, timeout, cancel).await?;
    let existing = matches!(input.destination, PrCheckoutDestination::Existing { .. });
    if existing {
        repo::registered_worktree(root, path)?;
        if !git(
            path,
            &["status", "--porcelain", "--untracked-files=all"],
            timeout,
            cancel,
        )
        .await?
        .is_empty()
        {
            return Err(AppError::new(
                "dirty_checkout",
                "The selected checkout has local changes. Commit or stash them before checking out this pull request.",
            ));
        }
    }
    let (owner, name) = input.target.key.repository();
    let remote = format!("https://github.com/{owner}/{name}.git");
    let reference = format!("refs/pull/{}/head", input.target.key.number());
    let fetched_ref = format!(
        "refs/bot-code/pr-checkout/{}",
        uuid::Uuid::new_v4().simple()
    );
    let refspec = format!("{reference}:{fetched_ref}");
    git(
        root,
        &[
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            &remote,
            &refspec,
        ],
        timeout,
        cancel,
    )
    .await?;
    let fetched = git(
        root,
        &[
            "rev-parse",
            "--verify",
            &format!("{fetched_ref}^{{commit}}"),
        ],
        timeout,
        cancel,
    )
    .await?;
    git(root, &["update-ref", "-d", &fetched_ref], timeout, cancel).await?;
    if fetched != input.target.head_oid {
        return Err(AppError::new(
            "pr_review_stale",
            "The fetched pull request head changed.",
        ));
    }
    crate::pr_review::checkout_snapshot(program, &input.target, timeout, cancel).await?;
    let exact = existing
        && git(path, &["rev-parse", "HEAD"], timeout, cancel).await? == input.target.head_oid;
    if !exact {
        let branch = loop {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let branch = format!(
                "botcode/pr-{owner}-{}-{}",
                input.target.key.number(),
                &id[..8]
            );
            if repo::git(
                root,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{branch}"),
                ],
            )
            .is_err()
            {
                break branch;
            }
        };
        if existing {
            repo::registered_worktree(root, path)?;
            if !git(
                path,
                &["status", "--porcelain", "--untracked-files=all"],
                timeout,
                cancel,
            )
            .await?
            .is_empty()
            {
                return Err(AppError::new(
                    "dirty_checkout",
                    "The selected checkout changed while fetching. Preserve those changes before retrying.",
                ));
            }
            git(
                path,
                &[
                    "switch",
                    "--no-guess",
                    "--no-overwrite-ignore",
                    "-c",
                    &branch,
                    &input.target.head_oid,
                ],
                timeout,
                cancel,
            )
            .await?;
        } else {
            git(
                root,
                &[
                    "worktree",
                    "add",
                    "-b",
                    &branch,
                    &path.to_string_lossy(),
                    &input.target.head_oid,
                ],
                timeout,
                cancel,
            )
            .await?;
        }
        git(
            path,
            &["config", &repo::merge_base_key(&branch), &snapshot.base],
            timeout,
            cancel,
        )
        .await?;
    }
    let refreshed =
        crate::pr_review::checkout_snapshot(program, &input.target, timeout, cancel).await?;
    if refreshed.head_repository != snapshot.head_repository {
        return Err(AppError::new(
            "pr_review_stale",
            "The pull request repository changed.",
        ));
    }
    if git(path, &["rev-parse", "HEAD"], timeout, cancel).await? != input.target.head_oid {
        return Err(AppError::new(
            "pr_review_stale",
            "The selected checkout no longer matches the pull request head.",
        ));
    }
    if existing
        && !git(
            path,
            &["status", "--porcelain", "--untracked-files=all"],
            timeout,
            cancel,
        )
        .await?
        .is_empty()
    {
        return Err(AppError::new(
            "dirty_checkout",
            "The selected checkout changed while preparing. Preserve those changes before retrying.",
        ));
    }
    Ok(!exact)
}
