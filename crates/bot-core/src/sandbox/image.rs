use crate::domain::{AppError, Result};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(super) const REPOSITORY: &str = "botcode-sandbox";
const CONTEXT: [(&str, &[u8]); 11] = [
    ("Dockerfile", include_bytes!("image/Dockerfile")),
    ("run", include_bytes!("image/run")),
    ("sync", include_bytes!("image/sync")),
    ("agent", include_bytes!("image/agent")),
    ("terminal", include_bytes!("image/terminal")),
    ("desktop", include_bytes!("image/desktop")),
    ("browser", include_bytes!("image/browser")),
    ("probe", include_bytes!("image/probe")),
    ("gateway", include_bytes!("image/gateway")),
    ("desktop.html", include_bytes!("image/desktop.html")),
    (
        "playwright-mcp.json",
        include_bytes!("image/playwright-mcp.json"),
    ),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexVersion(String);
impl CodexVersion {
    pub fn from_version_output(output: &str) -> Result<Self> {
        let output = output.trim();
        output
            .strip_prefix("codex-cli ")
            .or_else(|| output.strip_prefix("codex "))
            .unwrap_or(output)
            .parse()
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl std::str::FromStr for CodexVersion {
    type Err = AppError;
    fn from_str(s: &str) -> Result<Self> {
        let valid = (1..=64).contains(&s.len())
            && s.starts_with(|c: char| c.is_ascii_digit())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'));
        if valid {
            Ok(Self(s.into()))
        } else {
            Err(AppError::new(
                "sandbox",
                format!("Codex reported an unexpected version: {s}"),
            ))
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImageVersion(pub(super) String);
impl ImageVersion {
    pub(super) fn of(codex: &CodexVersion) -> Self {
        let mut hash = Sha256::new();
        for (name, bytes) in CONTEXT {
            hash.update(name);
            hash.update((bytes.len() as u64).to_le_bytes());
            hash.update(bytes);
        }
        hash.update(&codex.0);
        Self(format!("{:x}", hash.finalize())[..12].into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn tag(&self) -> String {
        format!("{REPOSITORY}:{}", self.0)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedImage(pub(super) String);
impl PartialEq<ImageVersion> for ObservedImage {
    fn eq(&self, version: &ImageVersion) -> bool {
        self.0 == version.0
    }
}

pub(super) fn write_context(dir: &Path) -> std::io::Result<()> {
    for (name, bytes) in CONTEXT {
        std::fs::write(dir.join(name), bytes)?;
    }
    Ok(())
}
