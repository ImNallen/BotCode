// Ported from T3 v0.0.45 apps/desktop/src/preview/Manager.ts; WKWebView navigation adaptation.
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::Value;
use tauri::{Manager, Webview};

use super::model::{Result, Viewport};

pub struct BrowserState {
    pub url: Option<String>,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

pub async fn evaluate(view: &Webview, script: String) -> Result<Value> {
    let manager = view
        .app_handle()
        .state::<super::PreviewManager>()
        .inner()
        .clone();
    wait_for_initial_commit(manager.initial_commit(view.label())?).await?;
    let script = format!(
        r#"(() => {{
            try {{
                const result = ({script});
                const encoded = JSON.stringify([true, result]);
                return typeof encoded === "string" ? encoded
                    : '[false,"Preview evaluation could not serialize its result."]';
            }} catch {{
                return '[false,"Preview evaluation could not serialize its result."]';
            }}
        }})()"#
    );
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let view = view.clone();
    let app = view.app_handle().clone();
    app.run_on_main_thread(move || {
        if sender
            .lock()
            .ok()
            .is_none_or(|sender| sender.as_ref().is_none_or(|sender| sender.is_closed()))
        {
            return;
        }
        if !manager
            .initial_commit(view.label())
            .is_ok_and(|committed| *committed.borrow())
        {
            if let Ok(mut sender) = sender.lock()
                && let Some(sender) = sender.take()
            {
                let _ = sender.send(Err("Preview was closed before evaluation.".into()));
            }
            return;
        }
        let callback_sender = sender.clone();
        let result = view.eval_with_callback(script, move |raw| {
            let result = decode_evaluation(&raw);
            if let Ok(mut sender) = callback_sender.lock()
                && let Some(sender) = sender.take()
            {
                let _ = sender.send(result);
            }
        });
        if let Err(error) = result
            && let Ok(mut sender) = sender.lock()
            && let Some(sender) = sender.take()
        {
            let _ = sender.send(Err(error.to_string()));
        }
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(3), receiver)
        .await
        .map_err(|_| "Preview evaluation timed out.".to_string())?
        .map_err(|_| "Preview was closed during evaluation.".to_string())?
}

fn decode_evaluation(raw: &str) -> Result<Value> {
    const RESULT_LIMIT: usize = 70_000;
    if raw.len() > RESULT_LIMIT * 6 + 2 {
        return Err("Preview evaluation response exceeded its transport limit.".into());
    }
    let encoded: String =
        serde_json::from_str(raw).map_err(|error| format!("Preview evaluation failed: {error}"))?;
    if encoded.len() > RESULT_LIMIT {
        return Err("Preview evaluation response exceeded 70 KB.".into());
    }
    let (success, value): (bool, Value) = serde_json::from_str(&encoded)
        .map_err(|error| format!("Preview evaluation failed: {error}"))?;
    if success {
        Ok(value)
    } else {
        Err("Preview evaluation could not serialize its result.".into())
    }
}

async fn wait_for_initial_commit(mut committed: tokio::sync::watch::Receiver<bool>) -> Result<()> {
    // Wry drops evaluation callbacks before its first didCommit navigation event.
    tokio::time::timeout(
        Duration::from_secs(3),
        committed.wait_for(|committed| *committed),
    )
    .await
    .map_err(|_| {
        "Preview is not ready for evaluation. Wait for the page to start loading.".to_string()
    })?
    .map_err(|_| "Preview was closed before evaluation.".to_string())?;
    Ok(())
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
        if sender.is_closed() {
            return;
        }
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
        if sender.is_closed() {
            return;
        }
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

pub struct Screenshot {
    pub bytes: Vec<u8>,
    pub width: usize,
    pub height: usize,
}

#[cfg(target_os = "macos")]
pub async fn screenshot(view: &Webview, css_width: u32) -> Result<Screenshot> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    if !(1..=8192).contains(&css_width) {
        return Err("Preview screenshot width must be 1..8192 CSS pixels.".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        if sender.is_closed() {
            return;
        }
        let Some(main) = MainThreadMarker::new() else {
            let _ = sender.send(Err("Preview snapshot requires the main thread.".into()));
            return;
        };
        // Tauri lends this WKWebView only for its main-thread callback.
        unsafe {
            let webview = &*platform.inner().cast::<WKWebView>();
            let config = WKSnapshotConfiguration::new(main);
            config.setSnapshotWidth(Some(&NSNumber::new_f64(f64::from(css_width))));
            let sender = Mutex::new(Some(sender));
            let handler = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let Ok(mut sender) = sender.lock() else {
                    return;
                };
                let Some(sender) = sender.take() else {
                    return;
                };
                if sender.is_closed() {
                    return;
                }
                let result = (|| {
                    let image = image.as_ref().ok_or_else(|| {
                        error
                            .as_ref()
                            .map(|error| error.localizedDescription().to_string())
                            .unwrap_or_else(|| "Native preview snapshot returned no image.".into())
                    })?;
                    let tiff = image
                        .TIFFRepresentation()
                        .ok_or("Could not encode preview snapshot.")?;
                    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
                        .ok_or("Could not decode preview snapshot.")?;
                    let png = bitmap
                        .representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
                        .ok_or("Could not encode preview PNG.")?;
                    let bytes = png.as_bytes_unchecked();
                    if bytes.len() > 4_400_000 {
                        return Err("Preview PNG exceeds 4.4 MB. Resize the preview or use includeImage:false.".into());
                    }
                    Ok(Screenshot {
                        bytes: bytes.to_vec(),
                        width: bitmap.pixelsWide() as usize,
                        height: bitmap.pixelsHigh() as usize,
                    })
                })();
                let _ = sender.send(result);
            });
            webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
        }
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(8), receiver)
        .await
        .map_err(|_| "Preview snapshot timed out.".to_owned())?
        .map_err(|_| "Preview closed during snapshot.".to_owned())?
}

#[cfg(not(target_os = "macos"))]
pub async fn screenshot(_view: &Webview, _css_width: u32) -> Result<Screenshot> {
    Err("Native preview PNG capture is currently supported on macOS. Use includeImage:false for a semantic snapshot.".into())
}

#[cfg(target_os = "macos")]
pub async fn appearance(view: &Webview, scheme: super::tools::ColorScheme) -> Result<()> {
    use super::tools::ColorScheme;
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    };

    let (sender, receiver) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        if sender.is_closed() {
            return;
        }
        // The appearance is retained for the duration of the native setter.
        unsafe {
            let webview = &*platform.inner().cast::<objc2_web_kit::WKWebView>();
            let appearance = match scheme {
                ColorScheme::Light => NSAppearance::appearanceNamed(NSAppearanceNameAqua),
                ColorScheme::Dark => NSAppearance::appearanceNamed(NSAppearanceNameDarkAqua),
                ColorScheme::System => None,
            };
            webview.setAppearance(appearance.as_deref());
        }
        let _ = sender.send(());
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(3), receiver)
        .await
        .map_err(|_| "Preview appearance change timed out.".to_owned())?
        .map_err(|_| "Preview closed during appearance change.".to_owned())
}

#[cfg(not(target_os = "macos"))]
pub async fn appearance(_view: &Webview, _scheme: super::tools::ColorScheme) -> Result<()> {
    Err("Native preview appearance is currently supported on macOS.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluation_decodes_only_primitive_string_envelopes() {
        let raw =
            serde_json::to_string(r#"[true,{"value":"hello\nworld","finite":null}]"#).unwrap();
        assert_eq!(
            decode_evaluation(&raw).unwrap(),
            serde_json::json!({"value":"hello\nworld","finite":null})
        );
        for raw in [
            r#"{"value":42}"#,
            r#"[true,42]"#,
            r#""[false,\"failed\"]""#,
            r#""[true,NaN]""#,
            "",
        ] {
            assert!(decode_evaluation(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn evaluation_bounds_decoded_json_without_rejecting_escaped_values() {
        let text = "\\".repeat(30_000);
        let encoded = serde_json::to_string(&(true, &text)).unwrap();
        let raw = serde_json::to_string(&encoded).unwrap();
        assert!(raw.len() > 70_000);
        assert_eq!(decode_evaluation(&raw).unwrap(), serde_json::json!(text));
        let encoded = serde_json::to_string(&(true, "x".repeat(70_000))).unwrap();
        assert_eq!(
            decode_evaluation(&serde_json::to_string(&encoded).unwrap()).unwrap_err(),
            "Preview evaluation response exceeded 70 KB."
        );
    }

    #[tokio::test]
    async fn evaluation_waits_for_the_first_commit_and_reuses_it() {
        let (committed, receiver) = tokio::sync::watch::channel(false);
        let waiter = tokio::spawn(async move {
            wait_for_initial_commit(receiver).await?;
            Ok::<_, String>("evaluated")
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        committed.send_replace(true);
        assert_eq!(waiter.await.unwrap().unwrap(), "evaluated");
        wait_for_initial_commit(committed.subscribe())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cancelled_evaluation_never_resumes_after_a_later_commit() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (committed, receiver) = tokio::sync::watch::channel(false);
        let evaluations = Arc::new(AtomicUsize::new(0));
        let observed = evaluations.clone();
        let waiter = tokio::spawn(async move {
            wait_for_initial_commit(receiver).await.unwrap();
            observed.fetch_add(1, Ordering::SeqCst);
        });
        tokio::task::yield_now().await;
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        committed.send_replace(true);
        tokio::task::yield_now().await;
        assert_eq!(evaluations.load(Ordering::SeqCst), 0);
        wait_for_initial_commit(committed.subscribe())
            .await
            .unwrap();
        evaluations.fetch_add(1, Ordering::SeqCst);
        assert_eq!(evaluations.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn closing_an_uncommitted_view_refuses_the_waiting_evaluation() {
        let (committed, receiver) = tokio::sync::watch::channel(false);
        let waiter = tokio::spawn(wait_for_initial_commit(receiver));
        drop(committed);
        assert_eq!(
            waiter.await.unwrap().unwrap_err(),
            "Preview was closed before evaluation."
        );
    }
}
