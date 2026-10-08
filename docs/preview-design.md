# Preview and agent tool design

## Problem and caller experience

Bot Code needs a browser in its existing right panel and tools bound to the conversation that invoked them. Existing native Codex conversations must gain those tools without losing history. A provider restart must cancel pending calls without repeating a click.

The user opens **Preview** from the right panel, enters a URL, or runs a project script with `previewUrl` and `autoOpenPreview`. The agent calls `preview_open`, `preview_snapshot`, and `preview_click` on that conversation's browser. It registers a PR with `link_pull_request({url})`. Neither tool accepts another conversation's identity as an argument.

## Shape and contracts

The core owns provider-neutral `ToolSpec`, `ToolCall`, `ToolContext`, and `ToolResult` types. Text and image results are distinct variants. One registry supplies names, descriptions, schemas, and dispatch. Existing PR membership storage remains the sole writer for link state. Repeated links and unlinks return whether the association already existed without changing its original source or timestamp.

The desktop starts the same executable in a stdio MCP mode. That mode forwards calls over a private Unix socket to the application owner. A random capability token binds each MCP session to a conversation and provider epoch. The socket has no TCP port and never accepts an agent-supplied conversation ID. The Codex adapter passes the stdio command through thread start, resume, and fork config. The process supervisor owns the MCP child through Codex's process group. The app owner retires tokens and pending requests on provider loss.

`item/tool/call` also decodes into the same registry before approval decoding. The core-only adapter can register dynamic tools when creating a native thread. Codex wire fields stay private. Browser jobs run outside the owner loop with bounded concurrency and deadlines. Their completion must match the captured epoch and turn. The owner never replays an uncertain mutation.

The Tauri adapter owns browser state keyed by conversation or project draft. It embeds a child webview with Tauri's `unstable` multiwebview feature. React owns tab intent and reports measured host geometry. The native manager scales a requested CSS viewport into that rectangle with native zoom. The native view hides whenever the panel is closed, another tab or thread is selected, or a menu or dialog covers it. Page content receives no application IPC privileges. Navigation accepts HTTP and HTTPS only.

Public evaluation callbacks return bounded JSON for semantic snapshots and DOM actions. macOS snapshot bindings capture PNG through WKWebView. DOM automation supports strict CSS selectors and references returned by the current snapshot. It rejects ambiguous, stale, hidden, and disabled targets. Evaluation is synchronous; Promise results return an explicit unsupported result. DOM-dispatched events cannot claim trusted native input.

The renderer ports T3's preview chrome and responsive toolbar classes. It preserves the existing sidebar, header, centered chat, composer, and optional right panel. Responsive sizes change CSS breakpoints while retaining the desktop user agent. Status reports measured viewport dimensions. Port discovery probes local listeners with bounded HTTP requests and never scans arbitrary network addresses.

## Synthesis decision

Two transport candidates were investigated independently. Dynamic tools have the smallest transport, but Codex 0.160.1 fixes their declarations at native thread creation. Resume and fork silently ignore additions. Stdio MCP can add tools to existing threads and survives process restart. It becomes the desktop transport. The shared registry and epoch checks from the dynamic candidate apply to both adapters.

Two real Tauri browser prototypes used child webviews and separate windows on WKWebView. Both returned semantic snapshots, filled inputs, clicked a button, and captured matching PNGs. Both rendered a measured 1280 by 720 CSS viewport inside a 375-pixel frame through native zoom. The child webview fits the requested right-panel workflow; a separate window offers no automation advantage.

Prototype artifacts are in `/tmp/botcode-preview-prototype` and `/tmp/botcode-preview-design`. The installed Codex types were generated with `codex app-server generate-ts --experimental`. The protocol probes used isolated Codex homes and a deterministic local Responses endpoint. These observations establish feasibility; they do not replace final verification in Bot Code.

Model the Domain puts tool results and browser operations in typed variants. Sequence Work into Verifiable Units keeps each delivery boundary green before the next. Prove It Works requires the final Codex tool workflow in the real Tauri app.

## Delivery units

1. Tool transport and the three PR-link tools. Verify durable, idempotent links, wrong-scope refusals, dynamic replies, MCP resume, and restart cleanup.
2. Preview tab, URL navigation, local server discovery, responsive viewport, and project-script opening. Verify native geometry, overlays, tab switching, and isolated data storage.
3. Preview automation tools. Verify a Codex turn opens the local page, snapshots it, clicks an element, and observes the result. Verify stale targets and provider loss.

Each unit runs the requested UI tests, build, Rust format, Clippy, and core tests. The finished changes stay uncommitted. Saved patches and verification records preserve the delivery boundaries without creating commits or PRs.

## Accepted limits

The initial browser has one tab per conversation. Recording, simulators, device control, and cookie import remain outside this task. Tool guidance is a short paragraph; schemas and descriptions carry the operation details. The report measures their UTF-8 bytes and tokens separately with a named tokenizer.

## Implementation reconciliation

Unit a implements the chosen shared registry and both adapters. Desktop registration uses stdio MCP. Core-only dynamic registration records a catalog fingerprint; existing threads without that fingerprint receive no tool guidance. Per-turn context supplies guidance on new and resumed conversations. Independent review identified partial-frame cancellation, completed-turn job retirement, disconnected-call dispatch, and the output/frame budget boundary; their repairs and regressions passed before the unit gate. Tool output is capped at 6 MB and 64 content items, leaving room under Codex’s 8 MB enclosing frame limit.


## Native panel boundary

The renderer and native adapter use `PreviewScope = {kind: "thread", threadId} | {kind: "draft", workspaceId}`. Agent calls always derive the thread scope from `ToolContext`. The native state reports `url`, `title`, `loading`, `error`, navigation availability, a nullable requested `viewport`, and the actual measured CSS viewport.

The panel uses `preview_state`, `preview_open`, `preview_navigate`, `preview_viewport`, and `preview_discover`. Navigation is a tagged URL, back, forward, or reload operation. A `botcode-preview` event carries `{scope, state, openPanel}`; React opens the panel only for the currently selected scope.

A mount acquires a monotonic lease with `preview_attach`. `preview_layout` carries that lease, a monotonic sequence, measured logical bounds, and visibility. `preview_detach` releases only its matching lease. Renderer attachment acquisition is serialized, and disposed queued mounts are skipped. A later mount invalidates earlier geometry and cleanup calls. The manager displays at most one child view; the hidden views retain conversation browser state. A finite view limit bounds native resources. Renderer observers hide the view during covering dialogs and menus. Geometry updates use coalesced microtasks: WKWebView can report the main document hidden and pause animation frames while the containing window remains visible. Native child visibility still follows that parent window.


The concrete IPC payloads are:

- `preview_state({scope}) -> PreviewState`
- `preview_open({scope, url}) -> PreviewState`
- `preview_navigate({scope, action: {kind: "url", url} | {kind: "back"} | {kind: "forward"} | {kind: "reload"}}) -> PreviewState`
- `preview_viewport({scope, viewport: {width, height} | null}) -> PreviewState`
- `preview_attach({scope}) -> {lease, state}`
- `preview_layout({lease, sequence, rect: {x, y, width, height} | null, visible}) -> void`
- `preview_detach({lease}) -> void`
- `preview_discover() -> Array<{port, url, title: string | null}>`

`PreviewState` has `url: string | null`, `title: string`, `loading: boolean`, `error: string | null`, `canGoBack: boolean`, `canGoForward: boolean`, `viewport: {width, height} | null`, and `measuredViewport: {width, height} | null`. All native structs use camel-case fields and reject extra input fields. `viewport: null` fits the panel; a requested size fits proportionally and sets native zoom to preserve CSS breakpoints.

## Automation contract

The backend derives a thread scope from `ToolContext`. The first implementation keeps one browser per thread. It does not accept tab or thread identities. Each entry owns a serialization gate and an opaque DOM key. An in-flight call pins its entry against eviction. Wait calls retain that pin while releasing the gate between polls. Main-thread operations check whether their caller has been canceled before issuing work.

The twelve operations are:

| Tool | Input and result |
| --- | --- |
| `preview_status` | Reports browser availability, current URL, loading, visibility and measured viewport. |
| `preview_open` | Optional HTTP/HTTPS URL and `open` flag. Reuses the browser or initializes a blank one; `open: false` allows background work. |
| `preview_navigate` | Navigates to a URL without forcing the panel open. |
| `preview_snapshot` | Bounded semantic text, current element references and optional native PNG. `save` writes a generated path beneath the application data directory. |
| `preview_click` | One current snapshot reference or strict CSS selector. |
| `preview_type` | One text target, literal text and optional `clear`. |
| `preview_press` | Page key handlers and supported form, editing and focus defaults. |
| `preview_scroll` | Finite deltas for the page or one container. |
| `preview_resize` | Fill, freeform, or desktop/tablet/mobile preset; reports measured CSS size. |
| `preview_evaluate` | Synchronous JavaScript expression and a bounded JSON value. Promise results return an explicit error. |
| `preview_wait_for` | All supplied target, text and URL conditions; bounded, cancelable polling. |
| `preview_set_appearance` | Native light, dark, or system color scheme. |

DOM actions reject ambiguous, hidden, disabled, read-only or stale targets. A new snapshot invalidates earlier references, and navigation replaces the document that owns them. Snapshots inspect the main frame and omit password values. They report their omissions. DOM-dispatched events are untrusted; trusted-input-only behavior is not guaranteed. Native shortcuts, cross-origin frame inspection and closed shadow roots remain unsupported. Native PNG capture and appearance overrides are implemented for macOS.
