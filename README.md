# Bot Code

Bot Code is a local macOS coding workbench built with Rust, Tauri 2, React, Vite, TanStack Router and Query, SQLite, Pierre Trees, and Pierre Diffs. Its first working slice opens real Git repositories and runs conversations through the installed Codex app-server.

## Run locally

Install Rust 1.89 or newer, Node.js 20.19 or Node.js 22.12 or newer, pnpm, and the macOS Command Line Tools. `pnpm test:ui` needs Node.js 22.18 or newer. This slice was verified with Rust 1.93 and Node.js 26.7. Rust 1.89 is required for the state-directory file lock. Install Codex and sign in through its own CLI. Bot Code uses that account without changing Codex credentials or `CODEX_HOME`.

```sh
pnpm install
pnpm tauri dev
```

The dev server uses port 1420. If another dev build holds that port, `pnpm tauri dev` takes the next free one.

Open a Git repository and start a conversation. To work outside a repository, choose **Start without a project** or press Command+Option+N, and Bot Code runs that conversation in its own folder under `scratch` in the data directory. Send with Enter. Shift+Enter adds a line. The right-panel toggle in the header opens Files, Diff, and Reviews tabs. Approvals offer Approve, Decline, or Cancel turn. Stop is available after Codex acknowledges the running turn.

The folder button beside the sidebar search filters threads by project. Its gear buttons open that project's Project settings page, where you can rename a repository, choose where its new threads start, or remove it. Removing a project deletes it and its threads from Bot Code and clears its overrides. The repository, Bot Code worktrees, and scratch folders stay on disk. Stop a project's running conversations before you remove it.

The sidebar's bottom Settings button opens General, Appearance, Keyboard shortcuts, and Storage. Command+, also opens settings. General and Project start with "Applying settings for", followed by a project picker. With **All projects** picked, General sets where new threads start for every project. Pick a repository to override those defaults for that project only. The reset button beside a setting removes the override, and the layers button shows which value applies. While a project is picked, a **Project** page appears at the top of the navigation. Appearance, prompt and code font sizes, and project overrides save on this device. Back or Escape returns to the same conversation and draft.

The terminal toggle in the header, or Command+J, opens a terminal drawer under the conversation in the thread's checkout. Command+D and Shift+Command+D split the focused terminal, Command+N adds one, and Command+W closes it after confirmation. Each thread keeps its own terminals. Their shells keep running while you work in another thread and show their earlier output when you return. Shells do not survive quitting Bot Code.

The composer has model, reasoning effort, and access menus. Model and effort choices come from the installed Codex. Settings save per conversation and apply to the next turn. Supervised is the default access mode. The other modes are Auto-accept edits, Auto, and Full access.

To attach an image, paste it into the prompt or drop it on the composer. Bot Code accepts PNG, JPEG, GIF, and WebP images up to 10 MiB. Click the button on a thumbnail to remove that image. Codex receives each image as a local file, and the image stays in the sent message after a restart.

A new worktree starts on a temporary `botcode/<random>` branch. Its first message generates a short branch name in the background. Bot Code applies the name after the first Codex turn ends and keeps the same folder. A branch switch, Git action, cleanup, or later message cancels pending naming. A generation failure keeps the temporary branch and does not interrupt the conversation. Local checkouts and branches you name yourself keep their names.

In a repository thread, the Git actions control at the right of the header commits, pushes, pulls, and opens GitHub pull requests for that thread's checkout. Its button runs the next step for the branch. Its menu lists Commit, Push, and Create PR or View PR. The commit dialog generates an editable message with the selected Codex model. You can type your own message or leave the field empty to generate one when committing. Closing the dialog cancels its preview, and a typed message can proceed while generation runs. Pull requests go through the GitHub CLI, so install `gh` and run `gh auth login`. Bot Code generates the pull request title and body from the branch's commits and diff against its recorded base, normally the branch the worktree started from or the default branch. If generation fails, the result toast explains the fallback to `gh pr create --fill`. A failed automatic commit asks you to enter a message and leaves the changes uncommitted. Bot Code refuses a Git action while Codex works in the same checkout, and refuses a prompt or a branch switch there while a Git action runs.

The browser build explains that the native runtime is required. It does not simulate repositories or conversations.

Open **Reviews** in a repository conversation to load its branch's open PR from github.com through `gh`. Reviews includes inline threads and replies, review summaries, and PR conversation comments. It shows author and source links, GitHub resolved/outdated status, original reviewed commits and diff hunks when GitHub supplies them, plus separately labeled checkout HEAD and PR head. Use **Fix** for planned work, **Dismiss** with a reason, **Needs decision**, or **Clear decision**. These choices save locally and become stale when the PR head or finding changes. Fix does not mean verified. **Ask Codex** appends the selected finding to the existing conversation draft and focuses the composer. You send it. Bot Code does not post comments or resolve threads on GitHub. Reviews is absent for threads without a project and removed worktrees. Enterprise GitHub hosts are not supported in this slice.

## State and recovery

Bot Code keeps its data in `~/.z1`, the directory it used as Z1 Code. That directory holds preferences in `settings.json`, the SQLite database, worktrees under `worktrees`, threads without a project under `scratch`, and images under `attachments`. Each image file is named by the SHA-256 of its bytes, and each saved turn lists the images it sent. At startup, Bot Code deletes images that no saved turn lists once they are a day old. Settings > Storage can remove worktrees of inactive or unchanged threads to save space, and the thread's next message recreates its worktree. You can edit `settings.json` by hand or symlink it to sync preferences between machines. The database holds machine-local UI state, such as panel widths. Set `BOT_CODE_DATA_DIR` to use another directory. Only one runtime can own a directory at a time. Set `BOT_CODE_CODEX_BIN` to choose an explicit Codex executable, and `BOT_CODE_GH_BIN` to choose an explicit `gh`.

Conversation history and native thread IDs survive restart. Reconnect resumes that saved native conversation. A lost prompt acknowledgement remains uncertain. Bot Code never automatically sends that prompt a second time. Old approval callbacks expire when the provider process ends.

Review decisions survive restart and belong to the project and immutable GitHub PR/finding IDs. Removing a project removes its review decisions. Remote feedback is fetched on demand and is not stored as an offline cache. The database migration preserves older data and refuses a schema version newer than this app supports.

One conversation may run in each canonical checkout at a time. Other checkouts can run concurrently through the shared Codex process. A provider failure affects every live conversation on that process.

## Verify

```sh
pnpm typecheck
pnpm build
pnpm test:ui
cargo test -p bot-core
pnpm smoke
pnpm tauri build --debug --bundles app
```

The core tests use temporary Git repositories and a scripted JSONL provider. They cover real staged, unstaged, untracked, and rename diffs, path containment, operation deduplication, image attachments, uncertain delivery, approval routing, storage failures, interruption, stalled provider input, and subprocess cleanup. Git actions and review triage use scripted `gh` fixtures. Review checks cover complete nested pagination, failed pages, moving heads, source identity, restart, stale decisions, conflicting writes, migration, and bounded process cleanup. `pnpm test:ui` uses `node --test` for the Git action rules, review prompt/decision behavior, and React panel rendering. [The review fixture protocol](docs/review-fixtures.md) supports isolated native checks.

The real smoke uses the installed Codex account in a disposable checkout and an isolated state directory. It observes streaming, completion, durable history, and same-native-thread continuation after reopening. It asserts the checkout remains unchanged.

The actual Mac window was verified with native folder selection, two repository trees, real files and Git diffs, live Codex output, command and file approvals, interruption, renderer reload, and conversation continuation after a full restart. Code quotes stay literal in the composer.

Pierre helper packages currently report a theme peer-version warning. Tree, file, and diff rendering passed in the native window despite that warning.

## Roadmap

PR review triage now records local intent and prepares scoped Codex drafts. Automatic verified-fix tracking remains future work. This version does not include browser preview, manual worktree management, Cursor, or a provider plugin system.

The implementation and recovery decisions are in [docs/architecture.md](docs/architecture.md).

Native verification results are in [docs/verification.md](docs/verification.md).

The visual baseline and layout ownership are in [docs/ui-baseline.md](docs/ui-baseline.md).
