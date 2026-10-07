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

To edit a file, open it in the Files tab and type. Bot Code saves the file 500 ms after you stop typing, and a dot on the tab shows that a save is waiting. If Codex writes the same file before your edit saves, your text replaces its change, as in T3 Code. Binary files, non-UTF-8 files, and files over 1 MB stay read-only. Bot Code refuses to write outside the thread's checkout or inside `.git`, including through symlinks.

The conversation shows Codex's work as T3 Code does. Commands, file changes, MCP tool calls, web searches, image views, and agent calls appear as rows. Click a row to see the command output, the patch, the MCP call's arguments and result, or the search query. Codex's reasoning summary streams as **Thinking** and settles as **Thought**, grouped with the tool calls beside it. Context compaction shows a **Context compacted** divider. A finished turn folds its work under **Worked for**.

Command+K opens T3's command palette in chat, Settings, and Usage. Search thread titles across projects or message text in conversations already loaded in this session. Start a query with `>` to search actions only. Arrow keys select a result, Enter opens or runs it, and Escape closes the palette. A focused terminal keeps Command+K for clearing its output.

The palette offers the existing thread and panel controls, including new threads, Settings, pin, settle, snooze, wake, rename, copy, archive, and confirmed deletion. Pin and settle act in place, as their shortcuts do. Archived threads stay out of ordinary search and can be restored from their own submenu. Actions appear only when their current context supports them. Palette entries and shortcut matching share one action table.

Command+P opens **Go to file** for the active checkout. Type a filename or fuzzy path, use the arrow keys to select a result, and press Enter to open it in the right panel's Files view. Command+Shift+F opens **Search project contents**. Select a matching line to open the file at that line. Both actions also appear in the command palette. On other platforms, use Control in place of Command. A focused terminal keeps these chords for its own input.

Content search offers **Match case**, **Match whole word**, and **Use regular expression**. It searches current file contents, including uncommitted edits, and caps results to keep large repositories usable. The dialog reports incomplete searches and skipped files. Binary files, invalid UTF-8, and files above the viewer's 1 MB limit are skipped. Regular expressions use Rust's supported regex syntax.

Files, **Go to file**, and `@` mentions share one Rust file index for the selected checkout. It respects `.gitignore`, nested ignore rules, `.ignore`, and Git's global excludes. Ignored files stay absent even if Git already tracks them. The picker returns up to 200 rows, and the composer returns up to 50. Search runs outside the UI thread; changing the query makes older rows unavailable until the new results arrive.

Search refreshes the file index on use after two seconds. **Refresh** forces a rebuild after external file or ignore-rule changes. [Project search verification](docs/project-search-verification.md) records native checks and measurements on 50,002 files.

While Codex runs, Enter queues your text and images in order. **General > Application > Follow-up behavior** changes that default from **Queue** to **Steer**. Steering adds input to the current run. **Send now** on the first queued message steers a running turn or sends a new turn when idle. Queued messages keep their captured model, effort, and access settings for the next turn. Steering uses the current turn's settings. Queues continue when you switch threads, but waiting input disappears when you reload or quit. Accepted messages and steering instructions remain in history.

**Stop** holds the queue and returns unsent messages to the composer, preserving current text and images. The queued message's remove button returns that one message. If image staging or capacity prevents recovery, the held row stays visible. A message already in flight cannot be recalled. A lost response shows **Check delivery**, which checks the same operation without sending it twice. Failures hold later input for explicit action. Remove queued messages before archiving or deleting their thread or removing its project.

Repository turns save before and after checkpoints under hidden Git refs. **Open diff** in a turn's changed-files card shows only that turn's changes. The Diff scope menu also offers **Latest turn** and individual turns alongside the checkout's Git diff. Checkpoints do not move your branch or change your index during capture, and their refs survive worktree cleanup.

Hover a prompt and choose **Edit from here** to rewind the conversation before it. **Revert and keep changes** keeps the checkout contents. **Revert files too** restores the checkpoint before that prompt, including non-ignored untracked files, and removes later non-ignored files. Ignored files remain untouched. Restored edits are unstaged when HEAD exists. Steering instructions have Copy only. Rewinding the original prompt removes its whole turn, including steering instructions, and recovers only the original input. The returned prompt and images merge with your unsent input and stay in the composer until you send them. Bot Code continues on a new native Codex thread with the retained conversation, preserving the original native history. A turn or Git action in the checkout blocks rewind. A failed prepared operation offers **Retry revert** and survives restart without replaying a completed restore.

The folder button beside the sidebar search filters threads by project. Its gear buttons open that project's Project settings page, where you can rename a repository, choose where its new threads start, or remove it. Removing a project deletes it and its threads from Bot Code and clears its overrides. The repository, Bot Code worktrees, and scratch folders stay on disk. Stop a project's running conversations before you remove it.

Right-click a thread to **Rename thread**, **Copy** its **Path**, **Branch**, or **Thread ID**, **Archive thread**, or **Delete**. Rename saves a nonempty title on Enter or blur, and Escape cancels. Archive hides a thread until you restore it in **Settings > Archived**. Restore preserves its former pin, settle, or active placement, and archive clears its snooze. Threads with old activity can settle again after restoration. Delete asks for confirmation and permanently removes conversation history and the thread's terminal processes. Running conversations and checkout operations must finish first.

The sidebar's bottom Settings button opens General, Appearance, Keyboard shortcuts, Storage, and Archived. Command+, also opens settings. General and Project start with "Applying settings for", followed by a project picker. With **All projects** picked, General sets where new threads start for every project. Pick a repository to override those defaults for that project only. The reset button beside a setting removes the override, and the layers button shows which value applies. While a project is picked, a **Project** page appears at the top of the navigation. Appearance, prompt and code font sizes, and project overrides save on this device. Back or Escape returns to the same conversation and draft.

General > Behavior has T3's **Thread notifications** menu with Off, Notifications only, Sound only, and Notifications with sound. It starts off and applies to this device. Background turns can alert when they complete, fail, or wait for approval. Clicking a system notification focuses Bot Code and opens that thread. The open conversation stays silent while its window has focus. **In-app notifications** separately enables an **Open thread** toast for other conversations while the app has focus. Restore defaults turns both settings off.

macOS asks for notification permission only when you choose a mode with system notifications. A denied request keeps your previous choice. System alerts require launching the bundled `.app`, built with `pnpm tauri build --debug --bundles app`. Local bundles use an ad-hoc signature so macOS recognizes the app's notification identity; distribution can supply `APPLE_SIGNING_IDENTITY` as described in [Tauri's signing guide](https://v2.tauri.app/distribute/sign/macos/). Sound only and in-app toasts also work in `pnpm tauri dev`. The port uses T3's completion and attention sounds and a patched Tauri notification plugin backend for macOS permission and clicks.

The terminal toggle in the header, or Command+J, opens a terminal drawer under the conversation in the thread's checkout. Command+D and Shift+Command+D split the focused terminal, Command+N adds one, and Command+W closes it after confirmation. Each thread keeps its own terminals. Their shells keep running while you work in another thread and show their earlier output when you return. Shells do not survive quitting Bot Code.

Bot Code reads your repository's `t3.json` directly. Existing T3 project files work without conversion, including comments and trailing commas. Invalid files show an error instead of silently dropping their scripts. The first script with `runOnWorktreeCreate: true` runs in each new worktree. Its timeline card shows live output and offers **Retry** after failure. Setup runs alongside the first agent turn by default. Set `async: false` on the script to wait until it exits before starting that turn. A failed exit still allows the agent to start, as in T3.

Project scripts appear in the chat header. Running one opens a terminal tab in the right panel at the current checkout. **Script actions > Set keyboard shortcut** saves a device binding for `script.{id}.run`. Both automatic setup and manual scripts receive `T3CODE_PROJECT_ROOT`; worktree scripts also receive `T3CODE_WORKTREE_PATH`. Setup completion survives a restart, and retry checks the saved result before launching another attempt. `worktreeSubmodules` accepts `recursive`, `top-level`, or `none`. A failed submodule checkout still allows the setup script to run. Bot Code reads `previewUrl` and `autoOpenPreview` but does not open a preview from these scripts.

The composer has model, reasoning effort, and access menus backed by the provider's supported choices. Settings save per conversation and apply to the next turn. **Supervised** asks before commands and file changes. **Auto-accept edits** allows edits and asks before other actions. **Auto** uses Codex's automatic review. **Full access** allows commands and edits without prompts.

New drafts inherit **Settings > General > New threads > Permissions**, including the selected project's override. The initial provider default is **Full access**, as in T3. Saved threads and access modes you explicitly choose in a draft keep their permissions. The reset and layers buttons show and restore inheritance.

Command, file-change, network, filesystem permission, and supported MCP consent requests appear above the composer. **Approve** and **Decline** are the main actions. **More approval options** offers **Always allow this session** when supported, so Codex can skip matching requests in that session. MCP requests can also offer **Always allow** when they support persistent consent. Each request supplies its available choices and any warning. **Cancel** returns the provider's cancellation response. Pending approvals expire if Codex stops. Bot Code declines MCP URL requests and forms that need input the approval buttons cannot supply, matching T3. Dynamic tool calls and token refresh remain unsupported; T3 has no token-refresh handler.

Type `@` at a word boundary to search files in the thread's checkout. Arrow keys choose a result, and Enter or Tab inserts a path chip. Chips retain the full relative path when copied, pasted, sent, or recovered. Type `$` at a word boundary to search Codex skills, including repository skills and installed skills such as `pstack:poteto-mode`. Type `/` at the start of a line for skills, `/model`, `/plan`, `/default`, and `/usage-limits`. Both `$pot` and `/pot` find poteto-mode. Picking a skill inserts a chip, sends `$name` to Codex, and shows the chip in the sent message. Disabled skills stay hidden. Currency amounts such as `$5` remain ordinary text. Escape dismisses the menu; Shift+Enter adds a line.

Skills refresh for the thread's checkout and when you reopen a menu after 30 seconds. If Codex cannot list skills, the menu shows an empty state and you can keep composing and sending prompts.

When the installed Codex app-server advertises Plan and Default collaboration modes, the composer shows a **Build / Plan** toggle. Plan saves per conversation and uses the selected model, effort, and access settings. Codex's proposed plan appears as a collapsible card. Type feedback and send **Refine** to continue planning, or leave the prompt empty and choose **Implement** to run in Build mode. **Implement in a new thread** starts a Build conversation in the same checkout, preserving its files. Only one conversation can run in that checkout at a time. Planning questions appear above the composer when Codex requests them.

Type `#` at a word boundary for recent pull requests, `#123` to look up a number, or `#search` to search titles through GitHub CLI. Selecting a result inserts a PR context chip with its captured title, URL, and branches.

Diff line numbers offer a comment control. Write a comment and choose **Add to chat** to insert its selected diff lines into the composer. Terminal selections also offer **Add to chat**. Select text in an assistant response and choose **Cite** to quote it in the composer. These context chips share the file and skill chip model. Copy and paste preserve their payloads, and drafts retain text and chips across conversation changes and renderer reloads. Queued follow-ups retain the context captured when you send them. Codex receives T3's context and assistant citation envelopes.

Codex 0.160.1 exposes collaboration modes but no slash-command catalog, so the menu includes the four app commands above.

To attach an image, paste it into the prompt or drop it on the composer. Bot Code accepts PNG, JPEG, GIF, and WebP images up to 10 MiB. Click the button on a thumbnail to remove that image. Codex receives each image as a local file, and the image stays in the sent message after a restart.

A new worktree starts on a temporary `botcode/<random>` branch. Its first message generates a short branch name in the background. Bot Code applies the name after the first Codex turn ends and keeps the same folder. A branch switch, Git action, cleanup, or later message cancels pending naming. A generation failure keeps the temporary branch and does not interrupt the conversation. Local checkouts and branches you name yourself keep their names.

In a repository thread, the Git actions control at the right of the header commits, pushes, pulls, and opens GitHub pull requests for that thread's checkout. Its button runs the next step for the branch. Its menu lists Commit, Push, and Create PR or View PR. The commit dialog generates an editable message with the selected Codex model. You can type your own message or leave the field empty to generate one when committing. Closing the dialog cancels its preview, and a typed message can proceed while generation runs. Pull requests go through the GitHub CLI, so install `gh` and run `gh auth login`. Bot Code generates the pull request title and body from the branch's commits and diff against its recorded base, normally the branch the worktree started from or the default branch. If generation fails, the result toast explains the fallback to `gh pr create --fill`. A failed automatic commit asks you to enter a message and leaves the changes uncommitted. Bot Code refuses a Git action while Codex works in the same checkout, and refuses a prompt or a branch switch there while a Git action runs.

The **Open** button in the header opens the conversation's checkout in your preferred editor, and Command+O does the same. Its menu lists the editors installed on this Mac, such as Cursor, VS Code, Zed and the JetBrains IDEs. Choosing one opens it and remembers it. **General > Application > Preferred editor** sets the same choice, and **Automatic** uses the first installed editor. The file viewer has the same control for the open file. Right-click a diff file header or a file in a changed-files card to open it, choose another editor, or **Reveal in Finder**. Right-click a file link in chat for the same actions and to copy its path. A link that names a line, such as `src/main.ts:12`, opens at that line. Bot Code opens only files inside the conversation's checkout, or absolute paths that the conversation itself names.

The browser build explains that the native runtime is required. It does not simulate repositories or conversations.

Open **Reviews** in a repository conversation to load its branch's open PR from github.com through `gh`. Reviews includes inline threads and replies, review summaries, and PR conversation comments. It shows author and source links, GitHub resolved/outdated status, original reviewed commits and diff hunks when GitHub supplies them, plus separately labeled checkout HEAD and PR head. Use **Fix** for planned work, **Dismiss** with a reason, **Needs decision**, or **Clear decision**. These choices save locally and become stale when the PR head or finding changes. Fix does not mean verified. **Ask Codex** appends the selected finding to the existing conversation draft and focuses the composer. You send it. Bot Code does not post comments or resolve threads on GitHub. Reviews is absent for threads without a project and removed worktrees. Enterprise GitHub hosts are not supported in this slice.

## State and recovery

Bot Code keeps its data in `~/.z1`, the directory it used as Z1 Code. That directory holds preferences in `settings.json`, the SQLite database, worktrees under `worktrees`, threads without a project under `scratch`, and images under `attachments`. Each image file is named by the SHA-256 of its bytes, and each saved turn and steering instruction lists the images it sent. At startup, Bot Code deletes images that neither a saved turn nor an outstanding rewind references once they are a day old. Recovered images survive restart until the next accepted send. Settings > Storage can remove worktrees of inactive or unchanged threads to save space, and the thread's next message recreates its worktree. The **Delete worktrees with deleted threads** switch is off by default. When enabled, deleting a thread also tries to remove its unused clean worktree without force. Dirty, shared, locked, or unsafe worktrees stay on disk, and the app reports the reason after deleting the history. Branches, repository roots, and scratch folders stay on disk. The switch applies at deletion time. If storage fails after Git removal, the conversation remains and its next message can restore the missing worktree.

You can edit `settings.json` by hand or symlink it to sync preferences between machines. The database holds machine-local UI state, such as panel widths. Set `BOT_CODE_DATA_DIR` to use another directory. Only one runtime can own a directory at a time. Set `BOT_CODE_CODEX_BIN` to choose an explicit Codex executable, and `BOT_CODE_GH_BIN` to choose an explicit `gh`.

Conversation history and native thread IDs survive restart. Reconnect resumes that saved native conversation. A lost prompt acknowledgement remains uncertain. Bot Code never automatically sends that prompt a second time. Old approval callbacks expire when the provider process ends.

Review decisions survive restart and belong to the project and immutable GitHub PR/finding IDs. Removing a project removes its review decisions. Remote feedback is fetched on demand and is not stored as an offline cache. The database migration preserves older data and refuses a schema version newer than this app supports.

One conversation may run in each canonical checkout at a time. Other checkouts can run concurrently through the shared Codex process. If that process crashes, every conversation with work in flight stops. Each one shows why it stopped, with the last lines Codex wrote to stderr. Pending approvals and questions expire. Your next message restarts Codex and resumes the saved native conversation. Bot Code never sends the interrupted prompt again. If Codex keeps crashing, Bot Code waits longer before each restart, up to 30 seconds. Codex stderr and restart events go to `logs/codex.log` in the data directory. The log rotates at 1 MiB and keeps three older files.

## Verify

```sh
pnpm typecheck
pnpm build
pnpm test:ui
cargo test -p bot-core
pnpm smoke
pnpm tauri build --debug --bundles app
```

The core tests use temporary Git repositories and a scripted JSONL provider. They cover real staged, unstaged, untracked, and rename diffs, path containment, operation deduplication, image attachments, uncertain delivery, approval routing, storage failures, interruption, stalled provider input, and subprocess cleanup. Git actions and review triage use scripted `gh` fixtures. Review checks cover complete nested pagination, failed pages, moving heads, source identity, restart, stale decisions, conflicting writes, migration, and bounded process cleanup. `pnpm test:ui` uses `node --test` for the Git action rules, review prompt/decision behavior, composer context and clipboard round trips, recovery, and React panel rendering. [The review fixture protocol](docs/review-fixtures.md) supports isolated native checks.

The real smoke uses the installed Codex account in a disposable checkout and an isolated state directory. It observes streaming, completion, durable history, and same-native-thread continuation after reopening. It asserts the checkout remains unchanged.

The actual Mac window was verified with native folder selection, two repository trees, real files and Git diffs, live Codex output, command and file approvals, interruption, renderer reload, and conversation continuation after a full restart. Code quotes stay literal in the composer.

Pierre helper packages currently report a theme peer-version warning. Tree, file, and diff rendering passed in the native window despite that warning.

## Roadmap

PR review triage now records local intent and prepares scoped Codex drafts. Automatic verified-fix tracking remains future work. This version does not include browser preview, manual worktree management, Cursor, or a provider plugin system.

The implementation and recovery decisions are in [docs/architecture.md](docs/architecture.md).

Native verification results are in [docs/verification.md](docs/verification.md).

The visual baseline and layout ownership are in [docs/ui-baseline.md](docs/ui-baseline.md).
