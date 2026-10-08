# Preview verification

The verification uses a disposable repository at `/tmp/botcode-preview-verification/repository` and `BOT_CODE_DATA_DIR=/tmp/botcode-preview-verification/data`. The native bundle has the separate identifier `dev.bot.code.previewverify`. No production Bot Code state is used.

## Baseline and prototypes

The baseline passed 405 UI tests, the frontend build, and `cargo test -p bot-core`. Logs are `/tmp/botcode-preview-baseline-ui.log`, `/tmp/botcode-preview-baseline-build.log`, and `/tmp/botcode-preview-baseline-core.log`.

The baseline native app created conversation `8b956a15-ccd5-4bd1-b9be-34667dee1ead` through installed Codex 0.160.1 and received `baseline ready`. This conversation predates tool registration and is the existing-history upgrade check.

The browser prototype ran both a Tauri child webview and a separate webview window on macOS. Each filled an input, clicked a button, returned the changed DOM, hid and showed its view, and captured a PNG. Native zoom fitted a measured 1280 by 720 CSS viewport into a 375-pixel-wide frame. Both PNGs matched. Evidence is `/tmp/botcode-preview-prototype/evidence.json` and `report.md`.

Protocol probes used installed Codex with isolated `CODEX_HOME` directories and a deterministic local Responses endpoint. Dynamic tools persisted across process restart but could not be added on resume or fork. Stdio MCP tools worked on an existing conversation, after restart, and with separate scopes for two live conversations. Per-tool `approval_mode: approve` worked with truthful mutation annotations. Evidence and runners are named in `/tmp/botcode-preview-design/dynamic.md` and `mcp.md`.

## Delivery checks

| Unit | Native workflow | Required checks | State |
| --- | --- | --- | --- |
| a. Transport and PR tools | Existing Codex conversation links and lists a PR; link persists across restart. | UI tests, build, format, workspace Clippy, core tests. | Passed. |
| b. Preview panel | Local script opens the preview; navigation, discovery, responsive size, overlay hiding, and page-focused shortcuts work. | UI tests, build, format, workspace Clippy, core tests. | Passed. |
| c. Automation | A Codex turn opens, snapshots, types, clicks, and observes the changed local page. | UI tests, build, format, workspace Clippy, core tests. | Pending implementation. |

## Repeat the local page

The disposable page has an input named **Name**, an **Apply name** button, a status region initially reading **Ready**, a second page, and a media query that shows **Desktop layout** at widths of at least 700 CSS pixels. Its project script serves the repository on `127.0.0.1:43127` and sets `previewUrl` and `autoOpenPreview`.

Unit a passed 405 UI tests, `pnpm build`, `cargo fmt --check`, workspace Clippy with warnings denied, and all core tests. Logs are `/tmp/botcode-preview-verification/unit-a-{ui,build,format,clippy,core}.log`. The actual native bundle was rebuilt, closed, and relaunched using the same isolated data directory. In the existing conversation, Codex linked PR #67 twice (first `alreadyLinked: false`, then `true`) and listed one membership. After restart it listed that saved link and returned `alreadyLinked: true` again. The original `agent_discovered` source, generation 1, and timestamp were unchanged. The earlier `baseline ready` response remained in the same native history.

Independent review identified four transport defects. Regressions now cover a split next MCP frame while an image result completes, provider-originated completion cancellation, a disconnected queued caller, and a near-limit tool result inside the provider notification envelope. Scope and restart tests reject another thread and revoked credentials, preserve a manually linked PR's original source, and cancel pending browser futures without replay.

With tiktoken 0.14.0 `o200k_base`, PR-only guidance is **46 UTF-8 bytes / 10 tokens**. The preview paragraph is **163 bytes / 32 tokens** and is injected only when preview tools are registered. Unit a's three tool schemas and descriptions serialize to **1,443 bytes / 340 tokens**. These are reproducible static counts, not provider billing or an exact GPT-6.1 tokenizer. The detailed record is `/tmp/botcode-preview-verification/unit-a-token-counts.json`.

The final preview checks and complete catalog measurement remain open until units b and c pass.

Unit b passed 418 UI tests, the build, format, workspace Clippy with warnings denied, and all core tests. Logs are `/tmp/botcode-preview-verification/unit-b-{ui,build,format,clippy,core}.log`. The final native bundle opened the script URL in the right panel. Desktop, mobile, rotation, and custom Enter changed the page's measured CSS viewport. Custom 900 by 600 measured exactly 900 by 600. Back, reload, and forward retained the forward entry. A History API route updated the URL bar and Back state. Local discovery listed the fixture server. Draft and conversation previews retained separate state, including a switch during browser startup. Menus and the command palette covered the page without a native view covering them. Command+K from a focused page input opened the application palette; ordinary typing stayed in the input.

The keyboard relay uses an AppKit local event monitor. It registers effective application bindings, checks the main window and native first responder, and rejects events from an old preview scope. It needs no OS input permission. The prototype evidence is `/tmp/botcode-preview-keyboard/design.md` and `prototype-native.log`. Independent panel review found notification activation, SPA state, pre-commit navigation timeout, late panel reopening, and reload-history defects. All were repaired before this gate. Temporary native visibility diagnostics were removed.

A final slow-server check requested `http://127.0.0.1:43128/` with no listener, then closed the panel during readiness polling. The timeout did not reopen the panel. Reopening showed that same requested address and the local-server error.
