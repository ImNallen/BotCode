// Ported from pingdotgg/t3code v0.0.45 apps/server/src/provider/Layers/CodexAdapter.ts (MIT).
use crate::domain::{
    NativeAppRef, ToolIcon, ToolPresentation, ToolSource, ToolSourceKind, ToolSurface,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_URL: usize = 4096;
const MAX_KEY: usize = 512;

fn js_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn http_url(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    if js_len(value) > MAX_URL {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    let href = url.as_str();
    (matches!(url.scheme(), "http" | "https") && js_len(href) <= MAX_URL).then(|| href.to_owned())
}

fn image_url(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    if js_len(value) > MAX_URL {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    matches!(url.scheme(), "http" | "https" | "data").then(|| url.as_str().to_owned())
}

fn app_id(value: Option<&Value>) -> Option<String> {
    let id = value?.as_str()?.trim();
    (!id.is_empty()
        && id.len() <= MAX_KEY
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
    .then(|| id.to_owned())
}

pub(crate) fn display_name(value: Option<&Value>) -> Option<String> {
    let name = value?
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!name.is_empty() && js_len(&name) <= 160).then_some(name)
}

fn source_key_part(value: &str) -> String {
    value.trim().to_lowercase()
}

fn native_app_source_key(app_id: &str) -> String {
    let key = format!("native-app:{}", app_id.to_lowercase());
    if key.len() <= MAX_KEY {
        return key;
    }
    let digest = Sha256::digest(key.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{}:{digest}", &key[..MAX_KEY - digest.len() - 1])
}

fn browser_display_name(value: Option<&Value>) -> Option<String> {
    let name = display_name(value)?;
    let lower = name.to_lowercase();
    let known = if lower.contains("chrome") || lower == "chromium" {
        "Chrome"
    } else if lower.contains("edge") {
        "Microsoft Edge"
    } else if lower.contains("firefox") {
        "Firefox"
    } else if lower.contains("safari") {
        "Safari"
    } else if lower.contains("arc") {
        "Arc"
    } else if lower == "iab" || lower.contains("in-app") {
        "Browser"
    } else {
        return Some(name);
    };
    Some(known.to_owned())
}

fn browser_native_app(name: &str) -> Option<NativeAppRef> {
    let display_name = match name {
        "Chrome" => "Google Chrome",
        "Microsoft Edge" | "Firefox" | "Safari" | "Arc" => name,
        _ => return None,
    };
    Some(NativeAppRef::DisplayName {
        display_name: display_name.to_owned(),
    })
}

pub(crate) fn app_display_name_from_id(app_id: &str) -> Option<&'static str> {
    Some(match app_id.to_lowercase().as_str() {
        "com.apple.finder" => "Finder",
        "com.apple.safari" => "Safari",
        "com.google.chrome" => "Chrome",
        "com.microsoft.edgemac" => "Microsoft Edge",
        "org.mozilla.firefox" => "Firefox",
        "company.thebrowser.browser" => "Arc",
        _ => return None,
    })
}

fn native_app(value: Option<&Value>) -> Option<NativeAppRef> {
    let app = value?;
    match app.get("kind")?.as_str()? {
        "appId" => Some(NativeAppRef::AppId {
            app_id: app_id(app.get("appId"))?,
        }),
        "displayName" => Some(NativeAppRef::DisplayName {
            display_name: display_name(app.get("displayName"))?,
        }),
        _ => None,
    }
}

fn themed_logo(records: [Option<&Value>; 3]) -> Option<ToolIcon> {
    records.into_iter().flatten().find_map(|record| {
        let logo_url = image_url(record.get("logoUrl"))?;
        Some(ToolIcon::ThemedLogo {
            logo_url,
            logo_url_dark: image_url(record.get("logoUrlDark").or(record.get("logoDarkUrl"))),
        })
    })
}

pub(crate) fn mcp_presentation(item: &Value) -> Option<ToolPresentation> {
    let metadata = item.pointer("/result/_meta").filter(|m| m.is_object());
    let surface = metadata
        .and_then(|m| m.get("codex/toolSurface"))
        .filter(|s| s.is_object())?;
    let app_context = item.get("appContext").filter(|c| c.is_object());
    let source_logo = themed_logo([
        Some(surface),
        metadata
            .and_then(|m| m.get("source"))
            .filter(|s| s.is_object()),
        app_context,
    ]);
    let app_name = app_context.and_then(|c| c.get("appName"));
    match surface.get("kind")?.as_str()? {
        "browserUse" => {
            let screenshot = surface.get("screenshot").filter(|s| s.is_object());
            let browser_use = metadata
                .and_then(|m| m.get("browser_use"))
                .filter(|b| b.is_object());
            let latest_tab = surface
                .get("openTabs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .rev()
                .filter(|tab| tab.is_object())
                .find(|tab| http_url(tab.get("url")).is_some());
            let page = [
                screenshot.map(|s| (s, s.get("pageUrl"))),
                browser_use.map(|b| (b, b.get("url"))),
                latest_tab.map(|t| (t, t.get("url"))),
            ]
            .into_iter()
            .flatten()
            .find_map(|(record, url)| Some((record, http_url(url)?)));
            let name = browser_display_name(app_name)
                .or_else(|| browser_display_name(surface.get("browserFamily")))
                .or_else(|| browser_display_name(surface.get("backend")))
                .unwrap_or_else(|| "Browser".to_owned());
            let source_icon = source_logo
                .or_else(|| browser_native_app(&name).map(|app| ToolIcon::NativeApp { app }));
            let key_part = Some(source_key_part(&name))
                .filter(|part| !part.is_empty())
                .unwrap_or_else(|| "browser".to_owned());
            Some(ToolPresentation {
                surface: ToolSurface::Browser,
                icon: page.map(|(record, page_url)| ToolIcon::Website {
                    page_url,
                    favicon_url: image_url(record.get("faviconUrl").or(record.get("favIconUrl"))),
                    favicon_url_dark: image_url(
                        record
                            .get("faviconUrlDark")
                            .or(record.get("favIconUrlDark")),
                    ),
                }),
                source: ToolSource {
                    key: format!("browser-use:{key_part}"),
                    kind: if name == "Browser" {
                        ToolSourceKind::Browser
                    } else {
                        ToolSourceKind::Integration
                    },
                    name,
                    icon: source_icon,
                },
            })
        }
        "computerUse" => {
            let app = native_app(surface.get("app"));
            let args = item.get("arguments").filter(|a| a.is_object());
            let argument_app = ["appName", "application", "app"]
                .into_iter()
                .find_map(|key| display_name(args?.get(key)));
            let name = display_name(app_name)
                .or(argument_app)
                .or_else(|| match &app {
                    Some(NativeAppRef::DisplayName { display_name }) => Some(display_name.clone()),
                    Some(NativeAppRef::AppId { app_id }) => {
                        app_display_name_from_id(app_id).map(str::to_owned)
                    }
                    None => None,
                })
                .unwrap_or_else(|| "Computer Use".to_owned());
            let key = match &app {
                Some(NativeAppRef::AppId { app_id }) => native_app_source_key(app_id),
                Some(NativeAppRef::DisplayName { display_name }) => {
                    format!("native-app-name:{}", source_key_part(display_name))
                }
                None => "computer-use".to_owned(),
            };
            let app_icon = app.map(|app| ToolIcon::NativeApp { app });
            Some(ToolPresentation {
                surface: ToolSurface::Computer,
                source: ToolSource {
                    key,
                    name,
                    kind: ToolSourceKind::Computer,
                    icon: source_logo.or_else(|| app_icon.clone()),
                },
                icon: app_icon,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn presentation(item: Value) -> Value {
        serde_json::to_value(mcp_presentation(&item)).unwrap()
    }

    #[test]
    fn computer_use_names_the_app_by_bundle_id_and_falls_back_to_computer_use() {
        assert_eq!(
            presentation(json!({
                "type": "mcpToolCall", "id": "call_8fe2acb4d20b46c9a6e59dd236c01a8e",
                "server": "cua_repl", "tool": "js", "status": "completed",
                "arguments": {"code": "var verifyApp = await cua.getApp('dev.l1.code.previewverify');",
                              "title": "Inspect isolated baseline Tauri app"},
                "appContext": null,
                "result": {"content": [{"type": "text", "text": "ok"}], "structuredContent": null,
                           "_meta": {"codex/nodeReplExecutionDurationMs": 748,
                                     "codex/toolSurface": {"app": {"appId": "dev.l1.code.previewverify", "kind": "appId"},
                                                           "kind": "computerUse"}}},
                "durationMs": 752
            })),
            json!({
                "surface": "computer",
                "source": {"key": "native-app:dev.l1.code.previewverify", "name": "Computer Use",
                           "kind": "computer",
                           "icon": {"kind": "native_app", "app": {"kind": "app_id", "appId": "dev.l1.code.previewverify"}}},
                "icon": {"kind": "native_app", "app": {"kind": "app_id", "appId": "dev.l1.code.previewverify"}}
            })
        );
    }

    #[test]
    fn computer_use_names_known_bundle_ids() {
        let value = presentation(json!({
            "type": "mcpToolCall", "id": "call_c", "server": "cua_repl", "tool": "js",
            "status": "completed", "arguments": {"code": "await chrome.getState();"},
            "result": {"content": [], "structuredContent": null,
                       "_meta": {"codex/computerUseChrome": true,
                                 "codex/toolSurface": {"app": {"appId": "com.google.Chrome", "kind": "appId"},
                                                       "kind": "computerUse"}}}
        }));
        assert_eq!(value["source"]["name"], "Chrome");
        assert_eq!(value["source"]["key"], "native-app:com.google.chrome");
    }

    #[test]
    fn computer_use_without_an_app_has_no_icon() {
        assert_eq!(
            presentation(json!({
                "type": "mcpToolCall", "id": "call_n", "server": "cua_repl", "tool": "js",
                "status": "failed", "arguments": {"code": "let app = await cua.getApp(\"glassboard\");"},
                "result": {"content": [{"type": "text", "text": "Invalid app: glassboard"}],
                           "_meta": {"codex/toolSurface": {"app": null, "kind": "computerUse"}}}
            })),
            json!({
                "surface": "computer",
                "source": {"key": "computer-use", "name": "Computer Use", "kind": "computer", "icon": null},
                "icon": null
            })
        );
    }

    #[test]
    fn computer_use_prefers_the_app_context_name_and_its_logo() {
        let value = presentation(json!({
            "type": "mcpToolCall", "id": "call_x", "server": "computer-use", "tool": "click",
            "status": "completed", "arguments": {"app": "Notes"},
            "appContext": {"connectorId": "c", "linkId": null, "resourceUri": null,
                           "appName": "  Safari  ", "actionName": null,
                           "logoUrl": "https://example.com/logo.png",
                           "logoDarkUrl": "https://example.com/logo-dark.png"},
            "result": {"content": [], "_meta": {"codex/toolSurface": {
                "kind": "computerUse", "app": {"kind": "displayName", "displayName": "Safari"}}}}
        }));
        assert_eq!(value["source"]["name"], "Safari");
        assert_eq!(value["source"]["key"], "native-app-name:safari");
        assert_eq!(
            value["source"]["icon"],
            json!({"kind": "themed_logo", "logoUrl": "https://example.com/logo.png",
                   "logoUrlDark": "https://example.com/logo-dark.png"})
        );
        assert_eq!(
            value["icon"],
            json!({"kind": "native_app", "app": {"kind": "display_name", "displayName": "Safari"}})
        );
    }

    #[test]
    fn browser_use_takes_the_screenshot_page_and_names_the_in_app_browser() {
        assert_eq!(
            presentation(json!({
                "type": "mcpToolCall", "id": "call_68e27098b8664ebc84094ce65f81406d",
                "server": "cua_repl", "tool": "js", "status": "completed",
                "arguments": {"title": "Open shared logo link"},
                "result": {"content": [], "_meta": {
                    "browser_use": {"url": "https://chatgpt.com/s/m_6ac904b5dc5481918fa0cfa7cdb84e4c"},
                    "codex/browserUse": true,
                    "codex/toolSurface": {"backend": "iab", "browserId": "2", "kind": "browserUse",
                                          "openTabIds": ["1"],
                                          "screenshot": {"pageUrl": "https://chatgpt.com", "tabId": "1",
                                                         "url": "data:image/jpeg;base64,/9j/"}}}}
            })),
            json!({
                "surface": "browser",
                "source": {"key": "browser-use:browser", "name": "Browser", "kind": "browser", "icon": null},
                "icon": {"kind": "website", "pageUrl": "https://chatgpt.com/", "faviconUrl": null,
                         "faviconUrlDark": null}
            })
        );
    }

    #[test]
    fn browser_use_without_a_page_keeps_its_source() {
        assert_eq!(
            presentation(json!({
                "type": "mcpToolCall", "id": "call_q", "server": "cua_repl", "tool": "js",
                "status": "completed", "arguments": {},
                "result": {"content": [], "_meta": {"browser_use": {}, "codex/browserUse": true,
                    "codex/toolSurface": {"backend": "iab", "browserId": "1", "kind": "browserUse"}}}
            }))["icon"],
            Value::Null
        );
    }

    #[test]
    fn chrome_browser_use_is_an_integration_with_the_chrome_app_icon_and_tab_favicons() {
        let value = presentation(json!({
            "type": "mcpToolCall", "id": "call_b", "server": "browser", "tool": "navigate",
            "status": "completed", "arguments": {},
            "result": {"content": [], "_meta": {"codex/toolSurface": {
                "kind": "browserUse", "browserFamily": "chrome",
                "openTabs": [
                    {"url": "https://github.com/pingdotgg/t3code", "favIconUrl": "https://github.com/favicon.ico"},
                    {"url": "chrome://newtab"}
                ]}}}
        }));
        assert_eq!(
            value["source"],
            json!({"key": "browser-use:chrome", "name": "Chrome", "kind": "integration",
                   "icon": {"kind": "native_app", "app": {"kind": "display_name", "displayName": "Google Chrome"}}})
        );
        assert_eq!(
            value["icon"],
            json!({"kind": "website", "pageUrl": "https://github.com/pingdotgg/t3code",
                   "faviconUrl": "https://github.com/favicon.ico", "faviconUrlDark": null})
        );
    }

    #[test]
    fn other_mcp_tools_have_no_presentation() {
        assert_eq!(
            presentation(json!({
                "type": "mcpToolCall", "id": "m", "server": "node_repl", "tool": "js",
                "result": {"content": [], "_meta": {"codex/nodeReplExecutionDurationMs": 0}}
            })),
            Value::Null
        );
    }

    #[test]
    fn long_bundle_ids_hash_into_a_bounded_source_key() {
        let key = native_app_source_key(&"a".repeat(600));
        assert_eq!(key.len(), 512);
        assert!(key.starts_with("native-app:aaa"));
    }
}
