//! Tauri adds every plugin's initialization script to every webview, including the Preview and
//! Desktop child webviews that load other sites. There the notification script replaces
//! `window.Notification` and asks for its permission over IPC, and the dialog script replaces
//! `alert` and `confirm` with IPC calls. The capabilities refuse IPC from those views, so the
//! pages saw rejected promises, which noVNC reported as an error.
use tauri::{
    AppHandle, RunEvent, Runtime, Url, Webview, Window, ipc::Invoke, plugin::Plugin,
    webview::PageLoadPayload,
};

pub struct MainViewOnly<P>(pub P);

impl<R: Runtime, P: Plugin<R>> Plugin<R> for MainViewOnly<P> {
    fn name(&self) -> &'static str {
        self.0.name()
    }
    fn initialize(
        &mut self,
        app: &AppHandle<R>,
        config: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.0.initialize(app, config)
    }
    fn initialization_script(&self) -> Option<String> {
        self.0.initialization_script().map(|script| {
            format!(
                "if (window.__TAURI_INTERNALS__.metadata.currentWebview.label === \"main\") {{\n{script}\n}}"
            )
        })
    }
    fn window_created(&mut self, window: Window<R>) {
        self.0.window_created(window)
    }
    fn webview_created(&mut self, webview: Webview<R>) {
        self.0.webview_created(webview)
    }
    fn on_navigation(&mut self, webview: &Webview<R>, url: &Url) -> bool {
        self.0.on_navigation(webview, url)
    }
    fn on_page_load(&mut self, webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
        self.0.on_page_load(webview, payload)
    }
    fn on_event(&mut self, app: &AppHandle<R>, event: &RunEvent) {
        self.0.on_event(app, event)
    }
    fn extend_api(&mut self, invoke: Invoke<R>) -> bool {
        self.0.extend_api(invoke)
    }
}
