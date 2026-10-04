# Z1 Code

Z1 Code is a local macOS coding workbench built with Rust, Tauri 2, React, Vite, TanStack Router and Query, SQLite, Pierre Trees, and Pierre Diffs. Its first working slice opens real Git repositories and runs conversations through the installed Codex app-server.

## Run locally

Install Rust 1.89 or newer, Node.js 20.19 or Node.js 22.12 or newer, pnpm, and the macOS Command Line Tools. This slice was verified with Rust 1.93 and Node.js 26.7. Rust 1.89 is required for the state-directory file lock. Install Codex and sign in through its own CLI. Z1 uses that account without changing Codex credentials or `CODEX_HOME`.

```sh
pnpm install
pnpm tauri dev
```

Open a Git repository and start a conversation. To work outside a repository, choose **Start without a project** or press Command+Option+N, and Z1 runs that conversation in its own folder under `scratch` in the data directory. Send with Enter. Shift+Enter adds a line. The right-panel toggle in the header opens Files and Diff tabs for the working copy. Approvals offer Approve, Decline, or Cancel turn. Stop is available after Codex acknowledges the running turn.

The folder button beside the sidebar search filters threads by project. Its gear buttons open that project's Project settings page, where you can rename a repository, choose where its new threads start, or remove it. Removing a project deletes it and its threads from Z1 and clears its overrides. The repository, Z1 worktrees, and scratch folders stay on disk. Stop a project's running conversations before you remove it.

The sidebar's bottom Settings button opens General, Appearance, Keyboard shortcuts, and Storage. Command+, also opens settings. General and Project start with "Applying settings for", followed by a project picker. With **All projects** picked, General sets where new threads start for every project. Pick a repository to override those defaults for that project only. The reset button beside a setting removes the override, and the layers button shows which value applies. While a project is picked, a **Project** page appears at the top of the navigation. Appearance, prompt and code font sizes, and project overrides save on this device. Back or Escape returns to the same conversation and draft.

The composer has model, reasoning effort, and access menus. Model and effort choices come from the installed Codex. Settings save per conversation and apply to the next turn. Supervised is the default access mode. The other modes are Auto-accept edits, Auto, and Full access.

The browser build explains that the native runtime is required. It does not simulate repositories or conversations.

## State and recovery

Z1 keeps its data in `~/.z1`. That directory holds preferences in `settings.json`, the SQLite database, worktrees under `worktrees`, and threads without a project under `scratch`. Settings > Storage can remove worktrees of inactive or unchanged threads to save space, and the thread's next message recreates its worktree. You can edit `settings.json` by hand or symlink it to sync preferences between machines. The database holds machine-local UI state, such as panel widths. Set `Z1_DATA_DIR` to use another directory. Only one runtime can own a directory at a time. Set `Z1_CODEX_BIN` to choose an explicit Codex executable.

Conversation history and native thread IDs survive restart. Reconnect resumes that saved native conversation. A lost prompt acknowledgement remains uncertain. Z1 never automatically sends that prompt a second time. Old approval callbacks expire when the provider process ends.

One conversation may run in each canonical checkout at a time. Other checkouts can run concurrently through the shared Codex process. A provider failure affects every live conversation on that process.

## Verify

```sh
pnpm typecheck
pnpm build
cargo test -p z1-core
pnpm smoke
pnpm tauri build --debug --bundles app
```

The core tests use temporary Git repositories and a scripted JSONL provider. They cover real staged, unstaged, untracked, and rename diffs, path containment, operation deduplication, uncertain delivery, approval routing, storage failures, interruption, stalled provider input, and subprocess cleanup.

The real smoke uses the installed Codex account in a disposable checkout and an isolated state directory. It observes streaming, completion, durable history, and same-native-thread continuation after reopening. It asserts the checkout remains unchanged.

The actual Mac window was verified with native folder selection, two repository trees, real files and Git diffs, live Codex output, command and file approvals, interruption, renderer reload, and conversation continuation after a full restart. Code quotes stay literal in the composer.

Pierre helper packages currently report a theme peer-version warning. Tree, file, and diff rendering passed in the native window despite that warning.

## Roadmap

AI review triage for pull requests is the intended differentiator. Review findings, reviewed commit identity, explicit dispositions, and verified fixes belong in the next slice. This version does not include PR automation, a terminal, browser preview, worktree management, Cursor, or a provider plugin system.

The implementation and recovery decisions are in [docs/architecture.md](docs/architecture.md).

Native verification results are in [docs/verification.md](docs/verification.md).

The visual baseline and layout ownership are in [docs/ui-baseline.md](docs/ui-baseline.md).
