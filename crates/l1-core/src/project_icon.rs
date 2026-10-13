// Ported from pingdotgg/t3code v0.0.45 ProjectFaviconResolver.ts and orchestration.ts (MIT).
use crate::{AppError, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use grep_matcher::Matcher;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectIconColor {
    Gray,
    Red,
    Orange,
    Amber,
    Yellow,
    Lime,
    Green,
    Emerald,
    Teal,
    Cyan,
    Sky,
    Blue,
    Indigo,
    Violet,
    Purple,
    Fuchsia,
    Pink,
    Rose,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProjectIconOverride {
    Lucide {
        name: String,
        color: ProjectIconColor,
    },
    Emoji {
        emoji: String,
    },
    Monogram {
        text: String,
        color: ProjectIconColor,
    },
}
impl ProjectIconOverride {
    pub(crate) fn normalize(self) -> Result<Self> {
        let valid =
            |value: &str, max: usize| !value.is_empty() && value.encode_utf16().count() <= max;
        let normalized = match self {
            Self::Lucide { name, color } => {
                let name = name.trim().to_owned();
                if !valid(&name, 64)
                    || name.split('-').any(|part| {
                        part.is_empty()
                            || !part
                                .bytes()
                                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                    })
                {
                    return Err(invalid("Choose a valid Lucide icon name."));
                }
                Self::Lucide { name, color }
            }
            Self::Emoji { emoji } => {
                let emoji = emoji.trim().to_owned();
                if !valid(&emoji, 32) {
                    return Err(invalid("Choose an emoji of at most 32 characters."));
                }
                Self::Emoji { emoji }
            }
            Self::Monogram { text, color } => {
                let text = text.nfkc().collect::<String>().trim().to_uppercase();
                static MONOGRAM: OnceLock<grep_regex::RegexMatcher> = OnceLock::new();
                let matcher = MONOGRAM.get_or_init(|| {
                    grep_regex::RegexMatcher::new(
                        r"\A[\p{L}\p{N}][\p{L}\p{N}\p{M}\x{200c}\x{200d}]*\z",
                    )
                    .unwrap()
                });
                if !valid(&text, 32) || !matcher.is_match(text.as_bytes()).unwrap_or(false) {
                    return Err(invalid(
                        "Project monograms must contain letters or numbers.",
                    ));
                }
                if text.graphemes(true).count() > 2 {
                    return Err(invalid(
                        "Project monograms must contain at most two characters.",
                    ));
                }
                Self::Monogram { text, color }
            }
        };
        Ok(normalized)
    }
}
fn invalid(message: &str) -> AppError {
    AppError::new("project_icon", message)
}
pub(crate) fn normalize_favicon_path(path: String) -> Result<String> {
    let path = path.trim().to_owned();
    if path.is_empty()
        || path.encode_utf16().count() > 1024
        || image_mime(Path::new(&path)).is_none()
    {
        return Err(invalid("Choose an image file with a supported extension."));
    }
    Ok(path)
}
pub(crate) fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "avif" => Some("image/avif"),
        "gif" => Some("image/gif"),
        "ico" => Some("image/x-icon"),
        "jpeg" | "jpg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFavicon {
    pub path: String,
    pub data_url: String,
}
const CANDIDATES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/icon.svg",
    "app/icon.png",
    "app/icon.ico",
    "src/favicon.ico",
    "src/favicon.svg",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    ".idea/icon.svg",
];
const SOURCES: &[&str] = &[
    "index.html",
    "public/index.html",
    "app/routes/__root.tsx",
    "src/routes/__root.tsx",
    "app/root.tsx",
    "src/root.tsx",
    "src/index.html",
];
struct Cached {
    path: Option<PathBuf>,
    inserted: Instant,
}
type FaviconCache = HashMap<(PathBuf, Option<String>), Cached>;

#[derive(Clone, Default)]
pub(crate) struct FaviconResolver {
    cache: Arc<Mutex<FaviconCache>>,
}
impl FaviconResolver {
    pub(crate) fn resolve(
        &self,
        root: &Path,
        saved: Option<&str>,
    ) -> Result<Option<ProjectFavicon>> {
        let root = dunce::canonicalize(root)?;
        let key = (root.clone(), saved.map(str::to_owned));
        let mut cache = self.cache.lock().unwrap();
        let cached = cache.get(&key).filter(|entry| {
            entry.inserted.elapsed()
                < Duration::from_secs(if entry.path.is_some() { 600 } else { 60 })
        });
        let path = match cached {
            Some(Cached { path: None, .. }) => return Ok(None),
            Some(Cached {
                path: Some(path), ..
            }) if cached_path(&root, saved, path)? => Some(path.clone()),
            _ => {
                let path = resolve_uncached(&root, saved)?;
                if cache.len() >= 512
                    && !cache.contains_key(&key)
                    && let Some(oldest) = cache
                        .iter()
                        .min_by_key(|(_, entry)| entry.inserted)
                        .map(|(key, _)| key.clone())
                {
                    cache.remove(&oldest);
                }
                cache.insert(
                    key,
                    Cached {
                        path: path.clone(),
                        inserted: Instant::now(),
                    },
                );
                path
            }
        };
        drop(cache);
        let Some(path) = path else {
            return Ok(None);
        };
        let mime = image_mime(&path)
            .ok_or_else(|| invalid("The discovered project icon is not a supported image file."))?;
        let bytes = fs::read(&path)?;
        Ok(Some(ProjectFavicon {
            path: path.to_string_lossy().into_owned(),
            data_url: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
        }))
    }
}
fn existing_file(path: &Path) -> Result<Option<PathBuf>> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(Some(path.to_owned())),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn cached_path(root: &Path, saved: Option<&str>, path: &Path) -> Result<bool> {
    if existing_file(path)?.is_none() {
        return Ok(false);
    }
    if saved.is_some_and(|saved| Path::new(saved).is_absolute() && Path::new(saved) == path) {
        return Ok(true);
    }
    Ok(dunce::canonicalize(path)?.starts_with(root))
}
fn confined(root: &Path, relative: &str) -> Result<Option<PathBuf>> {
    let relative = Path::new(relative);
    let mut normalized = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir if normalized.pop() => {}
            _ => return Ok(None),
        }
    }
    let Some(path) = existing_file(&root.join(normalized))? else {
        return Ok(None);
    };
    let path = dunce::canonicalize(path)?;
    Ok(path.starts_with(root).then_some(path))
}
fn resolve_uncached(root: &Path, saved: Option<&str>) -> Result<Option<PathBuf>> {
    if let Some(saved) = saved {
        let saved_path = Path::new(saved);
        let path = if saved_path.is_absolute() {
            existing_file(saved_path)?
        } else {
            confined(root, saved)?
        };
        if path.is_some() {
            return Ok(path);
        }
    }
    if let Some(icon) = crate::project::read(root)
        .ok()
        .and_then(|config| config.icon_path)
        && let Some(path) = confined(root, &icon)?
    {
        return Ok(Some(path));
    }
    for candidate in CANDIDATES {
        if let Some(path) = confined(root, candidate)? {
            return Ok(Some(path));
        }
    }
    for source in SOURCES {
        let Some(path) = confined(root, source)? else {
            continue;
        };
        let source = fs::read_to_string(path)?;
        let Some(href) = icon_href(&source) else {
            continue;
        };
        let clean = href.strip_prefix('/').unwrap_or(href);
        for candidate in [format!("public/{clean}"), clean.to_owned()] {
            if let Some(path) = confined(root, &candidate)? {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}
fn quoted_field(source: &str, key: &str, separator: u8) -> Option<std::ops::Range<usize>> {
    let bytes = source.as_bytes();
    for (index, _) in source.match_indices(key) {
        if index > 0 && (bytes[index - 1].is_ascii_alphanumeric() || bytes[index - 1] == b'_') {
            continue;
        }
        let mut cursor = index + key.len();
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&separator) {
            continue;
        }
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let Some(&quote @ (b'\'' | b'"')) = bytes.get(cursor) else {
            continue;
        };
        cursor += 1;
        let end = bytes[cursor..].iter().position(|&byte| byte == quote)? + cursor;
        return Some(cursor..end);
    }
    None
}
fn icon_rel(source: &str, separator: u8) -> bool {
    quoted_field(source, "rel", separator)
        .is_some_and(|range| matches!(&source[range], "icon" | "shortcut icon"))
}
fn icon_href(source: &str) -> Option<&str> {
    let lower = source.to_ascii_lowercase();
    for (start, _) in lower.match_indices("<link") {
        if lower
            .as_bytes()
            .get(start + 5)
            .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
        {
            continue;
        }
        let Some(end) = lower[start..].find('>') else {
            break;
        };
        let tag = &lower[start..start + end];
        if icon_rel(tag, b'=')
            && let Some(range) = quoted_field(tag, "href", b'=')
        {
            return source[start + range.start..start + range.end]
                .split('?')
                .next()
                .filter(|href| !href.is_empty());
        }
    }
    let mut offset = 0;
    for run in lower.split('}') {
        if icon_rel(run, b':')
            && let Some(range) = quoted_field(run, "href", b':')
        {
            return source[offset + range.start..offset + range.end]
                .split('?')
                .next()
                .filter(|href| !href.is_empty());
        }
        offset += run.len() + 1;
    }
    None
}

#[cfg(test)]
mod tests;
