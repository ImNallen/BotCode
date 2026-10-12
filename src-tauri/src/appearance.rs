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
