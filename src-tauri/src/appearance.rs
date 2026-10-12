use bot_core::{AppError, Result};

/// Installed font families for the Appearance font picker. A synchronous
/// command runs on the main thread, which NSFontManager requires.
#[tauri::command]
pub fn installed_font_families() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSFontManager;
        let Some(mtm) = MainThreadMarker::new() else {
            return Vec::new();
        };
        let names = NSFontManager::sharedFontManager(mtm).availableFontFamilies();
        normalize_font_families(names.iter().map(|name| name.to_string()))
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

/// Saves an exported theme through the native save panel and reports whether
/// the user saved. The chosen path never reaches the webview. A Blob
/// download cannot replace this: wry cancels download navigations because
/// Bot Code registers no download handler.
#[tauri::command]
pub async fn export_theme_file(
    window: tauri::WebviewWindow,
    default_name: String,
    contents: String,
) -> Result<bool> {
    use tauri_plugin_dialog::DialogExt;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(default_name)
        .add_filter("JSON", &["json"])
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver
        .await
        .map_err(|error| AppError::new("export_theme", error))?
    else {
        return Ok(false);
    };
    let path = path
        .into_path()
        .map_err(|error| AppError::new("export_theme", error))?;
    tokio::fs::write(path, contents).await?;
    Ok(true)
}

// Dot-prefixed families are macOS-internal UI faces that web content cannot
// render (T3 appearanceFonts.ts queryInstalledFontFamilies).
#[cfg(any(target_os = "macos", test))]
fn normalize_font_families(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut families: Vec<String> = names
        .into_iter()
        .filter(|name| !name.is_empty() && !name.starts_with('.'))
        .collect();
    families.sort_by(|left, right| {
        left.to_lowercase()
            .cmp(&right.to_lowercase())
            .then_with(|| left.cmp(right))
    });
    families.dedup();
    families
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_families_for_the_picker() {
        let names = [
            "menlo",
            ".SF NS",
            "Menlo",
            "Avenir",
            "",
            "Menlo",
            ".AppleSystemUIFont",
            "avenir Next",
        ]
        .map(String::from);
        assert_eq!(
            normalize_font_families(names),
            ["Avenir", "avenir Next", "Menlo", "menlo"]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn lists_installed_families_on_the_main_thread_only() {
        assert!(
            std::thread::spawn(installed_font_families)
                .join()
                .unwrap()
                .is_empty()
        );
    }
}
