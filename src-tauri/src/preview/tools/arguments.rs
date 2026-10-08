// Ported from T3 Code v0.0.45 apps/server/src/mcp/toolkits/preview/tools.ts.
use std::time::Duration;

use bot_core::ToolCall;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;

use super::super::{
    Viewport,
    model::{Result, parse_url},
};

#[derive(Debug)]
pub(super) enum Operation {
    Status,
    Open { url: Option<tauri::Url>, open: bool },
    Snapshot { image: bool, save: bool },
    Resize(Option<Viewport>),
    Appearance(ColorScheme),
    Dom { name: &'static str, args: Value },
    Wait { args: Value, timeout: Duration },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ColorScheme {
    Light,
    Dark,
    System,
}
impl ColorScheme {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
            Self::System => "system",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Open {
    url: Option<String>,
    open: Option<bool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Navigate {
    url: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    include_image: Option<bool>,
    save: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Appearance {
    color_scheme: ColorScheme,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Click {
    r#ref: Option<String>,
    selector: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Type {
    r#ref: Option<String>,
    selector: Option<String>,
    text: String,
    #[serde(rename = "clear")]
    _clear: Option<bool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Press {
    r#ref: Option<String>,
    selector: Option<String>,
    key: String,
    modifiers: Option<Vec<Modifier>>,
}
#[derive(Debug, Deserialize, PartialEq, Eq)]
enum Modifier {
    Alt,
    Control,
    Meta,
    Shift,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scroll {
    r#ref: Option<String>,
    selector: Option<String>,
    delta_x: Option<f64>,
    delta_y: Option<f64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Evaluate {
    expression: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wait {
    r#ref: Option<String>,
    selector: Option<String>,
    text: Option<String>,
    url_includes: Option<String>,
    timeout_ms: Option<u64>,
}
#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
enum Resize {
    Fill {},
    Freeform {
        width: u32,
        height: u32,
    },
    Preset {
        preset: Preset,
        orientation: Option<Orientation>,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Preset {
    Desktop,
    Tablet,
    Mobile,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Orientation {
    Portrait,
    Landscape,
}

impl Operation {
    pub(super) fn parse(call: ToolCall) -> Result<Self> {
        let args = call.arguments;
        match call.name.as_str() {
            "preview_status" => {
                decode::<Empty>(&args)?;
                Ok(Self::Status)
            }
            "preview_open" => {
                let input: Open = decode(&args)?;
                Ok(Self::Open {
                    url: input.url.map(|url| parse_url(&url)).transpose()?,
                    open: input.open.unwrap_or(true),
                })
            }
            "preview_navigate" => {
                let input: Navigate = decode(&args)?;
                Ok(Self::Open {
                    url: Some(parse_url(&input.url)?),
                    open: false,
                })
            }
            "preview_snapshot" => {
                let input: Snapshot = decode(&args)?;
                Ok(Self::Snapshot {
                    image: input.include_image.unwrap_or(true),
                    save: input.save.unwrap_or(false),
                })
            }
            "preview_resize" => {
                let viewport = match decode::<Resize>(&args)? {
                    Resize::Fill {} => None,
                    Resize::Freeform { width, height } => {
                        Some(Viewport { width, height }.validate()?)
                    }
                    Resize::Preset {
                        preset,
                        orientation,
                    } => {
                        let (width, height) = match preset {
                            Preset::Desktop => (1280, 720),
                            Preset::Tablet => (768, 1024),
                            Preset::Mobile => (375, 667),
                        };
                        let (width, height) = match orientation {
                            Some(Orientation::Landscape) => (width.max(height), width.min(height)),
                            Some(Orientation::Portrait) => (width.min(height), width.max(height)),
                            None => (width, height),
                        };
                        Some(Viewport { width, height })
                    }
                };
                Ok(Self::Resize(viewport))
            }
            "preview_set_appearance" => {
                Ok(Self::Appearance(decode::<Appearance>(&args)?.color_scheme))
            }
            "preview_click" => {
                let input: Click = decode(&args)?;
                target(&input.r#ref, &input.selector, true)?;
                Ok(Self::Dom {
                    name: "click",
                    args,
                })
            }
            "preview_type" => {
                let input: Type = decode(&args)?;
                target(&input.r#ref, &input.selector, true)?;
                bounded(&input.text, "text", 65_536, true)?;
                Ok(Self::Dom { name: "type", args })
            }
            "preview_press" => {
                let input: Press = decode(&args)?;
                target(&input.r#ref, &input.selector, false)?;
                bounded(&input.key, "key", 64, false)?;
                if let Some(modifiers) = &input.modifiers
                    && (modifiers.len() > 4
                        || modifiers
                            .iter()
                            .enumerate()
                            .any(|(index, value)| modifiers[..index].contains(value)))
                {
                    return Err(
                        "modifiers must contain at most four distinct modifier names.".into(),
                    );
                }
                Ok(Self::Dom {
                    name: "press",
                    args,
                })
            }
            "preview_scroll" => {
                let input: Scroll = decode(&args)?;
                target(&input.r#ref, &input.selector, false)?;
                let deltas = [input.delta_x.unwrap_or(0.0), input.delta_y.unwrap_or(0.0)];
                if deltas == [0.0, 0.0]
                    || deltas
                        .iter()
                        .any(|value| !value.is_finite() || value.abs() > 100_000.0)
                {
                    return Err("Provide a nonzero deltaX or deltaY, each within -100000..100000 CSS pixels.".into());
                }
                Ok(Self::Dom {
                    name: "scroll",
                    args,
                })
            }
            "preview_evaluate" => {
                bounded(
                    &decode::<Evaluate>(&args)?.expression,
                    "expression",
                    65_536,
                    false,
                )?;
                Ok(Self::Dom {
                    name: "evaluate",
                    args,
                })
            }
            "preview_wait_for" => {
                let input: Wait = decode(&args)?;
                target(&input.r#ref, &input.selector, false)?;
                if input.r#ref.is_none()
                    && input.selector.is_none()
                    && input.text.is_none()
                    && input.url_includes.is_none()
                {
                    return Err("Provide at least one wait condition.".into());
                }
                for (field, value) in [("text", input.text), ("urlIncludes", input.url_includes)] {
                    if let Some(value) = value {
                        bounded(&value, field, 8192, false)?;
                    }
                }
                let timeout = input.timeout_ms.unwrap_or(10_000);
                if timeout > 60_000 {
                    return Err("timeoutMs must be 0..60000.".into());
                }
                Ok(Self::Wait {
                    args,
                    timeout: Duration::from_millis(timeout),
                })
            }
            _ => Err("Unknown preview tool.".into()),
        }
    }
}

fn decode<T: DeserializeOwned>(args: &Value) -> Result<T> {
    serde_json::from_value(args.clone())
        .map_err(|error| format!("Invalid preview arguments: {error}"))
}

fn bounded(value: &str, name: &str, limit: usize, empty: bool) -> Result<()> {
    if value.len() > limit || (!empty && value.is_empty()) {
        Err(format!(
            "{name} must be {}..{limit} UTF-8 bytes.",
            usize::from(!empty)
        ))
    } else {
        Ok(())
    }
}

fn target(reference: &Option<String>, selector: &Option<String>, required: bool) -> Result<()> {
    if (reference.is_some() && selector.is_some())
        || (required && reference.is_none() && selector.is_none())
    {
        return Err("Pass exactly one current snapshot ref or CSS selector.".into());
    }
    if let Some(reference) = reference {
        bounded(reference, "ref", 128, false)?;
    }
    if let Some(selector) = selector {
        bounded(selector, "selector", 2048, false)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(name: &str, arguments: Value) -> Result<Operation> {
        Operation::parse(ToolCall {
            name: name.into(),
            arguments,
        })
    }

    #[test]
    fn browser_arguments_reject_other_conversations_and_privileged_urls() {
        for (name, mut args) in [
            ("preview_status", json!({})),
            ("preview_open", json!({})),
            ("preview_navigate", json!({"url":"http://localhost:3000"})),
            ("preview_snapshot", json!({"includeImage":false})),
            ("preview_click", json!({"selector":"button"})),
            ("preview_type", json!({"selector":"input","text":"hello"})),
            ("preview_press", json!({"key":"Enter"})),
            ("preview_scroll", json!({"deltaY":100})),
            ("preview_resize", json!({"mode":"fill"})),
            ("preview_evaluate", json!({"expression":"document.title"})),
            ("preview_wait_for", json!({"text":"Ready"})),
            ("preview_set_appearance", json!({"colorScheme":"dark"})),
        ] {
            assert!(parse(name, args.clone()).is_ok(), "{name}");
            args["threadId"] = json!("other");
            assert!(parse(name, args).is_err(), "{name}");
        }
        for url in [
            "about:blank",
            "file:///tmp/private",
            "javascript:alert(1)",
            "https://user:password@example.com",
        ] {
            assert!(parse("preview_open", json!({"url":url})).is_err(), "{url}");
            assert!(
                parse("preview_navigate", json!({"url":url})).is_err(),
                "{url}"
            );
        }
        let Operation::Open { url, open } = parse("preview_open", json!({})).unwrap() else {
            panic!("expected open")
        };
        assert!(url.is_none());
        assert!(open);
        let Operation::Open { url, open } =
            parse("preview_navigate", json!({"url":"http://localhost:3000"})).unwrap()
        else {
            panic!("expected navigation")
        };
        assert_eq!(url.unwrap().as_str(), "http://localhost:3000/");
        assert!(!open);
    }

    #[test]
    fn targets_and_limits_fail_before_a_page_is_called() {
        for (name, args) in [
            ("preview_click", json!({})),
            ("preview_click", json!({"ref":"e1","selector":"button"})),
            (
                "preview_type",
                json!({"selector":"input","text":"é".repeat(32769)}),
            ),
            (
                "preview_type",
                json!({"selector":"input","text":"hello","clear":"yes"}),
            ),
            (
                "preview_press",
                json!({"key":"Enter","modifiers":["Meta","Meta"]}),
            ),
            (
                "preview_press",
                json!({"key":"Enter","modifiers":["Super"]}),
            ),
            ("preview_scroll", json!({"deltaX":0,"deltaY":0})),
            ("preview_scroll", json!({"deltaY":100001})),
            ("preview_wait_for", json!({"timeoutMs":20})),
            (
                "preview_wait_for",
                json!({"text":"Ready","timeoutMs":60001}),
            ),
            ("preview_evaluate", json!({"expression":"x".repeat(65537)})),
        ] {
            assert!(parse(name, args).is_err(), "{name}");
        }
        let Operation::Dom { name, args } = parse(
            "preview_type",
            json!({"ref":"snapshot:e1","text":"hello \"world\"\n"}),
        )
        .unwrap() else {
            panic!("expected DOM operation")
        };
        assert_eq!(name, "type");
        assert_eq!(args["text"], "hello \"world\"\n");
        let Operation::Wait { timeout, .. } =
            parse("preview_wait_for", json!({"text":"Ready","timeoutMs":0})).unwrap()
        else {
            panic!("expected wait")
        };
        assert_eq!(timeout, Duration::ZERO);
        assert!(matches!(
            parse("preview_scroll", json!({"deltaY":-100000})).unwrap(),
            Operation::Dom { name: "scroll", .. }
        ));
    }

    #[test]
    fn resize_variants_reject_irrelevant_fields_and_preserve_preset_orientation() {
        for args in [
            json!({"mode":"fill","width":375}),
            json!({"mode":"freeform","width":375,"height":667,"orientation":"portrait"}),
            json!({"mode":"freeform","width":239,"height":667}),
            json!({"mode":"preset","preset":"mobile","height":667}),
        ] {
            assert!(parse("preview_resize", args).is_err());
        }
        let Operation::Resize(viewport) = parse(
            "preview_resize",
            json!({"mode":"preset","preset":"mobile","orientation":"landscape"}),
        )
        .unwrap() else {
            panic!("expected resize")
        };
        assert_eq!(
            viewport,
            Some(Viewport {
                width: 667,
                height: 375
            })
        );
        let Operation::Resize(viewport) = parse("preview_resize", json!({"mode":"fill"})).unwrap()
        else {
            panic!("expected resize")
        };
        assert_eq!(viewport, None);
    }
}
