// Policy ported from pingdotgg/t3code v0.0.45 apps/server/src/assets/AssetAccess.ts, apps/server/src/http.ts and packages/shared/src/filePreview.ts (MIT).
use crate::{domain::*, repo};
use percent_encoding::percent_decode_str;
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::UNIX_EPOCH,
};

pub const SCHEME: &str = "botcode-workspace";
const HTML_CSP: &str = "sandbox allow-scripts allow-forms allow-popups allow-modals";
const SVG_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const AUDIO_NEVER_CACHED: &str = "private, no-store";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Image,
    Audio,
    Html,
    Asset,
}

impl Class {
    fn loads_siblings(self) -> bool {
        matches!(self, Class::Html | Class::Asset)
    }
}

const SERVED: &[(&str, Class, &str)] = &[
    ("avif", Class::Image, "image/avif"),
    ("gif", Class::Image, "image/gif"),
    ("ico", Class::Image, "image/x-icon"),
    ("jpeg", Class::Image, "image/jpeg"),
    ("jpg", Class::Image, "image/jpeg"),
    ("png", Class::Image, "image/png"),
    ("svg", Class::Image, "image/svg+xml"),
    ("webp", Class::Image, "image/webp"),
    ("mp3", Class::Audio, "audio/mpeg"),
    ("wav", Class::Audio, "audio/wav"),
    ("ogg", Class::Audio, "audio/ogg"),
    ("oga", Class::Audio, "audio/ogg"),
    ("flac", Class::Audio, "audio/flac"),
    ("aac", Class::Audio, "audio/aac"),
    ("m4a", Class::Audio, "audio/mp4"),
    ("opus", Class::Audio, "audio/ogg"),
    ("aiff", Class::Audio, "audio/aiff"),
    ("htm", Class::Html, "text/html; charset=utf-8"),
    ("html", Class::Html, "text/html; charset=utf-8"),
    ("css", Class::Asset, "text/css"),
    ("js", Class::Asset, "text/javascript"),
    ("mjs", Class::Asset, "text/javascript"),
    ("otf", Class::Asset, "font/otf"),
    ("ttf", Class::Asset, "font/ttf"),
    ("woff", Class::Asset, "font/woff"),
    ("woff2", Class::Asset, "font/woff2"),
];

fn suffix_after_last_dot(name: &str) -> Option<&str> {
    name.rsplit_once('.').map(|(_, suffix)| suffix)
}

fn served(path: &Path) -> Option<(Class, &'static str)> {
    let suffix = suffix_after_last_dot(path.file_name()?.to_str()?)?;
    SERVED
        .iter()
        .find(|(known, ..)| known.eq_ignore_ascii_case(suffix))
        .map(|&(_, class, mime)| (class, mime))
}

pub(crate) fn is_media(path: &str) -> bool {
    matches!(
        served(Path::new(path)),
        Some((Class::Image | Class::Audio, _))
    )
}

pub(crate) fn revision(meta: &std::fs::Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    format!("{}-{modified}", meta.len())
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Request {
    pub workspace: WorkspaceId,
    pub thread: Option<ThreadId>,
    pub path: String,
}

pub(crate) fn parse(uri_path: &str) -> Option<Request> {
    let mut segments = uri_path.strip_prefix('/')?.split('/');
    let workspace = segments.next()?.parse().ok()?;
    let thread = match segments.next()? {
        "-" => None,
        id => Some(id.parse().ok()?),
    };
    let path = segments
        .map(decode_path_segment)
        .collect::<Option<Vec<_>>>()?
        .join("/");
    (!path.is_empty()).then_some(Request {
        workspace,
        thread,
        path,
    })
}

fn decode_path_segment(segment: &str) -> Option<String> {
    let decoded = percent_decode_str(segment).decode_utf8().ok()?;
    let refused = decoded.is_empty()
        || decoded == "."
        || decoded == ".."
        || decoded.contains(['/', '\\', '\0']);
    (!refused).then(|| decoded.into_owned())
}

#[derive(Debug, PartialEq, Eq)]
enum ByteRange {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

fn byte_range(header: &str, len: u64) -> ByteRange {
    let header = header.trim();
    let number = |digits: &str| -> Option<Option<u64>> {
        if digits.is_empty() {
            Some(None)
        } else if digits.bytes().all(|byte| byte.is_ascii_digit()) {
            Some(Some(digits.parse().unwrap_or(u64::MAX)))
        } else {
            None
        }
    };
    let bounds = header
        .get(..6)
        .filter(|unit| unit.eq_ignore_ascii_case("bytes="))
        .and_then(|_| header[6..].split_once('-'))
        .and_then(|(first, last)| Some((number(first)?, number(last)?)));
    let (first, last) = match bounds {
        None | Some((None, None)) => return ByteRange::Full,
        Some((Some(first), Some(last))) if last < first => return ByteRange::Full,
        Some(bounds) => bounds,
    };
    if len == 0 || first.is_some_and(|first| first >= len) || (first.is_none() && last == Some(0)) {
        return ByteRange::Unsatisfiable;
    }
    let start = match (first, last) {
        (Some(first), _) => first,
        (None, Some(last)) if last < len => len - last,
        _ => 0,
    };
    let end = match (first, last) {
        (Some(_), Some(last)) if last < len => last,
        _ => len - 1,
    };
    ByteRange::Partial { start, end }
}

#[derive(Debug)]
pub struct FileResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl FileResponse {
    pub(crate) fn not_found() -> Self {
        Self {
            status: 404,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }
}

pub(crate) fn respond(
    root: &Path,
    path: &str,
    range: Option<&str>,
    if_range: bool,
) -> FileResponse {
    serve(root, path, range, if_range).unwrap_or_else(FileResponse::not_found)
}

fn serve(root: &Path, path: &str, range: Option<&str>, if_range: bool) -> Option<FileResponse> {
    let file = repo::contained(root, path).ok()?;
    let canonical_root = dunce::canonicalize(root).ok()?;
    let canonical_relative = file.strip_prefix(&canonical_root).ok()?;
    let (class, mime) = served(canonical_relative)?;
    if class.loads_siblings()
        && canonical_relative
            .components()
            .any(|segment| segment.as_os_str().to_string_lossy().starts_with('.'))
    {
        return None;
    }
    let mut handle = std::fs::File::open(&file).ok()?;
    let meta = handle.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let len = meta.len();
    let mut headers = vec![
        ("Content-Type", mime.to_owned()),
        ("X-Content-Type-Options", "nosniff".to_owned()),
    ];
    if class == Class::Html {
        headers.push(("Content-Security-Policy", HTML_CSP.to_owned()));
    } else if mime == "image/svg+xml" {
        headers.push(("Content-Security-Policy", SVG_CSP.to_owned()));
    }
    let (mut status, mut start, mut count) = (200, 0, len);
    if class == Class::Audio {
        headers.push(("Cache-Control", AUDIO_NEVER_CACHED.to_owned()));
        headers.push(("Accept-Ranges", "bytes".to_owned()));
        let requested = range
            .filter(|_| !if_range)
            .map_or(ByteRange::Full, |header| byte_range(header, len));
        match requested {
            ByteRange::Unsatisfiable => {
                headers.push(("Content-Range", format!("bytes */{len}")));
                return Some(FileResponse {
                    status: 416,
                    headers,
                    body: Vec::new(),
                });
            }
            ByteRange::Partial { start: first, end } => {
                headers.push(("Content-Range", format!("bytes {first}-{end}/{len}")));
                (status, start, count) = (206, first, end - first + 1);
            }
            ByteRange::Full => {}
        }
    } else {
        headers.push(("Cache-Control", "no-cache".to_owned()));
    }
    handle.seek(SeekFrom::Start(start)).ok()?;
    let mut body = Vec::new();
    handle.take(count).read_to_end(&mut body).ok()?;
    headers.push(("Content-Length", body.len().to_string()));
    Some(FileResponse {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKSPACE: &str = "6f1c1b8e-9a0e-4a52-9c3e-0d6a3f0f1a11";
    const THREAD: &str = "0b5e4c2a-7f3d-4a19-8e2b-5c6d7e8f9a01";

    fn header<'a>(response: &'a FileResponse, name: &str) -> Option<&'a str> {
        response
            .headers
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }

    fn checkout() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("checkout");
        for folder in ["docs", ".github", ".hidden", ".git"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        for (path, bytes) in [
            ("logo.png", &b"\x89PNG"[..]),
            (".github/logo.png", b"png"),
            ("docs/page.html", b"<p>page</p>"),
            ("docs/style.css", b"p{}"),
            (".hidden/style.css", b"p{}"),
            ("mark.svg", b"<svg/>"),
            ("tone.wav", b"0123456789"),
            ("empty.wav", b""),
            ("main.ts", b"export {}"),
            (".env", b"SECRET=1"),
            (".git/x.png", b"png"),
        ] {
            std::fs::write(root.join(path), bytes).unwrap();
        }
        (dir, root)
    }

    #[test]
    fn serves_t3_preview_extensions_and_refuses_the_rest() {
        for path in [
            "a.avif", "a.gif", "a.ico", "a.JPEG", "a.jpg", "a.png", "a.svg", "a.webp",
        ] {
            assert_eq!(served(Path::new(path)).unwrap().0, Class::Image, "{path}");
        }
        for path in [
            "a.mp3", "a.WAV", "a.ogg", "a.oga", "a.flac", "a.aac", "a.m4a", "a.opus", "a.aiff",
        ] {
            assert_eq!(served(Path::new(path)).unwrap().0, Class::Audio, "{path}");
        }
        assert_eq!(served(Path::new("a.htm")).unwrap().0, Class::Html);
        assert_eq!(served(Path::new("a.HTML")).unwrap().0, Class::Html);
        for path in [
            "a.css", "a.js", "a.mjs", "a.otf", "a.ttf", "a.woff", "a.woff2",
        ] {
            assert_eq!(served(Path::new(path)).unwrap().0, Class::Asset, "{path}");
        }
        for path in [
            "a.ts", ".env", "a.pdf", "a.mp4", "Makefile", "a.png.ts", "a.json", "png.d/x",
        ] {
            assert_eq!(served(Path::new(path)), None, "{path}");
        }
        assert!(is_media("docs/logo.PNG"));
        assert!(
            is_media(".png"),
            "T3 matches the suffix, so a bare dot name still counts"
        );
        assert!(is_media("notes/recording.WAV"));
        assert!(!is_media("recording.wav.ts"));
        assert!(!is_media("index.html"));
    }

    #[test]
    fn parses_path_form_urls_one_segment_at_a_time() {
        let request = parse(&format!("/{WORKSPACE}/{THREAD}/docs/my%20pic%23.png")).unwrap();
        assert_eq!(request.workspace, WORKSPACE.parse().unwrap());
        assert_eq!(request.thread, Some(THREAD.parse().unwrap()));
        assert_eq!(request.path, "docs/my pic#.png");
        assert_eq!(
            parse(&format!("/{WORKSPACE}/-/logo.png")).unwrap().thread,
            None
        );
        for refused in [
            format!("/{WORKSPACE}/-/docs%2Fx.png"),
            format!("/{WORKSPACE}/-/docs%5Cx.png"),
            format!("/{WORKSPACE}/-/x%00.png"),
            format!("/{WORKSPACE}/-/../x.png"),
            format!("/{WORKSPACE}/-/%2E%2E/x.png"),
            format!("/{WORKSPACE}/-/./x.png"),
            format!("/{WORKSPACE}/-/docs//x.png"),
            format!("/{WORKSPACE}/-/"),
            format!("/{WORKSPACE}/-"),
            format!("/{WORKSPACE}/not-a-thread/x.png"),
            "/not-a-workspace/-/x.png".to_owned(),
            format!("/{WORKSPACE}/-/%FF.png"),
        ] {
            assert_eq!(parse(&refused), None, "{refused}");
        }
    }

    #[test]
    fn reads_one_byte_range_like_t3() {
        let partial = |start, end| ByteRange::Partial { start, end };
        assert_eq!(byte_range("bytes=0-1", 10), partial(0, 1));
        assert_eq!(byte_range(" BYTES=5- ", 10), partial(5, 9));
        assert_eq!(byte_range("bytes=-3", 10), partial(7, 9));
        assert_eq!(byte_range("bytes=-30", 10), partial(0, 9));
        assert_eq!(byte_range("bytes=2-99", 10), partial(2, 9));
        assert_eq!(byte_range("bytes=10-", 10), ByteRange::Unsatisfiable);
        assert_eq!(byte_range("bytes=-0", 10), ByteRange::Unsatisfiable);
        assert_eq!(byte_range("bytes=0-", 0), ByteRange::Unsatisfiable);
        for full in [
            "bytes=-",
            "bytes=5-2",
            "bytes=0-1,4-5",
            "items=0-1",
            "bytes=a-1",
        ] {
            assert_eq!(byte_range(full, 10), ByteRange::Full, "{full}");
        }
    }

    #[test]
    fn serves_checkout_files_with_t3_headers() {
        let (_dir, root) = checkout();
        let image = respond(&root, "logo.png", None, false);
        assert_eq!(
            (image.status, image.body.as_slice()),
            (200, &b"\x89PNG"[..])
        );
        assert_eq!(header(&image, "Content-Type"), Some("image/png"));
        assert_eq!(header(&image, "X-Content-Type-Options"), Some("nosniff"));
        assert_eq!(header(&image, "Cache-Control"), Some("no-cache"));
        assert_eq!(header(&image, "Content-Length"), Some("4"));
        assert_eq!(header(&image, "Content-Security-Policy"), None);
        assert_eq!(header(&image, "Accept-Ranges"), None);
        assert_eq!(
            respond(&root, ".github/logo.png", None, false).status,
            200,
            "images may live in dot directories"
        );
        let page = respond(&root, "docs/page.html", None, false);
        assert_eq!(
            header(&page, "Content-Type"),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            header(&page, "Content-Security-Policy"),
            Some("sandbox allow-scripts allow-forms allow-popups allow-modals")
        );
        assert_eq!(
            header(
                &respond(&root, "mark.svg", None, false),
                "Content-Security-Policy"
            ),
            Some("default-src 'none'; style-src 'unsafe-inline'; sandbox")
        );
        assert_eq!(respond(&root, "docs/style.css", None, false).status, 200);
        assert!(
            respond(&root, "logo.png", None, false)
                .headers
                .iter()
                .all(|(name, _)| !name.starts_with("Access-Control")),
            "a sandboxed page must not read what it loads"
        );
    }

    #[test]
    fn serves_audio_slices() {
        let (_dir, root) = checkout();
        let full = respond(&root, "tone.wav", None, false);
        assert_eq!((full.status, full.body.len()), (200, 10));
        assert_eq!(header(&full, "Accept-Ranges"), Some("bytes"));
        assert_eq!(header(&full, "Cache-Control"), Some("private, no-store"));
        let slice = respond(&root, "tone.wav", Some("bytes=2-4"), false);
        assert_eq!((slice.status, slice.body.as_slice()), (206, &b"234"[..]));
        assert_eq!(header(&slice, "Content-Range"), Some("bytes 2-4/10"));
        assert_eq!(header(&slice, "Content-Length"), Some("3"));
        let unconditional = respond(&root, "tone.wav", Some("bytes=2-4"), true);
        assert_eq!((unconditional.status, unconditional.body.len()), (200, 10));
        let past = respond(&root, "tone.wav", Some("bytes=10-"), false);
        assert_eq!((past.status, past.body.len()), (416, 0));
        assert_eq!(header(&past, "Content-Range"), Some("bytes */10"));
        assert_eq!(
            respond(&root, "empty.wav", Some("bytes=0-"), false).status,
            416
        );
        let image = respond(&root, "logo.png", Some("bytes=0-1"), false);
        assert_eq!(
            (image.status, image.body.len()),
            (200, 4),
            "only audio is ranged"
        );
    }

    #[test]
    fn refuses_paths_outside_the_policy() {
        let (_dir, root) = checkout();
        for path in [
            "main.ts",
            ".env",
            ".git/x.png",
            ".hidden/style.css",
            "missing.png",
            "docs",
            "../checkout/logo.png",
        ] {
            let response = respond(&root, path, None, false);
            assert_eq!((response.status, response.body.len()), (404, 0), "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn checks_the_symlink_target_not_the_link_name() {
        let (dir, root) = checkout();
        let outside = dir.path().join("outside.png");
        std::fs::write(&outside, b"png").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("escape.png")).unwrap();
        std::os::unix::fs::symlink(root.join(".env"), root.join("secret.png")).unwrap();
        std::os::unix::fs::symlink(root.join(".hidden/style.css"), root.join("docs/x.css"))
            .unwrap();
        std::os::unix::fs::symlink(root.join("logo.png"), root.join("docs/alias.png")).unwrap();
        for path in ["escape.png", "secret.png", "docs/x.css"] {
            assert_eq!(respond(&root, path, None, false).status, 404, "{path}");
        }
        assert_eq!(respond(&root, "docs/alias.png", None, false).status, 200);
    }
}
