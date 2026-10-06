mod ipc;
use tauri::{Emitter, Manager};
use z1_core::{App, RuntimeConfig};
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let runtime =
                tauri::async_runtime::block_on(App::open(RuntimeConfig::from_environment()?))?;
            let mut changes = runtime.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match changes.recv().await {
                        Ok(change) => {
                            let _ = handle.emit("z1:changed", change);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            let _ = handle.emit("z1:refresh", ());
                        }
                        Err(_) => break,
                    }
                }
            });
            let mut limits = runtime.watch_usage_limits();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while limits.changed().await.is_ok() {
                    let value = limits.borrow_and_update().clone();
                    if let Some(value) = value {
                        let _ = handle.emit("z1:usage-limits", value);
                    }
                }
            });
            app.manage(runtime);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::list_workspaces,
            ipc::open_workspace,
            ipc::rename_workspace,
            ipc::remove_workspace,
            ipc::scratch_available,
            ipc::ensure_scratch,
            ipc::workspace_view,
            ipc::read_file,
            ipc::read_diff,
            ipc::list_branches,
            ipc::switch_branch,
            ipc::git_status,
            ipc::current_branch_pull_request,
            ipc::list_thread_pull_requests,
            ipc::link_pull_request,
            ipc::unlink_pull_request,
            ipc::read_pull_request,
            ipc::change_pull_request,
            ipc::reconcile_pull_request,
            ipc::acknowledge_uncertain_update,
            ipc::pull_request_operations,
            ipc::set_review_disposition,
            ipc::run_git_action,
            ipc::open_url,
            ipc::create_thread,
            ipc::thread_snapshot,
            ipc::open_thread,
            ipc::submit,
            ipc::list_models,
            ipc::usage_limits,
            ipc::update_thread_settings,
            ipc::answer_approval,
            ipc::interrupt,
            ipc::arrange_thread,
            ipc::ui_state,
            ipc::set_ui_state,
            ipc::settings,
            ipc::save_settings,
            ipc::terminal_attach,
            ipc::terminal_detach,
            ipc::terminal_write,
            ipc::terminal_resize,
            ipc::terminal_close
        ])
        .build(tauri::generate_context!())
        .expect("Z1 Code could not start");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let runtime = handle.state::<App>();
            let _ = tauri::async_runtime::block_on(runtime.shutdown());
        }
    });
}
