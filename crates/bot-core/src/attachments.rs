// Ported from T3 Code v0.0.45 apps/server/src/attachmentStore.ts and packages/contracts/src/orchestration.ts.
use crate::domain::*;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_TOTAL_IMAGE_BYTES: u64 = 80 * 1024 * 1024;
pub const MAX_NAME_CHARS: usize = 255;
const UNREFERENCED_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const PARTIAL_MAX_AGE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone)]
pub struct Attachments {
    dir: PathBuf,
}
impl Attachments {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("attachments"),
        }
    }
    pub fn stage(&self, name: &str, bytes: &[u8], kind: AttachmentKind) -> Result<Attachment> {
        let name = name.trim();
        if name.is_empty()
            || name.chars().count() > MAX_NAME_CHARS
            || name.chars().any(char::is_control)
        {
            return Err(AppError::new(
                "invalid_attachment",
                "Attachment names must be 1 to 255 characters.",
            ));
        }
        match &kind {
            AttachmentKind::Image if bytes.len() > MAX_IMAGE_BYTES => return Err(too_large(name)),
            AttachmentKind::File { mime_type, source } => {
                validate_file(name, bytes.len() as u64, mime_type, *source)?
            }
            AttachmentKind::Image => {}
        }
        let id: AttachmentId = format!("{:x}", Sha256::digest(bytes)).parse()?;
        let attachment = match kind {
            AttachmentKind::Image => {
                if bytes.len() > MAX_IMAGE_BYTES {
                    return Err(too_large(name));
                }
                let mime_type = sniff(bytes).ok_or_else(|| AppError::new("unsupported_image", format!("'{name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.")))?;
                Attachment::Image(ImageAttachment {
                    id,
                    mime_type,
                    name: name.into(),
                    size_bytes: bytes.len() as u64,
                })
            }
            AttachmentKind::File { mime_type, source } => {
                validate_file(name, bytes.len() as u64, &mime_type, source)?;
                Attachment::File(FileAttachment {
                    id,
                    mime_type,
                    name: name.into(),
                    size_bytes: bytes.len() as u64,
                    extension: AttachmentExtension::from_name(name),
                    source,
                })
            }
        };
        let path = self.path(&attachment);
        if !path.exists() {
            std::fs::create_dir_all(&self.dir)?;
            let mut part = tempfile::Builder::new()
                .suffix(".part")
                .tempfile_in(&self.dir)?;
            part.write_all(bytes)?;
            part.as_file().sync_all()?;
            part.persist(&path).map_err(|e| e.error)?;
        }
        Ok(attachment)
    }
    pub fn path(&self, attachment: &Attachment) -> PathBuf {
        self.dir
            .join(format!("{}.{}", attachment.id(), attachment.extension()))
    }
    pub fn read(&self, file: &str) -> Result<(Vec<u8>, String)> {
        let (_, extension) = parse_file_name(file)
            .ok_or_else(|| AppError::new("invalid_attachment", "Invalid attachment name."))?;
        let bytes = std::fs::read(self.dir.join(file))?;
        let mime = sniff(&bytes)
            .filter(|mime| mime.extension() == extension.as_str())
            .map_or_else(
                || "application/octet-stream".into(),
                |mime| mime.as_str().into(),
            );
        Ok((bytes, mime))
    }
    pub fn validate(&self, attachment: &Attachment) -> Result<()> {
        let name = attachment.name();
        if name.trim().is_empty()
            || name.chars().count() > MAX_NAME_CHARS
            || name.chars().any(char::is_control)
        {
            return Err(AppError::new(
                "invalid_attachments",
                "Attachment names must be 1 to 255 characters.",
            ));
        }
        match attachment {
            Attachment::Image(_) if attachment.size_bytes() > MAX_IMAGE_BYTES as u64 => {
                return Err(too_large(name));
            }
            Attachment::File(file) => {
                validate_file(name, file.size_bytes, &file.mime_type, file.source)?
            }
            Attachment::Image(_) => {}
        }
        let file = std::fs::File::open(self.path(attachment)).map_err(|_| missing(name))?;
        if !file.metadata()?.is_file() || file.metadata()?.len() != attachment.size_bytes() {
            return Err(missing(name));
        }
        if let Attachment::Image(image) = attachment {
            let mut header = [0; 12];
            let length = (&file).read(&mut header)?;
            if sniff(&header[..length]) != Some(image.mime_type) {
                return Err(AppError::new(
                    "invalid_attachment",
                    format!("'{name}' could not be read as an image."),
                ));
            }
        }
        Ok(())
    }
    pub fn sweep(&self, referenced: &HashSet<AttachmentId>, now: SystemTime) -> Result<()> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let max_age = if name.ends_with(".part") {
                PARTIAL_MAX_AGE
            } else if let Some((id, _)) = parse_file_name(name) {
                if referenced.contains(&id) {
                    continue;
                }
                UNREFERENCED_MAX_AGE
            } else {
                continue;
            };
            if now
                .duration_since(entry.metadata()?.modified()?)
                .unwrap_or_default()
                > max_age
            {
                std::fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}
fn missing(name: &str) -> AppError {
    AppError::new(
        "missing_attachment",
        format!("'{name}' is no longer available. Attach the file again."),
    )
}
fn validate_file(
    name: &str,
    size: u64,
    mime: &str,
    source: Option<AttachmentSource>,
) -> Result<()> {
    if size == 0 {
        return Err(AppError::new(
            "empty_attachment",
            format!("'{name}' is empty or could not be read."),
        ));
    }
    if size > MAX_FILE_BYTES as u64 {
        return Err(AppError::new(
            "file_too_large",
            format!("'{name}' exceeds the 50 MB attachment limit."),
        ));
    }
    if mime.is_empty()
        || mime.len() > 255
        || mime.chars().any(char::is_control)
        || (source == Some(AttachmentSource::PastedText) && mime != "text/plain;charset=utf-8")
    {
        return Err(AppError::new(
            "invalid_attachment",
            "Invalid attachment MIME type or source.",
        ));
    }
    Ok(())
}
pub fn validate_total(attachments: &[Attachment]) -> Result<()> {
    if attachments.len() > 100 {
        return Err(AppError::new(
            "invalid_attachments",
            "You can attach up to 100 files per message.",
        ));
    }
    let total = attachments
        .iter()
        .filter(|a| {
            matches!(a, Attachment::Image(_))
                || ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&a.mime_type())
        })
        .try_fold(0u64, |sum, a| sum.checked_add(a.size_bytes()));
    if total.is_none_or(|total| total > MAX_TOTAL_IMAGE_BYTES) {
        return Err(AppError::new(
            "invalid_attachments",
            "Images can total up to 80 MiB per message or question response. Use smaller images or send fewer at once.",
        ));
    }
    Ok(())
}
pub fn too_large(name: &str) -> AppError {
    AppError::new(
        "image_too_large",
        format!("'{name}' is too large to attach, even after compression."),
    )
}
fn parse_file_name(file: &str) -> Option<(AttachmentId, AttachmentExtension)> {
    let (id, extension) = file.split_once('.')?;
    Some((id.parse().ok()?, extension.parse().ok()?))
}
fn sniff(bytes: &[u8]) -> Option<ImageMime> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageMime::Png)
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(ImageMime::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageMime::Gif)
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(ImageMime::Webp)
    } else {
        None
    }
}

// Only known composer owners retain bytes. Malformed owners make the census incomplete.
pub fn ui_references(rows: &BTreeMap<String, String>) -> Result<HashSet<AttachmentId>> {
    let mut ids = HashSet::new();
    for (key, saved) in rows {
        if !key.starts_with("composer-draft:") && key != "prompt-stash:v1" {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(saved)?;
        if value.get("version").is_some_and(|version| {
            if key == "prompt-stash:v1" {
                version != 1
            } else {
                version != 1 && version != 2
            }
        }) {
            return Err(AppError::new(
                "attachment_census",
                "Unknown composer state version.",
            ));
        }
        let owners: Vec<&serde_json::Value> = if key == "prompt-stash:v1" {
            value
                .get("entries")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| AppError::new("attachment_census", "Invalid prompt stash."))?
                .iter()
                .map(|entry| entry.get("payload").unwrap_or(entry))
                .collect()
        } else {
            vec![&value]
        };
        for owner in owners {
            if !owner.is_object()
                || owner
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .is_none()
            {
                return Err(AppError::new(
                    "attachment_census",
                    "Invalid composer draft.",
                ));
            }
            for field in ["attachments", "images"] {
                if let Some(slots) = owner.get(field) {
                    let slots = slots.as_array().ok_or_else(|| {
                        AppError::new("attachment_census", "Invalid draft attachments.")
                    })?;
                    for slot in slots {
                        let attachment = slot.get("attachment").unwrap_or(slot);
                        let id = attachment
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .ok_or_else(|| {
                                AppError::new("attachment_census", "Invalid attachment reference.")
                            })?;
                        ids.insert(id.parse()?);
                    }
                }
            }
            if let Some(records) = owner.get("records") {
                for record in records
                    .as_array()
                    .ok_or_else(|| AppError::new("attachment_census", "Invalid draft context."))?
                {
                    if matches!(
                        record.get("kind").and_then(serde_json::Value::as_str),
                        Some("image" | "file")
                    ) {
                        let id = record
                            .get("attachmentId")
                            .and_then(serde_json::Value::as_str)
                            .ok_or_else(|| {
                                AppError::new("attachment_census", "Invalid context attachment.")
                            })?;
                        ids.insert(id.parse()?);
                    }
                }
            }
        }
    }
    Ok(ids)
}
#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }
    fn age(path: &Path, by: Duration) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - by)
            .unwrap();
    }

    #[test]
    fn sniffing_ignores_the_name_and_rejects_non_images_and_oversize_files() {
        let data = tempfile::tempdir().unwrap();
        let store = Attachments::new(data.path());
        let svg = store.stage(
            "logo.png",
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
            AttachmentKind::Image,
        );
        assert_eq!(
            svg.unwrap_err(),
            AppError::new(
                "unsupported_image",
                "'logo.png' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images."
            )
        );
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert_eq!(
            store
                .stage("big.png", &big, AttachmentKind::Image)
                .unwrap_err(),
            AppError::new(
                "image_too_large",
                "'big.png' is too large to attach, even after compression."
            )
        );
        let webp = store
            .stage(
                "photo.png",
                b"RIFF\x10\0\0\0WEBPVP8 ",
                AttachmentKind::Image,
            )
            .unwrap();
        assert_eq!(webp.mime_type(), "image/webp");
        assert_eq!(
            files(&data.path().join("attachments")),
            [format!("{}.webp", webp.id())]
        );
    }

    #[test]
    fn staging_the_same_bytes_twice_yields_one_id_and_one_file() {
        let data = tempfile::tempdir().unwrap();
        let store = Attachments::new(data.path());
        let first = store.stage("a.png", PNG, AttachmentKind::Image).unwrap();
        let second = store.stage("b.png", PNG, AttachmentKind::Image).unwrap();
        assert_eq!(
            first.id().as_str(),
            "bd54b02fae14b6b9ed73887ded339b8ef846fbcba0d4e5f9d95470ac23ade242"
        );
        assert_eq!(second.id(), first.id());
        assert_eq!(first.size_bytes(), 15);
        assert_eq!(second.name(), "b.png");
        assert_eq!(
            files(&data.path().join("attachments")),
            [format!("{}.png", first.id())]
        );
        assert_eq!(std::fs::read(store.path(&first)).unwrap(), PNG);
        assert_eq!(
            store.read(&format!("{}.png", first.id())).unwrap(),
            (PNG.to_vec(), "image/png".into())
        );
        assert_eq!(
            store.read("../settings.json").unwrap_err().code,
            "invalid_attachment"
        );
    }

    #[test]
    fn sweep_removes_stale_unreferenced_and_partial_files_only() {
        let data = tempfile::tempdir().unwrap();
        let store = Attachments::new(data.path());
        let dir = data.path().join("attachments");
        let referenced = store.stage("kept.png", PNG, AttachmentKind::Image).unwrap();
        let old = store
            .stage("old.gif", b"GIF89a-old", AttachmentKind::Image)
            .unwrap();
        let fresh = store
            .stage("fresh.jpg", b"\xff\xd8\xff-fresh", AttachmentKind::Image)
            .unwrap();
        std::fs::write(dir.join(".tmpstale.part"), b"partial").unwrap();
        std::fs::write(dir.join(".tmpfresh.part"), b"partial").unwrap();
        age(
            &store.path(&referenced),
            Duration::from_secs(30 * 24 * 60 * 60),
        );
        age(&store.path(&old), Duration::from_secs(25 * 60 * 60));
        age(
            &dir.join(".tmpstale.part"),
            Duration::from_secs(2 * 60 * 60),
        );
        age(&store.path(&fresh), Duration::from_secs(23 * 60 * 60));
        store
            .sweep(&HashSet::from([referenced.id().clone()]), SystemTime::now())
            .unwrap();
        let mut expected = vec![
            ".tmpfresh.part".to_string(),
            format!("{}.png", referenced.id()),
            format!("{}.jpg", fresh.id()),
        ];
        expected.sort();
        assert_eq!(files(&dir), expected);
    }
}
