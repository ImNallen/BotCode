use tauri::State;
use z1_core::*;
#[tauri::command]
pub async fn list_workspaces(app: State<'_, App>) -> Result<Vec<Workspace>> {
    app.list_workspaces().await
}
#[tauri::command]
pub async fn open_workspace(app: State<'_, App>, path: String) -> Result<Workspace> {
    app.open_workspace(path.into()).await
}
#[tauri::command]
pub async fn workspace_view(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
) -> Result<WorkspaceView> {
    app.workspace_view(workspace_id).await
}
#[tauri::command]
pub async fn read_file(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    path: String,
) -> Result<FileView> {
    app.read_file(workspace_id, path).await
}
#[tauri::command]
pub async fn read_diff(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
    path: String,
    basis: DiffBasis,
) -> Result<DiffView> {
    app.read_diff(workspace_id, path, basis).await
}
#[tauri::command]
pub async fn create_thread(
    app: State<'_, App>,
    workspace_id: WorkspaceId,
) -> Result<ThreadSnapshot> {
    app.create_thread(workspace_id).await
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
pub async fn list_models(app: State<'_, App>) -> Result<Vec<ModelOption>> {
    app.models().await
}
#[tauri::command]
pub async fn update_thread_settings(
    app: State<'_, App>,
    thread_id: ThreadId,
    settings: SessionSettings,
) -> Result<ThreadSnapshot> {
    app.update_settings(thread_id, settings).await
}
