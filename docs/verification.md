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

## Sidebar footer and settings

Verified on 2026-10-03 against the pinned T3 Code v0.0.45 source. Footer, sidebar navigation, breadcrumb, grouped settings rows, and number fields use copied T3 classes. No new pixel-difference measurement was made for these settings pages.

The native debug bundle used a disposable Git repository, 25 seeded draft conversations, an isolated `Z1_DATA_DIR`, and the temporary app identifier `dev.z1.code.sidebarverify` to isolate WebView preferences. Native checks passed at 1100×780 and 1000×620. The minimum-size bundle used a temporary Tauri window configuration, because the computer driver did not resize the window edge.

- The Settings gear remained at the bottom while the conversation list scrolled. Back restored that scroll position.
- Settings retained the unsent composer draft and the open README file panel. A selected thread and its URL search remained unchanged across category navigation and Back.
- Search found Prompt font size, Return opened its row, and Escape returned to the conversation. Command+B and Command+, opened settings with the sidebar collapsed, with a visible Back control in the header.
- Dark and System applied in the native window. Prompt size 20px and code size 18px visibly changed the composer and file preview. Those preferences survived a full restart. Restore defaults returned to System, 14px prompts, and 13px code.
- The conversation controls stayed out of the accessibility tree while settings was open. Retained content uses opacity and visibility together to prevent a stale Send-button paint. Separate footer button keys prevent an icon-to-Back width transition from clipping the label.

The collaborative browser used a mocked Tauri boundary for additional checks. Draft, thread search, selection, file tab, and return focus survived settings. Search focused the requested row. Open portal menus closed on settings entry. Browser Back and collapsed-sidebar navigation passed. The file viewer's rendered font measured 18px after the code-size change.

System mode followed emulated dark and light changes. Out-of-range input reverted to the last valid value. Invalid stored fields fell back independently; malformed JSON showed defaults and a read error. A simulated storage write failure applied the change in memory, retained the old saved value, and showed a persistence error. Restore defaults cleared that error.

Frontend typecheck, production build, formatting, whitespace checks, and the native debug bundle passed. Rust runtime behavior and IPC contracts did not change.

## Model, effort, and access controls

Verified on 2026-10-03 with Codex 0.160.0. All 20 core tests passed sequentially. Frontend typechecking, production build, formatting, whitespace checks, and the native debug bundle passed. The provider fixture now publishes its descendant PID atomically, after a verification run exposed an empty-file race in the existing shutdown test.

Core checks cover live-catalog pagination and hidden models, saved settings across restart, legacy defaults, unsupported selections, busy-state rejection, provider loss and catalog recovery, and model and effort reset. Captured start, resume, and turn requests carry T3's access policies and explicit approval reviewer. A failed catalog refresh retains the last successful capabilities. A successful refresh that removes a saved model rejects its next prompt before acceptance.

Browser checks used the collaborative preview until its host disconnected, then headless Chrome with a mocked Tauri boundary. At 1000×620, light and dark layouts retained the conversation sidebar, centered composer, and optional tools panel. Menus stayed inside the viewport with the tools panel open. Keyboard navigation and Escape restored trigger focus. Switching Ultra to Luna reset effort to Medium. Failed settings saves retained the prompt and selections, and repeated attempts reused one created draft. Send stayed disabled during a pending settings save. Settings survived renderer reload, and model discovery could retry without losing the prompt. Default conversations remained usable when discovery failed.

The actual Tauri app used a disposable repository, isolated `Z1_DATA_DIR`, and the temporary identifier `dev.z1.code.modelverify`. The native driver recovered when the test window was visible. At 1000×620, screenshots confirmed the sidebar, centered conversation and composer, and optional tools panel. The model menu stayed inside the viewport with the tools panel open. A legacy conversation showed GPT-6.1-Sol, Low, and Supervised defaults. Selecting Ultra and then GPT-6-Luna reset effort to Medium. Arrow keys and Enter selected High. The access menu showed all four modes; Escape closed it and returned focus to its trigger. The native execution checks retained Supervised access.

A harmless prompt completed with GPT-6-Luna and High effort. All three settings controls were disabled during execution and enabled after completion. The persisted thread and accepted turn recorded those settings. After quitting and explicitly relaunching the binary with the isolated `Z1_DATA_DIR`, reopening the conversation restored GPT-6-Luna, High, and Supervised. Its history remained visible, and a second harmless prompt completed in the resumed session. Native visual, menu, and restart checks passed. Access-policy requests for the other three modes were verified by the core protocol fixtures.

### Opened picker layouts

The first version used generic single-line menu rows for all three controls. The corrected popups copy the pinned T3 structures: a searchable model card with provider lines, an effort heading and descriptions with an advertised Default badge, and access rows with icons and descriptions. Selected rows use shading instead of visible checkmarks. Model search uses the existing live catalog; settings and access-policy mappings did not change.

The final debug bundle passed native checks at 1000×620 with the same disposable repository and isolated `Z1_DATA_DIR`. Typing a model identifier and pressing Return selected GPT-6-Luna on a saved conversation. After the save, Tab moved from the model trigger to effort. Native screenshots confirmed all three opened layouts, including model and access popups with the tools panel open. Escape closed effort, access, and the existing repository menu; the repository trigger regained focus. The isolated test window remains visible for inspection.

The collaborative preview confirmed filtering, selection, focus restoration after an asynchronous save, outside-click dismissal, and dark access-menu presentation. Frontend typechecking, production build, formatting, whitespace checks, and the final native debug bundle passed. No new pixel-difference measurement was made.

### Provider rail and model favorites

The model picker now copies T3's provider rail and star classes. Favorites and Codex are the working rail entries. Device preferences store provider/model pairs, preserve unavailable favorites, and retain stars when appearance and font defaults are restored. Existing conversation settings and provider execution contracts did not change.

The final native bundle passed at 1000×620 with the disposable repository, isolated `Z1_DATA_DIR`, and temporary identifier `dev.z1.code.modelverify`. Clicking a star kept the picker open and the selected model unchanged. Reopening selected Favorites and showed the filled star. Tab reached the model and star separately. Enter removed the last favorite and returned focus to search; Space added a favorite without selecting it. Empty-search Left reached the rail, and Down then Enter switched to Codex. Escape from a focused star closed the picker and restored trigger focus.

After terminating the isolated process and relaunching it explicitly with the same data directory, Favorites still contained GPT-6-Luna. Its rail and star remained visible with the tools panel open. Selecting the favorite by keyboard changed the model and applied its Medium default effort. The isolated window remains open on Favorites for inspection.

Collaborative-preview checks confirmed favorite-first Codex ordering, Favorites filtering, search outside the current Favorites view, and no thread-settings IPC calls from stars. Renderer reload restored favorites. A storage-write failure retained the in-memory star, left the saved list unchanged, and displayed the persistence warning; a later successful write cleared it. Malformed favorites preserved a valid dark appearance and 18px prompt size. Restore defaults retained favorites. Duplicate saved pairs were deduplicated, and a future provider's same-named model did not mark the Codex model as a favorite. Frontend typechecking, production build, formatting, whitespace checks, and the native bundle passed. No new pixel-difference measurement was made.

## Worktree threads

Verified on 2026-10-03 with Codex 0.160.0 against the pinned T3 Code v0.0.45 source. All 24 core tests passed in parallel. Frontend typechecking, production build, Prettier, rustfmt, and the debug Mac bundle passed.

Core checks cover the `z1code/<id>` branch and its directory under `worktrees/<repository>/`, the `thread/start` cwd for local and worktree threads, and a worktree turn that completes while a local turn holds the checkout lease. A second local thread still receives `checkout_busy`. A repository without commits rejects a worktree thread and creates no directory. Legacy snapshots load as local threads. Worktree views list worktree files and branches only, and a thread from another repository is rejected. Moving the lease key or the cwd back to the repository root fails the concurrency and cwd tests.

The native debug bundle used a disposable one-commit repository, an isolated `Z1_DATA_DIR`, and the temporary identifier `dev.z1.code.worktreeverify`. At 1100×780:

- A new thread showed **Current checkout** and `main`. The menu offered **Current checkout** and **New worktree** under **Workspace**. **New worktree** changed the branch label to "From main".
- Return sent a harmless prompt. Real Codex replied `Z1_WORKTREE_OK`. `git worktree list` showed `z1/eff0f251` under the data directory, and the Codex session recorded the worktree as its cwd.
- The strip locked to **Worktree** and `z1/eff0f251`. The sidebar row showed the worktree icon and branch.
- Files listed a file created only in the worktree and opened it in a tab. A new local draft replaced that tab with Files, which listed only the repository's `README.md`.
- Settings › General › New threads › Workspace changed the default to **New worktree**. The open draft followed it. Search for "worktree" found the row.
- After Command+Q and an explicit relaunch with the same data directory, the default stayed **New worktree**. The thread reopened as **Worktree**, and a follow-up replied `Z1_RESUME_OK`. All six cwd records in its Codex session named the worktree.

Worktrees are not removed, because Z1 does not delete threads yet. No new pixel-difference measurement was made.

## Branch picker

Verified on 2026-10-03 against the pinned T3 Code v0.0.45 source. All 27 core tests passed. Frontend typechecking, production build, Prettier and rustfmt passed.

Core checks cover the branch list of the repository checkout and of a worktree thread, including current, default, remote and other-worktree markers. A worktree from `origin/main` starts at the commit of a bare origin that is ahead of local `main`; without the option it starts at local `main`, and a base origin lacks falls back to the local branch. An unreachable origin fails the creation. Switches change the local checkout, create a branch, track a remote branch, and update a worktree thread's stored branch. A held lease returns `checkout_busy` for the local checkout while a worktree still switches. Invalid names return `invalid_branch`, and a branch checked out in another worktree returns Git's error.

The interface was checked in headless Chrome at 1100×780 against a mocked Tauri boundary, so no real Git ran behind it. A worktree draft read **New worktree** and "From origin/main", the picker offered no create row and showed **Start from origin**, and the send carried `{ base: "main", fromOrigin: true }`. A worktree thread read **Worktree** and its branch, disabled branches held by other worktrees, and created `my-new-branch` from a typed "my new branch". A `checkout_busy` failure appeared in the composer error. A local thread switched to `origin/release` and then read `release`. Settings search for "origin" found the row, the switch persisted, and Restore defaults turned it back on.

The native debug bundle used a disposable repository whose bare `origin` was one commit ahead of local `main`, an isolated `Z1_DATA_DIR`, and the temporary identifier `dev.z1.code.worktreeverify`. At 1100×780:

- A worktree draft read **New worktree** and "From origin/main" with chevrons. The picker listed `main` as current, `feature`, and the **Start from origin** switch.
- Return sent a harmless prompt, and real Codex replied `Z1_ORIGIN_OK`. The worktree started at origin's `af05a89` while local `main` stayed at `f08f4c7`.
- The thread strip read **Worktree** and `z1/57b1a89c`. Typing `my-feature` offered `Create new ref "my-feature"`. Return switched the worktree to it, and the stored checkout, the sidebar row and the strip all read `my-feature`.
- A local draft read **Current checkout** and `main`. Its picker showed `my-feature` disabled with a worktree badge. Choosing `feature` switched the repository checkout, and the strip read `feature`.

## Threads without a project

Verified on 2026-10-04 against T3 Code commit `6b286ae8a`. All 31 core tests passed. Frontend typechecking, production build, Prettier, rustfmt and Clippy passed.

Core checks cover the **No project** workspace. A fresh data directory has none. `ensure_scratch` creates exactly one at `scratch` in the data directory, even for two concurrent calls, and returns the same id when called again and after a reopen. Inside a Git work tree `scratch_available` is false and `ensure_scratch` fails with `scratch_unavailable`. A scratch workspace stored earlier still loads there and its threads still open, but new folder threads fail with `scratch_unavailable`. A thread started from "Convert these PNGs to WebP please now ok" gets a folder named `YYYY-MM-DD-convert-these-pngs-to-webp-` plus eight hex characters, and Codex receives that folder as its `thread/start` cwd. A folder thread lists its own files with no changes or branch, rejects branch listing and reports diffs as unavailable. A scratch workspace rejects local and worktree checkouts, and a repository rejects folder checkouts, both with `invalid_checkout`.

The native debug bundle used a disposable one-commit repository and an isolated `Z1_DATA_DIR`. At 1100×780:

- An empty data directory stored no workspace and showed "Add a project, or start without one." with **Add project** and **Start without a project**. Real T3 0.0.45 with an empty home showed the same sidebar and hero.
- **Start without a project** stored the single **No project** workspace. As in T3, the sidebar header then showed the project menu, which listed **No project**, and **Add project**, and the list read "No threads yet". A relaunch opened the **No project** draft instead of the hero, and a prompt there replied `LAZY_OK` from its own folder.
- **Start without a project** opened "What should we work on?" with **No project** below it. The breadcrumb read **No project** and the composer had no workspace or branch strip.
- Return sent a prompt that writes `notes.txt`. Real Codex replied `SCRATCH_OK` and wrote the file to `scratch/2026-10-03-convert-notes-create-a-file-3adeeece`, which is not a Git work tree. The date is UTC.
- A follow-up command waited for approval, and the sidebar row read **Approval**. **Approve** wrote `b.txt` in the same folder. The reply's `b.txt` chip resolved against the folder, and the right panel offered Files only.
- Command+Option+N opened a new scratch draft. Its menu listed **No project** and **Add project**, and **Add project** opened the native folder picker that added the repository.
- The repository draft read "What should we build in demo?" with **or start without a project** below it and kept **Current checkout** and `main`. The link opened a scratch draft whose menu listed **No project**, `demo` and **Add project**. The sidebar menu listed **No project** and `demo`.
- After a restart, the store still held one scratch workspace, and the thread reopened with both turns.

In the first native run, the first command approval was recorded as answered and a file tab opened without a click from the driver. The second run reproduced neither, and the cause is unknown.

## Project management

Verified on 2026-10-04 in the native debug bundle with the temporary app identifier `dev.z1.code.projectsverify`, an isolated `Z1_DATA_DIR` seeded with two disposable repositories and three conversations, and real Codex. The core suite passed 31 runtime tests, including rename persistence, removal across restart, and refusal while a turn runs. Clippy, rustfmt, `pnpm typecheck`, `pnpm build` and Prettier passed.

- The folder button opened T3's project filter under the search field with **All projects** and both repositories. Choosing one showed only its threads and put its badge on the button. **New thread** then opened that project's draft.
- The filter's gear and a right-click on a project row each opened Settings, Projects, focused on that project. The project settings rework below replaced that page.
- Renaming saved on Return and on blur. SQLite held the new label, and the sidebar, header, draft heading and badge updated. An empty name reverted and showed "Project name cannot be empty."
- **Copy path** put the exact repository root on the macOS clipboard. The rework below removed this row, because T3 has none.
- **Remove project** showed a native warning sheet that named the project, its two threads and its path. Cancel changed nothing. Remove deleted the project row and both thread rows, and the repository's files stayed on disk.
- While a Codex turn waited on a command approval, **Remove project** was disabled and its row read "Stop this project's running conversations before removing it." Declining the approval ended the turn.
- After a full restart, the removed project stayed gone, the new name stayed, and the sidebar filter was restored.

Keys sent through `cliclick` did not reach the WebView's text fields, so Return and Delete were sent as System Events key codes.

### Project-scoped settings

A second native pass on 2026-10-04 used a fresh data directory with two repositories and one conversation each.

- Settings opened from the footer read "Applying settings for All projects" with General, Appearance and Keyboard shortcuts in the nav and **Restore defaults** visible.
- Picking alpha-app in the sentence kept General open, added **Project** at the top of the nav, hid **Restore defaults**, and changed the Workspace and Start from origin descriptions to this project.
- Setting alpha-app's Workspace to **New worktree** showed the reset button. The layers popover listed "This project: New worktree" as effective over "All projects: Current checkout".
- The Project page showed the info alert, **Name**, **New threads** with the same Workspace override, and **Danger** with **Remove project**.
- A new alpha-app draft opened in **New worktree**, and a new beta-service draft opened in **Current checkout**.
- The sidebar filter's gear for beta-service opened the Project page with beta-service picked. Removing it named "1 thread", deleted the project and its thread from SQLite, returned to the conversation, and reset the sidebar filter to all projects.
- After a full restart, the alpha-app draft still opened in **New worktree**, and Settings from the footer opened unscoped.

## Settled threads

Verified on 2026-10-04 against T3 Code v0.0.45. The core suite passed 45 tests, 42 of them runtime tests. New tests cover a settle and un-settle round trip across reopen, auto-settling at exactly 3 idle days and not a millisecond before, `kept` suppressing auto-settle, a prompt or a new approval returning a thread to `auto`, `settle_blocked` while an approval waits, settling a running thread, and snapshots saved without `settlement` loading as `auto`. Clippy, rustfmt, `pnpm typecheck`, `pnpm build` and Prettier passed.

The native debug bundle used the temporary identifier `dev.z1.code.settledverify`, an isolated `Z1_DATA_DIR` and a disposable one-commit repository. Seventeen threads were written into the SQLite `threads` table before launch: three recent ones, one 4 days old, one `settled`, one `kept` and 10 days old, and eleven between 5 and 15 days old. At 1100×780:

- The active list showed the three recent threads and the 10-day-old `kept` thread. The shelf sat at the bottom of the sidebar, collapsed, and read "Settled (13)".
- Expanding showed slim rows with dimmed badges, newest first: "Ship release notes" at 5h, the 4-day-old thread at 1d, and the rest at 2d and older. Ten rows showed, then **Show 3 more**, which revealed the last three. This run stamped an auto-settled thread 3 days after its last activity. The stamp now uses the last activity itself, as T3 does, so that thread reads 4d. The runtime test covers the new stamp, and the native shelf has not been observed since that change.
- Hovering a slim row restored its badge and replaced the age with the Un-settle button. Hovering a card replaced its time with **Settle**.
- **Settle** on a card that was not open moved it into the shelf, raised the count to 14, and kept the draft open. SQLite held `{"kind":"settled","atMs":...}`.
- **Settle** on the open "Fix login redirect" opened the next active thread. Settling the only thread matched by a search opened a new draft in its project.
- Command+Shift+S on the open thread moved it to the collapsed shelf, which then showed only its row at "now". Pressing it again returned the thread to the active list, and SQLite held `{"kind":"kept"}`.
- **Un-settle** on a slim row moved the thread back to the active list and stored `kept`.
- With the shelf collapsed, searching "chore 1" showed the three matching settled rows. Clearing the search collapsed the shelf again.
- After quitting and relaunching, the shelf was still expanded, starting again at ten rows, and every settled and kept thread kept its place. SQLite held `z1:sidebar:settled-expanded` as `true` in `ui_state`. The thread seeded without `settlement` was saved back as `auto`.
- With real Codex waiting on a command approval, the card showed **Approval** and no Settle button on hover. Command+Shift+S showed the error banner "Answer the pending approval before settling this thread." and the thread stayed active.
- Keyboard shortcuts listed **Settle thread** as ⇧⌘S under Threads.

A thread that reaches 3 idle days while Z1 is open moves to the shelf at the next sidebar refresh, such as a window focus or a change to the thread. The run did not observe that transition live.

## Pinned and snoozed threads

Verified on 2026-10-04 against T3 Code v0.0.45. The core suite passed 61 tests, 58 of them runtime tests. New tests cover each pin, unpin, settle, un-settle, snooze and wake transition with fixed times. They cover the refusals of a snooze with an open approval or a wake time that is not in the future, and a repeated snooze to the same time keeping the first snooze time unless the thread raised its hand. They cover a raised hand from a newer completed or failed turn or an approval, snoozed threads auto-settling only after they wake, a prompt clearing the snooze but keeping the pin, a new approval returning `kept` to `auto` while keeping a pin, and snapshots saved with `settlement` loading it as `placement`. Clippy, rustfmt, `pnpm typecheck`, `pnpm build` and Prettier passed.

The native debug bundle used the temporary identifier `dev.z1.code.pinverify` through `tauri build --config`, so `tauri.conf.json` never changed. It ran with an isolated `Z1_DATA_DIR` and a disposable one-commit repository. Thirteen threads were written into the SQLite `threads` table before launch. They included one pinned thread, one snooze ending 90 seconds after seeding, a pinned thread with a snooze ending after 150 seconds, a snooze ending after 20 hours, a 4-day-old idle thread, and a 10-day-old thread saved with the old `settlement` field as `kept`. At 1100×780:

- The pinned thread sat at the top as a card with a pin icon and no header. The shelves read "Snoozed (3)" and "Settled (5)". The `kept` thread saved under `settlement` showed in the active list.
- Expanded, the Snoozed shelf listed the three threads soonest first with "2m", "3m" and "20h" in the info color. The pinned one showed its pin icon. Hovering a row showed the **Wake thread now** button.
- With the app left open, the 90-second snooze moved into the active list, and the 150-second one moved into Pinned, each without a reload.
- **Wake thread now** moved the 20-hour thread to the active list. SQLite then held no `snooze` for it.
- Right-clicking a card opened the menu at the pointer with Pin thread, Settle thread and Snooze. Hovering Snooze opened the presets. On a Sunday these were In 1 hour, In 3 hours, This evening and Tomorrow, because Next week falls on the same Monday morning. **Pin thread** moved the card to the top of Pinned and stored `{"kind":"pinned","atMs":...}`.
- **Settle** on a pinned card moved it to the Settled shelf without a pin and stored `settled`. **Settle thread** from the menu on the open pinned thread did the same and opened the next card.
- The pin icon on a pinned card unpinned it and stored `auto`, keeping its expired `snooze` value.
- Command+Shift+P on the open thread pinned it in place without navigating. Keyboard shortcuts listed **Pin thread** as ⇧⌘P under Threads.
- On the open pinned thread, hovering showed the pin, the clock and **Settle**. The clock opened the presets with their times. **In 1 hour** opened the next card and added the thread to the Snoozed shelf at "60m" with its pin icon. Collapsed, the shelf read "Snoozed (1)". SQLite kept `pinned` and held `{"untilMs":...,"atMs":...}`.
- **In 3 hours** from the menu's Snooze submenu on another thread raised the count to "Snoozed (2)". **Wake thread** from the menu on a snoozed row returned it to the active list.
- The Settled shelf showed the 4-day-old idle thread at "4d".
- After quitting and relaunching, both shelves were still expanded and SQLite held `z1:sidebar:snoozed-expanded` as `true`. Every thread was saved back with `placement`, and none kept a `settlement` field.
- With a snoozed thread open, collapsing the shelf left only that thread's row under "Snoozed (1)".

A second run after review fixes used a fresh seed. Escape on the thread menu returned focus to the right-clicked row, which showed its focus ring. A right-click inside the open snooze presets did not open the thread menu. The debug build's own Reload and Inspect Element menu appeared instead. The 90-second snooze again moved into the active list without a reload, and the shelf count dropped to "Snoozed (2)".

The run did not observe the hidden Snooze button while an approval waits, or a raised hand from a turn that finished after the snooze. The runtime tests cover the snooze refusal and the raised hand, but not the hidden button.

### Auto-settling pinned threads

This changed after the run above. Pinned threads used to never settle by themselves. They now auto-settle as in T3, and settling drops the pin. Pinning a settled thread stores the pin with `kept`, T3's active override, so it stays pinned until its next activity.

Verified on 2026-10-04. The core suite passed 67 tests, 64 of them runtime tests. New tests cover an idle pinned thread reading as settled without a pin, un-settling it storing `kept` without a pin, pinning a settled thread storing `kept: true` and never auto-settling, activity dropping `kept`, a prompt returning an auto-settled pinned thread to the active list without its pin, and pins saved without `kept` loading. Clippy, rustfmt, `pnpm typecheck`, `pnpm build` and Prettier passed.

The native debug bundle used the temporary identifier `dev.z1.code.autosettleverify`, an isolated `Z1_DATA_DIR` and two disposable repositories. One thread was seeded 4 days idle and pinned in the earlier `{"kind":"pinned","atMs":...}` shape. At 1100×780:

- The 4-day-old pinned thread was not in Pinned. The shelf read "Settled (1)", and expanding it showed that thread. The seeded pin loaded and was saved back with `"kept":false`.
- Right-clicking its slim row offered **Pin thread** and **Un-settle thread**. **Pin thread** moved it to the top of Pinned with its pin icon and stored `{"kind":"pinned","atMs":...,"kept":true}`.
- After quitting and relaunching, it was still at the top of Pinned and SQLite still held `kept: true`.

The run did not send a prompt to that thread, so activity dropping `kept` was observed only in the runtime tests.

## Auto-settle limit per project

Verified on 2026-10-04 against T3 Code v0.0.45. The core suite passed 72 tests, 69 of them runtime tests. New tests cover a project override beating the default, a `null` override turning auto-settling off for that project only, a `null` default with **No project** using its own override, a missing, unparseable or out-of-range limit falling back to 3 days, and a settings save sending one change hint and reclassifying a thread without a restart. Clippy, rustfmt, `pnpm typecheck`, `pnpm build` and Prettier passed.

The native debug bundle used the temporary identifier `dev.z1.code.autosettleverify`, an isolated `Z1_DATA_DIR`, two disposable repositories and a **No project** workspace. Each repository had a thread idle for 2 days. `settings.json` was seeded with alpha-app at 1 day and beta-service at `null`. At 1100×780:

- The alpha-app thread was in the Settled shelf at "1d", and the beta-service thread stayed in the active list.
- General for all projects showed the Organization group with **Auto-settle inactive threads** on and **Days of inactivity before auto-settle** at 3.
- With alpha-app picked, the row showed the highlighted layers button and the reset button. The popover listed "This project: 1 day" as effective over "All projects: 3 days". The days field read 1.
- Typing 5 in the field saved the alpha-app override as 5. After **Back**, with no restart, the alpha-app thread was in the active list again.
- The reset button removed the alpha-app override, and the field read 3.
- With beta-service picked, the switch was off, the days row was hidden, and the popover listed "This project: Never".
- With **No project** picked, Workspace and Start from origin were disabled and the auto-settle rows stayed enabled. Turning the switch off saved `null` under the **No project** id.
- Setting all projects to 1 day showed the reset button. After **Back**, the alpha-app thread settled and the beta-service thread stayed active.
- **Restore defaults** wrote `"sidebarAutoSettleAfterDays": 3` and empty `projectOverrides`. After **Back**, both 2-day-old threads were active.
- The alpha-app Project page had no auto-settle row, as in T3. Searching settings for "days of inactivity" found **Auto-settle inactive threads** under General.

The sidebar is hidden while settings are open, so the run saw each reclassification after **Back**. The runtime test covers the change hint that updates the list.

## Storage cleanup

Verified on 2026-10-04 against the pinned T3 Code v0.0.45 source with Codex 0.160.0. The core suite passed 50 tests: 1 unit test, 3 repository tests, 35 runtime tests and 11 storage cleanup tests. Clippy, rustfmt, `pnpm typecheck`, `pnpm build` and Prettier passed.

Core checks use real temporary repositories. An inactive clean worktree is removed, its branch survives, and the thread keeps its checkout. A modified file, an untracked file, or an ignored file outside `node_modules` keeps the worktree. Commits beyond origin's default branch keep it under the unchanged rule, and a worktree without them is removed. A running thread and a path shared with another thread keep their worktree. With both rules off, nothing is removed. Missing, unparseable and wrongly typed settings count as off, one key at a time. A removed thread reports the removed message for files and diffs, lists its branch as current, and refuses branch switches. The next message recreates the worktree at the same path on the same branch and Codex receives that cwd. A restore whose branch is gone refuses with `worktree_restore` and starts no turn.

The native debug bundle used a disposable one-commit repository, an isolated `Z1_DATA_DIR`, the temporary identifier `dev.z1.code.storageverify` and real Codex. At 1100×780:

- Settings › Storage showed **Worktrees** with **Delete inactive worktrees** and **Delete unchanged worktrees**, both off. The inactive row showed "Off" beside its switch (`02-storage-off.png`).
- Switching the inactive rule on showed the stepper at 8 days, and `settings.json` held `"worktreeAfterDays": 8` (`03-storage-on-8.png`). The layout matches T3's rows, stepper and switch (`10-storage-vs-t3.png`).
- Eight presses of the minus button stopped at 1 day, and `settings.json` held `"worktreeAfterDays": 1` (`04-storage-1-day.png`).
- Two worktree threads each got a real Codex reply (`05-thread-a-reply.png`, `06-thread-b-reply.png`). A `notes.txt` was written into the second worktree. With the app closed, both threads' turn times were moved back three days in SQLite.
- On relaunch, the startup sweep logged the removal of the first worktree and skipped the second with "working tree has changes". The first directory was gone, `git worktree list` no longer listed it, and its `z1code/09c8eb90` branch remained. The dirty worktree and its `notes.txt` stayed.
- The removed thread opened with its history. The right panel read "This thread's worktree was removed to save space. Send a message to restore it.", and the branch picker read `z1code/09c8eb90` (`07-removed-thread-panel.png`). A rebuilt bundle also showed that line above the composer in place of Reconnect (`09-removed-thread-banner.png`).
- A follow-up message recreated the worktree at the same path on `z1code/09c8eb90`, Codex replied `STORAGE_RESTORED_OK`, and the panel returned to its launcher (`08-restored-reply.png`). All six cwd records in that Codex session named the worktree.

The screenshots were saved outside the repository in `/tmp/z1-storage-shots`. After the restart, the removed thread also showed the earlier "Z1 Code closed. Native execution stopped." notice, because opening a removed thread skipped the reconnect that normally clears it. Opening a removed thread now clears that notice. A runtime test covers the fix, and the native app has not been observed since.

## Git actions

Verified on 2026-10-04 against the pinned T3 Code v0.0.45 source with Git 2.54.0, GitHub CLI 2.102.0 and Node.js 26.7.0. The core suite passed 107 tests: 7 unit tests, 17 Git action tests, 69 runtime tests, 3 repository tests and 11 storage cleanup tests. `pnpm test:ui` passed 84 tests: T3's own logic tests for the quick action and menu rules, and Z1's tests for the dialog order, the `gh` and Codex states and the result toasts. Clippy, rustfmt, `pnpm typecheck`, `pnpm build`, Prettier and the debug Mac bundle passed. Every commit on the branch compiles and typechecks on its own.

Core checks use real temporary repositories with a bare origin and a scripted `gh` that records its arguments and environment. They cover status on a detached HEAD, without an upstream, ahead and behind, with untracked files, and on a worktree branch that tracks `origin/main` from before `--no-track`, which reads no upstream and `main` as its base. A commit, push and pull request run in one action, the first push sets the upstream and records `gh-merge-base`, and an open pull request comes back instead of a second one. A missing or signed-out `gh` refuses a pull request action before anything is committed. A rejected push keeps the landed commit in the outcome. A Git action is refused while a Codex turn holds the checkout, and a prompt is refused while a Git action does. A `pre-receive` hook that sleeps past a short network limit stops the push and releases the checkout. Running an action again after it finished changes nothing.

The core also ran against GitHub. A disposable private repository, `ImNallen/z1-git-actions-verify`, was cloned, and a throwaway program drove the `App` API with Finder's minimal `PATH`. It resolved `gh` at `/opt/homebrew/bin/gh` and read the new branch as having no upstream, `main` as its base and one untracked file. A single `commit_push_pr` action reported the commit, push and pull request phases, pushed with `-u` to `origin`, and opened pull request #1 with the commit subject as its title and the commit body as its description. Afterwards the status read the same-named upstream with nothing ahead, and the lookup returned the open pull request. `create_pr` returned pull request #1 with `created: false`, and **Push** with nothing ahead was refused with `nothing_to_push`.

The interface was checked in Playwright's WebKit 26.6 at 1440×900 against a mocked Tauri boundary, so no real Git ran behind it. The quick action read **Commit, push & PR**. The menu listed **Commit**, **Push** and **Create PR**, and Push explained that local changes must be committed first. The commit dialog showed the branch, three files with their line counts and the totals, focused the message field, and kept its **Commit, push & PR** button disabled until a message was typed. The run showed the step in a toast above the closing dialog and finished with "Created PR #12" and **View PR**. The default-branch confirmation, the Codex-busy info toast and the narrow header passed the same script.

The native debug bundle used the same disposable GitHub repository, an isolated `Z1_DATA_DIR` and real Codex. At 1100×780:

- A repository draft showed no Git control. A **New worktree** thread got a real Codex reply, `Z1_GIT_OK`, and its header showed **Push** for the clean branch. The worktree branch `z1code/dae67816` had `gh-merge-base` set to `main` and no tracking configuration.
- After a new file and a README edit were written into the worktree and the window regained focus, the quick action read **Commit, push & PR**. The menu enabled **Commit** and disabled **Push** and **Create PR**.
- The commit dialog listed `NATIVE.md` at +0 and `README.md` at +2, focused the message field and kept **Commit, push & PR** disabled until a message was typed. Command+Enter started the action. The toast showed "Pushing to origin..." and then "Creating pull request...", and finished with "Created PR #2", the commit subject and **View PR**. The quick action then read **View PR**.
- GitHub showed pull request #2 open from `z1code/dae67816` into `main` with both files. The branch then tracked `origin/z1code/dae67816`.
- The header's **View PR** opened that pull request in the default browser.
- While a second Codex turn ran in the worktree, the quick action read **Commit** and was disabled. When the turn completed, it read **View PR** again.
