# UI baseline

Z1 renders the T3 Code interface for every workflow it implements. The reference is T3 Code v0.0.45 (`pingdotgg/t3code` tag `v0.0.45`, commit `6c8fed35d`), the build in the installed desktop app. T3 Code is MIT licensed. Ported files name their source in a one-line header.

## Styles come from T3, not from a lookalike

`src/t3-theme.css` is T3's `apps/web/src/index.css`, copied verbatim. Regenerate it with `scripts/port-t3-theme.sh <t3code-checkout>`. Tailwind v4 compiles it through `@tailwindcss/vite`, so components use T3's own utility classes and tokens: `bg-sidebar`, `text-secondary-label`, `--chat-max-width`, `alert-glass`. `src/styles.css` imports the theme and holds the only Z1 overrides: root typography, which T3 sets from JavaScript, and the macOS traffic-light inset.

`src/ui/controls.tsx` copies T3's `buttonVariants` and `toggleVariants` tables and the select trigger and item classes. Components copy T3's class strings literally. A hand-written approximation drifts the first time T3 changes a token. A copied class string can only drift when the copy is stale.

## Layout

The shell matches T3's desktop app:

- A 256px left sidebar, resizable from 208px and collapsible with Command+B. It holds the brand row, thread search, the repository menu, **Add project**, **New thread**, and one card per thread across every repository. A fixed bottom bar contains the 32px Settings gear. Settings replaces the sidebar list with search and category navigation, and the bottom bar becomes Back.
- A 52px header with the repository badge, the thread title, and a fixed right-panel toggle.
- A centered 48rem conversation column. The composer floats over the bottom of the timeline. A new thread centers the composer under "What should we build in {repository}?", and that repository name is the repository picker.
- An optional right panel, 540px by default, with Files, file, and Diff tabs.

A thread can also start without a project, as in T3 commit `6b286ae8a`. The empty window offers **Start without a project**, a repository draft offers **or start without a project** under its heading, and Command+Option+N opens the same draft. That draft asks "What should we work on?" and moves the picker, which reads **No project**, to the line below. Each of these threads runs Codex in its own plain folder under `scratch` in the data directory, named from the date, the first words of the prompt, and a short id. They show T3's gray dashed message icon and have no workspace selector, branch picker, or Diff tab. The option is absent when the data directory sits inside a Git work tree.

Appearance follows the system by default. The local preferences owner in `src/settings/preferences.tsx` applies the system, light or dark choice, and the prompt and code font sizes. The macOS window keeps an overlay titlebar with native traffic lights at `{16, 19}`. Elements that carry T3's `drag-region` class also carry `data-tauri-drag-region="deep"`, which gives Tauri the same rule: the subtree drags and clickable children opt out.

## Only working controls appear

T3 shows controls that Z1 cannot back yet: attachments, the terminal drawer, Git actions, pull requests, and usage. Z1 leaves them out. The composer has model, reasoning effort, and access-mode menus backed by per-thread Codex settings and the live model catalog. The context strip under the composer starts with T3's workspace selector on a new thread: **Current checkout** or **New worktree**. Once a thread exists, the left side shows a fixed **Local checkout** or **Worktree** label. The right side is T3's branch picker in every state. A worktree draft uses it to choose the base, which defaults to the repository's default branch, and its **Start from origin** switch. The trigger then reads "From origin/{base}" or "From {base}". Elsewhere, picking a ref switches the checkout's branch, and a typed name that matches no ref offers **Create new ref**. Branches checked out in another worktree are disabled. Z1 leaves out T3's pull request badge, pull request checkout, and reuse of another worktree. Sidebar rows of worktree threads show T3's worktree icon and the worktree branch.

The model picker has T3's Favorites and provider rail, with Codex as the current configured provider. Stars save provider and model pairs in device preferences. Favorites survive appearance and font resets. Search hides the rail and searches the live catalog. Model and star buttons are separate grid controls, so starring does not select a model or close the picker.

## Settings

Settings uses T3's compact breadcrumb header, centered page and grouped rows. General describes Codex and the conversation access controls, sets where new threads start and whether new worktrees start from origin, and restores device preferences. Appearance changes system, light or dark mode and the composer font size from 12 to 20px. The code font size from 11 to 20px applies to code blocks, tool output, file previews and diffs. Keyboard shortcuts documents the working sidebar toggle, the shortcut for a thread without a project, the settings shortcut and Escape. Search matches category, section and row labels and focuses the selected setting.

Command/Control+, opens settings. Back or Escape returns to the conversation with its draft, thread search, selected thread, panel tabs and scroll retained. An active settings search consumes Escape first. Collapsed sidebars have a Back button in the settings header. Device preferences persist in local storage after schema validation. Storage failures appear in settings while changes continue to apply in memory.

## Domain data the interface needs

T3's timeline reads timestamps that Z1 did not record before this baseline. Each `Turn` now stores `started_at` and `completed_at` in Unix milliseconds. `ThreadSnapshot::stamp_completions` records completion on every save. Turns saved earlier have neither value and show "Worked" instead of "Worked for 8.6s". `ThreadSummary` carries `updated_at` for the sidebar's relative time and `awaiting_approval` for its **Approval** status. File-change items carry their `paths`, so a single change shows its file name.

## How parity is checked

A Playwright harness renders T3 v0.0.45 and Z1 in the same headless Chrome at 1440x900 and diffs the screenshots region by region. T3 runs from the server and web client bundled in the installed app, with an isolated `T3CODE_HOME` and a disposable repository. Z1 runs its Vite build against a mocked Tauri IPC that serves the same repository and the same conversation. The harness lives outside the repository. [Verification](verification.md) records the results and the remaining differences.
