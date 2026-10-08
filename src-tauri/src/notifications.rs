use bot_core::{App, ThreadId, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, State};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationTarget {
    workspace_id: WorkspaceId,
    thread_id: ThreadId,
}
#[derive(Default)]
pub struct NotificationActions(Mutex<Vec<NotificationTarget>>);

#[tauri::command]
pub async fn notification_actions(
    app: State<'_, App>,
    actions: State<'_, NotificationActions>,
) -> bot_core::Result<Vec<NotificationTarget>> {
    let queued = std::mem::take(&mut *actions.0.lock().expect("notification action lock"));
    let mut targets = Vec::new();
    for target in queued {
        if app
            .thread(target.thread_id.clone())
            .await
            .is_ok_and(|thread| thread.workspace_id == target.workspace_id)
        {
            targets.push(target);
        }
    }
    Ok(targets)
}

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) {
    use tauri::{Emitter, EventTarget, Manager};
    use tauri_plugin_notification::NotificationExt;
    let handle = app.clone();
    app.notification().on_action(move |notification| {
        let target = notification
            .extra("botThread")
            .and_then(|value| serde_json::from_value::<NotificationTarget>(value.clone()).ok());
        let handle = handle.clone();
        let main = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if let Some(window) = main.get_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(target) = target {
                main.state::<NotificationActions>()
                    .0
                    .lock()
                    .expect("notification action lock")
                    .push(target);
                let _ = main.emit_to(EventTarget::webview("main"), "bot:notification-open", ());
            }
        });
    });
}
#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) {}
