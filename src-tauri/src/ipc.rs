use bot_core::*;
use tauri::{State, ipc::Channel};
#[tauri::command]
pub async fn list_workspaces(app: State<'_, App>) -> Result<Vec<Workspace>> {
    app.list_workspaces().await
}
#[tauri::command]
pub async fn open_workspace(app: State<'_, App>, path: String) -> Result<Workspace> {
    app.open_workspace(path.into()).await
}
#[tauri::command]
pub async fn rename_workspace(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    label: String,
) -> Result<Workspace> {
    app.rename_workspace(workspace_id, label).await
}
#[tauri::command]
pub async fn remove_workspace(app: State<'_, App>, workspace_id: WorkspaceId) -> Result<()> {
    app.remove_workspace(workspace_id).await
}
#[tauri::command]
pub fn scratch_available(app: State<'_, App>) -> bool {
    app.scratch_available()
}
#[tauri::command]
pub async fn ensure_scratch(app: State<'_, App>) -> Result<Workspace> {
    app.ensure_scratch().await
}
#[tauri::command]
pub async fn workspace_view(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
) -> Result<WorkspaceView> {
    app.workspace_view(workspace_id, thread_id).await
}
#[tauri::command]
pub async fn read_file(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    path: String,
) -> Result<FileView> {
    app.read_file(workspace_id, thread_id, path).await
}
#[tauri::command]
pub async fn read_diff(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    path: String,
    basis: DiffBasis,
) -> Result<DiffView> {
    app.read_diff(workspace_id, thread_id, path, basis).await
}
#[tauri::command]
pub async fn list_branches(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
) -> Result<Branches> {
    app.list_branches(workspace_id, thread_id).await
}
#[tauri::command]
pub async fn switch_branch(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    branch: String,
    create: bool,
) -> Result<()> {
    app.switch_branch(workspace_id, thread_id, branch, create)
        .await
}
#[tauri::command]
pub async fn git_status(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
) -> Result<GitStatus> {
    app.git_status(workspace_id, thread_id).await
}
#[tauri::command]
pub async fn current_branch_pull_request(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    branch: String,
) -> Result<PrLookup> {
    app.current_branch_pull_request(workspace_id, thread_id, branch)
        .await
}
#[tauri::command]
pub async fn read_pull_request(
    app: State<'_, App>,
    thread_id: ThreadId,
    key: PullRequestKey,
) -> Result<PrReviewDetail> {
    app.read_pull_request(thread_id, key).await
}
#[tauri::command]
pub async fn change_pull_request(
    app: State<'_, App>,
    thread_id: ThreadId,
    input: PrReviewChange,
) -> Result<PrChangeResult> {
    app.change_pull_request(thread_id, input).await
}
#[tauri::command]
pub async fn pull_request_operations(
    app: State<'_, App>,
    thread_id: ThreadId,
    key: PullRequestKey,
) -> Result<Vec<PrOperation>> {
    app.pull_request_operations(thread_id, key).await
}
#[tauri::command]
pub async fn reconcile_pull_request(
    app: State<'_, App>,
    thread_id: ThreadId,
    key: PullRequestKey,
    request_id: String,
) -> Result<PrChangeResult> {
    app.reconcile_pull_request(thread_id, key, request_id).await
}
#[tauri::command]
pub async fn set_review_disposition(
    app: State<'_, App>,
    thread_id: ThreadId,
    key: PullRequestKey,
    input: SetReviewDisposition,
) -> Result<Option<SavedDisposition>> {
    app.set_review_disposition(thread_id, key, input).await
}
#[tauri::command]
pub async fn run_git_action(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    origin_thread_id: ThreadId,
    action: GitAction,
    on_progress: Channel<GitPhase>,
) -> Result<GitOutcome> {
    app.run_git_action(workspace_id, Some(origin_thread_id), action, move |phase| {
        let _ = on_progress.send(phase);
    })
    .await
}
#[tauri::command]
pub fn open_url(url: String) -> Result<()> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(AppError::new(
            "invalid_url",
            "Only web links can be opened.",
        ));
    }
    let status = std::process::Command::new("/usr/bin/open")
        .arg(&url)
        .status()?;
    if !status.success() {
        return Err(AppError::new(
            "open_failed",
            format!("Could not open {url}."),
        ));
    }
    Ok(())
}
#[tauri::command]
pub async fn create_thread(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    checkout: NewCheckout,
) -> Result<ThreadSnapshot> {
    app.create_thread(workspace_id, checkout).await
}
#[tauri::command]
pub async fn thread_snapshot(app: State<'_, App>, thread_id: ThreadId) -> Result<ThreadSnapshot> {
    app.thread(thread_id).await
}
#[tauri::command]
pub async fn open_thread(app: State<'_, App>, thread_id: ThreadId) -> Result<ThreadSnapshot> {
    app.open_thread(thread_id).await
}
#[tauri::command]
pub async fn submit(
    app: State<'_, App>,
    thread_id: ThreadId,
    request_id: String,
    text: String,
) -> Result<Receipt> {
    app.submit(thread_id, request_id, text).await
}
#[tauri::command]
pub async fn answer_approval(
    app: State<'_, App>,
    approval_id: ApprovalId,
    decision: ApprovalDecision,
) -> Result<()> {
    app.answer_approval(approval_id, decision).await
}
#[tauri::command]
pub async fn interrupt(app: State<'_, App>, thread_id: ThreadId) -> Result<()> {
    app.interrupt(thread_id).await
}
#[tauri::command]
pub async fn arrange_thread(
    app: State<'_, App>,
    thread_id: ThreadId,
    action: Arrange,
) -> Result<()> {
    app.arrange(thread_id, action).await
}
#[tauri::command]
pub async fn list_models(app: State<'_, App>) -> Result<Vec<ModelOption>> {
    app.models().await
}
#[tauri::command]
pub async fn usage_limits(app: State<'_, App>, refresh: bool) -> Result<UsageLimits> {
    app.usage_limits(refresh).await
}
#[tauri::command]
pub async fn update_thread_settings(
    app: State<'_, App>,
    thread_id: ThreadId,
    settings: SessionSettings,
) -> Result<ThreadSnapshot> {
    app.update_settings(thread_id, settings).await
}
#[tauri::command]
pub async fn ui_state(app: State<'_, App>) -> Result<std::collections::BTreeMap<String, String>> {
    app.ui_state().await
}
#[tauri::command]
pub async fn set_ui_state(app: State<'_, App>, key: String, value: Option<String>) -> Result<()> {
    app.set_ui_state(key, value).await
}
#[tauri::command]
pub async fn settings(app: State<'_, App>) -> Result<Option<String>> {
    app.settings()
}
#[tauri::command]
pub async fn save_settings(app: State<'_, App>, text: String) -> Result<()> {
    app.save_settings(&text).await
}

#[tauri::command]
pub async fn list_thread_pull_requests(
    app: State<'_, App>,
    thread_id: ThreadId,
    refresh: bool,
) -> Result<ThreadPrSummary> {
    app.list_thread_pull_requests(thread_id, refresh).await
}
#[tauri::command]
pub async fn link_pull_request(
    app: State<'_, App>,
    thread_id: ThreadId,
    url: String,
) -> Result<ThreadPrSummary> {
    app.link_pull_request(thread_id, url).await
}
#[tauri::command]
pub async fn unlink_pull_request(
    app: State<'_, App>,
    thread_id: ThreadId,
    key: PullRequestKey,
) -> Result<ThreadPrSummary> {
    app.unlink_pull_request(thread_id, key).await
}

#[tauri::command]
pub async fn acknowledge_uncertain_update(
    app: State<'_, App>,
    thread_id: ThreadId,
    input: AcknowledgeUncertainUpdate,
) -> Result<PrChangeResult> {
    app.acknowledge_uncertain_update(thread_id, input).await
}
#[tauri::command]
pub async fn terminal_attach(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    terminal_id: TerminalId,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<u64> {
    app.terminal_attach(
        workspace_id,
        thread_id,
        terminal_id,
        cols,
        rows,
        move |event| {
            let _ = on_event.send(event);
        },
    )
    .await
}
#[tauri::command]
pub fn terminal_detach(app: State<'_, App>, subscription: u64) {
    app.terminal_detach(subscription)
}
#[tauri::command]
pub async fn terminal_write(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    terminal_id: TerminalId,
    data: String,
) -> Result<()> {
    app.terminal_write(workspace_id, thread_id, terminal_id, data)
        .await
}
#[tauri::command]
pub fn terminal_resize(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    terminal_id: TerminalId,
    cols: u16,
    rows: u16,
) -> Result<()> {
    app.terminal_resize(workspace_id, thread_id, terminal_id, cols, rows)
}
#[tauri::command]
pub async fn terminal_close(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    terminal_id: TerminalId,
) -> Result<()> {
    app.terminal_close(workspace_id, thread_id, terminal_id)
        .await
}
