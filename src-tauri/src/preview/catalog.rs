// Adapted from T3 v0.0.45 apps/server/src/mcp/toolkits/preview/tools.ts.
use bot_core::{ToolAnnotations, ToolSpec};
use serde_json::{Value, json};

pub fn specs() -> Vec<ToolSpec> {
    let target = json!({
        "ref": {"type":"string","maxLength":128,"description":"Reference from this conversation's latest snapshot."},
        "selector": {"type":"string","maxLength":2048,"description":"Strict CSS selector matching one visible element."}
    });
    let mut click = schema(target.clone());
    click["oneOf"] = json!([{"required":["ref"]},{"required":["selector"]}]);
    let mut typing = click.clone();
    typing["properties"]["text"] = json!({"type":"string","maxLength":65536});
    typing["properties"]["clear"] = json!({"type":"boolean","default":false});
    typing["required"] = json!(["text"]);
    let mut press = schema(target.clone());
    press["not"] = json!({"required":["ref","selector"]});
    press["properties"]["key"] = json!({"type":"string","minLength":1,"maxLength":64});
    press["properties"]["modifiers"] = json!({"type":"array","maxItems":4,"uniqueItems":true,"items":{"enum":["Alt","Control","Meta","Shift"]}});
    press["required"] = json!(["key"]);
    let mut scroll = schema(target.clone());
    scroll["not"] = json!({"required":["ref","selector"]});
    for axis in ["deltaX", "deltaY"] {
        scroll["properties"][axis] = json!({"type":"number","minimum":-100000,"maximum":100000});
    }
    scroll["anyOf"] = json!([{"required":["deltaX"]},{"required":["deltaY"]}]);
    let mut wait = schema(target);
    wait["not"] = json!({"required":["ref","selector"]});
    wait["properties"]["text"] = json!({"type":"string","minLength":1,"maxLength":8192});
    wait["properties"]["urlIncludes"] = json!({"type":"string","minLength":1,"maxLength":8192});
    wait["properties"]["timeoutMs"] =
        json!({"type":"integer","minimum":0,"maximum":60000,"default":10000});
    wait["anyOf"] = json!([{"required":["ref"]},{"required":["selector"]},{"required":["text"]},{"required":["urlIncludes"]}]);
    let mut resize = schema(json!({
        "mode":{"enum":["fill","freeform","preset"]},
        "width":{"type":"integer","minimum":240,"maximum":3840},
        "height":{"type":"integer","minimum":160,"maximum":2160},
        "preset":{"enum":["desktop","tablet","mobile"]},
        "orientation":{"enum":["portrait","landscape"]}
    }));
    resize["required"] = json!(["mode"]);
    resize["oneOf"] = json!([
        {"properties":{"mode":{"const":"fill"}},"not":{"anyOf":[{"required":["width"]},{"required":["height"]},{"required":["preset"]},{"required":["orientation"]}]}},
        {"properties":{"mode":{"const":"freeform"}},"required":["width","height"],"not":{"anyOf":[{"required":["preset"]},{"required":["orientation"]}]}},
        {"properties":{"mode":{"const":"preset"}},"required":["preset"],"not":{"anyOf":[{"required":["width"]},{"required":["height"]}]}}
    ]);
    [
        ("status", "Report this conversation's one preview, visibility, page state and measured CSS viewport. Does not create a browser.", schema(json!({})), true, false, true),
        ("open", "Open or reuse this conversation's one browser. URL must be credential-free HTTP/HTTPS; omit it to reuse or initialize a blank page. open defaults true; false works in the background. Never switches conversations.", schema(json!({"url":{"type":"string","maxLength":8192},"open":{"type":"boolean","default":true}})), false, true, false),
        ("navigate", "Navigate this conversation's preview to a credential-free HTTP/HTTPS URL without opening its panel. May discard page state.", required(schema(json!({"url":{"type":"string","maxLength":8192}})), &["url"]), false, true, false),
        ("snapshot", "Read a bounded main-frame semantic snapshot and current element refs. Password values are excluded. includeImage defaults true for a PNG on macOS; use false for DOM only. save optionally writes a generated PNG under the app data directory. Frames and shadow roots are not traversed.", schema(json!({"includeImage":{"type":"boolean","default":true},"save":{"type":"boolean","default":false}})), true, false, false),
        ("click", "DOM-click exactly one visible enabled target using a current snapshot ref or CSS selector. Scrolls into view and focuses it. Events are untrusted; trusted-input-only behavior is not guaranteed.", click, false, true, false),
        ("type", "Insert literal text into one visible editable text input, textarea or contenteditable using a current ref or CSS selector. clear defaults false. Dispatches cancelable beforeinput and input/change events. Text is limited to 64 KB.", typing, false, true, false),
        ("press", "Dispatch untrusted keydown/keyup to a ref, CSS target or active element. Common defaults support Enter, Tab, Escape and text input/textarea editing and caret keys. Unsupported defaults return errors. Modifiers run page handlers only; OS shortcuts and trusted input are unsupported.", press, false, true, false),
        ("scroll", "Scroll the window or one visible ref/CSS container by finite nonzero CSS deltas. Returns its actual scroll position.", scroll, false, false, false),
        ("resize", "Set CSS layout to fill, freeform, or desktop 1280x720, tablet 768x1024, mobile 375x667 preset. Preset orientation swaps dimensions. Returns measured viewport. Desktop user agent remains; this is not device emulation.", resize, false, false, true),
        ("evaluate", "Evaluate a synchronous JavaScript expression in this preview's main frame. May mutate the page. Returns {value}; expression and serialized value each have a 64 KB limit. Promises/thenables, cycles and BigInt are unsupported.", required(schema(json!({"expression":{"type":"string","minLength":1,"maxLength":65536}})), &["expression"]), false, true, false),
        ("wait_for", "Wait until every supplied condition matches. A ref/CSS target must be uniquely visible; text is searched within it or the body, and urlIncludes in the URL. At least one condition is required. Stale refs fail immediately. timeoutMs defaults 10000 and is capped at 60000.", wait, true, false, true),
        ("set_appearance", "Set the preview's native light/dark appearance or clear the override with system. Verifies page color-scheme media queries. Currently supported on macOS only.", required(schema(json!({"colorScheme":{"enum":["light","dark","system"]}})), &["colorScheme"]), false, false, true),
    ]
    .into_iter()
    .map(|(name, description, input_schema, read_only_hint, destructive_hint, idempotent_hint)| ToolSpec {
        name: format!("preview_{name}"),
        description: description.into(),
        input_schema,
        annotations: ToolAnnotations { read_only_hint, destructive_hint, idempotent_hint, open_world_hint: true },
    })
    .collect()
}

fn schema(properties: Value) -> Value {
    json!({"type":"object","properties":properties,"additionalProperties":false})
}

fn required(mut schema: Value, fields: &[&str]) -> Value {
    schema["required"] = json!(fields);
    schema
}
