use bot_core::*;
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const DAY_MS: u64 = 86_400_000;
const INACTIVE_AFTER_THREE_DAYS: &str =
    r#"{"storageCleanup":{"worktreeAfterDays":3,"worktreeUnchanged":false}}"#;
const UNCHANGED_ONLY: &str =
    r#"{"storageCleanup":{"worktreeAfterDays":null,"worktreeUnchanged":true}}"#;

struct Fixture {
    _dir: tempfile::TempDir,
    config: RuntimeConfig,
    repository: PathBuf,
    peer: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repository = dir.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        git_output(&repository, &["init", "-q", "-b", "main"]);
        let peer = dir.path().join("peer.py");
        std::fs::write(&peer, include_str!("support/codex_peer.py")).unwrap();
        std::fs::set_permissions(&peer, std::fs::Permissions::from_mode(0o755)).unwrap();
        let f = Self {
            config: RuntimeConfig {
                data_dir: dir.path().join("state"),
                codex_binary: peer.clone(),
                gh_binary: dir.path().join("no-gh"),
                network_timeout: Duration::from_secs(180),
                shell: None,
            },
            _dir: dir,
            repository,
            peer,
        };
        std::fs::write(f.repository.join("README.md"), "fixture\n").unwrap();
        std::fs::write(f.repository.join(".gitignore"), "*.log\nnode_modules/\n").unwrap();
        git_output(&f.repository, &["add", "."]);
        commit(&f.repository, "initial");
        f
    }
    fn settings(&self, text: &str) {
        std::fs::create_dir_all(&self.config.data_dir).unwrap();
        std::fs::write(self.config.data_dir.join("settings.json"), text).unwrap();
    }
    fn calls(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.peer.parent().unwrap().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    fn worktree_listed(&self, path: &Path) -> bool {
        git_output(&self.repository, &["worktree", "list", "--porcelain"])
            .lines()
            .any(|line| line == format!("worktree {}", path.display()))
    }
    fn branch_exists(&self, branch: &str) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(&self.repository)
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ])
            .output()
            .unwrap()
            .status
            .success()
    }
    /// A bare origin whose HEAD is main, mirroring the fixture repository.
    fn add_origin(&self) {
        let origin = self.repository.with_file_name("origin.git");
        git_output(
            self.repository.parent().unwrap(),
            &["clone", "-q", "--bare", "repository", "origin.git"],
        );
        git_output(
            &self.repository,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        git_output(&self.repository, &["fetch", "-q", "origin"]);
        git_output(&self.repository, &["remote", "set-head", "origin", "main"]);
    }
}
fn git_output(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}
fn commit(root: &Path, message: &str) {
    git_output(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-qm",
            message,
        ],
    );
}
fn commit_file(root: &Path, file: &str) {
    std::fs::write(root.join(file), file).unwrap();
    git_output(root, &["add", file]);
    commit(root, file);
}
fn worktree(checkout: &Checkout) -> (PathBuf, String) {
    match checkout {
        Checkout::Worktree { path, branch } => (path.clone(), branch.clone()),
        other => panic!("expected a worktree checkout, got {other:?}"),
    }
}
async fn wait(
    app: &App,
    id: &ThreadId,
    predicate: impl Fn(&ThreadSnapshot) -> bool,
) -> ThreadSnapshot {
    for _ in 0..500 {
        let snapshot = app.thread(id.clone()).await.unwrap();
        if predicate(&snapshot) {
            return snapshot;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("Timed out awaiting public snapshot state")
}
async fn worktree_thread(app: &App, workspace: &WorkspaceId) -> ThreadSnapshot {
    app.create_thread(
        workspace.clone(),
        NewCheckout::Worktree {
            base: "main".into(),
            from_origin: false,
        },
    )
    .await
    .unwrap()
}
/// Submits one prompt and waits for it to complete, so the thread has activity.
async fn complete_turn(app: &App, thread: &ThreadSnapshot, prompt: &str) {
    app.submit(
        thread.id.clone(),
        format!("{}-{prompt}", thread.id),
        prompt.into(),
    )
    .await
    .unwrap();
    wait(app, &thread.id, |t| {
        t.turns
            .last()
            .is_some_and(|turn| matches!(turn.execution, Execution::Completed))
    })
    .await;
}
fn four_days_later() -> u64 {
    now_ms() + 4 * DAY_MS
}

#[tokio::test]
async fn inactive_clean_worktree_is_removed_and_its_branch_survives() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = worktree_thread(&app, &workspace.id).await;
    let (path, branch) = worktree(&thread.checkout);
    complete_turn(&app, &thread, "hello").await;
    let mut hints = app.subscribe();
    f.settings(INACTIVE_AFTER_THREE_DAYS);
    app.sweep_worktrees_at(now_ms() + 2 * DAY_MS).await;
    assert!(path.exists(), "two days is within the three-day window");
    app.sweep_worktrees_at(four_days_later()).await;
    assert!(!path.exists());
    assert!(!f.worktree_listed(&path));
    assert!(f.branch_exists(&branch));
    let after = app.thread(thread.id.clone()).await.unwrap();
    assert_eq!(after.checkout, thread.checkout);
    let mut refreshed = false;
    while let Ok(hint) = hints.try_recv() {
        refreshed |= hint.thread_id == thread.id && hint.refresh_workspace;
    }
    assert!(refreshed, "removal must tell open UIs to refetch");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn dirty_and_untracked_worktrees_are_kept() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let dirty = worktree_thread(&app, &workspace.id).await;
    let untracked = worktree_thread(&app, &workspace.id).await;
    for thread in [&dirty, &untracked] {
        complete_turn(&app, thread, "hello").await;
    }
    let (dirty_path, _) = worktree(&dirty.checkout);
    let (untracked_path, _) = worktree(&untracked.checkout);
    std::fs::write(dirty_path.join("README.md"), "edited\n").unwrap();
    std::fs::write(untracked_path.join("notes.txt"), "draft\n").unwrap();
    f.settings(INACTIVE_AFTER_THREE_DAYS);
    app.sweep_worktrees_at(four_days_later()).await;
    assert!(dirty_path.exists());
    assert!(untracked_path.exists());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn ignored_files_block_removal_unless_they_are_node_modules() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let secrets = worktree_thread(&app, &workspace.id).await;
    let installed = worktree_thread(&app, &workspace.id).await;
    for thread in [&secrets, &installed] {
        complete_turn(&app, thread, "hello").await;
    }
    let (secrets_path, _) = worktree(&secrets.checkout);
    let (installed_path, _) = worktree(&installed.checkout);
    std::fs::write(secrets_path.join("debug.log"), "token\n").unwrap();
    std::fs::create_dir_all(installed_path.join("node_modules/pkg")).unwrap();
    std::fs::write(installed_path.join("node_modules/pkg/index.js"), "").unwrap();
    f.settings(INACTIVE_AFTER_THREE_DAYS);
    app.sweep_worktrees_at(four_days_later()).await;
    assert!(
        secrets_path.exists(),
        "an ignored log file keeps the worktree"
    );
    assert!(
        !installed_path.exists(),
        "node_modules alone allows removal"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn unchanged_rule_removes_only_worktrees_without_commits_beyond_origin_default() {
    let f = Fixture::new();
    f.add_origin();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let ahead = worktree_thread(&app, &workspace.id).await;
    let unchanged = worktree_thread(&app, &workspace.id).await;
    let (ahead_path, ahead_branch) = worktree(&ahead.checkout);
    let (unchanged_path, unchanged_branch) = worktree(&unchanged.checkout);
    commit_file(&ahead_path, "feature.txt");
    f.settings(UNCHANGED_ONLY);
    app.sweep_worktrees_at(now_ms()).await;
    assert!(
        ahead_path.exists(),
        "commits beyond origin/main keep the worktree"
    );
    assert!(!unchanged_path.exists());
    assert!(f.branch_exists(&ahead_branch));
    assert!(f.branch_exists(&unchanged_branch));
    assert_eq!(
        app.thread(unchanged.id).await.unwrap().checkout,
        unchanged.checkout
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn running_threads_keep_their_worktree() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = worktree_thread(&app, &workspace.id).await;
    let (path, _) = worktree(&thread.checkout);
    app.submit(thread.id.clone(), "hold".into(), "hold".into())
        .await
        .unwrap();
    wait(&app, &thread.id, |t| {
        matches!(t.turns[0].execution, Execution::Running)
    })
    .await;
    f.settings(UNCHANGED_ONLY);
    app.sweep_worktrees_at(four_days_later()).await;
    assert!(path.exists());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_path_shared_with_another_thread_is_kept_until_that_thread_goes() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = worktree_thread(&app, &workspace.id).await;
    let (path, _) = worktree(&thread.checkout);
    // Opening the worktree as its own project gives a Local thread the same root.
    let nested = app.open_workspace(path.clone()).await.unwrap();
    assert_eq!(nested.root, path);
    app.create_thread(nested.id.clone(), NewCheckout::Local)
        .await
        .unwrap();
    f.settings(UNCHANGED_ONLY);
    app.sweep_worktrees_at(now_ms()).await;
    assert!(path.exists(), "two threads share this checkout");
    app.remove_workspace(nested.id).await.unwrap();
    app.sweep_worktrees_at(now_ms()).await;
    assert!(!path.exists(), "the sole remaining owner is eligible");
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn submit_restores_a_removed_worktree_before_the_turn_starts() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = worktree_thread(&app, &workspace.id).await;
    let (path, branch) = worktree(&thread.checkout);
    complete_turn(&app, &thread, "hello").await;
    f.settings(INACTIVE_AFTER_THREE_DAYS);
    app.sweep_worktrees_at(four_days_later()).await;
    assert!(!path.exists());
    complete_turn(&app, &thread, "again").await;
    assert!(path.exists());
    assert!(f.worktree_listed(&path));
    assert_eq!(git_output(&path, &["branch", "--show-current"]), branch);
    let resumed: Vec<String> = f
        .calls()
        .into_iter()
        .filter(|call| call["method"] == "thread/resume")
        .map(|call| call["params"]["cwd"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(resumed, vec![path.to_string_lossy().into_owned()]);
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().checkout,
        thread.checkout
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_restore_that_cannot_succeed_refuses_without_starting_a_turn() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = worktree_thread(&app, &workspace.id).await;
    let (path, branch) = worktree(&thread.checkout);
    complete_turn(&app, &thread, "hello").await;
    f.settings(INACTIVE_AFTER_THREE_DAYS);
    app.sweep_worktrees_at(four_days_later()).await;
    assert!(!path.exists());
    git_output(&f.repository, &["branch", "-D", &branch]);
    let error = app
        .submit(thread.id.clone(), "retry".into(), "again".into())
        .await
        .unwrap_err();
    assert_eq!(error.code, "worktree_restore");
    assert!(
        error
            .message
            .starts_with("Couldn't restore this thread's worktree: "),
        "{}",
        error.message
    );
    assert!(!path.exists());
    let after = app.thread(thread.id.clone()).await.unwrap();
    assert_eq!(after.turns.len(), 1);
    assert_eq!(after.session, SessionState::Ready);
    assert_eq!(
        f.calls()
            .iter()
            .filter(|call| call["method"] == "turn/start")
            .count(),
        1
    );
    // The failed restore released its hold, so recreating the branch lets the next submit succeed.
    git_output(&f.repository, &["branch", &branch, "main"]);
    complete_turn(&app, &thread, "again").await;
    assert!(path.exists());
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn removed_threads_degrade_to_unavailable_views_and_refuse_switches() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = worktree_thread(&app, &workspace.id).await;
    let (path, branch) = worktree(&thread.checkout);
    complete_turn(&app, &thread, "hello").await;
    f.settings(INACTIVE_AFTER_THREE_DAYS);
    app.sweep_worktrees_at(four_days_later()).await;
    assert!(!path.exists());
    app.shutdown().await.unwrap();
    let app = App::open(f.config.clone()).await.unwrap();
    let opened = app.open_thread(thread.id.clone()).await.unwrap();
    assert_eq!(opened.session, SessionState::Dormant);
    assert_eq!(
        opened.diagnostic, None,
        "the shutdown notice must not outlive the skipped resume"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        app.thread(thread.id.clone()).await.unwrap().session,
        SessionState::Dormant,
        "opening a removed thread must not resume Codex in a missing cwd"
    );
    let view = app
        .workspace_view(workspace.id.clone(), Some(thread.id.clone()))
        .await
        .unwrap();
    assert_eq!(view.unavailable.as_deref(), Some(WORKTREE_REMOVED));
    assert_eq!(view.branch, branch);
    assert!(view.files.is_empty());
    assert!(view.changes.is_empty());
    let file = app
        .read_file(
            workspace.id.clone(),
            Some(thread.id.clone()),
            "README.md".into(),
        )
        .await
        .unwrap();
    assert!(matches!(file, FileView::Unavailable { reason } if reason == WORKTREE_REMOVED));
    let diff = app
        .read_diff(
            workspace.id.clone(),
            Some(thread.id.clone()),
            "README.md".into(),
            DiffBasis::Unstaged,
        )
        .await
        .unwrap();
    assert!(matches!(diff, DiffView::Unavailable { reason } if reason == WORKTREE_REMOVED));
    let branches = app
        .list_branches(workspace.id.clone(), Some(thread.id.clone()))
        .await
        .unwrap();
    let current: Vec<&str> = branches
        .branches
        .iter()
        .filter(|b| b.current)
        .map(|b| b.name.as_str())
        .collect();
    assert_eq!(current, vec![branch.as_str()]);
    assert!(branches.branches.iter().any(|b| b.name == "main"));
    assert_eq!(
        app.switch_branch(
            workspace.id.clone(),
            Some(thread.id.clone()),
            "main".into(),
            false
        )
        .await
        .unwrap_err()
        .code,
        "worktree_removed"
    );
    assert!(
        !f.calls()
            .iter()
            .any(|call| call["method"] == "thread/resume")
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn malformed_settings_disable_each_rule_independently() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = worktree_thread(&app, &workspace.id).await;
    let (path, _) = worktree(&thread.checkout);
    complete_turn(&app, &thread, "hello").await;
    let settings_file = f.config.data_dir.join("settings.json");
    let _ = std::fs::remove_file(&settings_file);
    app.sweep_worktrees_at(four_days_later()).await;
    assert!(path.exists(), "no settings file");
    for (text, label) in [
        ("garbage", "unparseable file"),
        (
            r#"{"storageCleanup": 5}"#,
            "storageCleanup is not an object",
        ),
        (
            r#"{"storageCleanup": {"worktreeAfterDays": "8", "worktreeUnchanged": "yes"}}"#,
            "string values",
        ),
        (
            r#"{"storageCleanup": {"worktreeAfterDays": 0, "worktreeUnchanged": false}}"#,
            "days below range",
        ),
        (
            r#"{"storageCleanup": {"worktreeAfterDays": 3651, "worktreeUnchanged": false}}"#,
            "days above range",
        ),
        (
            r#"{"storageCleanup": {"worktreeAfterDays": 2.5, "worktreeUnchanged": null}}"#,
            "fractional days",
        ),
        (
            r#"{"storageCleanup": {"worktreeAfterDays": null, "worktreeUnchanged": false}}"#,
            "both rules off",
        ),
    ] {
        f.settings(text);
        app.sweep_worktrees_at(four_days_later()).await;
        assert!(path.exists(), "{label} must keep the worktree");
    }
    f.settings(r#"{"storageCleanup": {"worktreeAfterDays": "8", "worktreeUnchanged": true}}"#);
    app.sweep_worktrees_at(now_ms()).await;
    assert!(
        !path.exists(),
        "an invalid days value still lets the unchanged rule apply"
    );
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn saving_settings_triggers_a_sweep() {
    let f = Fixture::new();
    let app = App::open(f.config.clone()).await.unwrap();
    let workspace = app.open_workspace(f.repository.clone()).await.unwrap();
    let thread = worktree_thread(&app, &workspace.id).await;
    let (path, _) = worktree(&thread.checkout);
    app.save_settings(UNCHANGED_ONLY).await.unwrap();
    for _ in 0..500 {
        if !path.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!path.exists(), "a settings save must start a sweep");
    app.shutdown().await.unwrap();
}
