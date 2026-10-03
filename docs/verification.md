# Verification of the first version

The first-slice checks below describe the original layout. The later T3-style alignment has its own native results at the end.

Verified on macOS on 2026-10-03 with Rust 1.93.0, Node.js 26.7.0, and Codex 0.160.0.

The core suite passed 13 tests. The real Codex smoke observed partial streamed text, completed a turn, restored SQLite history, continued the same native thread after reopening, and confirmed its disposable checkout stayed unchanged. Frontend typechecking, production build, formatting checks, and the debug Mac app bundle passed.

The native checks used the actual Tauri window, disposable Git repositories, and a separate `Z1_DATA_DIR`.

| Workflow | Observed result |
| --- | --- |
| Native folder picker | Opened a real Git repository. |
| Pierre tree and files | Displayed real paths and syntax-highlighted contents; refresh found a newly created file. |
| Workspace selection | A second repository displayed its own tree and file contents. |
| Pierre diffs | Displayed modified and untracked file contents from the actual working copy. |
| Codex streaming | Partial assistant text appeared while the turn was running. |
| Stop | The real turn became interrupted and another prompt could run. |
| Command approval | Decline prevented execution; Allow once ran a reviewed Python print command and showed its output. |
| Full app restart | Restored four saved turns and continued the same native thread. |
| Renderer reload | Retained the live run and its file-change approval. |
| File approval | Displayed and applied the exact one-line patch in the disposable repository; the open file and Git diff refreshed. |
| Composer | Typed straight quotes remained literal. |

The native tree theme needed explicit Pierre CSS overrides. Pierre helper packages still report a theme peer-version warning, although native tree, file, and diff rendering passed.

These checks establish this Mac slice. They do not establish GitHub review workflows, Cursor integration, universal native history hydration, or other operating systems.

To repeat the automated checks, use the commands in the README. To repeat native checks, launch with an isolated data directory, open a disposable repository, inspect known file changes, run a harmless Codex prompt, and exercise approvals, Stop, reload, and restart. Review each command and patch before allowing it.

## T3-style layout alignment

The updated debug Mac bundle, frontend typecheck, production build, formatting, and diff checks passed on 2026-10-03. Rust, IPC, Router validation, and dependencies did not change.

Native verification used the same isolated state and disposable repositories. The actual window showed neutral light surfaces, the left conversation sidebar, centered transcript and bottom composer, and optional right Files/Changes inspection. A drafted prompt remained intact across panel toggles. Files showed actual contents. Staged, unstaged, and untracked unified diffs showed the expected Git bytes.

Closing either inspector returned focus to its surviving toolbar trigger. Tab reached Close, Return closed it, and Space reopened Files from the restored focus. Repository selection cleared old thread and inspection state; the second repository displayed only its own README. The native folder picker reopened the first repository. A Command+Enter prompt completed with `Z1_LAYOUT_OK`. Renderer reload retained the selected diff and all seven saved turns. The native thread ID remained unchanged.

Native traffic lights stayed visible and clear of controls. Double-clicking the breadcrumb zoomed the window and restored its normal size. The system-dark palette has source and build coverage but no native observation. Native minimum-width coverage remains incomplete because the driver could not resize the window edge; normal and zoomed windows were observed. No pixel-exact parity is claimed.

## T3 Code v0.0.45 parity

Verified on 2026-10-03 against the server and web client bundled in the installed T3 Code 0.0.45 app. Both apps rendered in headless Chrome at 1440x900 with the same disposable repository and the same two-turn conversation. The table counts pixels that differ by region.

| Scene and region | Differing pixels | Cause of the difference |
| --- | --- | --- |
| Header, light and dark | 0 | None. |
| Sidebar thread row | 0 | None. |
| Sidebar, whole column | 678 of 230,400 | The Z1 brand, and T3's Settled shelf and footer icons, which Z1 lacks. |
| Timeline above the second turn's work row | 0 | None. |
| Timeline, whole column | 3,809 of 505,600 | T3 records an extra "Approval resolved" activity, which shifts the rows below it. |
| Composer | 2,279 of 165,900 | The placeholder text, and T3's model, effort, access-mode menus and attach button. |
| Right panel, Files and Diff | 0 | Measured without the titlebar cluster, where T3 adds a terminal toggle. |
| Approval drawer | 172 of 132,880 | Label text inside the drawer. |

The native debug bundle ran with an isolated `Z1_DATA_DIR` and copies of the disposable repositories. These checks passed in the actual Tauri window:

- Traffic lights, the sidebar toggle, and the brand sit at T3's desktop positions.
- A prompt sent with Return from the new-thread view created a conversation and ran a real Codex turn.
- The turn showed "Working for", then a command approval in the composer drawer, with **Approval** in the sidebar.
- Approve and Decline each finished the turn under a "Worked for" fold.
- The approval overflow menu opened above its button.
- Command+B collapsed and restored the sidebar.
- The right panel opened Files, a file tab with syntax highlighting, and Diff with an expanded hunk.

Pierre's `shiki-wasm` highlighter rendered nothing in the native window, because the app's content security policy blocks WebAssembly. The viewers use Pierre's default `shiki-js` engine instead.

System-dark appearance was checked in the Chrome harness only. The minimum window width and window dragging were not driven natively. The core suite shows intermittent shutdown-timing failures in parallel runs. Those failures also occur on the unmodified base commit.
