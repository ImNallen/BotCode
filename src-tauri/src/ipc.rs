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
pub async fn search_paths(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    caller: String,
    sequence: u64,
    input: PathSearchInput,
) -> Result<PathSearchResult> {
    app.search_paths(workspace_id, thread_id, caller, sequence, input)
        .await
}
#[tauri::command]
pub async fn search_contents(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    caller: String,
    sequence: u64,
    input: ContentSearchInput,
) -> Result<ContentSearchResult> {
    app.search_contents(workspace_id, thread_id, caller, sequence, input)
        .await
}
#[tauri::command]
pub fn cancel_project_search(app: State<'_, App>, caller: String, sequence: u64) {
    app.cancel_project_search(caller, sequence);
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
pub async fn write_file(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    path: String,
    contents: String,
) -> Result<()> {
    app.write_file(workspace_id, thread_id, path, contents)
        .await
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
pub async fn read_turn_diff(
    app: State<'_, App>,
    thread_id: ThreadId,
    turn_id: TurnId,
    path: String,
) -> Result<TurnDiffView> {
    app.read_turn_diff(thread_id, turn_id, path).await
}
#[tauri::command]
pub async fn revert_thread(
    app: State<'_, App>,
    thread_id: ThreadId,
    request_id: String,
    turn_id: TurnId,
    files: bool,
) -> Result<ThreadSnapshot> {
    app.revert_thread(thread_id, request_id, turn_id, files)
        .await
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
pub async fn begin_commit_message(
    app: State<'_, App>,
    thread_id: ThreadId,
    selection: CommitSelection,
) -> Result<String> {
    app.begin_commit_message(thread_id, selection).await
}
#[tauri::command]
pub async fn await_commit_message(app: State<'_, App>, job: String) -> Result<String> {
    app.await_commit_message(job).await
}
#[tauri::command]
pub async fn cancel_commit_message(app: State<'_, App>, job: String) -> Result<()> {
    app.cancel_commit_message(job).await
}
#[tauri::command]
pub async fn run_git_action(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    origin_thread_id: ThreadId,
    action: GitAction,
    on_progress: Channel<GitProgress>,
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
#[tauri::command(async)]
pub fn available_editors() -> Vec<EditorId> {
    bot_core::available_editors()
}
#[tauri::command]
pub async fn open_in_editor(
    app: State<'_, App>,
    target: OpenTarget,
    editor: EditorId,
    position: Option<Position>,
) -> Result<()> {
    app.open_in_editor(target, editor, position).await
}
#[tauri::command]
pub async fn reveal_in_finder(app: State<'_, App>, target: OpenTarget) -> Result<()> {
    app.reveal_in_finder(target).await
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
// Ported from T3 Code v0.0.45 apps/server/src/attachmentStore.ts.
#[tauri::command]
pub async fn stage_attachment(
    app: State<'_, App>,
    request: tauri::ipc::Request<'_>,
) -> Result<Attachment> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::new(
            "invalid_request",
            "Expected the attachment bytes.",
        ));
    };
    let name = request
        .headers()
        .get("x-attachment-name")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            percent_encoding::percent_decode_str(value)
                .decode_utf8()
                .ok()
        })
        .unwrap_or_default()
        .into_owned();
    let header = |key| {
        request
            .headers()
            .get(key)
            .and_then(|value| value.to_str().ok())
    };
    let kind = match header("x-attachment-kind") {
        None | Some("image") => AttachmentKind::Image,
        Some("file") => AttachmentKind::File {
            mime_type: header("x-attachment-mime")
                .unwrap_or("application/octet-stream")
                .into(),
            source: match header("x-attachment-source") {
                None => None,
                Some("pasted-text") => Some(AttachmentSource::PastedText),
                _ => {
                    return Err(AppError::new(
                        "invalid_attachment",
                        "Invalid attachment source.",
                    ));
                }
            },
        },
        _ => {
            return Err(AppError::new(
                "invalid_attachment",
                "Invalid attachment kind.",
            ));
        }
    };
    if matches!(kind, AttachmentKind::Image) && bytes.len() > 10 * 1024 * 1024 {
        return Err(AppError::new(
            "image_too_large",
            format!("'{name}' is too large to attach, even after compression."),
        ));
    }
    if bytes.len() > 50 * 1024 * 1024 {
        return Err(bot_core::AppError::new(
            "file_too_large",
            format!("'{name}' exceeds the 50 MB attachment limit."),
        ));
    }
    app.stage_attachment(name, bytes.clone(), kind).await
}
#[tauri::command]
pub async fn submit(
    app: State<'_, App>,
    thread_id: ThreadId,
    request_id: String,
    text: String,
    attachments: Vec<Attachment>,
    context: Option<MessageContext>,
    expected_turn_id: Option<TurnId>,
) -> Result<Receipt> {
    app.submit_with_context(
        thread_id,
        request_id,
        text,
        attachments,
        context,
        expected_turn_id,
    )
    .await
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
pub async fn list_skills(app: State<'_, App>, cwd: String) -> Result<Vec<Skill>> {
    Ok(app.list_skills(cwd.into()).await)
}
#[tauri::command]
pub async fn collaboration_modes(app: State<'_, App>) -> Result<Vec<InteractionMode>> {
    app.collaboration_modes().await
}
#[tauri::command]
pub async fn answer_user_questions(
    app: State<'_, App>,
    request_id: UserQuestionRequestId,
    answers: UserQuestionAnswers,
) -> Result<()> {
    app.answer_user_questions(request_id, answers).await
}
#[tauri::command]
pub async fn usage_history(
    app: State<'_, App>,
    request: UsageHistoryRequest,
) -> Result<UsageHistoryReport> {
    app.usage_history(request).await
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
pub fn clipboard_text() -> Result<Option<String>> {
    let clipboard_error =
        |error: arboard::Error| AppError::new("clipboard_unavailable", error.to_string());
    let mut clipboard = arboard::Clipboard::new().map_err(clipboard_error)?;
    match clipboard.get_text() {
        Ok(text) => Ok(Some(text)),
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(error) => Err(clipboard_error(error)),
    }
}
#[tauri::command]
pub async fn settings(app: State<'_, App>) -> Result<Option<String>> {
    app.settings()
}
#[tauri::command]
pub async fn keybindings_file(app: State<'_, App>) -> Result<bot_core::KeybindingsFile> {
    app.keybindings_file()
}
#[tauri::command]
pub async fn save_keybindings_file(
    app: State<'_, App>,
    text: String,
    expected_text: Option<String>,
) -> Result<()> {
    app.save_keybindings_file(&text, expected_text.as_deref())
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

#[tauri::command]
pub async fn rename_thread(
    app: State<'_, App>,
    thread_id: ThreadId,
    title: String,
) -> Result<ThreadSnapshot> {
    app.rename_thread(thread_id, title).await
}
#[tauri::command]
pub async fn delete_thread(app: State<'_, App>, thread_id: ThreadId) -> Result<DeletedWorktree> {
    app.delete_thread(thread_id).await
}

#[tauri::command]
pub async fn list_thread_summaries(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
) -> Result<Vec<ThreadSummary>> {
    app.list_thread_summaries(workspace_id).await
}

#[tauri::command]
pub async fn project_config(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
) -> Result<ProjectConfig> {
    app.project_config(workspace_id).await
}
#[tauri::command]
pub async fn retry_worktree_setup(
    app: State<'_, App>,
    thread_id: ThreadId,
) -> Result<ThreadSnapshot> {
    app.retry_worktree_setup(thread_id).await
}
#[tauri::command]
pub async fn run_project_script(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    script_id: String,
    terminal_id: TerminalId,
) -> Result<()> {
    app.run_project_script(workspace_id, thread_id, script_id, terminal_id)
        .await
}
#[tauri::command]
pub async fn search_composer_pull_requests(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    thread_id: Option<ThreadId>,
    query: String,
) -> Result<Vec<PullRequestContextMetadata>> {
    app.search_composer_pull_requests(workspace_id, thread_id, query)
        .await
}

#[tauri::command]
pub fn provider_capabilities(app: State<'_, App>) -> ProviderCapabilities {
    app.provider_capabilities()
}

#[tauri::command]
pub async fn search_thread_messages(
    app: State<'_, App>,
    query: String,
) -> Result<ThreadMessageSearch> {
    app.search_thread_messages(query).await
}

#[tauri::command]
pub async fn list_worktrees(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
) -> Result<Vec<RegisteredWorktree>> {
    app.list_worktrees(workspace_id).await
}
#[tauri::command]
pub async fn prepare_pull_request_thread(
    app: State<'_, App>,
    input: PreparePullRequestThread,
) -> Result<ThreadSnapshot> {
    app.prepare_pull_request_thread(input).await
}
