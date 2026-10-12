use super::ImageVersion;
use crate::domain::SandboxId;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const INSTANCE_LABEL: &str = "dev.botcode.instance";
pub const SANDBOX_LABEL: &str = "dev.botcode.sandbox";
pub const IMAGE_LABEL: &str = "dev.botcode.image";

/// The first 8 hex digits of the SHA-256 of the canonical data directory. Every label filter
/// includes it, so a run with its own `BOT_CODE_DATA_DIR` never lists, stops or removes
/// another run's containers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instance(String);
impl Instance {
    pub fn of(data_dir: &Path) -> Self {
        let canonical = dunce::canonicalize(data_dir)
            .or_else(|_| std::path::absolute(data_dir))
            .unwrap_or_else(|_| data_dir.into());
        let digest = format!(
            "{:x}",
            Sha256::digest(canonical.as_os_str().as_encoded_bytes())
        );
        Self(digest[..8].into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
pub(super) fn container_name(instance: &Instance, id: &SandboxId) -> String {
    format!("botcode-{}-{id}", instance.0)
}
pub(super) fn labels(
    instance: &Instance,
    id: &SandboxId,
    image: &ImageVersion,
) -> [(&'static str, String); 3] {
    [
        (INSTANCE_LABEL, instance.0.clone()),
        (SANDBOX_LABEL, id.to_string()),
        (IMAGE_LABEL, image.as_str().into()),
    ]
}
pub(super) fn instance_filter(instance: &Instance) -> String {
    format!("label={INSTANCE_LABEL}={}", instance.0)
}
/// Survives container removal, so a recreated container resumes the same Codex sessions.
pub(super) fn codex_home(data_dir: &Path, id: &SandboxId) -> PathBuf {
    data_dir
        .join("sandboxes")
        .join(id.as_str())
        .join("codex-home")
}
