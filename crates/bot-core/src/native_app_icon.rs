// Ported from pingdotgg/t3code v0.0.45 apps/server/src/assets/NativeAppIconResolver.ts (MIT).
use crate::domain::NativeAppRef;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const ICON_SIZE: u32 = 64;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const CACHE_MAX_ENTRIES: usize = 256;

struct Cached {
    path: Option<PathBuf>,
    inserted: Instant,
}

#[derive(Clone)]
pub(crate) struct NativeAppIcons {
    directory: PathBuf,
    cache: Arc<Mutex<HashMap<NativeAppRef, Cached>>>,
    permits: Arc<tokio::sync::Semaphore>,
}

impl NativeAppIcons {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            cache: Arc::default(),
            permits: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }

    pub(crate) async fn data_url(&self, app: &NativeAppRef) -> Option<String> {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let path = self.resolve(app).await?;
        let bytes = tokio::fs::read(path).await.ok()?;
        Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
    }

    async fn resolve(&self, app: &NativeAppRef) -> Option<PathBuf> {
        if !cfg!(target_os = "macos")
            || matches!(app, NativeAppRef::DisplayName { display_name } if display_name.chars().any(char::is_control))
        {
            return None;
        }
        let cached = {
            let cache = self.cache.lock().unwrap();
            cache
                .get(app)
                .filter(|entry| entry.inserted.elapsed() < CACHE_TTL)
                .map(|entry| entry.path.clone())
        };
        match cached {
            Some(None) => return None,
            Some(Some(path)) if path.is_file() => return Some(path),
            _ => {}
        }
        let _permit = self.permits.acquire().await.ok()?;
        let path = resolve_uncached(app, &self.directory).await.ok()?;
        let mut cache = self.cache.lock().unwrap();
        if cache.len() >= CACHE_MAX_ENTRIES
            && !cache.contains_key(app)
            && let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.inserted)
                .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
        cache.insert(
            app.clone(),
            Cached {
                path: path.clone(),
                inserted: Instant::now(),
            },
        );
        path
    }
}

struct Failed;

async fn output(program: &str, args: &[&str]) -> Result<String, Failed> {
    let mut command = tokio::process::Command::from(crate::process::command(program));
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(COMMAND_TIMEOUT, command.output())
        .await
        .map_err(|_| Failed)?
        .map_err(|_| Failed)?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn plist_value(info_plist: &Path, key: &str) -> String {
    let path = info_plist.to_string_lossy();
    output(
        "/usr/bin/plutil",
        &["-extract", key, "raw", "-o", "-", &path],
    )
    .await
    .map(|value| value.trim().to_owned())
    .unwrap_or_default()
}

fn escape_spotlight(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '\'' | '*' | '?') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

async fn application_path(app: &NativeAppRef) -> Result<Option<PathBuf>, Failed> {
    let query = match app {
        NativeAppRef::AppId { app_id } => format!(
            "kMDItemCFBundleIdentifier == '{}'",
            escape_spotlight(app_id)
        ),
        // Spotlight keeps the ".app" suffix in display names when Finder shows extensions.
        NativeAppRef::DisplayName { display_name } => {
            let name = escape_spotlight(display_name);
            format!(
                "kMDItemContentType == 'com.apple.application-bundle' && (kMDItemDisplayName == '{name}' || kMDItemDisplayName == '{name}.app')"
            )
        }
    };
    let found = output("/usr/bin/mdfind", &[&query]).await?;
    let candidates = found
        .lines()
        .map(str::trim)
        .filter(|line| line.ends_with(".app"))
        .collect::<Vec<_>>();
    let matching = match app {
        NativeAppRef::AppId { .. } => candidates.clone(),
        NativeAppRef::DisplayName { display_name } => candidates
            .iter()
            .copied()
            .filter(|candidate| {
                Path::new(candidate).file_stem().is_some_and(|stem| {
                    stem.to_string_lossy().to_lowercase() == display_name.to_lowercase()
                })
            })
            .collect(),
    };
    let ranked = if matching.is_empty() {
        candidates
    } else {
        matching
    };
    let mut most_recent: Option<(&str, String)> = None;
    for candidate in ranked {
        let last_used = output(
            "/usr/bin/mdls",
            &["-raw", "-name", "kMDItemLastUsedDate", candidate],
        )
        .await
        .map(|value| value.trim().to_owned())
        .unwrap_or_default();
        if most_recent
            .as_ref()
            .is_none_or(|(_, newest)| last_used > *newest)
        {
            most_recent = Some((candidate, last_used));
        }
    }
    Ok(most_recent.map(|(path, _)| PathBuf::from(path)))
}

fn existing_file(path: PathBuf) -> Option<PathBuf> {
    path.is_file().then_some(path)
}

async fn resolve_uncached(app: &NativeAppRef, directory: &Path) -> Result<Option<PathBuf>, Failed> {
    use sha2::{Digest, Sha256};
    let Some(app_path) = application_path(app).await? else {
        return Ok(None);
    };
    let app_path = dunce::canonicalize(app_path).map_err(|_| Failed)?;
    let info_plist = app_path.join("Contents").join("Info.plist");
    let resources = app_path.join("Contents").join("Resources");
    let mut icon_name = plist_value(&info_plist, "CFBundleIconFile").await;
    if icon_name.is_empty() {
        icon_name = plist_value(&info_plist, "CFBundleIconName").await;
    }
    if !icon_name.is_empty() && Path::new(&icon_name).file_name() != Some(icon_name.as_ref()) {
        return Ok(None);
    }
    let icon_file = (!icon_name.is_empty()).then(|| {
        if Path::new(&icon_name).extension().is_some() {
            icon_name.clone()
        } else {
            format!("{icon_name}.icns")
        }
    });
    let mut entries = std::fs::read_dir(&resources)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    entries.sort();
    let candidate = icon_file
        .and_then(|name| existing_file(resources.join(name)))
        .or_else(|| existing_file(resources.join("AppIcon.icns")))
        .or_else(|| {
            entries
                .iter()
                .find(|entry| entry.to_lowercase().ends_with(".icns"))
                .and_then(|entry| existing_file(resources.join(entry)))
        });
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    let source = dunce::canonicalize(candidate).map_err(|_| Failed)?;
    if !source.starts_with(&resources) {
        return Ok(None);
    }
    let mut version = plist_value(&info_plist, "CFBundleVersion").await;
    if version.is_empty() {
        version = plist_value(&info_plist, "CFBundleShortVersionString").await;
    }
    let key = Sha256::digest(
        format!("{}\0{version}\0{}", app_path.display(), source.display()).as_bytes(),
    )
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect::<String>();
    let cached = directory.join(format!("{key}.png"));
    if cached.is_file() {
        return Ok(Some(cached));
    }
    std::fs::create_dir_all(directory).map_err(|_| Failed)?;
    let temporary = directory.join(format!(
        ".{key}-{}-{}.png",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let size = ICON_SIZE.to_string();
    let converted = output(
        "/usr/bin/sips",
        &[
            "-z",
            &size,
            &size,
            "-s",
            "format",
            "png",
            &source.to_string_lossy(),
            "--out",
            &temporary.to_string_lossy(),
        ],
    )
    .await
    .and_then(|_| std::fs::rename(&temporary, &cached).map_err(|_| Failed));
    let _ = std::fs::remove_file(&temporary);
    converted?;
    Ok(existing_file(cached))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolves_finder_to_a_cached_png() {
        let directory = tempfile::tempdir().unwrap();
        let icons = NativeAppIcons::new(directory.path().to_owned());
        let finder = NativeAppRef::AppId {
            app_id: "com.apple.finder".into(),
        };
        let url = icons.data_url(&finder).await.expect("Finder has an icon");
        assert!(url.starts_with("data:image/png;base64,iVBORw0KGgo"));
        let pngs = std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "png"))
            .count();
        assert_eq!(pngs, 1);
    }

    #[tokio::test]
    async fn resolves_safari_by_display_name() {
        let directory = tempfile::tempdir().unwrap();
        let icons = NativeAppIcons::new(directory.path().to_owned());
        let safari = NativeAppRef::DisplayName {
            display_name: "Safari".into(),
        };
        let url = icons.data_url(&safari).await.expect("Safari has an icon");
        assert!(url.starts_with("data:image/png;base64,iVBORw0KGgo"));
    }

    #[tokio::test]
    async fn an_unknown_app_has_no_icon() {
        let directory = tempfile::tempdir().unwrap();
        let icons = NativeAppIcons::new(directory.path().to_owned());
        let missing = NativeAppRef::AppId {
            app_id: "dev.bot.code.no-such-app-for-icon-test".into(),
        };
        assert_eq!(icons.data_url(&missing).await, None);
    }
}
