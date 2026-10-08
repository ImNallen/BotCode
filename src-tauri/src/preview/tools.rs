// Ported from T3 Code v0.0.45 apps/server/src/mcp/toolkits/preview/tools.ts.
mod arguments;

use std::{path::PathBuf, time::Duration};

pub(super) use arguments::ColorScheme;
use arguments::Operation;
use base64::{Engine, engine::general_purpose::STANDARD};
use bot_core::{ToolBackend, ToolCall, ToolContent, ToolContext, ToolFuture, ToolResult, ToolSpec};
use serde_json::{Value, json};

use super::{
    PreviewManager, PreviewScope, catalog,
    model::{AutomationPin, Result},
    platform,
};

#[derive(Clone)]
pub struct PreviewTools {
    manager: PreviewManager,
    data_dir: PathBuf,
}

impl PreviewTools {
    pub fn new(manager: PreviewManager, data_dir: PathBuf) -> Self {
        Self { manager, data_dir }
    }

    async fn run(&self, context: ToolContext, call: ToolCall) -> Result<ToolResult> {
        let operation = Operation::parse(call)?;
        let scope = PreviewScope::Thread {
            thread_id: context.thread_id,
        };
        let pin = self
            .manager
            .pin(scope.clone(), matches!(operation, Operation::Open { .. }))
            .await?;
        let Some(pin) = pin else {
            if !matches!(operation, Operation::Status) {
                return Err("Open this conversation's preview before interacting with it.".into());
            }
            return Ok(ToolResult::text(
                self.manager.tool_status(&scope, None).await?.to_string(),
            ));
        };
        if let Operation::Wait { args, timeout } = operation {
            let deadline = tokio::time::Instant::now() + timeout;
            let view = self.manager.view(&scope)?;
            let mut committed = self.manager.initial_commit(view.label())?;
            if !*committed.borrow() {
                tokio::time::timeout_at(deadline, committed.wait_for(|value| *value))
                    .await
                    .map_err(|_| {
                        format!("Preview wait timed out after {} ms.", timeout.as_millis())
                    })?
                    .map_err(|_| "Preview closed before its first page committed.".to_owned())?;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if !timeout.is_zero() && remaining.is_zero() {
                return Err(format!(
                    "Preview wait timed out after {} ms.",
                    timeout.as_millis()
                ));
            }
            let value = wait_for(&pin, remaining, || {
                self.manager.dom(&scope, &pin.key, "wait_for", args.clone())
            })
            .await?;
            return Ok(ToolResult::text(value.to_string()));
        }
        let _guard = pin.gate.lock().await;
        let value = match operation {
            Operation::Status => self.manager.tool_status(&scope, Some(&pin.key)).await?,
            Operation::Open { url, open } => {
                self.manager.tool_open(scope.clone(), url, open).await?;
                self.manager.tool_status(&scope, Some(&pin.key)).await?
            }
            Operation::Snapshot { image, save } => {
                let mut value = self
                    .manager
                    .dom(
                        &scope,
                        &pin.key,
                        "snapshot",
                        json!({"snapshotId":uuid::Uuid::new_v4().simple().to_string()}),
                    )
                    .await?;
                let mut content = Vec::new();
                if image || save {
                    let view = self.manager.view(&scope)?;
                    let width = platform::measured_viewport(&view).await?.width;
                    let capture = platform::screenshot(&view, width).await?;
                    value["screenshot"] = json!({"mimeType":"image/png","width":capture.width,"height":capture.height,"bytes":capture.bytes.len()});
                    if save {
                        value["screenshotPath"] =
                            json!(save_png(self.data_dir.clone(), capture.bytes.clone()).await?);
                    }
                    if image {
                        content.push(ToolContent::Image {
                            data: STANDARD.encode(capture.bytes),
                            mime_type: "image/png".into(),
                        });
                    }
                }
                content.insert(
                    0,
                    ToolContent::Text {
                        text: value.to_string(),
                    },
                );
                return Ok(ToolResult {
                    success: true,
                    content,
                });
            }
            Operation::Resize(viewport) => {
                self.manager.view(&scope)?;
                self.manager.viewport(scope.clone(), viewport).await?;
                self.manager.tool_status(&scope, Some(&pin.key)).await?
            }
            Operation::Appearance(scheme) => {
                let view = self.manager.view(&scope)?;
                platform::appearance(&view, scheme).await?;
                let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
                loop {
                    let state = self
                        .manager
                        .dom(&scope, &pin.key, "status", json!({}))
                        .await?;
                    if scheme == ColorScheme::System
                        || state["colorScheme"].as_str() == Some(scheme.name())
                    {
                        break json!({"colorScheme":scheme.name(),"effectiveColorScheme":state["colorScheme"]});
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return Err("Native appearance changed, but the page media query did not match within 1 second.".into());
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
            Operation::Dom { name, args } => self.manager.dom(&scope, &pin.key, name, args).await?,
            Operation::Wait { .. } => unreachable!(),
        };
        Ok(ToolResult::text(value.to_string()))
    }
}

impl ToolBackend for PreviewTools {
    fn specs(&self) -> Vec<ToolSpec> {
        catalog::specs()
    }

    fn execute(&self, context: ToolContext, call: ToolCall) -> ToolFuture {
        let backend = self.clone();
        Box::pin(async move {
            Ok(backend.run(context, call).await.unwrap_or_else(|error| {
                ToolResult::failure(error.chars().take(1024).collect::<String>())
            }))
        })
    }
}

impl PreviewManager {
    async fn pin(&self, scope: PreviewScope, create: bool) -> Result<Option<AutomationPin>> {
        self.on_main(move |manager| {
            if !create && !manager.lock()?.entries.contains_key(&scope) {
                return Ok(None);
            }
            manager.ensure(&scope)?;
            Ok(Some(manager.lock()?.pin(&scope)?))
        })
        .await
    }

    async fn tool_open(
        &self,
        scope: PreviewScope,
        url: Option<tauri::Url>,
        open: bool,
    ) -> Result<()> {
        if let Some(url) = url {
            self.open_url(scope, url, open).await?;
        } else {
            self.on_main(move |manager| {
                if manager.view(&scope).is_err() {
                    {
                        let mut model = manager.lock()?;
                        let entry = model
                            .entries
                            .get_mut(&scope)
                            .ok_or("Preview scope disappeared.")?;
                        entry.navigation = entry.navigation.saturating_add(1);
                        entry.state.url = None;
                        entry.state.title.clear();
                        entry.state.loading = false;
                        entry.state.error = None;
                        entry.pending_url = None;
                    }
                    manager.create(
                        &scope,
                        tauri::Url::parse("about:blank").map_err(|error| error.to_string())?,
                    )?;
                    manager.apply_layout()?;
                }
                manager.emit(&scope, open);
                Ok(())
            })
            .await?;
        }
        Ok(())
    }

    async fn dom(
        &self,
        scope: &PreviewScope,
        key: &str,
        operation: &str,
        args: Value,
    ) -> Result<Value> {
        let script = format!(
            "({})({})",
            include_str!("automation.js"),
            json!({"operation":operation,"key":key,"args":args})
        );
        let result = platform::evaluate(&self.view(scope)?, script).await?;
        match result["ok"].as_bool() {
            Some(true) => Ok(result["value"].clone()),
            Some(false) => Err(result["error"]
                .as_str()
                .unwrap_or("Preview operation failed.")
                .chars()
                .take(512)
                .collect()),
            None => Err("Preview returned an invalid automation result.".into()),
        }
    }

    async fn tool_status(&self, scope: &PreviewScope, key: Option<&str>) -> Result<Value> {
        let state = self.current_state(scope).await?;
        let mut value = serde_json::to_value(state).map_err(|error| error.to_string())?;
        let capable = self.view(scope).is_ok();
        value["automationCapable"] = json!(capable);
        let visible = {
            let model = self.lock()?;
            model
                .attachment
                .as_ref()
                .is_some_and(|attachment| &attachment.scope == scope && attachment.visible)
                && model
                    .entries
                    .get(scope)
                    .is_some_and(|entry| entry.label.is_some() && entry.state.error.is_none())
        };
        value["visible"] = json!(visible);
        if capable
            && let Some(key) = key
            && let Ok(dom) = self.dom(scope, key, "status", json!({})).await
        {
            value["colorScheme"] = dom["colorScheme"].clone();
        }
        Ok(value)
    }
}

async fn wait_for<F: std::future::Future<Output = Result<Value>>>(
    pin: &AutomationPin,
    timeout: Duration,
    mut poll: impl FnMut() -> F,
) -> Result<Value> {
    let deadline = tokio::time::Instant::now() + timeout;
    let timed_out = || format!("Preview wait timed out after {} ms.", timeout.as_millis());
    loop {
        let value = if timeout.is_zero() {
            let _guard = pin.gate.try_lock().map_err(|_| timed_out())?;
            poll().await?
        } else {
            tokio::time::timeout_at(deadline, async {
                let _guard = pin.gate.lock().await;
                poll().await
            })
            .await
            .map_err(|_| timed_out())??
        };
        if value["matched"].as_bool() == Some(true) {
            return Ok(value);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(timed_out());
        }
        tokio::time::sleep_until(
            deadline.min(tokio::time::Instant::now() + Duration::from_millis(100)),
        )
        .await;
    }
}

async fn save_png(data_dir: PathBuf, bytes: Vec<u8>) -> Result<String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::task::spawn_blocking(move || {
        let result = write_png(&data_dir, &bytes, || sender.is_closed());
        let _ = sender.send(result);
    });
    receiver
        .await
        .map_err(|_| "Preview screenshot save was cancelled.".to_owned())?
}

fn write_png(
    data_dir: &std::path::Path,
    bytes: &[u8],
    cancelled: impl Fn() -> bool,
) -> Result<String> {
    if cancelled() {
        return Err("Preview screenshot save was cancelled.".into());
    }
    let root = dunce::canonicalize(data_dir).map_err(|error| error.to_string())?;
    let mut directory = root.clone();
    for component in ["preview", "screenshots"] {
        directory.push(component);
        match std::fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        directory = dunce::canonicalize(&directory).map_err(|error| error.to_string())?;
        if !directory.starts_with(&root) {
            return Err("Preview screenshot directory is outside the app data directory.".into());
        }
    }
    let path = directory.join(format!("{}.png", uuid::Uuid::new_v4().simple()));
    if cancelled() {
        return Err("Preview screenshot save was cancelled.".into());
    }
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn wait_yields_the_gate_so_another_call_can_satisfy_it() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let pin = AutomationPin {
            gate: Arc::new(tokio::sync::Mutex::new(())),
            key: "test".into(),
        };
        let ready = Arc::new(AtomicBool::new(false));
        let first_poll = Arc::new(tokio::sync::Notify::new());
        let ready_poll = ready.clone();
        let notify_poll = first_poll.clone();
        let poll_gate = pin.gate.clone();
        let waiter = tokio::spawn(async move {
            wait_for(&pin, Duration::from_secs(1), || {
                let matched = ready_poll.load(Ordering::SeqCst);
                notify_poll.notify_one();
                async move { Ok(json!({"matched":matched,"url":"http://localhost/"})) }
            })
            .await
        });
        first_poll.notified().await;
        let guard = poll_gate.lock().await;
        ready.store(true, Ordering::SeqCst);
        drop(guard);
        assert_eq!(
            waiter.await.unwrap().unwrap(),
            json!({"matched":true,"url":"http://localhost/"})
        );
    }

    #[tokio::test]
    async fn wait_deadline_bounds_a_busy_gate_and_cancelled_wait_releases_its_pin() {
        use std::sync::Arc;
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let pin = AutomationPin {
            gate: gate.clone(),
            key: "test".into(),
        };
        let guard = gate.lock().await;
        let result = wait_for(&pin, Duration::from_millis(5), || async {
            Ok(json!({"matched":true}))
        })
        .await;
        assert_eq!(result.unwrap_err(), "Preview wait timed out after 5 ms.");
        let waiter = tokio::spawn(async move {
            wait_for(&pin, Duration::from_secs(60), || async {
                Ok(json!({"matched":false}))
            })
            .await
        });
        tokio::task::yield_now().await;
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        drop(guard);
        assert_eq!(Arc::strong_count(&gate), 1);
        assert!(gate.try_lock().is_ok());
    }

    #[test]
    fn cancelled_saves_write_nothing_and_success_uses_generated_data_directory_path() {
        let directory =
            std::env::temp_dir().join(format!("botcode-screenshot-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        assert!(write_png(&directory, b"png", || true).is_err());
        assert!(!directory.join("preview").exists());
        let path = PathBuf::from(write_png(&directory, b"png", || false).unwrap());
        assert!(path.is_absolute());
        assert_eq!(
            path.parent().unwrap(),
            dunce::canonicalize(&directory)
                .unwrap()
                .join("preview/screenshots")
        );
        assert_eq!(std::fs::read(path).unwrap(), b"png");
        let checks = std::cell::Cell::new(0);
        assert!(
            write_png(&directory, b"cancelled", || {
                checks.set(checks.get() + 1);
                checks.get() > 1
            })
            .is_err()
        );
        assert_eq!(
            std::fs::read_dir(directory.join("preview/screenshots"))
                .unwrap()
                .count(),
            1
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn screenshot_directory_cannot_redirect_outside_app_data() {
        let directory =
            std::env::temp_dir().join(format!("botcode-screenshot-test-{}", uuid::Uuid::new_v4()));
        let outside = directory.with_extension("outside");
        std::fs::create_dir(&directory).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, directory.join("preview")).unwrap();
        assert!(write_png(&directory, b"png", || false).is_err());
        assert!(!outside.join("screenshots").exists());
        std::fs::remove_dir_all(directory).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
