use bot_core::{App, ThreadId, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State};

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

// Ported from pingdotgg/t3code v0.0.45 apps/desktop/src/ipc/methods/notificationBadge.ts (MIT).
fn focused(app: &AppHandle) -> bool {
    app.windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(false))
}

fn apply_badge(app: &AppHandle, count: u32, image: Option<Vec<u8>>) {
    let count = if focused(app) { 0 } else { count };
    #[cfg(windows)]
    {
        let overlay = image
            .filter(|rgba| count > 0 && rgba.len() == 64 * 64 * 4)
            .map(|rgba| tauri::image::Image::new_owned(rgba, 64, 64));
        for window in app.windows().values() {
            let _ = window.set_overlay_icon(overlay.clone());
        }
    }
    #[cfg(not(windows))]
    {
        let _ = image;
        if let Some(window) = app.get_window("main") {
            let _ = window.set_badge_count((count > 0).then_some(count.into()));
        }
    }
}

pub fn clear_badge(app: &AppHandle) {
    apply_badge(app, 0, None);
    let _ = app.emit_to(
        EventTarget::webview("main"),
        "bot:notification-badge-clear",
        (),
    );
}

#[tauri::command]
pub fn set_notification_badge(app: AppHandle, count: u32, image: Option<Vec<u8>>) {
    if count > 0 && focused(&app) {
        clear_badge(&app);
    } else {
        apply_badge(&app, count, image);
    }
}

#[tauri::command]
pub fn close_notifications(app: AppHandle, tags: Vec<String>) {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification().remove_delivered(&tags);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, tags);
}

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) {
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
