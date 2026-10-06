// Ported in spirit from pingdotgg/t3code v0.0.45 apps/server/src/attachmentStore.ts (MIT): content-addressed image files with a stale sweep.
use crate::domain::*;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_NAME_CHARS: usize = 255;
const UNREFERENCED_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const PARTIAL_MAX_AGE: Duration = Duration::from_secs(60 * 60);

/// `<data_dir>/attachments`, holding `<sha256>.<ext>` files and in-flight `.part` files.
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
    pub fn stage(&self, name: &str, bytes: &[u8]) -> Result<ImageAttachment> {
        let name = display_name(name);
        let mime_type = sniff(bytes).ok_or_else(|| {
            AppError::new(
                "unsupported_image",
                format!(
                    "'{name}' is not a supported image type. Attach GIF, JPEG, PNG, or WebP images."
                ),
            )
        })?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(too_large(&name));
        }
        let id: AttachmentId = format!("{:x}", Sha256::digest(bytes)).parse()?;
        let attachment = ImageAttachment {
            id,
            mime_type,
            name,
            size_bytes: bytes.len() as u64,
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
    pub fn path(&self, attachment: &ImageAttachment) -> PathBuf {
        self.dir
            .join(file_name(&attachment.id, attachment.mime_type))
    }
    /// Reads `<sha256>.<ext>` for the renderer. Any other name is refused before touching disk.
    pub fn read(&self, file: &str) -> Result<(Vec<u8>, ImageMime)> {
        let (_, mime) = parse_file_name(file)
            .ok_or_else(|| AppError::new("invalid_attachment", "Invalid attachment name."))?;
        Ok((std::fs::read(self.dir.join(file))?, mime))
    }
    /// Deletes images no turn references once older than a day, and `.part` files older than an
    /// hour. A younger unreferenced image may still be in a composer waiting to be sent.
    pub fn sweep(&self, referenced: &HashSet<AttachmentId>, now: SystemTime) -> Result<()> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            let entry = entry?;
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
            let modified = entry.metadata()?.modified()?;
            if now.duration_since(modified).unwrap_or_default() > max_age {
                std::fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}
pub fn too_large(name: &str) -> AppError {
    AppError::new(
        "image_too_large",
        format!("'{name}' is larger than 10 MiB. Attach a smaller image."),
    )
}
fn display_name(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        "image".into()
    } else {
        name.chars().take(MAX_NAME_CHARS).collect()
    }
}
fn file_name(id: &AttachmentId, mime: ImageMime) -> String {
    format!("{id}.{}", mime.extension())
}
fn parse_file_name(file: &str) -> Option<(AttachmentId, ImageMime)> {
    let (id, extension) = file.split_once('.')?;
    let mime = [
        ImageMime::Png,
        ImageMime::Jpeg,
        ImageMime::Gif,
        ImageMime::Webp,
    ]
    .into_iter()
    .find(|mime| mime.extension() == extension)?;
    Some((id.parse().ok()?, mime))
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
        let svg = store.stage("logo.png", b"<svg xmlns='http://www.w3.org/2000/svg'/>");
        assert_eq!(
            svg.unwrap_err(),
            AppError::new(
                "unsupported_image",
                "'logo.png' is not a supported image type. Attach GIF, JPEG, PNG, or WebP images."
            )
        );
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert_eq!(
            store.stage("big.png", &big).unwrap_err(),
            AppError::new(
                "image_too_large",
                "'big.png' is larger than 10 MiB. Attach a smaller image."
            )
        );
        let webp = store.stage("photo.png", b"RIFF\x10\0\0\0WEBPVP8 ").unwrap();
        assert_eq!(webp.mime_type, ImageMime::Webp);
        assert_eq!(
            files(&data.path().join("attachments")),
            [format!("{}.webp", webp.id)]
        );
    }

    #[test]
    fn staging_the_same_bytes_twice_yields_one_id_and_one_file() {
        let data = tempfile::tempdir().unwrap();
        let store = Attachments::new(data.path());
        let first = store.stage("a.png", PNG).unwrap();
        let second = store.stage("b.png", PNG).unwrap();
        assert_eq!(
            first.id.as_str(),
            "bd54b02fae14b6b9ed73887ded339b8ef846fbcba0d4e5f9d95470ac23ade242"
        );
        assert_eq!(second.id, first.id);
        assert_eq!(first.size_bytes, 15);
        assert_eq!(second.name, "b.png");
        assert_eq!(
            files(&data.path().join("attachments")),
            [format!("{}.png", first.id)]
        );
        assert_eq!(std::fs::read(store.path(&first)).unwrap(), PNG);
        assert_eq!(
            store.read(&format!("{}.png", first.id)).unwrap(),
            (PNG.to_vec(), ImageMime::Png)
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
        let referenced = store.stage("kept.png", PNG).unwrap();
        let old = store.stage("old.gif", b"GIF89a-old").unwrap();
        let fresh = store.stage("fresh.jpg", b"\xff\xd8\xff-fresh").unwrap();
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
            .sweep(&HashSet::from([referenced.id.clone()]), SystemTime::now())
            .unwrap();
        let mut expected = vec![
            ".tmpfresh.part".to_string(),
            format!("{}.png", referenced.id),
            format!("{}.jpg", fresh.id),
        ];
        expected.sort();
        assert_eq!(files(&dir), expected);
    }
}
