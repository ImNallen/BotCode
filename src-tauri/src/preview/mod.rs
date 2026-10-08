// Ported from T3 v0.0.45 apps/desktop/src/preview/Manager.ts; Tauri child-webview adapter.
mod discovery;
mod keyboard;
mod model;
mod platform;

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, State, Webview,
    WebviewUrl,
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
};

use model::{Model, Result, geometry, parse_url};
pub use model::{Navigation, PreviewScope, PreviewState, Rect, Viewport};

#[derive(Clone)]
pub struct PreviewManager(Arc<Inner>);

struct Inner {
    app: AppHandle,
    model: Mutex<Model>,
    shortcuts: Mutex<Vec<keyboard::Shortcut>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewEvent {
    scope: PreviewScope,
    state: PreviewState,
    open_panel: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentResult {
    lease: u32,
    state: PreviewState,
}

impl PreviewManager {
    pub fn new(app: AppHandle) -> Self {
        Self(Arc::new(Inner {
            app,
            model: Mutex::new(Model::default()),
            shortcuts: Mutex::new(Vec::new()),
        }))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Model>> {
        self.0
            .model
            .lock()
            .map_err(|_| "Preview state is unavailable.".into())
    }

    async fn on_main<T: Send + 'static>(
        &self,
        operation: impl FnOnce(Self) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let manager = self.clone();
        self.0
            .app
            .run_on_main_thread(move || {
                if !sender.is_closed() {
                    let _ = sender.send(operation(manager));
                }
            })
            .map_err(|error| error.to_string())?;
        tokio::time::timeout(Duration::from_secs(5), receiver)
            .await
            .map_err(|_| "Preview operation timed out.".to_string())?
            .map_err(|_| "Preview application closed.".to_string())?
    }

    fn emit(&self, scope: &PreviewScope, open_panel: bool) {
        if let Ok(model) = self.lock() {
            let event = PreviewEvent {
                scope: scope.clone(),
                state: model.state(scope),
                open_panel,
            };
            drop(model);
            let _ = self
                .0
                .app
                .emit_to(EventTarget::webview("main"), "botcode-preview", event);
        }
    }

    fn ensure(&self, scope: &PreviewScope) -> Result<()> {
        let evicted = self.lock()?.ensure(scope)?;
        if let Some(view) = evicted.and_then(|label| self.0.app.get_webview(&label)) {
            keyboard::remove_view(view.label());
            view.close().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn view(&self, scope: &PreviewScope) -> Result<Webview> {
        let label = self
            .lock()?
            .entries
            .get(scope)
            .and_then(|entry| entry.label.clone());
        label
            .and_then(|label| self.0.app.get_webview(&label))
            .ok_or_else(|| "Open a URL in this preview first.".into())
    }

    pub fn state(&self, scope: &PreviewScope) -> Result<PreviewState> {
        Ok(self.lock()?.state(scope))
    }

    pub async fn current_state(&self, scope: &PreviewScope) -> Result<PreviewState> {
        let identity = self
            .lock()?
            .entries
            .get(scope)
            .and_then(|entry| Some((entry.label.clone()?, entry.navigation)));
        if let Some((label, navigation)) = identity
            && let Some(view) = self.0.app.get_webview(&label)
        {
            self.refresh(scope, &label, navigation, &view).await;
        }
        self.state(scope)
    }

    fn poll_attachment(&self, scope: PreviewScope, lease: u32) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let active = manager.lock().ok().is_some_and(|model| {
                    model
                        .attachment
                        .as_ref()
                        .is_some_and(|attachment| attachment.lease == lease)
                });
                if !active {
                    return;
                }
                let _ = manager.current_state(&scope).await;
            }
        });
    }

    pub async fn open(&self, scope: PreviewScope, raw_url: String) -> Result<PreviewState> {
        let url = parse_url(&raw_url)?;
        let prepare_scope = scope.clone();
        let requested_url = url.to_string();
        let navigation = self
            .on_main(move |manager| {
                manager.ensure(&prepare_scope)?;
                let navigation = {
                    let mut model = manager.lock()?;
                    let entry = model
                        .entries
                        .get_mut(&prepare_scope)
                        .ok_or("Preview scope disappeared.")?;
                    entry.navigation = entry
                        .navigation
                        .checked_add(1)
                        .ok_or("Preview navigation exhausted.")?;
                    entry.state.url = Some(requested_url.clone());
                    entry.pending_url = Some(requested_url);
                    entry.state.loading = true;
                    entry.state.error = None;
                    entry.navigation
                };
                manager.emit(&prepare_scope, true);
                Ok(navigation)
            })
            .await?;
        let ready = discovery::wait_local_ready(&url).await;
        let manager_scope = scope.clone();
        self.on_main(move |manager| {
            let current = manager
                .lock()?
                .entries
                .get(&manager_scope)
                .map(|entry| entry.navigation);
            if current != Some(navigation) {
                return manager.state(&manager_scope);
            }
            if !ready {
                {
                    let mut model = manager.lock()?;
                    let entry = model
                        .entries
                        .get_mut(&manager_scope)
                        .ok_or("Preview scope disappeared.")?;
                    entry.state.loading = false;
                    entry.pending_url = None;
                    entry.state.error = Some(
                        "Local server is not listening yet. Start it and reload the preview."
                            .into(),
                    );
                }
                manager.apply_layout()?;
                manager.emit(&manager_scope, false);
                return manager.state(&manager_scope);
            }
            match manager.view(&manager_scope) {
                Ok(view) => {
                    view.navigate(url).map_err(|error| error.to_string())?;
                }
                Err(_) => {
                    manager.create(&manager_scope, url)?;
                }
            }
            manager.apply_layout()?;
            if let Ok(view) = manager.view(&manager_scope) {
                manager.watch_requested(
                    manager_scope.clone(),
                    view.label().to_owned(),
                    navigation,
                    view,
                );
            }
            manager.emit(&manager_scope, false);
            manager.state(&manager_scope)
        })
        .await
    }

    fn create(&self, scope: &PreviewScope, url: tauri::Url) -> Result<()> {
        let label = self.lock()?.next_label()?;
        {
            let mut model = self.lock()?;
            let entry = model
                .entries
                .get_mut(scope)
                .ok_or("Preview scope disappeared.")?;
            entry.label = Some(label.clone());
        }
        let navigation_manager = self.clone();
        let navigation_scope = scope.clone();
        let navigation_label = label.clone();
        let window_manager = self.clone();
        let window_scope = scope.clone();
        let load_manager = self.clone();
        let load_scope = scope.clone();
        let load_label = label.clone();
        let title_manager = self.clone();
        let title_scope = scope.clone();
        let title_label = label.clone();
        let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
            .incognito(true)
            .focused(false)
            .zoom_hotkeys_enabled(false)
            .on_navigation(move |url| {
                if parse_url(url.as_str()).is_ok() {
                    return true;
                }
                navigation_manager.set_error(
                    &navigation_scope,
                    &navigation_label,
                    "Navigation was refused. Preview only opens HTTP and HTTPS URLs.",
                );
                false
            })
            .on_new_window(move |url, _| {
                if parse_url(url.as_str()).is_ok() {
                    let manager = window_manager.clone();
                    let scope = window_scope.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = manager.open(scope, url.to_string()).await;
                    });
                }
                NewWindowResponse::Deny
            })
            .on_download(|_, event| !matches!(event, DownloadEvent::Requested { .. }))
            .on_page_load(move |view, payload| {
                load_manager.page_load(
                    &load_scope,
                    &load_label,
                    &view,
                    payload.event(),
                    payload.url().as_str(),
                );
            })
            .on_document_title_changed(move |_, title| {
                if let Ok(mut model) = title_manager.lock()
                    && let Some(entry) = model.entries.get_mut(&title_scope)
                    && entry.label.as_deref() == Some(title_label.as_str())
                {
                    entry.state.title = title.chars().take(512).collect();
                    drop(model);
                    title_manager.emit(&title_scope, false);
                }
            });
        let window = self
            .0
            .app
            .get_window("main")
            .ok_or("Main window is unavailable.")?;
        let result = window.add_child(
            builder,
            LogicalPosition::new(-10_000.0, 60.0),
            LogicalSize::new(1280.0, 720.0),
        );
        match result {
            Ok(view) => {
                view.hide().map_err(|error| error.to_string())?;
                keyboard::register(self.clone(), &view)?;
                view.set_size(LogicalSize::new(1280.0, 720.0))
                    .map_err(|error| error.to_string())?;
                Ok(())
            }
            Err(error) => {
                if let Some(entry) = self.lock()?.entries.get_mut(scope) {
                    entry.label = None;
                    entry.state.loading = false;
                    entry.pending_url = None;
                    entry.state.error = Some(error.to_string());
                }
                Err(error.to_string())
            }
        }
    }

    fn set_error(&self, scope: &PreviewScope, label: &str, error: &str) {
        self.set_navigation_error(scope, label, None, error);
    }

    fn set_navigation_error(
        &self,
        scope: &PreviewScope,
        label: &str,
        navigation: Option<u64>,
        error: &str,
    ) {
        if let Ok(mut model) = self.lock()
            && let Some(entry) = model.entries.get_mut(scope)
            && entry.label.as_deref() == Some(label)
            && navigation.is_none_or(|navigation| entry.navigation == navigation)
        {
            entry.state.error = Some(error.to_owned());
            entry.state.loading = false;
            entry.pending_url = None;
            drop(model);
            self.emit(scope, false);
            let manager = self.clone();
            let _ = self.0.app.run_on_main_thread(move || {
                let _ = manager.apply_layout();
            });
        }
    }

    fn page_load(
        &self,
        scope: &PreviewScope,
        label: &str,
        view: &Webview,
        event: PageLoadEvent,
        url: &str,
    ) {
        let navigation = {
            let Ok(mut model) = self.lock() else {
                return;
            };
            let Some(entry) = model.entries.get_mut(scope) else {
                return;
            };
            if entry.label.as_deref() != Some(label) {
                return;
            }
            if event == PageLoadEvent::Started {
                entry.navigation = entry.navigation.saturating_add(1);
                entry.state.loading = true;
                entry.pending_url = None;
                entry.state.error = None;
            }
            if parse_url(url).is_ok() {
                entry.state.url = Some(url.to_owned());
            }
            entry.navigation
        };
        self.emit(scope, false);
        let manager = self.clone();
        let scope = scope.clone();
        let label = label.to_owned();
        let view = view.clone();
        tauri::async_runtime::spawn(async move {
            if event == PageLoadEvent::Finished {
                manager.refresh(&scope, &label, navigation, &view).await;
                return;
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                if !manager.refresh(&scope, &label, navigation, &view).await {
                    return;
                }
            }
            manager.set_navigation_error(
                &scope,
                &label,
                Some(navigation),
                "The page did not finish loading. Check the address and reload.",
            );
        });
    }

    fn watch_requested(&self, scope: PreviewScope, label: String, navigation: u64, view: Webview) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let pending = manager.lock().ok().is_some_and(|model| {
                    model.entries.get(&scope).is_some_and(|entry| {
                        entry.label.as_deref() == Some(label.as_str())
                            && entry.navigation == navigation
                            && entry.pending_url.is_some()
                    })
                });
                if !pending {
                    return;
                }
                if tokio::time::Instant::now() >= deadline {
                    manager.set_navigation_error(
                        &scope,
                        &label,
                        Some(navigation),
                        "The page did not load. Check the address and reload.",
                    );
                    return;
                }
                manager.refresh(&scope, &label, navigation, &view).await;
            }
        });
    }

    async fn refresh(
        &self,
        scope: &PreviewScope,
        label: &str,
        navigation: u64,
        view: &Webview,
    ) -> bool {
        let state = platform::browser_state(view).await;
        let measured = platform::measured_viewport(view).await.ok();
        let Ok(state) = state else {
            return false;
        };
        let Ok(mut model) = self.lock() else {
            return false;
        };
        let Some(entry) = model.entries.get_mut(scope) else {
            return false;
        };
        if entry.label.as_deref() != Some(label) || entry.navigation != navigation {
            return false;
        }
        if entry.state.error.is_some() && state.url != entry.state.url {
            return false;
        }
        let previous = entry.state.clone();
        let valid_url = state
            .url
            .as_deref()
            .is_some_and(|url| parse_url(url).is_ok());
        if let Some(pending) = entry.pending_url.as_deref() {
            if state.url.as_deref() == Some(pending) && !state.loading && measured.is_some() {
                entry.pending_url = None;
            } else {
                return true;
            }
        }
        if valid_url {
            entry.state.url = state.url;
        }
        entry.state.title = state.title.chars().take(512).collect();
        entry.state.loading = state.loading;
        entry.state.can_go_back = state.can_go_back;
        entry.state.can_go_forward = state.can_go_forward;
        entry.state.measured_viewport = measured;
        let failed = !state.loading && (!valid_url || entry.state.measured_viewport.is_none());
        if failed {
            entry.state.error =
                Some("The page could not load. Check the address and reload.".into());
        }
        let loading = entry.state.loading;
        let changed = entry.state != previous;
        drop(model);
        if changed {
            self.emit(scope, false);
        }
        if failed {
            let manager = self.clone();
            let _ = self.0.app.run_on_main_thread(move || {
                let _ = manager.apply_layout();
            });
        }
        loading
    }

    pub async fn navigate(&self, scope: PreviewScope, action: Navigation) -> Result<PreviewState> {
        if let Navigation::Url { url } = action {
            return self.open(scope, url).await;
        }
        if matches!(action, Navigation::Reload { .. }) {
            let state = self.state(&scope)?;
            if (state.error.is_some() || self.view(&scope).is_err())
                && let Some(url) = state.url
            {
                return self.open(scope, url).await;
            }
        }
        let view = self.view(&scope)?;
        match action {
            Navigation::Back { .. } => platform::history(&view, false).await?,
            Navigation::Forward { .. } => platform::history(&view, true).await?,
            Navigation::Reload { .. } => view.reload().map_err(|error| error.to_string())?,
            Navigation::Url { .. } => unreachable!(),
        }
        self.state(&scope)
    }

    pub async fn viewport(
        &self,
        scope: PreviewScope,
        viewport: Option<Viewport>,
    ) -> Result<PreviewState> {
        let viewport = viewport.map(Viewport::validate).transpose()?;
        let result_scope = scope.clone();
        self.on_main(move |manager| {
            manager.ensure(&scope)?;
            manager
                .lock()?
                .entries
                .get_mut(&scope)
                .ok_or("Preview scope disappeared.")?
                .state
                .viewport = viewport;
            manager.apply_layout()?;
            manager.state(&scope)
        })
        .await?;
        if let Ok(view) = self.view(&result_scope) {
            let measured = platform::measured_viewport(&view).await.ok();
            if let Some(entry) = self.lock()?.entries.get_mut(&result_scope)
                && entry.label.as_deref() == Some(view.label())
            {
                entry.state.measured_viewport = measured;
            }
        }
        self.emit(&result_scope, false);
        self.state(&result_scope)
    }

    pub async fn attach(&self, scope: PreviewScope) -> Result<AttachmentResult> {
        self.on_main(move |manager| {
            manager.ensure(&scope)?;
            let result = {
                let mut model = manager.lock()?;
                AttachmentResult {
                    lease: model.attach(scope.clone())?,
                    state: model.state(&scope),
                }
            };
            manager.apply_layout()?;
            manager.poll_attachment(scope, result.lease);
            Ok(result)
        })
        .await
    }

    pub async fn layout(
        &self,
        lease: u32,
        sequence: u32,
        rect: Option<Rect>,
        visible: bool,
    ) -> Result<()> {
        let rect = rect.map(Rect::validate).transpose()?;
        self.on_main(move |manager| {
            if manager.lock()?.layout(lease, sequence, rect, visible) {
                manager.apply_layout()?;
            }
            Ok(())
        })
        .await
    }

    pub async fn detach(&self, lease: u32) -> Result<()> {
        self.on_main(move |manager| {
            if manager.lock()?.detach(lease) {
                manager.apply_layout()?;
            }
            Ok(())
        })
        .await
    }

    #[cfg(target_os = "macos")]
    fn visible_label(&self) -> Option<(String, PreviewScope)> {
        let model = self.lock().ok()?;
        let attachment = model
            .attachment
            .as_ref()
            .filter(|a| a.visible && a.rect.is_some())?;
        let entry = model.entries.get(&attachment.scope)?;
        if entry.state.error.is_some() {
            return None;
        }
        Some((entry.label.clone()?, attachment.scope.clone()))
    }

    fn apply_layout(&self) -> Result<()> {
        let (labels, visible) = {
            let model = self.lock()?;
            let labels = model
                .entries
                .values()
                .filter_map(|entry| {
                    Some((
                        entry.label.clone()?,
                        entry
                            .state
                            .viewport
                            .or(entry.state.measured_viewport)
                            .unwrap_or(Viewport {
                                width: 1280,
                                height: 720,
                            }),
                    ))
                })
                .collect::<Vec<_>>();
            let visible = model
                .attachment
                .as_ref()
                .filter(|a| a.visible)
                .and_then(|a| {
                    let entry = model.entries.get(&a.scope)?;
                    if entry.state.error.is_some() {
                        return None;
                    }
                    Some((
                        a.scope.clone(),
                        entry.label.clone()?,
                        a.rect?,
                        entry.state.viewport,
                        entry.navigation,
                    ))
                });
            (labels, visible)
        };
        let visible_label = visible.as_ref().map(|(_, label, _, _, _)| label.as_str());
        for (label, viewport) in labels {
            if Some(label.as_str()) != visible_label
                && let Some(view) = self.0.app.get_webview(&label)
            {
                view.hide().map_err(|error| error.to_string())?;
                view.set_zoom(1.0).map_err(|error| error.to_string())?;
                view.set_position(LogicalPosition::new(-10_000.0, 60.0))
                    .map_err(|error| error.to_string())?;
                view.set_size(LogicalSize::new(
                    f64::from(viewport.width),
                    f64::from(viewport.height),
                ))
                .map_err(|error| error.to_string())?;
            }
        }
        let Some((scope, label, host, viewport, navigation)) = visible else {
            return Ok(());
        };
        let Some(view) = self.0.app.get_webview(&label) else {
            return Ok(());
        };
        let window = self
            .0
            .app
            .get_window("main")
            .ok_or("Main window is unavailable.")?;
        let size = window
            .inner_size()
            .map_err(|error| error.to_string())?
            .to_logical::<f64>(window.scale_factor().map_err(|error| error.to_string())?);
        let Some(host) = host.clip(size.width, size.height) else {
            view.hide().map_err(|error| error.to_string())?;
            return Ok(());
        };
        let geometry = geometry(host, viewport);
        view.set_zoom(geometry.zoom)
            .map_err(|error| error.to_string())?;
        view.set_position(LogicalPosition::new(geometry.rect.x, geometry.rect.y))
            .map_err(|error| error.to_string())?;
        view.set_size(LogicalSize::new(geometry.rect.width, geometry.rect.height))
            .map_err(|error| error.to_string())?;
        view.show().map_err(|error| error.to_string())?;
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            manager.refresh(&scope, &label, navigation, &view).await;
        });
        Ok(())
    }
}

#[tauri::command]
pub async fn preview_state(
    manager: State<'_, PreviewManager>,
    scope: PreviewScope,
) -> Result<PreviewState> {
    manager.current_state(&scope).await
}

#[tauri::command]
pub async fn preview_open(
    manager: State<'_, PreviewManager>,
    scope: PreviewScope,
    url: String,
) -> Result<PreviewState> {
    manager.open(scope, url).await
}

#[tauri::command]
pub async fn preview_navigate(
    manager: State<'_, PreviewManager>,
    scope: PreviewScope,
    action: Navigation,
) -> Result<PreviewState> {
    manager.navigate(scope, action).await
}

#[tauri::command]
pub async fn preview_viewport(
    manager: State<'_, PreviewManager>,
    scope: PreviewScope,
    viewport: Option<Viewport>,
) -> Result<PreviewState> {
    manager.viewport(scope, viewport).await
}

#[tauri::command]
pub async fn preview_attach(
    manager: State<'_, PreviewManager>,
    scope: PreviewScope,
) -> Result<AttachmentResult> {
    manager.attach(scope).await
}

#[tauri::command]
pub async fn preview_layout(
    manager: State<'_, PreviewManager>,
    lease: u32,
    sequence: u32,
    rect: Option<Rect>,
    visible: bool,
) -> Result<()> {
    manager.layout(lease, sequence, rect, visible).await
}

#[tauri::command]
pub async fn preview_detach(manager: State<'_, PreviewManager>, lease: u32) -> Result<()> {
    manager.detach(lease).await
}

#[tauri::command]
pub async fn preview_discover() -> Vec<discovery::LocalServer> {
    discovery::discover().await
}

#[tauri::command]
pub fn preview_application_shortcuts(
    manager: State<'_, PreviewManager>,
    shortcuts: Vec<keyboard::Shortcut>,
) -> Result<()> {
    keyboard::validate(&shortcuts)?;
    *manager
        .0
        .shortcuts
        .lock()
        .map_err(|_| "Preview shortcut state is unavailable.")? = shortcuts;
    Ok(())
}

pub fn shutdown_keyboard() {
    keyboard::shutdown();
}
