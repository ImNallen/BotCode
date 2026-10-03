# UI baseline

Z1 renders the T3 Code interface for every workflow it implements. The reference is T3 Code v0.0.45 (`pingdotgg/t3code` tag `v0.0.45`, commit `6c8fed35d`), the build in the installed desktop app. T3 Code is MIT licensed. Ported files name their source in a one-line header.

## Styles come from T3, not from a lookalike

`src/t3-theme.css` is T3's `apps/web/src/index.css`, copied verbatim. Regenerate it with `scripts/port-t3-theme.sh <t3code-checkout>`. Tailwind v4 compiles it through `@tailwindcss/vite`, so components use T3's own utility classes and tokens: `bg-sidebar`, `text-secondary-label`, `--chat-max-width`, `alert-glass`. `src/styles.css` imports the theme and holds the only Z1 overrides: root typography, which T3 sets from JavaScript, and the macOS traffic-light inset.

`src/ui/controls.tsx` copies T3's `buttonVariants` and `toggleVariants` tables. Components copy T3's class strings literally. A hand-written approximation drifts the first time T3 changes a token. A copied class string can only drift when the copy is stale.

## Layout

The shell matches T3's desktop app:

- A 256px left sidebar, resizable from 208px and collapsible with Command+B. It holds the brand row, thread search, the repository menu, **Add project**, **New thread**, and one card per thread across every repository. A fixed bottom bar contains the 32px Settings gear. Settings replaces the sidebar list with search and category navigation, and the bottom bar becomes Back.
- A 52px header with the repository badge, the thread title, and a fixed right-panel toggle.
- A centered 48rem conversation column. The composer floats over the bottom of the timeline. A new thread centers the composer under "What should we build in {repository}?", and that repository name is the repository picker.
- An optional right panel, 540px by default, with Files, file, and Diff tabs.

Appearance follows the system by default. The local preferences owner in `src/settings/preferences.tsx` applies the system, light or dark choice, and the prompt and code font sizes. The macOS window keeps an overlay titlebar with native traffic lights at `{16, 19}`. Elements that carry T3's `drag-region` class also carry `data-tauri-drag-region="deep"`, which gives Tauri the same rule: the subtree drags and clickable children opt out.

## Only working controls appear

T3 shows controls that Z1 cannot back yet: attachments, the terminal drawer, Git actions, pull requests, and usage. Z1 leaves them out. The composer has model, reasoning effort, and access-mode menus backed by per-thread Codex settings and the live model catalog. The context strip under the composer shows **Local checkout** and the current branch without menus.

The model picker has T3's Favorites and provider rail, with Codex as the current configured provider. Stars save provider and model pairs in device preferences. Favorites survive appearance and font resets. Search hides the rail and searches the live catalog. Model and star buttons are separate grid controls, so starring does not select a model or close the picker.

## Settings

Settings uses T3's compact breadcrumb header, centered page and grouped rows. General describes Codex and the conversation access controls and restores device preferences. Appearance changes system, light or dark mode and the composer font size from 12 to 20px. The code font size from 11 to 20px applies to code blocks, tool output, file previews and diffs. Keyboard shortcuts documents the working sidebar toggle, settings shortcut and Escape. Search matches category, section and row labels and focuses the selected setting.

Command/Control+, opens settings. Back or Escape returns to the conversation with its draft, thread search, selected thread, panel tabs and scroll retained. An active settings search consumes Escape first. Collapsed sidebars have a Back button in the settings header. Device preferences persist in local storage after schema validation. Storage failures appear in settings while changes continue to apply in memory.

## Domain data the interface needs

T3's timeline reads timestamps that Z1 did not record before this baseline. Each `Turn` now stores `started_at` and `completed_at` in Unix milliseconds. `ThreadSnapshot::stamp_completions` records completion on every save. Turns saved earlier have neither value and show "Worked" instead of "Worked for 8.6s". `ThreadSummary` carries `updated_at` for the sidebar's relative time and `awaiting_approval` for its **Approval** status. File-change items carry their `paths`, so a single change shows its file name.

## How parity is checked

A Playwright harness renders T3 v0.0.45 and Z1 in the same headless Chrome at 1440x900 and diffs the screenshots region by region. T3 runs from the server and web client bundled in the installed app, with an isolated `T3CODE_HOME` and a disposable repository. Z1 runs its Vite build against a mocked Tauri IPC that serves the same repository and the same conversation. The harness lives outside the repository. [Verification](verification.md) records the results and the remaining differences.
