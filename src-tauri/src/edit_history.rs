//! Tauri's default macOS menu binds Cmd+Z and Shift+Cmd+Z to the native `undo:` and `redo:`
//! responder actions. AppKit fires those before WKWebView dispatches a keydown, so editors that
//! undo from keydown (pierre) never see the shortcut.
//!
//! `get_webview_window("main")` is unusable here: it returns `None` as soon as the window holds a
//! webview with another label.
use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind};
use tauri::{AppHandle, Manager, Runtime, Webview};

struct HistoryItem {
    command: &'static str,
    label: &'static str,
    id: &'static str,
    accelerator: &'static str,
}

const ITEMS: [HistoryItem; 2] = [
    HistoryItem {
        command: "undo",
        label: "Undo",
        id: "edit-history-undo",
        accelerator: "CmdOrCtrl+Z",
    },
    HistoryItem {
        command: "redo",
        label: "Redo",
        id: "edit-history-redo",
        accelerator: "CmdOrCtrl+Shift+Z",
    },
];

pub fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    for entry in menu.items()? {
        let MenuItemKind::Submenu(submenu) = entry else {
            continue;
        };
        if submenu.text()? != "Edit" {
            continue;
        }
        for (position, child) in submenu.items()?.into_iter().enumerate() {
            let MenuItemKind::Predefined(predefined) = &child else {
                continue;
            };
            let text = predefined.text()?;
            let Some(item) = ITEMS.iter().find(|item| item.label == text) else {
                continue;
            };
            let replacement =
                MenuItem::with_id(app, item.id, item.label, true, Some(item.accelerator))?;
            submenu.remove(&child)?;
            submenu.insert(&replacement, position)?;
        }
    }
    Ok(menu)
}

pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let Some(item) = ITEMS.iter().find(|item| event.id().as_ref() == item.id) else {
        return;
    };
    let script = format!("({})({:?})", include_str!("edit_history.js"), item.command);
    for webview in main_window_webviews(app) {
        let _ = webview.eval(&script);
    }
}

fn main_window_webviews<R: Runtime>(app: &AppHandle<R>) -> Vec<Webview<R>> {
    app.get_window("main")
        .map(|window| window.webviews())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use tauri::test::mock_app;
    use tauri::webview::WebviewBuilder;
    use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

    use super::main_window_webviews;

    #[test]
    fn selects_the_app_webview_and_every_preview_child_of_the_main_window() {
        let app = mock_app();
        WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        WebviewWindowBuilder::new(&app, "other", WebviewUrl::default())
            .build()
            .unwrap();
        let preview = WebviewBuilder::new(
            "preview-0",
            WebviewUrl::External("https://example.test/".parse().unwrap()),
        );
        app.get_window("main")
            .unwrap()
            .add_child(
                preview,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
            )
            .unwrap();

        let mut labels: Vec<String> = main_window_webviews(app.handle())
            .iter()
            .map(|webview| webview.label().to_owned())
            .collect();
        labels.sort();
        assert_eq!(labels, ["main", "preview-0"]);
    }
}
