// Ported from T3 v0.0.45 apps/desktop/src/preview/Manager.ts; native scope and lease adaptation.
use std::collections::HashMap;

use bot_core::{ThreadId, WorkspaceId};
use serde::{Deserialize, Serialize};
use tauri::Url;

pub type Result<T> = std::result::Result<T, String>;
const VIEW_LIMIT: usize = 16;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum PreviewScope {
    Thread {
        #[serde(rename = "threadId")]
        thread_id: ThreadId,
    },
    Draft {
        #[serde(rename = "workspaceId")]
        workspace_id: WorkspaceId,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

impl Viewport {
    pub fn validate(self) -> Result<Self> {
        if !(240..=3840).contains(&self.width) || !(160..=2160).contains(&self.height) {
            return Err("Preview viewport must be 240..3840 by 160..2160 CSS pixels.".into());
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn validate(self) -> Result<Self> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|value| !value.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || !(1.0..=8192.0).contains(&self.width)
            || !(1.0..=8192.0).contains(&self.height)
        {
            return Err(
                "Preview bounds must be finite positive logical pixels inside the window.".into(),
            );
        }
        Ok(self)
    }

    pub fn clip(self, width: f64, height: f64) -> Option<Self> {
        let clipped_width = self.width.min(width - self.x);
        let clipped_height = self.height.min(height - self.y);
        (clipped_width >= 1.0 && clipped_height >= 1.0).then_some(Self {
            width: clipped_width,
            height: clipped_height,
            ..self
        })
    }
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewState {
    pub url: Option<String>,
    pub title: String,
    pub loading: bool,
    pub error: Option<String>,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub viewport: Option<Viewport>,
    pub measured_viewport: Option<Viewport>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Navigation {
    Url { url: String },
    Back {},
    Forward {},
    Reload {},
}

pub fn parse_url(raw: &str) -> Result<Url> {
    if raw.len() > 8192 {
        return Err("Preview URL exceeds 8192 bytes.".into());
    }
    let url = Url::parse(raw).map_err(|_| "Enter an HTTP or HTTPS URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Preview only opens HTTP and HTTPS URLs.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Preview URLs cannot contain credentials.".into());
    }
    Ok(url)
}

pub struct Entry {
    pub label: Option<String>,
    pub state: PreviewState,
    pub navigation: u64,
    pub pending_url: Option<String>,
    touched: u64,
}

pub struct Attachment {
    pub lease: u32,
    pub scope: PreviewScope,
    pub sequence: u32,
    pub rect: Option<Rect>,
    pub visible: bool,
}

#[derive(Default)]
pub struct Model {
    pub entries: HashMap<PreviewScope, Entry>,
    pub attachment: Option<Attachment>,
    clock: u64,
    next_lease: u32,
    next_view: u32,
}

impl Model {
    pub fn ensure(&mut self, scope: &PreviewScope) -> Result<Option<String>> {
        self.clock = self
            .clock
            .checked_add(1)
            .ok_or("Preview clock exhausted.")?;
        if let Some(entry) = self.entries.get_mut(scope) {
            entry.touched = self.clock;
            return Ok(None);
        }
        let evicted = if self.entries.len() >= VIEW_LIMIT {
            let victim = self
                .entries
                .iter()
                .filter(|(scope, _)| self.attachment.as_ref().is_none_or(|a| &a.scope != *scope))
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(scope, _)| scope.clone())
                .ok_or(
                    "Every preview is attached. Close a panel before opening another preview.",
                )?;
            self.entries.remove(&victim).and_then(|entry| entry.label)
        } else {
            None
        };
        self.entries.insert(
            scope.clone(),
            Entry {
                label: None,
                state: PreviewState::default(),
                navigation: 0,
                pending_url: None,
                touched: self.clock,
            },
        );
        Ok(evicted)
    }

    pub fn state(&self, scope: &PreviewScope) -> PreviewState {
        self.entries
            .get(scope)
            .map(|entry| entry.state.clone())
            .unwrap_or_default()
    }

    pub fn attach(&mut self, scope: PreviewScope) -> Result<u32> {
        self.next_lease = self
            .next_lease
            .checked_add(1)
            .ok_or("Preview lease exhausted.")?;
        self.attachment = Some(Attachment {
            lease: self.next_lease,
            scope,
            sequence: 0,
            rect: None,
            visible: false,
        });
        Ok(self.next_lease)
    }

    pub fn layout(&mut self, lease: u32, sequence: u32, rect: Option<Rect>, visible: bool) -> bool {
        let Some(attachment) = self.attachment.as_mut() else {
            return false;
        };
        if attachment.lease != lease || sequence <= attachment.sequence {
            return false;
        }
        attachment.sequence = sequence;
        attachment.rect = rect;
        attachment.visible = visible && rect.is_some();
        true
    }

    pub fn detach(&mut self, lease: u32) -> bool {
        if self
            .attachment
            .as_ref()
            .is_some_and(|attachment| attachment.lease == lease)
        {
            self.attachment = None;
            true
        } else {
            false
        }
    }

    pub fn next_label(&mut self) -> Result<String> {
        self.next_view = self
            .next_view
            .checked_add(1)
            .ok_or("Preview identity exhausted.")?;
        Ok(format!("preview-{}", self.next_view))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub rect: Rect,
    pub zoom: f64,
}

pub fn geometry(host: Rect, viewport: Option<Viewport>) -> Geometry {
    let Some(viewport) = viewport else {
        return Geometry {
            rect: host,
            zoom: 1.0,
        };
    };
    let zoom = (host.width / f64::from(viewport.width))
        .min(host.height / f64::from(viewport.height))
        .min(1.0);
    let width = f64::from(viewport.width) * zoom;
    let height = f64::from(viewport.height) * zoom;
    let native_zoom = zoom as f32;
    let native_zoom = if f64::from(native_zoom) > zoom {
        native_zoom.next_down()
    } else {
        native_zoom
    };
    Geometry {
        rect: Rect {
            x: host.x + (host.width - width) / 2.0,
            y: host.y,
            width,
            height,
        },
        zoom: f64::from(native_zoom),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> PreviewScope {
        PreviewScope::Thread {
            thread_id: ThreadId::default(),
        }
    }

    #[test]
    fn stale_cleanup_and_layout_cannot_hide_a_new_mount() {
        let mut model = Model::default();
        let scope = scope();
        let old = model.attach(scope.clone()).unwrap();
        let new = model.attach(scope).unwrap();
        let rect = Rect {
            x: 400.0,
            y: 100.0,
            width: 375.0,
            height: 500.0,
        };
        assert!(model.layout(new, 2, Some(rect), true));
        assert!(!model.layout(new, 1, None, false));
        assert!(!model.layout(old, 99, None, false));
        assert!(!model.detach(old));
        assert!(model.attachment.as_ref().unwrap().visible);
        assert!(model.detach(new));
        assert!(model.attachment.is_none());
    }

    #[test]
    fn fixed_viewport_fits_and_preserves_css_dimensions() {
        let host = Rect {
            x: 500.0,
            y: 80.0,
            width: 375.0,
            height: 500.0,
        };
        let result = geometry(
            host,
            Some(Viewport {
                width: 1280,
                height: 720,
            }),
        );
        assert_eq!(result.rect.width, 375.0);
        assert_eq!(result.rect.height, 210.9375);
        assert_eq!(result.rect.width / result.zoom, 1280.0);
        assert_eq!(result.rect.height / result.zoom, 720.0);
        assert_eq!(result.rect.y, 80.0);
    }

    #[test]
    fn resource_limit_evicts_old_hidden_views_but_preserves_attached_scope() {
        let mut model = Model::default();
        let active = scope();
        model.ensure(&active).unwrap();
        model.entries.get_mut(&active).unwrap().label = Some("active".into());
        model.attach(active.clone()).unwrap();
        let oldest = scope();
        model.ensure(&oldest).unwrap();
        model.entries.get_mut(&oldest).unwrap().label = Some("oldest".into());
        for _ in 2..VIEW_LIMIT {
            model.ensure(&scope()).unwrap();
        }
        assert_eq!(model.ensure(&scope()).unwrap().as_deref(), Some("oldest"));
        assert_eq!(model.entries.len(), VIEW_LIMIT);
        assert!(model.entries.contains_key(&active));
        assert!(!model.entries.contains_key(&oldest));
    }

    #[test]
    fn boundary_rejects_privileged_schemes_credentials_and_extra_fields() {
        for raw in [
            "file:///tmp/secret",
            "javascript:alert(1)",
            "data:text/html,hi",
            "tauri://localhost",
            "https://user:secret@example.com",
        ] {
            assert!(parse_url(raw).is_err(), "{raw}");
        }
        assert_eq!(
            parse_url("http://localhost:3000").unwrap().as_str(),
            "http://localhost:3000/"
        );
        assert!(
            serde_json::from_value::<Viewport>(
                serde_json::json!({"width": 375,"height": 812,"threadId": "other"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<Navigation>(
                serde_json::json!({"kind":"back","url":"file:///tmp"})
            )
            .is_err()
        );
        assert!(
            Viewport {
                width: 239,
                height: 812
            }
            .validate()
            .is_err()
        );
    }
}
