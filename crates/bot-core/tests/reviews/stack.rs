use super::*;
fn native_stack() -> Value {
    json!({"id":50,"number":50,"url":"https://api.github.com/repos/fixture/project/stacks/50","html_url":"https://github.com/fixture/project/stacks/50","base":{"ref":"main"},"pull_requests":[
        {"number":41,"title":"Bottom layer","draft":false,"head":{"ref":"bottom","sha":"a".repeat(40)},"state":"open"},
        {"number":42,"title":"Middle layer","draft":true,"head":{"ref":"middle","sha":"b".repeat(40)},"state":"open"},
        {"number":43,"title":"Top layer","draft":false,"head":{"ref":"top","sha":"c".repeat(40)},"state":"closed","merged_at":"2026-10-01T12:00:00Z"}
    ]})
}
fn project_access(f: &Fixture, workspace: &WorkspaceId) -> PrAccess {
    assert!(
        Command::new("git")
            .arg("-C")
            .arg(&f.root)
            .args([
                "config",
                "remote.origin.url",
                "https://github.com/fixture/project.git"
            ])
            .status()
            .unwrap()
            .success()
    );
    PrAccess::Workspace {
        workspace_id: workspace.clone(),
    }
}
#[tokio::test]
async fn stack_reads_native_details_and_saves_navigation_without_heads_or_new_links() {
    let f = Fixture::new();
    f.state(json!({"stack":native_stack(),"matchNumber":true}));
    let (app, thread) = f.open().await;
    let stack = app
        .read_pull_request_stack(thread.clone(), f.key())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        stack
            .layers
            .iter()
            .map(|layer| layer.number)
            .collect::<Vec<_>>(),
        vec![41, 42, 43]
    );
    assert_eq!(stack.layers[1].is_draft, Some(true));
    assert_eq!(stack.layers[2].state, PrStackState::Merged);
    assert_eq!(stack.membership(42).unwrap().position, 2);
    let summary = app
        .list_thread_pull_requests(thread.clone(), false)
        .await
        .unwrap();
    assert_eq!(summary.links.len(), 1);
    let saved = summary.links[0].pr.stack.as_ref().unwrap();
    assert_eq!(saved.layers.len(), 3);
    assert!(!serde_json::to_string(saved).unwrap().contains("headSha"));
    assert!(
        !serde_json::to_string(saved)
            .unwrap()
            .contains(&"a".repeat(40))
    );
    let workspace = app.thread(thread.clone()).await.unwrap().workspace_id;
    let access = project_access(&f, &workspace);
    let sibling = PullRequestKey::new("fixture", "project", 42).unwrap();
    assert!(
        app.read_pull_request(thread.clone(), sibling.clone())
            .await
            .is_err()
    );
    assert!(
        app.read_pull_request(access.clone(), sibling.clone())
            .await
            .is_ok()
    );
    assert!(
        app.read_pull_request_stack(access, sibling)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        app.list_thread_pull_requests(thread, false)
            .await
            .unwrap()
            .links
            .len(),
        1
    );
    let calls: Vec<_> = f
        .log()
        .into_iter()
        .filter(|row| row.to_string().contains("/stacks"))
        .collect();
    assert_eq!(calls.len(), 4);
    assert!(
        calls[0]["args"]
            .as_array()
            .unwrap()
            .contains(&json!("repos/fixture/project/stacks?pull_request=41"))
    );
    assert!(
        calls[1]["args"]
            .as_array()
            .unwrap()
            .contains(&json!("repos/fixture/project/stacks/50"))
    );
    app.shutdown().await.unwrap();
    let (app, thread) = f.open().await;
    assert_eq!(
        app.list_thread_pull_requests(thread, false)
            .await
            .unwrap()
            .links[0]
            .pr
            .stack
            .as_ref()
            .unwrap()
            .number,
        50
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn stack_fresh_absence_clears_saved_navigation_but_failures_preserve_it() {
    let f = Fixture::new();
    f.state(json!({"stack":native_stack()}));
    let (app, thread) = f.open().await;
    app.read_pull_request_stack(thread.clone(), f.key())
        .await
        .unwrap();
    for mode in ["error", "invalid"] {
        f.state(json!({"stack":native_stack(),"stackMode":mode}));
        assert!(
            app.read_pull_request_stack(thread.clone(), f.key())
                .await
                .is_err()
        );
        assert!(
            app.list_thread_pull_requests(thread.clone(), false)
                .await
                .unwrap()
                .links[0]
                .pr
                .stack
                .is_some()
        );
    }
    f.state(json!({"stack":native_stack(),"stackMode":"unsupported"}));
    assert!(
        app.read_pull_request_stack(thread.clone(), f.key())
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        app.list_thread_pull_requests(thread.clone(), false)
            .await
            .unwrap()
            .links[0]
            .pr
            .stack
            .is_none()
    );
    f.state(json!({"stackListing":[]}));
    assert!(
        app.read_pull_request_stack(thread.clone(), f.key())
            .await
            .unwrap()
            .is_none()
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn stack_rejects_changed_identity_and_cross_repository_admission() {
    let f = Fixture::new();
    let mut changed = native_stack();
    changed["number"] = json!(51);
    f.state(json!({"stack":native_stack(),"stackDetail":changed}));
    let (app, thread) = f.open().await;
    assert_eq!(
        app.read_pull_request_stack(thread.clone(), f.key())
            .await
            .unwrap_err()
            .code,
        "pr_stack_stale"
    );
    assert!(
        app.list_thread_pull_requests(thread.clone(), false)
            .await
            .unwrap()
            .links[0]
            .pr
            .stack
            .is_none()
    );
    let workspace = app.thread(thread).await.unwrap().workspace_id;
    let access = project_access(&f, &workspace);
    let other = PullRequestKey::new("other", "repo", 42).unwrap();
    assert_eq!(
        app.read_pull_request_stack(access, other)
            .await
            .unwrap_err()
            .code,
        "pr_repository"
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn stack_revalidates_membership_after_an_unlink_during_read() {
    let f = Fixture::new();
    f.state(json!({"stack":native_stack(),"stackDelay":0.2}));
    let (app, thread) = f.open().await;
    let request = app.read_pull_request_stack(thread.clone(), f.key());
    let unlink = async {
        f.wait_for("/stacks?pull_request=").await;
        app.unlink_pull_request(thread.clone(), f.key())
            .await
            .unwrap();
    };
    let (result, ()) = tokio::join!(request, unlink);
    assert_eq!(result.unwrap_err().code, "pr_not_linked");
    assert!(
        app.list_thread_pull_requests(thread, false)
            .await
            .unwrap()
            .links
            .is_empty()
    );
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn stack_reads_are_bounded_by_the_network_deadline() {
    let mut f = Fixture::new();
    f.config.network_timeout = Duration::from_millis(100);
    f.state(json!({"stack":native_stack(),"stackDelay":1}));
    let (app, thread) = f.open().await;
    assert!(app.read_pull_request_stack(thread, f.key()).await.is_err());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn stack_shutdown_cancels_live_reads_without_waiting_for_host_delay() {
    let f = Fixture::new();
    f.state(json!({"stack":native_stack(),"stackDelay":10}));
    let (app, thread) = f.open().await;
    let request = app.read_pull_request_stack(thread, f.key());
    let shutdown = async {
        f.wait_for("/stacks?pull_request=").await;
        tokio::time::timeout(Duration::from_secs(3), app.shutdown())
            .await
            .unwrap()
            .unwrap();
    };
    let (result, ()) = tokio::join!(request, shutdown);
    assert!(result.is_err());
}

fn actionable_stack() -> Value {
    let mut stack = native_stack();
    for layer in stack["pull_requests"].as_array_mut().unwrap() {
        layer["state"] = json!("open");
        layer["draft"] = json!(false);
        layer.as_object_mut().unwrap().remove("merged_at");
    }
    stack
}
fn action_state() -> Value {
    json!({"stack":actionable_stack(),"matchNumber":true,"perNumber":{"42":{"head":"b".repeat(40)},"43":{"head":"c".repeat(40)}}})
}
async fn stack_input(
    f: &Fixture,
    app: &App,
    thread: &ThreadId,
    action: PrStackAction,
) -> (PrAccess, PrStackChange) {
    let workspace = app.thread(thread.clone()).await.unwrap().workspace_id;
    let access = project_access(f, &workspace);
    let key = PullRequestKey::new("fixture", "project", 42).unwrap();
    let target = app
        .read_pull_request(access.clone(), key.clone())
        .await
        .unwrap()
        .observation;
    let stack = app
        .read_pull_request_stack(access.clone(), key)
        .await
        .unwrap()
        .unwrap();
    let layers = if matches!(action, PrStackAction::Merge { .. }) {
        &stack.layers[..2]
    } else {
        &stack.layers[..]
    };
    (
        access,
        PrStackChange {
            request_id: uuid::Uuid::new_v4().to_string(),
            target,
            stack_number: stack.number,
            expected_stack_heads: layers
                .iter()
                .filter(|l| l.state != PrStackState::Merged)
                .map(|l| PrStackHead {
                    number: l.number,
                    head_sha: l.head_sha.clone().unwrap(),
                })
                .collect(),
            action,
        },
    )
}
fn stack_writes(f: &Fixture) -> Vec<Value> {
    f.log()
        .into_iter()
        .filter(|entry| {
            let args = entry["args"].as_array().unwrap();
            args.contains(&json!("PUT"))
                || args.iter().any(|a| {
                    a.as_str()
                        .is_some_and(|s| s.contains("mutation BotStackRebase("))
                })
        })
        .collect()
}

#[tokio::test]
async fn stack_pending_receipts_block_checkout_admission_before_and_after_restart() {
    async fn check(
        app: &App,
        f: &Fixture,
        workspace: &WorkspaceId,
        access: &PrAccess,
        target: &PrObservation,
    ) {
        let threads = app
            .workspace_view(workspace.clone(), None)
            .await
            .unwrap()
            .threads
            .len();
        let worktrees = app.list_worktrees(workspace.clone()).await.unwrap();
        let calls = f.log().len();
        for destination in [
            PrCheckoutDestination::Dedicated,
            PrCheckoutDestination::Existing {
                path: f.root.clone(),
            },
        ] {
            let error = app
                .prepare_pull_request_thread(PreparePullRequestThread {
                    source_thread_id: access.clone(),
                    target: target.clone(),
                    destination,
                })
                .await
                .unwrap_err();
            assert_eq!(error.code, "pr_pending");
            assert_eq!(
                error.message,
                "Reconcile the pending stack operation before starting another."
            );
        }
        assert_eq!(f.log().len(), calls);
        assert_eq!(
            app.list_worktrees(workspace.clone()).await.unwrap().len(),
            worktrees.len()
        );
        assert_eq!(
            app.workspace_view(workspace.clone(), None)
                .await
                .unwrap()
                .threads
                .len(),
            threads
        );
        assert!(
            !f.config
                .data_dir
                .join("worktrees")
                .join("pull-requests")
                .exists()
        );
    }
    for mode in ["queue", "uncertain"] {
        let f = Fixture::new();
        let mut state = action_state();
        if mode == "queue" {
            state["stackMergeResponses"] = json!([{"status":"enqueued","details":{}}]);
        } else {
            state["stackMergeMode"] = json!("uncertain");
        }
        f.state(state);
        let (app, thread) = f.open().await;
        let workspace = app.thread(thread.clone()).await.unwrap().workspace_id;
        let (access, input) = stack_input(
            &f,
            &app,
            &thread,
            PrStackAction::Merge {
                method: MergeMethod::Squash,
            },
        )
        .await;
        let receipt = app
            .change_pull_request_stack(access.clone(), input.clone())
            .await
            .unwrap();
        assert!(matches!(
            receipt.result,
            PrStackResult::Accepted { .. } | PrStackResult::Uncertain { .. }
        ));
        check(&app, &f, &workspace, &access, &input.target).await;
        app.shutdown().await.unwrap();
        let app = App::open(f.config.clone()).await.unwrap();
        check(&app, &f, &workspace, &access, &input.target).await;
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn stack_merge_through_selected_layer_is_durable_and_replays_identical_requests() {
    let f = Fixture::new();
    f.state(action_state());
    let (app, thread) = f.open().await;
    let (access, input) = stack_input(
        &f,
        &app,
        &thread,
        PrStackAction::Merge {
            method: MergeMethod::Squash,
        },
    )
    .await;
    let result = app
        .change_pull_request_stack(access.clone(), input.clone())
        .await
        .unwrap();
    assert_eq!(result.input, input);
    assert_eq!(
        result.result,
        PrStackResult::Completed {
            outcome: PrStackOutcome::Merged
        }
    );
    assert_eq!(
        result
            .affected_keys
            .iter()
            .map(|k| k.number())
            .collect::<Vec<_>>(),
        vec!["41", "42", "43"]
    );
    let writes = stack_writes(&f);
    assert_eq!(writes.len(), 1);
    let args = writes[0]["args"].as_array().unwrap();
    for expected in [
        "repos/fixture/project/pulls/42/merge-async",
        "merge_method=squash",
        "merge_action=default",
    ] {
        assert!(args.contains(&json!(expected)));
    }
    assert!(args.contains(&json!(format!("sha={}", "b".repeat(40)))));
    assert_eq!(
        app.change_pull_request_stack(access.clone(), input.clone())
            .await
            .unwrap(),
        result
    );
    let mut changed = input.clone();
    changed.action = PrStackAction::Rebase;
    assert_eq!(
        app.change_pull_request_stack(access.clone(), changed)
            .await
            .unwrap_err()
            .code,
        "pr_request_conflict"
    );
    app.shutdown().await.unwrap();
    let (app, _) = f.open().await;
    assert_eq!(
        app.change_pull_request_stack(access, input).await.unwrap(),
        result
    );
    assert_eq!(stack_writes(&f).len(), 1);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn stack_actions_refuse_account_permissions_and_exact_head_set_changes_without_writes() {
    let f = Fixture::new();
    f.state(action_state());
    let (app, thread) = f.open().await;
    let (access, input) = stack_input(
        &f,
        &app,
        &thread,
        PrStackAction::Merge {
            method: MergeMethod::Squash,
        },
    )
    .await;
    for field in ["stackViewer", "viewerPermission", "squashMergeAllowed"] {
        let mut state = action_state();
        state[field] = match field {
            "stackViewer" => json!("other-account"),
            "viewerPermission" => json!("READ"),
            _ => json!(false),
        };
        f.state(state);
        let mut request = input.clone();
        request.request_id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(
            app.change_pull_request_stack(access.clone(), request)
                .await
                .unwrap()
                .result,
            PrStackResult::Refused { .. }
        ));
    }
    f.state(action_state());
    for mode in ["wrong", "missing", "duplicate"] {
        let mut request = input.clone();
        request.request_id = uuid::Uuid::new_v4().to_string();
        match mode {
            "wrong" => request.expected_stack_heads[0].head_sha = "f".repeat(40),
            "missing" => {
                request.expected_stack_heads.pop();
            }
            _ => request.expected_stack_heads[1] = request.expected_stack_heads[0].clone(),
        }
        let result = app.change_pull_request_stack(access.clone(), request).await;
        assert!(result.is_err() || matches!(result.unwrap().result, PrStackResult::Refused { .. }));
    }
    assert!(stack_writes(&f).is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn stack_rebase_is_remote_only_bottom_to_top_skips_current_and_checks_all_branch_access() {
    let f = Fixture::new();
    let mut state = action_state();
    state["stackBehind"] = json!({"41":0});
    f.state(state);
    let before = Command::new("git")
        .arg("-C")
        .arg(&f.root)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap()
        .stdout;
    let (app, thread) = f.open().await;
    let (access, input) = stack_input(&f, &app, &thread, PrStackAction::Rebase).await;
    let result = app.change_pull_request_stack(access, input).await.unwrap();
    assert_eq!(
        result.result,
        PrStackResult::Completed {
            outcome: PrStackOutcome::Rebased
        }
    );
    assert_eq!(
        result.progress.iter().map(|p| p.number).collect::<Vec<_>>(),
        vec![41, 42, 43]
    );
    assert!(!result.progress[0].updated);
    let writes = stack_writes(&f);
    assert_eq!(writes.len(), 2);
    for (entry, number, head) in [(&writes[0], 42, "b"), (&writes[1], 43, "c")] {
        let args = entry["args"].as_array().unwrap();
        assert!(args.contains(&json!(format!("id=PR_fixture_{number}"))));
        assert!(args.contains(&json!(format!("sha={}", head.repeat(40)))));
        assert!(args.iter().any(|a| {
            a.as_str()
                .unwrap()
                .contains("expectedHeadOid:$sha,updateMethod:REBASE")
        }));
        assert_eq!(entry["cwd"], "/");
    }
    assert_eq!(
        Command::new("git")
            .arg("-C")
            .arg(&f.root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
        before
    );
    app.shutdown().await.unwrap();
    let mut state = action_state();
    state["stackAccess"] =
        json!({"43":{"headRepository":{"viewerPermission":"READ"},"maintainerCanModify":false}});
    f.state(state);
    let (app, thread) = f.open().await;
    let (access, input) = stack_input(&f, &app, &thread, PrStackAction::Rebase).await;
    assert!(matches!(
        app.change_pull_request_stack(access, input)
            .await
            .unwrap()
            .result,
        PrStackResult::Refused { .. }
    ));
    assert_eq!(stack_writes(&f).len(), 2);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn stack_rebase_reports_partial_failure_and_changed_processed_heads() {
    for (mode, layer, completed) in [("stackRebaseFail", 42, 1), ("stackChangeEarlier", 42, 2)] {
        let f = Fixture::new();
        let mut state = action_state();
        state[mode] = json!(layer);
        f.state(state);
        let (app, thread) = f.open().await;
        let (access, input) = stack_input(&f, &app, &thread, PrStackAction::Rebase).await;
        let result = app.change_pull_request_stack(access, input).await.unwrap();
        assert_eq!(result.progress.len(), completed);
        assert!(matches!(
            result.result,
            PrStackResult::Refused { .. } | PrStackResult::Uncertain { .. }
        ));
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(serialized.contains("Earlier updates remain on GitHub"));
        assert!(!stack_writes(&f).iter().any(|entry| {
            entry["args"]
                .as_array()
                .unwrap()
                .contains(&json!("id=PR_fixture_43"))
        }));
        app.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn stack_queue_and_ambiguous_dispatch_survive_restart_and_reconcile_without_resubmission() {
    for mode in ["queue", "uncertain", "pending"] {
        let f = Fixture::new();
        let mut state = action_state();
        if mode == "uncertain" {
            state["stackMergeMode"] = json!("uncertain");
        } else if mode == "pending" {
            state["stackMergeResponses"] =
                json!([{"status":"pending","details":{"uuid":"operation"}}]);
            state["waitFor"] = json!({"/merge-async/operation":f.dir.path().join("release-poll")});
        } else {
            state["stackMergeResponses"] =
                json!([{"status":"enqueued","details":{"uuid":"operation"}}]);
        }
        f.state(state);
        let (app, thread) = f.open().await;
        let (access, input) = stack_input(
            &f,
            &app,
            &thread,
            PrStackAction::Merge {
                method: MergeMethod::Squash,
            },
        )
        .await;
        let operation = if mode == "pending" {
            let request = app.change_pull_request_stack(access.clone(), input.clone());
            let stop = async {
                f.wait_for("/merge-async/operation").await;
                app.shutdown().await.unwrap();
            };
            let (result, ()) = tokio::join!(request, stop);
            result.unwrap()
        } else {
            let result = app
                .change_pull_request_stack(access.clone(), input.clone())
                .await
                .unwrap();
            app.shutdown().await.unwrap();
            result
        };
        assert!(matches!(
            operation.result,
            PrStackResult::Accepted { .. }
                | PrStackResult::Uncertain { .. }
                | PrStackResult::Pending { .. }
        ));
        assert_eq!(stack_writes(&f).len(), 1);
        let mut state = action_state();
        state["stackMergeResponses"] = json!([{"status":"merged","details":{"uuid":"operation"}}]);
        f.state(state);
        let (app, _) = f.open().await;
        assert_eq!(
            app.change_pull_request_stack(access.clone(), input.clone())
                .await
                .unwrap(),
            operation
        );
        let sibling = PullRequestKey::new("fixture", "project", 43).unwrap();
        let detail = app
            .read_pull_request(access.clone(), sibling.clone())
            .await
            .unwrap();
        let change = PrReviewChange {
            request_id: uuid::Uuid::new_v4().to_string(),
            target: detail.observation,
            action: PrReviewAction::SetDraft { draft: true },
        };
        assert!(matches!(
            app.change_pull_request(access.clone(), change)
                .await
                .unwrap(),
            PrChangeResult::Refused { .. }
        ));
        assert_eq!(
            app.pull_request_stack_operations(access.clone(), sibling)
                .await
                .unwrap()
                .len(),
            1
        );
        let reconciled = app
            .reconcile_pull_request_stack(
                access.clone(),
                input.target.key.clone(),
                input.request_id.clone(),
            )
            .await
            .unwrap();
        if mode == "uncertain" {
            assert!(matches!(reconciled.result, PrStackResult::Uncertain { .. }));
        } else {
            assert_eq!(
                reconciled.result,
                PrStackResult::Completed {
                    outcome: PrStackOutcome::Merged
                }
            );
        }
        assert_eq!(stack_writes(&f).len(), 1);
        app.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn stack_reserves_every_live_layer_against_reads_writes_and_other_stack_actions() {
    let f = Fixture::new();
    let mut state = action_state();
    state["waitFor"] = json!({"BotStackRebaseBranch:41":f.dir.path().join("release")});
    f.state(state);
    let (app, thread) = f.open().await;
    let (access, input) = stack_input(&f, &app, &thread, PrStackAction::Rebase).await;
    let sibling = PullRequestKey::new("fixture", "project", 43).unwrap();
    let target = app
        .read_pull_request(access.clone(), sibling.clone())
        .await
        .unwrap()
        .observation;
    let concurrent = async {
        f.wait_for("BotStackRebaseBranch").await;
        assert_eq!(
            app.read_pull_request(access.clone(), sibling.clone())
                .await
                .unwrap_err()
                .code,
            "pr_busy"
        );
        let change = PrReviewChange {
            request_id: uuid::Uuid::new_v4().to_string(),
            target: target.clone(),
            action: PrReviewAction::SetDraft { draft: true },
        };
        assert!(matches!(
            app.change_pull_request(access.clone(), change)
                .await
                .unwrap(),
            PrChangeResult::Refused { .. }
        ));
        let mut another = input.clone();
        another.request_id = uuid::Uuid::new_v4().to_string();
        another.target = target;
        assert_eq!(
            app.change_pull_request_stack(access.clone(), another)
                .await
                .unwrap_err()
                .code,
            "pr_busy"
        );
        std::fs::write(f.dir.path().join("release"), "").unwrap();
    };
    let (result, ()) = tokio::join!(
        app.change_pull_request_stack(access.clone(), input.clone()),
        concurrent
    );
    assert_eq!(
        result.unwrap().result,
        PrStackResult::Completed {
            outcome: PrStackOutcome::Rebased
        }
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn stack_navigation_survives_unavailable_action_permissions() {
    let f = Fixture::new();
    let mut state = action_state();
    state["stackPermissionMode"] = json!("error");
    f.state(state);
    let (app, thread) = f.open().await;
    let stack = app
        .read_pull_request_stack(thread, f.key())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stack.layers.len(), 3);
    assert!(!stack.capabilities.can_rebase);
    assert!(stack.capabilities.merge_methods.is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn stack_merge_refuses_an_upper_layer_added_after_reservation() {
    let f = Fixture::new();
    f.state(action_state());
    let (app, thread) = f.open().await;
    let (access, input) = stack_input(
        &f,
        &app,
        &thread,
        PrStackAction::Merge {
            method: MergeMethod::Squash,
        },
    )
    .await;
    let mut added = actionable_stack();
    added["pull_requests"].as_array_mut().unwrap().push(json!({"number":44,"title":"Added top","draft":false,"head":{"ref":"added","sha":"d".repeat(40)},"state":"open"}));
    let mut state = action_state();
    state["stackSequence"] = json!([actionable_stack(), added]);
    f.state(state);
    let result = app.change_pull_request_stack(access, input).await.unwrap();
    assert!(matches!(result.result, PrStackResult::Refused { .. }));
    assert!(stack_writes(&f).is_empty());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn stack_reconcile_closes_pre_dispatch_restart_receipts_but_never_resends_rebase_uncertainty()
{
    for in_flight in [false, true] {
        let f = Fixture::new();
        let mut state = action_state();
        if in_flight {
            state["stackRebaseUncertain"] = json!(42);
        }
        f.state(state);
        let (app, thread) = f.open().await;
        let (access, input) = stack_input(&f, &app, &thread, PrStackAction::Rebase).await;
        let operation = app
            .change_pull_request_stack(access.clone(), input.clone())
            .await
            .unwrap();
        app.shutdown().await.unwrap();
        if !in_flight {
            let mut interrupted = operation.clone();
            interrupted.result = PrStackResult::Uncertain {
                message: "Interrupted after saved progress".into(),
            };
            interrupted.dispatched_layer = None;
            let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
            db.execute(
                "UPDATE pull_request_stack_operations SET data=?1 WHERE request_id=?2",
                rusqlite::params![
                    serde_json::to_string(&interrupted).unwrap(),
                    input.request_id
                ],
            )
            .unwrap();
        }
        let writes = stack_writes(&f).len();
        let (app, _) = f.open().await;
        let result = app
            .reconcile_pull_request_stack(
                access.clone(),
                input.target.key.clone(),
                input.request_id,
            )
            .await
            .unwrap();
        if in_flight {
            assert!(matches!(result.result, PrStackResult::Uncertain { .. }));
            assert_eq!(result.dispatched_layer, Some(42));
            assert_eq!(result.progress.len(), 1);
        } else {
            assert!(matches!(result.result, PrStackResult::Refused { .. }));
            assert!(
                app.pull_request_stack_operations(access, input.target.key)
                    .await
                    .unwrap()
                    .is_empty()
            );
        }
        assert_eq!(stack_writes(&f).len(), writes);
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn stack_rejected_expansion_does_not_release_another_layer_operation() {
    let f = Fixture::new();
    let mut state = action_state();
    state["waitFor"] = json!({"BotAddComment:43":f.dir.path().join("release-comment")});
    f.state(state);
    let (app, thread) = f.open().await;
    let (access, input) = stack_input(
        &f,
        &app,
        &thread,
        PrStackAction::Merge {
            method: MergeMethod::Squash,
        },
    )
    .await;
    let sibling = PullRequestKey::new("fixture", "project", 43).unwrap();
    let detail = app
        .read_pull_request(access.clone(), sibling.clone())
        .await
        .unwrap();
    let comment = PrReviewChange {
        request_id: uuid::Uuid::new_v4().to_string(),
        target: detail.observation,
        action: PrReviewAction::AddComment {
            body: "Keep upper layer busy".into(),
        },
    };
    let refused = async {
        f.wait_for("BotAddComment").await;
        let result = app
            .change_pull_request_stack(access.clone(), input)
            .await
            .unwrap();
        assert!(matches!(result.result, PrStackResult::Refused { .. }));
        assert_eq!(
            result
                .affected_keys
                .iter()
                .map(|k| k.number())
                .collect::<Vec<_>>(),
            vec!["42"]
        );
        assert_eq!(
            app.read_pull_request(access.clone(), sibling)
                .await
                .unwrap_err()
                .code,
            "pr_busy"
        );
        assert!(stack_writes(&f).is_empty());
        std::fs::write(f.dir.path().join("release-comment"), "").unwrap();
    };
    let (comment_result, ()) =
        tokio::join!(app.change_pull_request(access.clone(), comment), refused);
    assert!(comment_result.is_ok());
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn stack_enqueued_without_uuid_reconciles_queue_membership_and_completion_without_writes() {
    for final_state in ["queued", "removed", "merged"] {
        let f = Fixture::new();
        let mut state = action_state();
        state["stackMergeResponses"] = json!([{"status":"enqueued","details":{}}]);
        f.state(state);
        let (app, thread) = f.open().await;
        let (access, input) = stack_input(
            &f,
            &app,
            &thread,
            PrStackAction::Merge {
                method: MergeMethod::Squash,
            },
        )
        .await;
        let result = app
            .change_pull_request_stack(access.clone(), input.clone())
            .await
            .unwrap();
        assert_eq!(
            result.result,
            PrStackResult::Accepted {
                outcome: PrStackOutcome::Enqueued
            }
        );
        assert_eq!(result.merge_uuid, None);
        app.shutdown().await.unwrap();
        let mut state = action_state();
        if final_state == "removed" {
            state["stackQueued"] = json!(false);
        }
        if final_state == "merged" {
            state["stackQueueState"] = json!({"41":"MERGED","42":"MERGED"});
            state["stackListing"] = json!([]);
        }
        f.state(state);
        let (app, _) = f.open().await;
        if final_state == "merged" {
            assert!(
                app.read_pull_request_stack(access.clone(), input.target.key.clone())
                    .await
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                app.pull_request_stack_operations(access.clone(), input.target.key.clone())
                    .await
                    .unwrap()
                    .len(),
                1
            );
        }
        let recovered = app
            .reconcile_pull_request_stack(
                access.clone(),
                input.target.key.clone(),
                input.request_id,
            )
            .await
            .unwrap();
        match final_state {
            "queued" => assert!(matches!(recovered.result, PrStackResult::Accepted { .. })),
            "removed" => assert!(matches!(recovered.result, PrStackResult::Refused { .. })),
            _ => assert_eq!(
                recovered.result,
                PrStackResult::Completed {
                    outcome: PrStackOutcome::Merged
                }
            ),
        }
        assert_eq!(stack_writes(&f).len(), 1);
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn stack_known_queue_acceptance_survives_failed_and_malformed_read_only_reconciliation() {
    for mode in ["error", "missing-entry"] {
        let f = Fixture::new();
        let mut state = action_state();
        state["stackMergeResponses"] = json!([{"status":"enqueued","details":{}}]);
        f.state(state);
        let (app, thread) = f.open().await;
        let (access, input) = stack_input(
            &f,
            &app,
            &thread,
            PrStackAction::Merge {
                method: MergeMethod::Squash,
            },
        )
        .await;
        let accepted = app
            .change_pull_request_stack(access.clone(), input.clone())
            .await
            .unwrap();
        let mut state = action_state();
        state["stackQueueMode"] = json!(mode);
        f.state(state);
        assert!(
            app.reconcile_pull_request_stack(
                access.clone(),
                input.target.key.clone(),
                input.request_id.clone()
            )
            .await
            .is_err()
        );
        assert_eq!(
            app.pull_request_stack_operations(access.clone(), input.target.key.clone())
                .await
                .unwrap()[0]
                .result,
            accepted.result
        );
        let mut state = action_state();
        state["stackQueueState"] = json!({"41":"MERGED","42":"MERGED"});
        f.state(state);
        assert_eq!(
            app.reconcile_pull_request_stack(access.clone(), input.target.key, input.request_id)
                .await
                .unwrap()
                .result,
            PrStackResult::Completed {
                outcome: PrStackOutcome::Merged
            }
        );
        assert_eq!(stack_writes(&f).len(), 1);
        app.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn stack_known_acceptance_survives_receipt_storage_failure_and_reconciles_without_resending()
{
    let f = Fixture::new();
    let mut state = action_state();
    state["stackMergeResponses"] = json!([{"status":"enqueued","details":{}}]);
    state["waitFor"] = json!({"/merge-async:42":f.dir.path().join("release-merge")});
    f.state(state);
    let (app, thread) = f.open().await;
    let (access, input) = stack_input(
        &f,
        &app,
        &thread,
        PrStackAction::Merge {
            method: MergeMethod::Squash,
        },
    )
    .await;
    let storage_failure = async {
        f.wait_for("/merge-async").await;
        let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
        db.execute_batch("CREATE TRIGGER reject_stack_receipt_update BEFORE UPDATE ON pull_request_stack_operations BEGIN SELECT RAISE(FAIL,'fixture saved receipt unavailable'); END;").unwrap();
        std::fs::write(f.dir.path().join("release-merge"), "").unwrap();
    };
    let (result, ()) = tokio::join!(
        app.change_pull_request_stack(access.clone(), input.clone()),
        storage_failure
    );
    assert!(result.is_err());
    let pending = app
        .pull_request_stack_operations(access.clone(), input.target.key.clone())
        .await
        .unwrap();
    assert_eq!(
        pending[0].result,
        PrStackResult::Accepted {
            outcome: PrStackOutcome::Enqueued
        }
    );
    let db = rusqlite::Connection::open(f.config.data_dir.join("z1.sqlite")).unwrap();
    db.execute_batch("DROP TRIGGER reject_stack_receipt_update;")
        .unwrap();
    drop(db);
    let mut state = action_state();
    state["stackQueueState"] = json!({"41":"MERGED","42":"MERGED"});
    f.state(state);
    let result = app
        .reconcile_pull_request_stack(access, input.target.key, input.request_id)
        .await
        .unwrap();
    assert_eq!(
        result.result,
        PrStackResult::Completed {
            outcome: PrStackOutcome::Merged
        }
    );
    assert_eq!(stack_writes(&f).len(), 1);
    app.shutdown().await.unwrap();
}
