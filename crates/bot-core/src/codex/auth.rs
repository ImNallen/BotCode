use crate::{
    codex::{AgentProcess, Codex, Signal},
    domain::*,
    log::RotatingLog,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, mpsc};

const PROBE: Duration = Duration::from_secs(20);
const COALESCE: Duration = Duration::from_secs(5);
const PLAN_CLAIM: &str = "https://api.openai.com/auth";

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Secret(String);
impl Secret {
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}
impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(..)")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChatgptTokens {
    pub access_token: Secret,
    pub account_id: String,
    pub plan_type: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Credentials {
    Chatgpt(ChatgptTokens),
    ApiKey(Secret),
}

pub(crate) fn sign_in_required() -> AppError {
    AppError::new("sandbox_auth", "Sign in to Codex on this Mac first.")
}

#[derive(Deserialize)]
struct AuthFile {
    #[serde(rename = "OPENAI_API_KEY")]
    api_key: Option<String>,
    tokens: Option<Tokens>,
}
#[derive(Deserialize)]
struct Tokens {
    access_token: Option<String>,
    account_id: Option<String>,
    id_token: Option<String>,
}
fn parse(text: &str) -> Result<Credentials> {
    let file: AuthFile = serde_json::from_str(text).map_err(|_| {
        AppError::new(
            "sandbox_auth",
            "The Codex credentials on this Mac could not be read. Sign in to Codex again.",
        )
    })?;
    let nonempty = |value: Option<String>| value.filter(|value| !value.trim().is_empty());
    if let Some(tokens) = file.tokens
        && let Some(access_token) = nonempty(tokens.access_token)
    {
        let claims = tokens.id_token.as_deref().and_then(claims);
        let claim = |key: &str| {
            claims
                .as_ref()
                .and_then(|claims| claims[PLAN_CLAIM][key].as_str())
                .map(str::to_owned)
        };
        let account_id = nonempty(tokens.account_id)
            .or_else(|| claim("chatgpt_account_id"))
            .ok_or_else(sign_in_required)?;
        return Ok(Credentials::Chatgpt(ChatgptTokens {
            access_token: Secret(access_token),
            account_id,
            plan_type: claim("chatgpt_plan_type"),
        }));
    }
    match nonempty(file.api_key) {
        Some(key) => Ok(Credentials::ApiKey(Secret(key))),
        None => Err(sign_in_required()),
    }
}
fn claims(jwt: &str) -> Option<Value> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[derive(Clone)]
pub(crate) struct TokenBroker {
    auth_file: PathBuf,
    binary: PathBuf,
    last: Arc<Mutex<Option<(Instant, ChatgptTokens)>>>,
}
pub(crate) fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::home_dir().unwrap_or_default().join(".codex"))
}
impl TokenBroker {
    pub(crate) fn new(codex_home: &Path, binary: PathBuf) -> Self {
        Self {
            auth_file: codex_home.join("auth.json"),
            binary,
            last: Default::default(),
        }
    }
    pub(crate) fn read(&self) -> Result<Credentials> {
        match std::fs::read_to_string(&self.auth_file) {
            Ok(text) => parse(&text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(sign_in_required()),
            Err(error) => Err(error.into()),
        }
    }
    pub(crate) async fn refresh(
        &self,
        host: Option<Codex>,
        previous_account: Option<&str>,
    ) -> Result<ChatgptTokens> {
        let mut last = self.last.lock().await;
        if let Some((at, tokens)) = &*last
            && at.elapsed() < COALESCE
            && previous_account.is_none_or(|previous| previous == tokens.account_id)
        {
            return Ok(tokens.clone());
        }
        match host {
            Some(host) => account_read(&host).await?,
            None => self.refresh_through_throwaway().await?,
        }
        let Credentials::Chatgpt(tokens) = self.read()? else {
            return Err(sign_in_required());
        };
        if previous_account.is_some_and(|previous| previous != tokens.account_id) {
            return Err(AppError::new(
                "sandbox_account_changed",
                "The Codex account on this Mac changed. Start a new sandbox thread to use it.",
            ));
        }
        *last = Some((Instant::now(), tokens.clone()));
        Ok(tokens)
    }
    async fn refresh_through_throwaway(&self) -> Result<()> {
        let (events, _receiver) = mpsc::channel::<Signal>(32);
        let host = Codex::launch(
            AgentProcess::mac(&self.binary),
            0,
            events,
            RotatingLog::silent(),
            Default::default(),
        )
        .await?;
        let result = tokio::time::timeout(PROBE, async {
            host.initialize().await?;
            account_read(&host).await
        })
        .await
        .unwrap_or_else(|_| {
            Err(AppError::new(
                "sandbox_auth",
                "Codex on this Mac did not answer the token refresh in time.",
            ))
        });
        let _ = host.terminate().await;
        result
    }
}
async fn account_read(host: &Codex) -> Result<()> {
    host.request_with_timeout("account/read", json!({"refreshToken": true}), PROBE)
        .await
        .map(drop)
}

pub(crate) async fn login(agent: &Codex, credentials: &Credentials) -> Result<()> {
    let params = match credentials {
        Credentials::Chatgpt(tokens) => json!({
            "type": "chatgptAuthTokens",
            "accessToken": tokens.access_token.expose(),
            "chatgptAccountId": tokens.account_id,
            "chatgptPlanType": tokens.plan_type,
        }),
        Credentials::ApiKey(key) => json!({"type": "apiKey", "apiKey": key.expose()}),
    };
    agent.request("account/login/start", params).await.map(drop)
}
pub(crate) fn refresh_reply(tokens: &ChatgptTokens) -> Value {
    json!({
        "accessToken": tokens.access_token.expose(),
        "chatgptAccountId": tokens.account_id,
        "chatgptPlanType": tokens.plan_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: Value) -> String {
        let encode = |value: &Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
        };
        format!(
            "{}.{}.sig",
            encode(&json!({"alg": "RS256"})),
            encode(&claims)
        )
    }
    fn chatgpt_file(access: &str, account: &str, plan: &str) -> String {
        json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": jwt(json!({PLAN_CLAIM: {"chatgpt_plan_type": plan, "chatgpt_account_id": account}})),
                "access_token": access,
                "refresh_token": "rt-secret-value",
                "account_id": account,
            },
            "last_refresh": "2026-10-12T00:00:00Z"
        })
        .to_string()
    }

    #[test]
    fn chatgpt_api_key_and_missing_files_are_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let broker = TokenBroker::new(dir.path(), "/no/codex".into());
        assert_eq!(broker.read().unwrap_err().code, "sandbox_auth");

        std::fs::write(
            dir.path().join("auth.json"),
            chatgpt_file("at-1", "acct-1", "pro"),
        )
        .unwrap();
        assert_eq!(
            broker.read().unwrap(),
            Credentials::Chatgpt(ChatgptTokens {
                access_token: Secret("at-1".into()),
                account_id: "acct-1".into(),
                plan_type: Some("pro".into()),
            })
        );

        std::fs::write(
            dir.path().join("auth.json"),
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test","tokens":null}"#,
        )
        .unwrap();
        assert_eq!(
            broker.read().unwrap(),
            Credentials::ApiKey(Secret("sk-test".into()))
        );

        std::fs::write(dir.path().join("auth.json"), r#"{"tokens":null}"#).unwrap();
        assert_eq!(broker.read().unwrap_err().code, "sandbox_auth");
        std::fs::write(dir.path().join("auth.json"), "not json").unwrap();
        assert_eq!(broker.read().unwrap_err().code, "sandbox_auth");
    }

    #[test]
    fn secrets_never_appear_in_debug_output() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("auth.json"),
            chatgpt_file("at-secret-value", "acct-1", "pro"),
        )
        .unwrap();
        let broker = TokenBroker::new(dir.path(), "/no/codex".into());
        let debug = format!("{:?}", broker.read().unwrap());
        assert!(!debug.contains("at-secret-value"), "{debug}");
        assert!(debug.contains("acct-1"), "{debug}");
        let key = format!(
            "{:?}",
            Credentials::ApiKey(Secret("sk-secret-value".into()))
        );
        assert!(!key.contains("sk-secret-value"), "{key}");
    }

    #[test]
    fn login_and_refresh_reply_carry_the_fields_codex_expects() {
        let tokens = ChatgptTokens {
            access_token: Secret("at".into()),
            account_id: "acct".into(),
            plan_type: None,
        };
        assert_eq!(
            refresh_reply(&tokens),
            json!({"accessToken": "at", "chatgptAccountId": "acct", "chatgptPlanType": null})
        );
    }

    #[cfg(unix)]
    mod host {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn fake_host(dir: &Path, auth: &Path, account: &str) -> PathBuf {
            let script = dir.join("host.py");
            std::fs::write(
                &script,
                format!(
                    r#"#!/usr/bin/env python3
import json, sys, time
auth = {auth:?}
log = open({log:?}, "a")
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        print(json.dumps({{"id": request["id"], "result": {{}}}}), flush=True)
    elif method == "account/read":
        log.write(json.dumps(request["params"]) + "\n"); log.flush()
        time.sleep(0.3)
        data = json.load(open(auth))
        data["tokens"]["access_token"] = "at-refreshed-" + str(time.time_ns())
        data["tokens"]["account_id"] = {account:?}
        json.dump(data, open(auth, "w"))
        print(json.dumps({{"id": request["id"], "result": {{"account": {{"type": "chatgpt"}}, "requiresOpenaiAuth": True}}}}), flush=True)
    elif "id" in request:
        print(json.dumps({{"id": request["id"], "error": {{"code": -32601, "message": "no"}}}}), flush=True)
"#,
                    auth = auth.to_str().unwrap(),
                    log = dir.join("reads.log").to_str().unwrap(),
                    account = account,
                ),
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            script
        }
        fn reads(dir: &Path) -> Vec<String> {
            std::fs::read_to_string(dir.join("reads.log"))
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()
        }
        async fn live(script: &Path) -> (Codex, mpsc::Receiver<Signal>) {
            let (events, receiver) = mpsc::channel(32);
            let codex = Codex::launch(
                AgentProcess::mac(script),
                1,
                events,
                RotatingLog::silent(),
                Default::default(),
            )
            .await
            .unwrap();
            codex.initialize().await.unwrap();
            (codex, receiver)
        }

        #[tokio::test]
        async fn refresh_asks_the_live_host_once_for_a_burst_and_rereads_the_file() {
            let dir = tempfile::tempdir().unwrap();
            let auth = dir.path().join("auth.json");
            std::fs::write(&auth, chatgpt_file("at-old", "acct-1", "pro")).unwrap();
            let script = fake_host(dir.path(), &auth, "acct-1");
            let broker = TokenBroker::new(dir.path(), "/no/codex".into());
            let (host, _events) = live(&script).await;
            let (first, second) = tokio::join!(
                broker.refresh(Some(host.clone()), Some("acct-1")),
                broker.refresh(Some(host.clone()), Some("acct-1"))
            );
            let (first, second) = (first.unwrap(), second.unwrap());
            assert!(first.access_token.expose().starts_with("at-refreshed-"));
            assert_eq!(first, second, "a concurrent refresh shares the result");
            assert_eq!(reads(dir.path()), vec![r#"{"refreshToken": true}"#]);
            let _ = host.terminate().await;
        }

        #[tokio::test]
        async fn refresh_without_a_live_host_uses_a_throwaway_app_server() {
            let dir = tempfile::tempdir().unwrap();
            let auth = dir.path().join("auth.json");
            std::fs::write(&auth, chatgpt_file("at-old", "acct-1", "pro")).unwrap();
            let script = fake_host(dir.path(), &auth, "acct-1");
            let broker = TokenBroker::new(dir.path(), script);
            let tokens = broker.refresh(None, None).await.unwrap();
            assert!(tokens.access_token.expose().starts_with("at-refreshed-"));
            assert_eq!(reads(dir.path()).len(), 1);
        }

        #[tokio::test]
        async fn refresh_is_refused_when_the_mac_account_changed() {
            let dir = tempfile::tempdir().unwrap();
            let auth = dir.path().join("auth.json");
            std::fs::write(&auth, chatgpt_file("at-old", "acct-1", "pro")).unwrap();
            let script = fake_host(dir.path(), &auth, "acct-2");
            let broker = TokenBroker::new(dir.path(), "/no/codex".into());
            let (host, _events) = live(&script).await;
            let error = broker
                .refresh(Some(host.clone()), Some("acct-1"))
                .await
                .unwrap_err();
            assert_eq!(error.code, "sandbox_account_changed");
            let _ = host.terminate().await;
        }
    }
}
