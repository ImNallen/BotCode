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
            app.manage(runtime);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::list_workspaces,
            ipc::open_workspace,
            ipc::workspace_view,
            ipc::read_file,
            ipc::read_diff,
            ipc::list_branches,
            ipc::create_thread,
            ipc::thread_snapshot,
            ipc::open_thread,
            ipc::submit,
            ipc::list_models,
            ipc::update_thread_settings,
            ipc::answer_approval,
            ipc::interrupt
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
