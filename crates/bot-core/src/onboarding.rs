// Local CLI setup adapted from T3 Code v0.0.45 onboarding/providerReadiness.logic.ts and provider/Layers/CodexProvider.ts (MIT).
use crate::{codex::Codex, log::RotatingLog, vcs};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CodexReadiness {
    Missing,
    Unauthenticated { version: String },
    Ready { version: String },
    Attention { message: String },
}
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexSetupAction {
    Install,
    SignIn,
}

pub(crate) fn resolve_binary(configured: &Path) -> PathBuf {
    if configured == Path::new("codex") {
        vcs::installed_binary("codex", "BOT_CODE_CODEX_BIN")
    } else {
        configured.to_owned()
    }
}

pub(crate) fn setup_command(action: CodexSetupAction, configured: &Path) -> String {
    match action {
        CodexSetupAction::Install if cfg!(windows) => {
            "irm https://chatgpt.com/codex/install.ps1 | iex".into()
        }
        CodexSetupAction::Install => "curl -fsSL https://chatgpt.com/codex/install.sh | sh".into(),
        CodexSetupAction::SignIn => {
            let binary = resolve_binary(configured).to_string_lossy().into_owned();
            let safe = binary
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "_./:\\-".contains(ch));
            if safe && (cfg!(windows) || !binary.contains('\\')) {
                return format!("{binary} login");
            }
            if cfg!(windows) {
                format!("& '{}' login", binary.replace('\'', "''"))
            } else {
                format!("'{}' login", binary.replace('\'', "'\"'\"'"))
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountRead {
    account: Option<Account>,
    requires_openai_auth: bool,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Account {
    Chatgpt,
    ApiKey,
}

pub(crate) async fn readiness(configured: &Path, cwd: &Path) -> CodexReadiness {
    let binary = resolve_binary(configured);
    let installed = if binary.components().count() > 1 {
        vcs::executable(binary.clone()).is_some()
    } else {
        vcs::bin_dirs()
            .into_iter()
            .any(|dir| vcs::executable(dir.join(&binary)).is_some())
    };
    if !installed {
        return CodexReadiness::Missing;
    }
    let (_cancel, mut cancelled) = watch::channel(false);
    let version = vcs::Tool {
        program: &binary,
        cwd,
    }
    .run_with_input(&["--version"], PROBE_TIMEOUT, 4096, &mut cancelled, None)
    .await;
    let version = match version {
        Ok(output) if output.code == Some(0) => {
            let text = output.stdout.trim();
            if !text.starts_with("codex ") && !text.starts_with("codex-cli ") {
                return attention("Codex returned an unexpected version response.");
            }
            text.chars().take(80).collect::<String>()
        }
        _ => return attention("Could not check the Codex version. Try again."),
    };
    let (events, _receiver) = mpsc::channel(32);
    let provider = match Codex::launch(binary, 0, events, RotatingLog::silent()).await {
        Ok(provider) => provider,
        Err(_) => return attention("Could not start Codex. Try again."),
    };
    let result = tokio::time::timeout(PROBE_TIMEOUT, async {
        provider.initialize().await?;
        provider
            .request_with_timeout("account/read", json!({}), PROBE_TIMEOUT)
            .await
    })
    .await;
    let _ = provider.terminate().await;
    match result {
        Ok(Ok(value)) => match serde_json::from_value::<AccountRead>(value) {
            Ok(AccountRead {
                account: None,
                requires_openai_auth: true,
            }) => CodexReadiness::Unauthenticated { version },
            Ok(_) => CodexReadiness::Ready { version },
            Err(_) => attention("Codex returned an unexpected account response. Try again."),
        },
        _ => attention("Could not check Codex sign-in. Try again."),
    }
}
fn attention(message: &str) -> CodexReadiness {
    CodexReadiness::Attention {
        message: message.into(),
    }
}
