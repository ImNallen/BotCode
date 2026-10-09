# Bot Code user guide

This guide covers day-to-day work in Bot Code. Start with the [README's setup instructions](../README.md#run-locally) to launch the desktop app.

Use the topic headings to find a workflow. Command shortcuts use Control on Windows, and Option uses Alt.

## Start a conversation

Choose **Add project**, select a Git repository, and start a conversation. To work outside a repository, choose **Start without a project** or press Command+Option+N, and Bot Code runs that conversation in its own folder under `scratch` in the data directory. Send with Enter. Shift+Enter adds a line. The right-panel toggle in the header opens Terminal, Files, Diff, Preview, and pull request tabs. Approvals offer Approve, Decline, or Cancel turn. Stop is available after Codex acknowledges the running turn.

## Edit files

To edit a file, open it in the Files tab and type. Bot Code saves the file 500 ms after you stop typing, and a dot on the tab shows that a save is waiting. If Codex writes the same file before your edit saves, your text replaces its change, as in T3 Code. Binary files, non-UTF-8 files, and files over 1 MB stay read-only. Bot Code refuses to write outside the thread's checkout or inside `.git`, including through symlinks.

## Follow Codex's work

The conversation shows Codex's work as T3 Code does. Commands, file changes, tool calls, web searches, image views, and agent calls appear as rows. Click a row to see the command output, the patch, the MCP call's arguments and result, or the search query. Codex's reasoning summary streams as **Thinking** and settles as **Thought**, grouped with the tool calls beside it. Context compaction shows a **Context compacted** divider. A finished turn folds its work under **Worked for**.

## Preview websites and local servers

Open **Preview** from the right-panel launcher or its **+** menu. Enter an HTTP or HTTPS URL, or choose a discovered local HTTP server. Back, Forward, and Refresh use the embedded browser. The device toolbar offers Fit panel, Desktop (1280 × 720), Tablet (768 × 1024), Mobile (375 × 667), custom dimensions, and rotation. Fixed sizes preserve CSS breakpoints while fitting the panel; they retain the desktop user agent. Each conversation and project draft keeps its own browser for this app session. Switching tabs or closing the panel hides it, and menus and dialogs can cover it. Preview pages cannot call Bot Code commands or read its attachments.

Codex can open, navigate, snapshot, click, type, press keys, scroll, resize, evaluate synchronous JavaScript, wait for page conditions, and set the preview's appearance. Snapshots provide current element references and optionally a PNG; saved PNGs go under `BOT_CODE_DATA_DIR/preview/screenshots`. Automation examines the main frame and dispatches untrusted DOM events. It does not promise native input behavior or inspect nested frames and shadow roots. PNG capture and appearance overrides currently require macOS. Recording, simulators, and cookie import are excluded.

## Find conversations and project files

Command+K opens the command palette in chat, Settings, and Usage. Search conversation titles and saved prompts, steering input, and assistant messages across projects, including conversations you have not opened in this session. Start a query with `>` to search actions only. Arrow keys select a result, Enter opens or runs it, and Escape closes the palette. A focused terminal keeps Command+K for clearing its output.

The palette offers the existing thread and panel controls, including new threads, Settings, pin, settle, snooze, wake, rename, copy, archive, and confirmed deletion. Pin and settle act in place, as their shortcuts do. Archived threads stay out of ordinary search and can be restored from their own submenu. Actions appear only when their current context supports them. Palette entries and shortcut matching share one action table.

Command+P opens **Go to file** for the active checkout. Type a filename or fuzzy path, use the arrow keys to select a result, and press Enter to open it in the right panel's Files view. Command+Shift+F opens **Search project contents**. Select a matching line to open the file at that line. Both actions also appear in the command palette. On other platforms, use Control in place of Command. A focused terminal keeps these chords for its own input.

Content search offers **Match case**, **Match whole word**, and **Use regular expression**. It searches current file contents, including uncommitted edits, and caps results to keep large repositories usable. The dialog reports incomplete searches and skipped files. Binary files, invalid UTF-8, and files above the viewer's 1 MB limit are skipped. Regular expressions use Rust's supported regex syntax.

Files, **Go to file**, and `@` mentions share one Rust file index for the selected checkout. It respects `.gitignore`, nested ignore rules, `.ignore`, and Git's global excludes. Ignored files stay absent even if Git already tracks them. The picker returns up to 200 rows, and the composer returns up to 50. Search runs outside the UI thread; changing the query makes older rows unavailable until the new results arrive.

Search refreshes the file index on use after two seconds. **Refresh** forces a rebuild after external file or ignore-rule changes. [Project search verification](project-search-verification.md) records native checks and measurements on 50,002 files.

## Queue or steer follow-ups

While Codex runs, Enter queues your text, context chips, and attachments in order. **General > Application > Follow-up behavior** changes that default from **Queue** to **Steer**. Steering adds input to the current run. **Send now** on the first queued message steers a running turn or sends a new turn when idle. Queued messages keep their captured model, effort, and access settings for the next turn. Steering uses the current turn's settings. Queues continue when you switch threads, but waiting input disappears when you reload or quit. Accepted messages and steering instructions remain in history.

**Stop** holds the queue and returns unsent messages to the composer, preserving current text, chips, and attachments. The queued message's remove button returns that one message. If file staging or capacity prevents recovery, the held row stays visible. A message already in flight cannot be recalled. A lost response shows **Check delivery**, which checks the same operation without sending it twice. Failures hold later input for explicit action. Remove queued messages before archiving or deleting their thread or removing its project.

## Inspect changes and rewind a conversation

Repository turns save before and after checkpoints under hidden Git refs. **Open diff** in a turn's changed-files card shows only that turn's changes. The Diff scope menu also offers **Latest turn** and individual turns alongside the checkout's Git diff. Checkpoints do not move your branch or change your index during capture, and their refs survive worktree cleanup.

Hover a prompt and choose **Edit from here** to rewind the conversation before it. **Revert and keep changes** keeps the checkout contents. **Revert files too** restores the checkpoint before that prompt, including non-ignored untracked files, and removes later non-ignored files. Ignored files remain untouched. Restored edits are unstaged when HEAD exists. Steering instructions have Copy only. Rewinding the original prompt removes its whole turn, including steering instructions, and recovers only the original input. The returned prompt, chips, and attachments merge with your unsent input and stay in the composer until you send them. Bot Code continues on a new native Codex thread with the retained conversation, preserving the original native history. A turn or Git action in the checkout blocks rewind. A failed prepared operation offers **Retry revert** and survives restart without replaying a completed restore.

## Manage projects and conversations

The folder button beside the sidebar search filters threads by project. Its gear buttons open that project's Project settings page, where you can rename a repository, choose where its new threads start, or remove it. Removing a project deletes it and its threads from Bot Code and clears its overrides. The repository, Bot Code worktrees, and scratch folders stay on disk. Stop a project's running conversations before you remove it.

Right-click a thread to **Rename thread**, **Copy** its **Path**, **Branch**, or **Thread ID**, **Archive thread**, or **Delete**. Rename saves a nonempty title on Enter or blur, and Escape cancels. Archive hides a thread until you restore it in **Settings > Archived**. Restore preserves its former pin, settle, or active placement, and archive clears its snooze. Threads with old activity can settle again after restoration. Delete asks for confirmation and permanently removes conversation history and the thread's terminal processes. Running conversations and checkout operations must finish first.

## Change settings

The sidebar's bottom Settings button opens General, Appearance, Keyboard shortcuts, Storage, and Archived. Command+, also opens settings. General and Project start with "Applying settings for", followed by a project picker. With **All projects** picked, General sets where new threads start for every project. Pick a repository to override those defaults for that project only. The reset button beside a setting removes the override, and the layers button shows which value applies. While a project is picked, a **Project** page appears at the top of the navigation. Appearance, prompt and code font sizes, and project overrides save on this device. Back or Escape returns to the same conversation and draft.

## Customize keyboard shortcuts

Open **Settings > Keyboard shortcuts** to change a shortcut. Click a shortcut to record a new chord, or use **Type shortcut** to enter T3's key string. **When** edits its condition. **Add keybinding** adds another rule; the row menu resets or removes a custom rule. Changes apply immediately after saving and survive restarting the app. The terminal, composer, project scripts, menus and palette use the same rules.

Bot Code stores `keybindings.json` inside its data directory, shown on the Keyboard shortcuts page. You can copy a T3 `keybindings.json` there without conversion. Bot Code never reads `~/.t3` automatically. The file is an ordered JSON array in T3's exact format, with comments and trailing commas accepted:

```json
[
  { "key": "mod+alt+b", "command": "sidebar.toggle" },
  { "key": "mod+g", "command": "chat.new", "when": "!terminalFocus" }
]
```

`mod` means Command on macOS and Control elsewhere. Conditions support `!`, `&&`, `||` and parentheses. A valid custom rule replaces that command's defaults, and the last matching rule wins. An invalid entry shows an error and leaves the command's defaults active unless another valid rule overrides them. A malformed whole file uses defaults and cannot be overwritten through settings until you fix it. Copied T3 commands that Bot Code does not implement stay in the file and do not intercept keys. External file edits reload when the app gains focus and within two seconds while it is open.

## Recover from a display error

Render failures use T3's error page with **Try again**, **Reload app**, **Copy error**, and a visible error report. A failed right-panel tab or terminal drawer shows that UI within its panel while the sidebar and composer keep working. Markdown highlighting falls back to plain text. Startup failures use the same recovery controls.

## Choose notifications

General > Behavior has T3's **Thread notifications** menu with Off, Notifications only, Sound only, and Notifications with sound. It starts off and applies to this device. Background turns can alert when they complete, fail, or wait for approval. Clicking a system notification focuses Bot Code and opens that thread. The open conversation stays silent while its window has focus. **In-app notifications** separately enables an **Open thread** toast for other conversations while the app has focus. Restore defaults turns both settings off.

macOS asks for notification permission only when you choose a mode with system notifications. A denied request keeps your previous choice. System alerts require launching the bundled `.app`, built with `pnpm tauri build --debug --bundles app`. Local bundles use an ad-hoc signature so macOS recognizes the app's notification identity; distribution can supply `APPLE_SIGNING_IDENTITY` as described in [Tauri's signing guide](https://v2.tauri.app/distribute/sign/macos/). Sound only and in-app toasts also work in `pnpm tauri dev`. Windows shows system notifications through the standard plugin backend. Clicking one does not open its thread.

## Use terminals and project scripts

The terminal toggle in the header, or Command+J, opens a terminal drawer under the conversation in the thread's checkout. Command+D and Shift+Command+D split the focused terminal, Command+N adds one, and Command+W closes it after confirmation. Each thread keeps its own terminals. Their shells keep running while you work in another thread and show their earlier output when you return. Shells do not survive quitting Bot Code. On Windows, the terminal runs PowerShell 7 when it is installed, then Windows PowerShell, then `cmd.exe`. Set `BOT_CODE_SHELL` to choose another shell.

## Run project scripts

Bot Code reads your repository's `t3.json` directly. Existing T3 project files work without conversion, including comments and trailing commas. Invalid files show an error instead of silently dropping their scripts. The first script with `runOnWorktreeCreate: true` runs in each new worktree. Its timeline card shows live output and offers **Retry** after failure. Setup runs alongside the first agent turn by default. Set `async: false` on the script to wait until it exits before starting that turn. A failed exit still allows the agent to start, as in T3.

Project scripts appear in the chat header. Running one opens a terminal tab in the right panel at the current checkout. **Script actions > Set keyboard shortcut** saves a T3-format rule for `script.{id}.run` in the same `keybindings.json`. Existing script shortcuts migrate into that file on startup. A copied script rule applies when its ID exists in the active project. Both automatic setup and manual scripts receive `T3CODE_PROJECT_ROOT`; worktree scripts also receive `T3CODE_WORKTREE_PATH`. Setup completion survives a restart, and retry checks the saved result before launching another attempt. `worktreeSubmodules` accepts `recursive`, `top-level`, or `none`. A failed submodule checkout still allows the setup script to run. When `previewUrl` is set and `autoOpenPreview` is true, a successful script launch opens that URL in Preview for the same conversation or project draft. On Windows, scripts run in `cmd.exe`, as npm scripts do, so `&&` works in both PowerShell versions.

## Choose models and permissions

The composer has model, reasoning effort, and access menus backed by the provider's supported choices. Settings save per conversation and apply to the next turn. **Supervised** asks before commands and file changes. **Auto-accept edits** allows edits and asks before other actions. **Auto** uses Codex's automatic review. **Full access** allows commands and edits without prompts.

New drafts inherit **Settings > General > New threads > Permissions**, including the selected project's override. The initial provider default is **Full access**, as in T3. Saved threads and access modes you explicitly choose in a draft keep their permissions. The reset and layers buttons show and restore inheritance.

Command, file-change, network, filesystem permission, and supported MCP consent requests appear above the composer. **Approve** and **Decline** are the main actions. **More approval options** offers **Always allow this session** when supported, so Codex can skip matching requests in that session. MCP requests can also offer **Always allow** when they support persistent consent. Each request supplies its available choices and any warning. **Cancel** returns the provider's cancellation response. Pending approvals expire if Codex stops. Bot Code declines MCP URL requests and forms that need input the approval buttons cannot supply, matching T3. Some request types, including token refresh, are not supported.

## Add context and use skills

Type `@` at a word boundary to search files in the thread's checkout. Arrow keys choose a result, and Enter or Tab inserts a path chip. Chips retain the full relative path when copied, pasted, sent, or recovered. Type `$` at a word boundary to search Codex skills, including repository skills and installed skills such as `pstack:poteto-mode`. Type `/` at the start of a line for skills, `/model`, `/plan`, `/default`, and `/usage-limits`. Both `$pot` and `/pot` find poteto-mode. Picking a skill inserts a chip, sends `$name` to Codex, and shows the chip in the sent message. Disabled skills stay hidden. Currency amounts such as `$5` remain ordinary text. Escape dismisses the menu; Shift+Enter adds a line.

Skills refresh for the thread's checkout and when you reopen a menu after 30 seconds. If Codex cannot list skills, the menu shows an empty state and you can keep composing and sending prompts.

## Plan before building

When the installed Codex app-server advertises Plan and Default collaboration modes, the composer shows a **Build / Plan** toggle. Plan saves per conversation and uses the selected model, effort, and access settings. Codex's proposed plan appears as a collapsible card. Type feedback and send **Refine** to continue planning, or leave the prompt empty and choose **Implement** to run in Build mode. **Implement in a new thread** starts a Build conversation in the same checkout, preserving its files. Only one conversation can run in that checkout at a time. Planning questions appear above the composer when Codex requests them.

Type `#` at a word boundary for recent pull requests, `#123` to look up a number, or `#search` to search titles through GitHub CLI. Selecting a result inserts a PR context chip with its captured title, URL, and branches.

Diff line numbers offer a comment control. Write a comment and choose **Add to chat** to insert its selected diff lines into the composer. Terminal selections also offer **Add to chat**. Select text in an assistant response and choose **Cite** to quote it in the composer. These context chips share the file and skill chip model. Copy and paste preserve their payloads, and drafts retain text and chips across conversation changes and renderer reloads. Queued follow-ups retain the context captured when you send them. Codex receives T3's context and assistant citation envelopes.

## Attach files and images

**Attach files** opens a multiple-file picker. Files also attach when pasted without clipboard text or dropped on the composer or a sidebar conversation. A sidebar drop opens that conversation and fills its draft without sending. Each message holds up to 100 files. Non-image files must contain at least one byte and can be up to 50 MiB each. Images accept PNG, JPEG, GIF, WebP, HEIC, and HEIF. Bot Code converts HEIC and HEIF to JPEG and compresses larger images to the 10 MiB limit. Image bytes can total up to 80 MiB per message. Generic files appear as inline chips or filename rows, and images show removable thumbnails. Codex receives file paths in the prompt and image paths as image inputs. Attachments remain available after restart.

## Recall and stash prompts

**ArrowUp** in an empty composer recalls that conversation's earlier prompts. **ArrowDown** moves forward and clears the composer past the newest prompt. Recall works at the first or last visual line and carries text only. Existing chips and attachments prevent recall. **Command+S**, or **Ctrl+S** on other platforms, stashes your complete draft, including chips and attachments. The stash holds the newest 20 prompts across conversations. The **Stash** badge opens its picker. The same shortcut restores the sole entry directly when the composer is empty. Restoring appends to existing text and keeps the destination's model settings. Stashed attachments survive restart.

A paste of at least 32 KiB of UTF-8 text becomes a `pasted-text.txt` attachment at the selection. **Command+Shift+V**, or **Ctrl+Shift+V** elsewhere, keeps that paste editable in the prompt.

[Composer verification](composer-verification.md) records the native checks and their evidence.

## Work with Git and pull requests

A new worktree starts on a temporary `botcode/<random>` branch. Its first message generates a short branch name in the background. Bot Code applies the name after the first Codex turn ends and keeps the same folder. A branch switch, Git action, cleanup, or later message cancels pending naming. A generation failure keeps the temporary branch and does not interrupt the conversation. Local checkouts and branches you name yourself keep their names.

In a repository thread, the Git actions control at the right of the header commits, pushes, pulls, and opens GitHub pull requests for that thread's checkout. Its button runs the next step for the branch. Its menu lists Commit, Push, and Create PR or View PR. The commit dialog generates an editable message with the selected Codex model. You can type your own message or leave the field empty to generate one when committing. Closing the dialog cancels its preview, and a typed message can proceed while generation runs. Pull requests go through the GitHub CLI, so install `gh` and run `gh auth login`. Bot Code generates the pull request title and body from the branch's commits and diff against its recorded base, normally the branch the worktree started from or the default branch. If generation fails, the result toast explains the fallback to `gh pr create --fill`. A failed automatic commit asks you to enter a message and leaves the changes uncommitted. Bot Code refuses a Git action while Codex works in the same checkout, and refuses a prompt or a branch switch there while a Git action runs.

## Open files in your editor

The **Open** button in the header opens the conversation's checkout in your preferred editor, and Command+O does the same. Its menu lists the editors installed on this Mac, such as Cursor, VS Code, Zed and the JetBrains IDEs. Choosing one opens it and remembers it. **General > Application > Preferred editor** sets the same choice, and **Automatic** uses the first installed editor. The file viewer has the same control for the open file. Right-click a diff file header or a file in a changed-files card to open it, choose another editor, or **Reveal in Finder**. Right-click a file link in chat for the same actions and to copy its path. A link that names a line, such as `src/main.ts:12`, opens at that line. Bot Code opens only files inside the conversation's checkout, or absolute paths that the conversation itself names.

## Review pull requests

Open **Pull requests** from the right tools panel to see the pull requests linked to the conversation. You can also open one from its sidebar badge or link an existing GitHub.com pull request by URL. Saved links survive branch switches, restarts, and worktree removal.

Each pull request opens in its own tab with **Summary**, **Timeline**, and **Code**. Review checks, comments, and the remote diff there. **Fix**, **Dismiss** with a reason, **Needs decision**, and **Clear decision** record your local review decisions. A decision becomes stale when the pull request's head commit or finding changes. Marking a finding for a fix does not verify the fix.

**Ask Codex** and **Explain with Codex** add context to your draft. **Fix finding**, **Fix check**, and **Resolve conflicts** prepare a conversation in the selected checkout, with a separate worktree as the default. Review the draft and send it when ready.

You can submit reviews, reply to comments, and resolve threads when GitHub allows your account to do so. Choose the action explicitly before sending it. If a submission has an uncertain result, check GitHub before trying again. GitHub Enterprise hosts are not supported.

## State and recovery

Bot Code keeps its data in `~/.z1`, the directory it used as Z1 Code. That directory holds preferences in `settings.json`, the SQLite database, worktrees under `worktrees`, threads without a project under `scratch`, and attached files under `attachments`. Each file is named by the SHA-256 of its bytes and its validated storage extension. Turns, steering instructions, outstanding rewinds, composer drafts, stash entries, and attachment chips retain their files. At startup, Bot Code removes unreferenced attachments older than a day and incomplete uploads older than an hour. An unreadable saved composer owner prevents deletion until its references can be checked. Recovered attachments survive restart until the next accepted send. Settings > Storage can remove worktrees of inactive or unchanged threads to save space, and the thread's next message recreates its worktree. The **Delete worktrees with deleted threads** switch is off by default. When enabled, deleting a thread also tries to remove its unused clean worktree without force. Dirty, shared, locked, or unsafe worktrees stay on disk, and the app reports the reason after deleting the history. Branches, repository roots, and scratch folders stay on disk. The switch applies at deletion time. If storage fails after Git removal, the conversation remains and its next message can restore the missing worktree.

You can edit `settings.json` by hand or symlink it to sync preferences between machines. The database holds machine-local UI state, such as panel widths. Set `BOT_CODE_DATA_DIR` to use another directory. Only one runtime can own a directory at a time. Set `BOT_CODE_CODEX_BIN` to choose an explicit Codex executable, and `BOT_CODE_GH_BIN` to choose an explicit `gh`.

Conversation history and native thread IDs survive restart. Reconnect resumes that saved native conversation. A lost prompt acknowledgement remains uncertain. Bot Code never automatically sends that prompt a second time. Old approval callbacks expire when the provider process ends.

Review decisions survive restart and belong to the project and the original GitHub pull request and finding. Removing a project removes its review decisions. Saved pull request status, titles, and branches appear as last-known data until GitHub confirms them. Review comments and findings load from GitHub on demand. A failed refresh marks the saved status stale.

One conversation may run in each canonical checkout at a time. Other checkouts can run concurrently through the shared Codex process. If that process crashes, every conversation with work in flight stops. Each one shows why it stopped, with the last lines Codex wrote to stderr. Pending approvals and questions expire. Your next message restarts Codex and resumes the saved native conversation. Bot Code never sends the interrupted prompt again. If Codex keeps crashing, Bot Code waits longer before each restart, up to 30 seconds. Codex stderr and restart events go to `logs/codex.log` in the data directory. The log rotates at 1 MiB and keeps three older files.

## Build and check the app

Run the checks that match your change:

```sh
pnpm typecheck
pnpm build
pnpm test:ui
cargo test -p bot-core
```

The frontend can run on Node.js 20.19 or newer on the Node 20 release line, or Node.js 22.12 or newer. UI tests require Node.js 22.18 or newer. The README uses the higher minimum so one setup supports both.

The core tests use temporary Git repositories and scripted providers. UI tests cover Git actions, review behavior, the composer, draft recovery, and panel rendering. The [review fixture protocol](review-fixtures.md) supports isolated native checks.

To check the real Codex connection, run:

```sh
pnpm smoke
```

The smoke check uses your installed Codex account, a disposable checkout, and an isolated data directory. It checks streaming, saved history, and conversation continuation after reopening.

To build a macOS app bundle, run:

```sh
pnpm tauri build --debug --bundles app
```

On Windows, `pnpm tauri build` produces an NSIS installer. CI covers Windows builds and unit tests. Integration tests use POSIX fixtures and run on macOS. The native Windows interface still needs verification.

The development server starts on port 1420. If that port is occupied, `pnpm tauri dev` uses the next free port.

## Further reading

- [Architecture](architecture.md) explains the runtime, storage, and recovery design.
- [UI baseline](ui-baseline.md) describes the layout and interaction conventions.
- [Native verification records](verification.md) record app checks and their results.
- [Composer verification](composer-verification.md) covers context, attachments, and draft recovery.
- [Preview verification](preview-verification.md) covers the embedded browser and its automation.
