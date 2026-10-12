use bot_core::{AppError, Result};

/// A synchronous command runs on the main thread, which NSFontManager requires.
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

/// A Blob download cannot replace the native save panel: wry cancels download
/// navigations because Bot Code registers no download handler.
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

const PICKED_THEME_FILE_MAX_BYTES: u64 = 256 * 1024;

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct PickedThemeFile {
    name: String,
    size: u64,
    text: String,
}

#[tauri::command]
pub async fn pick_theme_files(window: tauri::WebviewWindow) -> Result<Vec<PickedThemeFile>> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("JSON", &["json"]);
    if let Some(extensions) = std::env::home_dir()
        .map(|home| home.join(".vscode").join("extensions"))
        .filter(|path| path.is_dir())
    {
        dialog = dialog.set_directory(extensions);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.pick_files(move |paths| {
        let _ = sender.send(paths);
    });
    let paths = receiver
        .await
        .map_err(|error| AppError::new("pick_theme_files", error))?
        .unwrap_or_default();
    let paths = paths
        .into_iter()
        .map(|path| {
            path.into_path()
                .map_err(|error| AppError::new("pick_theme_files", error))
        })
        .collect::<Result<Vec<_>>>()?;
    tokio::task::spawn_blocking(move || {
        paths
            .iter()
            .map(|path| read_picked_theme_file(path))
            .collect()
    })
    .await
    .map_err(|error| AppError::new("pick_theme_files", error))
}

fn read_picked_theme_file(path: &std::path::Path) -> PickedThemeFile {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (size, text) = match std::fs::metadata(path).map(|metadata| metadata.len()) {
        Ok(size) if size > PICKED_THEME_FILE_MAX_BYTES => (size, String::new()),
        Ok(size) => {
            std::fs::read_to_string(path).map_or_else(|_| (0, String::new()), |text| (size, text))
        }
        Err(_) => (0, String::new()),
    };
    PickedThemeFile { name, size, text }
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

    #[test]
    fn reads_picked_theme_files_up_to_the_size_cap() {
        let dir = std::env::temp_dir().join(format!("bot-code-themes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let limit = PICKED_THEME_FILE_MAX_BYTES as usize;
        let at_limit = dir.join("at-limit.json");
        std::fs::write(&at_limit, "a".repeat(limit)).unwrap();
        let oversized = dir.join("oversized.json");
        std::fs::write(&oversized, "a".repeat(limit + 1)).unwrap();
        let not_utf8 = dir.join("binary.json");
        std::fs::write(&not_utf8, [0xff, 0xfe, 0x00]).unwrap();

        assert_eq!(
            read_picked_theme_file(&at_limit),
            PickedThemeFile {
                name: "at-limit.json".into(),
                size: limit as u64,
                text: "a".repeat(limit),
            }
        );
        assert_eq!(
            read_picked_theme_file(&oversized),
            PickedThemeFile {
                name: "oversized.json".into(),
                size: limit as u64 + 1,
                text: String::new(),
            }
        );
        for unreadable in [not_utf8, dir.join("missing.json")] {
            let picked = read_picked_theme_file(&unreadable);
            assert_eq!((picked.size, picked.text.as_str()), (0, ""));
        }
        std::fs::remove_dir_all(dir).unwrap();
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
