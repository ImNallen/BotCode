// Ported from T3 v0.0.45 apps/desktop/src/preview/Manager.ts; WKWebView navigation adaptation.
use std::{sync::Mutex, time::Duration};

use serde_json::Value;
use tauri::Webview;

use super::model::{Result, Viewport};

pub struct BrowserState {
    pub url: Option<String>,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

pub async fn evaluate(view: &Webview, script: String) -> Result<Value> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Mutex::new(Some(sender));
    view.eval_with_callback(script, move |raw| {
        let result = if raw.len() > 65_536 {
            Err("Preview evaluation exceeded 64 KB.".to_string())
        } else {
            serde_json::from_str(&raw)
                .map_err(|error| format!("Preview evaluation failed: {error}"))
        };
        if let Ok(mut sender) = sender.lock()
            && let Some(sender) = sender.take()
        {
            let _ = sender.send(result);
        }
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(3), receiver)
        .await
        .map_err(|_| "Preview evaluation timed out.".to_string())?
        .map_err(|_| "Preview was closed during evaluation.".to_string())?
}

pub async fn measured_viewport(view: &Webview) -> Result<Viewport> {
    let value = evaluate(view, "({width:innerWidth,height:innerHeight})".into()).await?;
    serde_json::from_value(value)
        .map_err(|error| format!("Could not measure preview viewport: {error}"))
}

#[cfg(target_os = "macos")]
pub async fn browser_state(view: &Webview) -> Result<BrowserState> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        // Tauri borrows the WKWebView on the main thread for this callback.
        let state = unsafe {
            let webview = &*platform.inner().cast::<objc2_web_kit::WKWebView>();
            BrowserState {
                url: webview
                    .URL()
                    .and_then(|url| url.absoluteString())
                    .map(|url| url.to_string()),
                title: webview
                    .title()
                    .map(|title| title.to_string())
                    .unwrap_or_default(),
                loading: webview.isLoading(),
                can_go_back: webview.canGoBack(),
                can_go_forward: webview.canGoForward(),
            }
        };
        let _ = sender.send(state);
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(3), receiver)
        .await
        .map_err(|_| "Preview navigation state timed out.".to_string())?
        .map_err(|_| "Preview closed while reading navigation state.".to_string())
}

#[cfg(not(target_os = "macos"))]
pub async fn browser_state(view: &Webview) -> Result<BrowserState> {
    let value = evaluate(
        view,
        "({url:location.href,title:document.title,loading:document.readyState!=='complete'})"
            .into(),
    )
    .await?;
    Ok(BrowserState {
        url: value["url"].as_str().map(str::to_owned),
        title: value["title"].as_str().unwrap_or_default().to_owned(),
        loading: value["loading"].as_bool().unwrap_or(false),
        can_go_back: false,
        can_go_forward: false,
    })
}

#[cfg(target_os = "macos")]
pub async fn history(view: &Webview, forward: bool) -> Result<()> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        // The borrowed pointer cannot outlive Tauri's main-thread callback.
        let result = unsafe {
            let webview = &*platform.inner().cast::<objc2_web_kit::WKWebView>();
            if forward && webview.canGoForward() {
                webview.goForward();
                Ok(())
            } else if !forward && webview.canGoBack() {
                webview.goBack();
                Ok(())
            } else {
                Err("No page in that navigation direction.".into())
            }
        };
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(3), receiver)
        .await
        .map_err(|_| "Preview navigation timed out.".to_string())?
        .map_err(|_| "Preview closed during navigation.".to_string())?
}

#[cfg(not(target_os = "macos"))]
pub async fn history(_view: &Webview, _forward: bool) -> Result<()> {
    Err("Native preview history is currently supported on macOS.".into())
}
