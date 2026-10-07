# Verification of the first version

The first-slice checks below describe the original layout. The later T3-style alignment has its own native results at the end.

Verified on macOS on 2026-10-03 with Rust 1.93.0, Node.js 26.7.0, and Codex 0.160.0.

The core suite passed 13 tests. The real Codex smoke observed partial streamed text, completed a turn, restored SQLite history, continued the same native thread after reopening, and confirmed its disposable checkout stayed unchanged. Frontend typechecking, production build, formatting checks, and the debug Mac app bundle passed.

The native checks used the actual Tauri window, disposable Git repositories, and a separate `Z1_DATA_DIR`.

| Workflow              | Observed result                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Native folder picker  | Opened a real Git repository.                                                                                      |
| Pierre tree and files | Displayed real paths and syntax-highlighted contents; refresh found a newly created file.                          |
| Workspace selection   | A second repository displayed its own tree and file contents.                                                      |
| Pierre diffs          | Displayed modified and untracked file contents from the actual working copy.                                       |
| Codex streaming       | Partial assistant text appeared while the turn was running.                                                        |
| Stop                  | The real turn became interrupted and another prompt could run.                                                     |
| Command approval      | Decline prevented execution; Allow once ran a reviewed Python print command and showed its output.                 |
| Full app restart      | Restored four saved turns and continued the same native thread.                                                    |
| Renderer reload       | Retained the live run and its file-change approval.                                                                |
| File approval         | Displayed and applied the exact one-line patch in the disposable repository; the open file and Git diff refreshed. |
| Composer              | Typed straight quotes remained literal.                                                                            |

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

| Scene and region                          | Differing pixels | Cause of the difference                                                            |
| ----------------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| Header, light and dark                    | 0                | None.                                                                              |
| Sidebar thread row                        | 0                | None.                                                                              |
| Sidebar, whole column                     | 678 of 230,400   | The Z1 brand, and T3's Settled shelf and footer icons, which Z1 lacks.             |
| Timeline above the second turn's work row | 0                | None.                                                                              |
| Timeline, whole column                    | 3,809 of 505,600 | T3 records an extra "Approval resolved" activity, which shifts the rows below it.  |
| Composer                                  | 2,279 of 165,900 | The placeholder text, and T3's model, effort, access-mode menus and attach button. |
| Right panel, Files and Diff               | 0                | Measured without the titlebar cluster, where T3 adds a terminal toggle.            |
| Approval drawer                           | 172 of 132,880   | Label text inside the drawer.                                                      |

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

Thread deletion was unavailable in this 2026-10-03 run. Delete-time worktree removal is now verified under [Thread actions and Archived settings](#thread-actions-and-archived-settings). No new pixel-difference measurement was made.

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

## PR review triage

Verified on 2026-10-04. The core suite passed 115 tests. The frontend suite passed 93 tests. Clippy with warnings denied, rustfmt, TypeScript checking, the production build, Prettier and the debug Mac bundle passed.

Core tests use real disposable Git repositories, a scripted GitHub CLI and native SQLite storage. They cover independent pagination of threads and replies, review summaries and PR conversation comments, original reviewed commits, partial-response refusal, moving heads, checkout changes, bounded output and timeouts. Decisions survive restart, retain their evidence and reason, reject conflicting old writes and clear idempotently. Migration preserves existing data and refuses an unknown future schema. Frontend tests cover schema parsing, stale intent, draft preservation and a failed refresh with cached data.

The native debug bundle used the temporary identifier `dev.z1.code.reviewverify`, a disposable repository and an isolated `Z1_DATA_DIR`. Both GitHub CLI and Codex were scripted peers. At 1100×780:

- Reviews showed a PR conversation comment, two inline threads and a review summary. Inline details showed the original commit, path, line, diff hunk and reply. A general conversation comment showed unavailable source context. GitHub resolved and outdated flags stayed separate from local intent.
- Dismiss opened a reason field and disabled Save until it had a reason. Saving stored the dismissal and its evidence in SQLite. Refresh and a quit/relaunch kept the choice and reason.
- Editing a finding marked the saved dismissal stale and kept its reason. Saving Fix updated the evidence. Advancing the PR and checkout head marked Fix stale while the source commit and hunk still named the original reviewed version.
- Ask Codex preserved the existing draft and appended feedback, its source and local intent. The peer log held no `turn/start` before Send. Explicit Send produced one turn with the full prompt and a scripted reply.
- A maximized panel initially kept the composer hidden during the handoff. After a fix and rebuild, Ask Codex restored the panel size and focused the visible composer with the draft preserved.
- Needs decision saved and Clear returned it to Untouched. Empty feedback, no open PR, an authentication failure and a transport failure each showed their own state. Failed refreshes removed old actionable findings and offered Retry.
- A draft without a project offered only Files in the panel launcher. Resizing the panel and scrolling source details preserved the sidebar, centered conversation and bottom composer.

This native run did not contact GitHub or run a real Codex fix. Read-only queries against a public GitHub PR separately confirmed the nonempty original commit, diff hunk, resolved/outdated, summary and conversation schema. Fix records planned work; this slice does not verify remediation or post to GitHub. GraphQL requests explicitly select `github.com`, including when `GH_HOST` names another host.

## Direct pull request tabs

Verified on 2026-10-05. `pnpm typecheck`, Prettier and `pnpm test:ui` (112 tests) passed. New tests cover the resolver and titles, one tab per pull request, and hiding a pull request tab that the current conversation does not link. Each test failed against a deliberately broken resolver, tab identity or eligibility rule.

The native debug bundle used the temporary identifier `dev.z1.code.prverify`, an isolated `Z1_DATA_DIR`, a clone of `ImNallen/z1-git-actions-verify`, real Codex and real GitHub reads of its open PRs #1 and #2. At 1100×780:

- A **New worktree** conversation with no links showed only **Files** and **Diff** in the launcher and the **+** menu. Pressing P on the launcher or in the open menu did nothing, while F opened Files.
- With PR #1 linked, the launcher and the **+** menu read **Pull requests**. Clicking the launcher entry or pressing P opened the #1 detail directly in a tab titled **#1**. **Back** opened the list beside it.
- With the panel closed, the sidebar's **#1 Open** badge opened the **#1** detail directly.
- With PRs #1 and #2 linked, the launcher entry read **Pull requests**. Clicking it or pressing P opened the list. **Open** on the #2 row added a **#2** tab. Unlinking #2 removed that tab.
- A second conversation hid the first conversation's **#1** tab and showed its own empty list. Returning restored the **#1** tab.
- With the second conversation's local checkout on PR #1's branch, the header's **View PR** linked it and opened the **#1** detail directly.

The Git control's create-PR path was not run natively. It uses the same opener as **View PR**.

## T3 pull request detail layout

Verified on 2026-10-05. `pnpm typecheck`, `pnpm test:ui` (125 tests), Prettier, `pnpm build`, rustfmt, Clippy with warnings denied and `cargo test -p z1-core` (173 tests) passed. New frontend tests cover the header control for each lifecycle state, the armed badge beside a conflict, the menu split, the mapping of raw GitHub check states, the checks rollup and summary, and the relative time. A new core test reads a fixture whose totals differ from the sum of its files and whose reviewers include a team and a reviewer who was not requested. It checks the serialized author, labels, reviewers, totals and auto-merge method.

The native debug bundle used the temporary identifier `dev.z1.code.prlayout`, an isolated `Z1_DATA_DIR`, the disposable clone of `ImNallen/z1-git-actions-verify` and `Z1_GH_BIN` set to a proxy for the real GitHub CLI. The proxy refused every mutation and REST write, and its log recorded none from the app. At 1500×1000 with an 880px panel:

- PR #1 read from GitHub showed `imnallen/z1-git-actions-verify #1` in green, **Merge** and the **…** menu, the title, the author's GitHub avatar and login, "updated 1d ago", `gh pr checkout 1`, `main ← z1-verify-145738`, and "1 file +1 -0". Reviewers and Labels read None, and the row read "No checks reported".
- The **…** menu listed All pull requests, Refresh, Explain with Codex, Fix findings, Convert to draft, Squash and merge, Rebase and merge, Close pull request and Open on GitHub. **All pull requests** opened the list. **Squash and merge** opened the confirmation with the captured head and account, and Cancel closed it.
- With the proxy adding two labels, a requested reviewer, an approving reviewer, two running checks and an armed squash auto-merge to the real responses, the header showed the blue **Auto-merge (squash and merge)** badge. The row read "2 of 2 running". Both avatars loaded, and the approver had a green ring. The labels used their colors. The popover listed both checks as Running with Details. The expanded Checks section listed both, and the menu offered **Disable auto-merge**.

The reference screenshot shows the blue **Auto-merge (squash and merge)** button that enables auto-merge while checks run. Z1 shows it when GitHub reports `enable_auto_merge` as the primary action. The disposable pull requests have no checks, so that state was not observed natively. The condensed header that T3 shows after scrolling, and T3's reviewer and label pickers, are not ported.

## Pull request Code tab

Verified on 2026-10-05. `pnpm typecheck`, `pnpm test:ui` (131 tests), Prettier and `pnpm build` passed. No Rust changed. New frontend tests build pierre hunks from GitHub's headerless per-file patches, mark added and removed files, keep a path with a space, and keep the reason for a missing or broken patch. They map every rendered row to the GitHub anchor it comments on, offer no target outside the anchors, and group drafted comments under their line.

The native debug bundle used the temporary identifier `dev.z1.code.prlayout`, an isolated `Z1_DATA_DIR`, the disposable clone of `ImNallen/z1-git-actions-verify` and `Z1_GH_BIN` set to the read-only GitHub CLI proxy. The proxy refused every mutation and REST write, and its log recorded none from the app. No review was submitted. At 1500×1000 with an 880px panel:

- PR #1, read from GitHub, showed "1 file", the five toolbar controls and a collapsed `notes.md` row with its added icon and `+1`. Clicking the row expanded the one added line. Hovering its line number showed the **+** button. Clicking it opened a pending comment under the line with the cursor in it, and typing a sentence kept focus. **Review (1)** opened the composer with `notes.md:1 (right)` and the typed text.
- With the proxy appending a modified file with two hunks, an added file whose path has a space, a removed file and a binary file to the real file list, the tab read "5 files". The modified file showed syntax colors, added and deleted lines with word highlights, and "24 unmodified lines" in the stacked and split views. Each row read `+a −d`. The binary file was listed after the diff with "Patch unavailable, binary or oversized." and **View on GitHub**. The header totals still read GitHub's real "1 file", because the proxy changed only the file list.
- In the split view, **+** on the old-column context line 30 opened a comment under new line 31. **+** on added line 34 in the stacked view reached the composer as `src/run.ts:34 (right)`. The trash button discarded a pending comment. The file tree listed the four rendered files with their status, and choosing `run.ts` expanded and scrolled to it. A drafted comment stayed on its line after switching to the Diff tab and back.
- The local Diff tab still rendered a working-tree change in the clone with its own toolbar order, and the change was then reverted.

Screenshots are in `/tmp/z1-prverify-code`. Z1 leaves out T3's commit picker and Viewed checkboxes, which need per-commit diffs and saved viewed state. It also leaves out multi-line comments, existing conversations under their lines and expanding unchanged context, which needs the full file contents.

## Editable pull request title and description

Verified on 2026-10-05. `pnpm typecheck`, `pnpm test:ui` (133 tests), Prettier, `pnpm build`, rustfmt, Clippy with warnings denied and `cargo test -p z1-core` (177 tests) passed. New core tests use the scripted GitHub CLI. A title edit sends `updatePullRequest` with only the pull request ID and the title, and a re-read returns the new title. An empty description is applied, while blank and 257-character titles are refused before any mutation. Without `viewerCanUpdate`, at the first or the final permission read, no mutation is sent. An edit applies after the head moves and is refused after the account changes, while a reply against the old head is still refused. Each test failed against a deliberately broken head or permission check.

The native debug bundle used the temporary identifier `dev.z1.code.preditverify`, an isolated `Z1_DATA_DIR`, a disposable clone of `ImNallen/z1-git-actions-verify` and `Z1_GH_BIN` set to a proxy for the real GitHub CLI. The proxy passed reads and `updatePullRequest`, refused every other mutation and REST write, and logged every call. The conversation was linked to PR #1 through the core API before launch. At 1500×1000:

- Hovering the title of PR #1 showed the pencil. Editing the title and pressing Enter showed **Saving...** until the refreshed detail arrived, then the new title and "updated just now". `gh pr view` returned the new title, and the proxy log held one `Z1EditTitle` mutation with no body field.
- Hovering the description showed its pencil. The editor kept the existing text, Preview rendered a bold list item, and Cmd+Enter saved. `gh pr view` returned the new body, and the log held one `Z1EditBody` mutation with no title field.
- With the proxy refusing one marker title, the save kept the typed title in the field and showed GitHub's refusal below it. Escape then closed the editor without a request, and GitHub kept the previous title.
- The Pull requests list showed the edited title.

PR #1 was restored to its original title and description afterwards.

## First-message worktree branch names

Verified on 2026-10-05. `cargo test -p z1-core` passed 190 tests, including 12 public worktree naming tests and a process timeout test. Clippy with warnings denied, rustfmt, frontend typecheck, production build and the debug Mac app bundle passed. The real-Git tests cover first-message acceptance and receipt replay, the selected model, unchanged folders and PR bases, restart, follow-up messages, branch collisions, the total 64-byte limit, upstream and remote tracking guards, checkout exclusion, cancellation and process cleanup. The slash-remote publication and collision tests and the long-name collision test failed against the earlier implementation and passed after the fixes.

The native debug bundle used `dev.z1.code.namingverify`, a disposable repository under `/tmp/z1-worktree-naming/native/repository`, an isolated `Z1_DATA_DIR` under the same directory, and the installed Codex binary. A first message asking to fix login redirects and reply without touching files started on `z1code/a8758424`. Codex returned `Z1_NAMING_OK`, and the sidebar changed to `z1code/fix-login-redirect-handling`. Git HEAD and the saved SQLite checkout agreed on that branch. The folder remained `z1code-a8758424`, the PR base remained `main`, and both repository checkouts stayed clean.

That native run exposed a stale composer branch because workspace hints did not invalidate the branch query. The fix uses the existing checkout invalidation helper. All 134 frontend tests passed. The new subscriber regression uses Tauri's event mock and an active React Query observer. A naming hint refreshes the current branch data and sidebar summary while another workspace stays cached. It failed against the old invalidations and passed with the fix.

The native recheck passed on 2026-10-06 after desktop access became available. With `dev.z1.code.namingfinalverify` and the same disposable repository and isolated state, a new worktree started on `z1code/7c956a08` and changed to `z1code/improve-password-reset-validation`. Both the sidebar and composer refreshed automatically without opening the branch picker. A follow-up about checkout cleanup kept that name. After a full quit and relaunch, opening the conversation restored both responses and the generated name in the sidebar and composer. Git HEAD and SQLite agreed, the folder remained `z1code-7c956a08`, the PR base remained `main`, and the worktree stayed clean. The core restart and follow-up tests also passed. Evidence and review reports are under `/tmp/z1-worktree-naming`.

## Terminal drawer

Verified on macOS on 2026-10-06 in the `pnpm tauri dev` window with an isolated `Z1_DATA_DIR`, a disposable repository and a Swedish Pro keyboard layout. `cargo test -p z1-core` covers the PTY manager against `/bin/sh`: spawning in the thread's checkout, history replay on reattach from the same shell, resize, close, exit, and shutdown and drop reaping.

| Workflow          | Observed result                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| No-project draft  | No terminal toggle.                                                                                           |
| Repository draft  | The toggle sat left of the right-panel toggle. Command+J opened a login zsh in the repository and focused it. |
| Typing            | `$`, `@`, `[`, `]` and the `~` dead key arrived intact. Command+T and Command+U sent nothing to the shell.    |
| Reattach          | Closing and reopening the drawer, and switching split groups, replayed earlier output from the same shell.    |
| Split and new     | Command+D split side by side, Command+N added a group, and T3's tab sidebar listed both groups.               |
| Close             | Command+W asked "Close terminal "Terminal 1"?" and kept the window open. Confirming ended one shell process.  |
| Exit              | `exit` removed the tab and its process.                                                                       |
| Resize            | Dragging the top edge grew the drawer and shrank the conversation above it.                                   |
| Quit and relaunch | Quitting left no shell processes. The persisted open drawer started a new shell after relaunch.               |

A tall drawer on an empty draft lets the centered heading overlap the header, as T3's identical overlay does. Light mode, link clicks and switching between existing threads had no native observation.

## Right-panel terminal

Verified on 2026-10-06 in the same native setup.

| Workflow         | Observed result                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launcher         | **Open a surface** listed **Terminal** with T above Files and Diff. T opened a focused "Terminal 1" tab in the repository while the drawer held `term-3`. |
| Panel shortcuts  | Command+D split the tab side by side, Command+N opened a "Terminal 4" tab, and Command+J closed the drawer.                                               |
| Tab switch       | Returning to the split tab replayed both panes' earlier output.                                                                                           |
| Tab close        | The tab's close button asked "Close 2 terminals?". Confirming ended both shells and left the other tab.                                                   |
| No-project draft | The Terminal row was dimmed, and T started no shell.                                                                                                      |
| Quit             | No shell processes remained.                                                                                                                              |

Returning to a thread restores its terminal tabs in `reconcileTerminalSurfaces` tests but had no native observation, because the disposable data directory had no threads.

## Context window meter and usage limits

Verified on macOS on 2026-10-06 in the native debug bundle with the temporary identifier `dev.z1.code.usageverify`, an isolated `Z1_DATA_DIR`, a disposable one-commit repository and real codex-cli 0.160.1 signed in to a ChatGPT Pro account. `cargo test -p z1-core` drives the fake peer through reads, sparse updates, other limit buckets, API-key and signed-out accounts, failed reads and provider loss. At 1100×780:

| Workflow                      | Observed result                                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/usage-limits` on a draft    | The notice docked above the composer with "Codex · ChatGPT Pro 20x Subscription" and one Weekly row: 56% left, the even-spending mark and "resets in 3d 4h". No thread was created. |
| First turn                    | The notice closed when the turn started. The ring appeared left of Send, and SQLite stored `{"usedTokens":20682,"maxTokens":258400,"totalProcessedTokens":null}`.                   |
| Meter card                    | Hovering the ring showed "Context Window", "8% · 21k/258k", the bar and "Context for GPT-6.1-Sol compacts automatically when needed."                                               |
| Usage page                    | The sidebar Usage button opened the page with the same Weekly row and Refresh. The thread list stayed, the footer showed Back, and Escape returned to the conversation.             |
| Switch                        | Turning off **Context window indicator** removed the ring. Turning it on brought it back.                                                                                           |
| `/usage-limits` during a turn | The notice opened while Stop showed, and nothing reached Codex.                                                                                                                     |
| Quit and relaunch             | The ring returned from storage with "8.1% · 21k/258k" and "Total processed 42k".                                                                                                    |

The account has no 5-hour window, so a Session row had no native observation. Light mode, an API-key login and a live percentage change during a turn had no native observation.

## Generated commit messages and pull request text

Verified on macOS on 2026-10-06. `pnpm typecheck`, `pnpm test:ui` (202 tests), `cargo test -p bot-core` (239 tests), Prettier for the changed frontend files, rustfmt, `git diff --check` and the debug Tauri bundle passed. The final core suite ran with its default parallelism. An earlier delegate run hit the existing store-migration lock race, returning `already_running` instead of the expected `unsupported_schema`; its retry and both integrated-tree runs passed without changes to storage.

The public core tests use real Git and scripted Codex and GitHub CLI peers. Together with the UI tests, they cover selected-model propagation, unchanged real index bytes with a split index, an unborn repository, edits and intentional blanks, late registration cancellation, stalled preview and descendant cleanup, typed submission while a preview runs, blank combined actions, the recorded nondefault `develop` base, preflight refusal before staging or generation, invalid and missing output, PR fallback warnings on both success and failure, and existing PRs bypassing generation. The worktree-cleanup regression failed without immediate preview cancellation and passed after the fix. It removes a real worktree, requires a cancelled result, and checks that both the generator and its descendant exit. Independent review found no remaining concrete bugs.

The native debug bundle used `dev.bot.code.writingverify`, `BOT_CODE_DATA_DIR=/tmp/bot-git-writing-verification/native/state` and a disposable repository under the same directory. Its GitHub-shaped remote was redirected by repository-local Git configuration to a local bare repository. `BOT_CODE_GH_BIN` selected the scripted fixture, so no GitHub reads or writes occurred. The first passes used the scripted Codex peer; the final pass used installed codex-cli 0.160.1 through a logging proxy. At 1100×780 in dark mode:

| Workflow                  | Observed result                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open and cancel           | The dialog showed an editable generated subject and body. Its prompt included tracked and untracked changes and the selected `model-two`. Cancelling left HEAD and the actual index bytes unchanged.                                                                                                                                                                              |
| Cancel pending generation | Cancelling a stalled preview stopped both its process and its TERM-ignoring descendant. The actual index remained unchanged.                                                                                                                                                                                                                                                      |
| Edit during generation    | A late result preserved the exact typed subject and body, and the dialog showed "Your message will be used." Command+Enter committed that text.                                                                                                                                                                                                                                   |
| Submit while preview runs | A typed commit completed while its preview was stalled. Both preview processes exited, and Git held the exact typed subject.                                                                                                                                                                                                                                                      |
| Intentional blank         | Clearing a generated message showed "A message will be generated when committing." The combined action generated again from the actual staged diff, committed, pushed to the local bare remote, and created a fixture PR with an explicit title and private body file. Its prompt contained the branch commits and recorded `main` base.                                          |
| Commit failure            | Invalid generated output showed the manual-message guidance. Blank submission left HEAD unchanged, skipped later steps and offered **Commit** to reopen the dialog. A typed message then committed successfully.                                                                                                                                                                  |
| PR failure                | Invalid generated output used `gh pr create --fill`. The result toast showed the fallback note, and the fixture recorded the commit-based title and body.                                                                                                                                                                                                                         |
| Real Codex                | Selecting GPT-6-Luna generated a visible preview. Clearing it and submitting generated a fresh commit and a PR title and Markdown body with `## Summary` and `## Testing`. All three exec calls succeeded with `--model gpt-6-luna`. Git and the fixture contained the returned text exactly, and the remote branch matched HEAD. The native toast showed the generated PR title. |

The fixture does not supply complete PR-review metadata, so the right panel showed status or metadata warnings for fixture PRs. PR-review behavior was outside this check. Light mode and minimum-size layout had no native observation. Logs, fixture data and the real-Codex comparison are under `/tmp/bot-git-writing-verification`. The isolated app was closed after verification. No changes in the working repository were committed or pushed.

## Turn notifications

Verified on macOS on 2026-10-06 against T3 Code v0.0.45. `pnpm typecheck`, `pnpm test:ui` (201 tests), `pnpm format:check`, `cargo fmt --check`, `cargo test -p bot-core` (229 tests), and the debug `.app` build passed. Observer tests cover startup baselines, duplicate and stale revisions, new approval identities, off and focused suppression, and recovery through refresh after a missed live hint. The refresh regression failed before its fix.

After rebasing onto the updated main branch for the pull request, typecheck, all 209 UI tests, the production frontend build, Prettier, rustfmt, Clippy with warnings denied, and all 239 core tests passed.

The real Tauri bundle used `dev.bot.code.turnnotificationsverify`, an isolated `BOT_CODE_DATA_DIR` at `/tmp/bot-turn-notifications/native/data`, and a disposable one-commit repository with separate Alpha and Beta worktrees. A release-controlled Codex app-server peer ran through the actual Rust runtime and produced completion, failure and approval events. At 1100×780, the sidebar, centered chat, bottom composer, compact header and neutral colors remained intact. General > Behavior showed T3's two rows, four mode labels and menu width. Search found and focused Thread notifications.

| Workflow                        | Observed result                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial launch and Sound only   | No macOS permission prompt. Sound only saved on this device.                                                                                                                                           |
| Explicit notification opt-in    | Choosing Notifications only opened the macOS permission dialog. Permission refusal preserved Sound only and appeared in the row. After enabling the disposable app in System Settings, the mode saved. |
| Two concurrent background turns | Both threads showed Working before minimizing the window. Releasing Alpha's completion and Beta's approval produced separate native alerts, visible together in the expanded macOS notification group. |
| Completion click                | From minimized Beta, the native completion alert restored the window, focused the composer and opened Alpha's exact workspace/thread URL.                                                              |
| Approval click                  | Opened Beta's exact thread with the harmless command approval still waiting.                                                                                                                           |
| Background failure              | Showed Thread failed; clicking it restored Alpha from selected Beta and displayed the failure reason.                                                                                                  |
| Focused selected thread         | With both mode and in-app notifications enabled, Alpha completed without a toast. A native Web Inspector audio probe recorded zero audio-buffer starts.                                                |
| Focused other thread            | While viewing Beta, Alpha's completion showed Thread completed with Open thread. Clicking it opened Alpha. The decoded completion buffer started in a running AudioContext.                            |
| Notifications with sound        | A background Beta approval showed a native alert and started the copied attention buffer in a running AudioContext. Its click opened Beta.                                                             |
| Full quit and relaunch          | Both mode and in-app enabled persisted. Historical turns produced no toast or permission prompt on startup.                                                                                            |
| Restore defaults                | The saved mode returned to off and In-app notifications returned to false.                                                                                                                             |

The first native permission request exposed a packaging defect: the debug bundle's linker signature had a different identifier from its Info.plist, and Apple returned `UNErrorDomain` error 1. Signing the bundle with its own identifier produced the permission dialog. The final build applies Tauri's ad-hoc signing configuration automatically and passed the native alert/click checks.

macOS suppressed banners while display sharing was configured to hide notifications. The test temporarily allowed them and restored the original Notifications Off setting afterwards. All three disposable Git checkouts stayed clean. The audio probe verified decoded buffer playback, not audible output from physical speakers. Clicks after the application has completely quit were not exercised. Test logs, fixture scripts, the decision trail and native accessibility observations are under `/tmp/bot-turn-notifications`; native screenshots are in the task's tool transcript.

## Composer image attachments

Verified on macOS on 2026-10-06 with `pnpm tauri dev`, an isolated `BOT_CODE_DATA_DIR` at `/tmp/botcode-img-data`, a disposable one-commit repository and real codex-cli 0.160.1. The installed app-server protocol, generated with `codex app-server generate-ts`, lists `{ "type": "localImage", "path": string }` as a `turn/start` input item. Bot Code sends the text item, then one `localImage` item per image.

`cargo test -p bot-core` passed 248 tests. The attachment tests cover content sniffing, the 10 MiB limit, one file for repeated bytes, and the sweep. The runtime tests cover the `turn/start` input order, a retried submit that returns the same turn and sends once, conflicting retries, image-only messages, missing files, and attachments after reopening. `pnpm test:ui` passed 223 tests, including the paste and drop classification and the retry operation ID. `pnpm typecheck` passed.

| Workflow                  | Observed result                                                                                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paste                     | A window screenshot taken with `screencapture -c` pasted as a 64px thumbnail with a remove button. The data directory held one file, `attachments/d2dc25f3….png`, 100,089 bytes.                                                                                                    |
| Send                      | The prompt "Describe the attached image in one sentence, including any text it shows." returned "The image shows a blue circle on a yellow background beside bold black text reading 'ZEBRA 7319,' displayed in a window titled 'zebra.png.'" The prompt did not name the contents. |
| Timeline                  | The user message showed the image above its text. SQLite stored the turn's attachment as `{"id":"d2dc25f3…","mimeType":"image/png","name":"image.png","sizeBytes":100089}` with accepted delivery and completed execution.                                                          |
| Quit and relaunch         | The thread opened with the image still rendered from `botcode-attachment://`.                                                                                                                                                                                                       |
| Drop                      | Dragging a different PNG from Finder showed the drag-over ring. The drop added its thumbnail and stored a second file. The Finder file stayed in place.                                                                                                                             |
| Remove                    | The remove button cleared the thumbnail and disabled Send.                                                                                                                                                                                                                          |
| Drop outside the composer | Dropping the PNG on the timeline added nothing, and the page stayed in place.                                                                                                                                                                                                       |

A retried submit after a lost response had no native observation, because the window cannot drop a response. The runtime test covers it. An image-only message, unsupported image types, and the 10 MiB limit had no native observation. Tests cover each.

## Thread actions and Archived settings

Initial feature verification passed on macOS on 2026-10-06 against T3 Code v0.0.45. `pnpm typecheck`, `pnpm test:ui` (197 tests), and `cargo test -p bot-core` (241 tests) passed. The debug Tauri app bundle built successfully. Prettier, rustfmt, and the whitespace check passed.

The native bundle used the temporary identifier `dev.bot.code.threadverify`, the disposable repository `/tmp/bot-thread-actions/native/repository`, and `BOT_CODE_DATA_DIR=/tmp/bot-thread-actions/native/data`. Five persisted conversation fixtures supplied history and local, clean-worktree, and dirty-worktree checkouts. Three additional fixtures exercised automatic, kept, and settled placement. `BOT_CODE_CODEX_BIN` pointed to the core tests' scripted app-server peer, so running-turn checks used no live Codex account. Git, SQLite, the native warning sheets, clipboard, and terminal processes were real. The window was 1100×780.

Each successful rename, copy, pin, archive, restore, storage change, and deletion was followed by a full quit and explicit relaunch with the same isolated data directory. The following checks combined native observations with clipboard, SQLite, Git, file, and process assertions:

| Workflow                 | Observed result                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread menu              | T3's Rename thread, Copy, Archive thread, and destructive Delete appeared after the existing arrangement actions. Copy offered Path, Branch, and Thread ID.                                                                                                                                                                                                          |
| Rename                   | The inline input selected the title. Enter updated the card and breadcrumb, and the title persisted after restart. Escape cancelled a replacement, an empty Enter left the editor open, and a valid title saved on blur and survived restart.                                                                                                                        |
| Copy                     | Thread ID matched SQLite. Local Path and Branch matched the repository and `main`; worktree Path and Branch matched the actual checkout and `botcode/fixture-3`. The clipboard was checked after each action.                                                                                                                                                        |
| Archive and restore      | Archiving the open pinned thread hid it and selected the next card. Settings > Archived listed its project, title, ages, and Unarchive button after restart. Restore preserved the exact pin timestamp and conversation history. Separate archive/restore cycles preserved automatic, kept, and settled placements, including the settled timestamp, across restart. |
| Delete with cleanup off  | Cancel retained the open thread. Confirm removed its history and selected the next thread. The worktree and branch remained after restart.                                                                                                                                                                                                                           |
| Storage                  | Delete worktrees with deleted threads started off. Enabling it persisted after restart; the existing inactive and unchanged switches stayed off.                                                                                                                                                                                                                     |
| Clean worktree deletion  | A native terminal recorded its shell PID. Confirming deletion stopped that PID before app quit, removed the checkout, kept the branch, and selected the next thread. The history and checkout stayed absent after restart.                                                                                                                                           |
| Dirty worktree deletion  | The thread disappeared and the sidebar reported "Thread deleted. Worktree kept. working tree has changes" in neutral text. Its untracked `draft.txt`, checkout, and branch survived restart.                                                                                                                                                                         |
| Running checkout refusal | Archive and Delete were disabled on the running thread. Confirming Delete on another thread sharing its local checkout returned the busy error; both histories and the target's live terminal remained. Stop completed the scripted turn before restart.                                                                                                             |
| Git checkout refusal     | A native Commit ran inside a held disposable pre-commit hook. Deleting another thread sharing the checkout returned the busy error without removing its history or terminal. Releasing the hook completed the commit; both threads remained after restart.                                                                                                           |
| Archived deletion        | The Archived row's context menu offered Unarchive and Delete. Cancel preserved the archive across restart. After temporarily moving the repository away, the page still listed it and Delete succeeded. The empty archive and retained project were checked after restart.                                                                                           |

Core regressions additionally cover running and pending admission, shared checkout ownership, deletion surviving caller cancellation, stale terminal attachment, PR membership and submission-receipt removal, shared PR/review data retention, ignored and locked worktrees, default-off cleanup, and database failure after worktree removal. That last case leaves the conversation available through the existing missing-worktree restoration path. No force removal or delayed cleanup queue was added.

Screenshots, fixture manifests, timestamped assertions, suite logs, and the independent review are under `/tmp/bot-thread-actions`. Review found and rechecked a pending-rename race: the editor and rename switching now stay disabled until the save finishes. Native focus and normal save paths passed. No new pixel-difference measurement was made; live GitHub PR mutations and a real Codex turn were outside this run.

After composer image attachments merged in PR #46, this change was rebased onto `8db0584`. Type checking, all 226 UI tests, the production web build, formatting, all 261 existing core tests, and workspace Clippy passed. An additional core integration test passed for a renamed image-only first message, image history retained by an archived thread across restart, and the attachment sweep removing an old shared image after its last referencing thread is deleted. Rebase and integration evidence is under `/tmp/bot-thread-actions/shipping`.

Before opening the PR, the branch was rebased onto the updated `main`, which adds generated commit messages and pull request text. Typecheck, all 205 UI tests, all 252 core tests, the production and Tauri builds, formatting, and Clippy with warnings denied passed. The new `thread_deletion_cancels_a_running_commit_preview` test passed without a production fix. It deletes a clean worktree during a stalled preview, requires a cancelled result, and checks that the generator and its descendant stop before app shutdown. The existing maintenance loop provides that cancellation after the thread disappears. The rebuilt native app repeated rename, archive, restore, and clean worktree deletion, with a restart after each action. Deletion stopped its live terminal before app quit, kept the branch, selected the next thread, and remained absent after restart. These integration checks used the same isolated data directory and an additional disposable worktree. An independent integration review found no remaining blocker.

## Turn checkpoints, diffs and Edit from here

Verified on macOS on 2026-10-06 against T3 Code v0.0.45 and installed Codex 0.160.1. `pnpm typecheck`, `pnpm test:ui` (199 tests), `cargo test -p bot-core` (259 tests), Prettier, rustfmt, Clippy with warnings denied, the production frontend build and the debug Mac app bundle passed.

Before opening the PR, the branch was rebased onto main's generated Git text feature. The new checkout-exclusion test was updated for its optional commit-message input. The combined tree passed typecheck, all 207 UI tests, all 269 core tests, formatting, workspace Clippy with warnings denied, and another production frontend and debug Mac app build. These repeated checks are recorded in the evidence directory's `*-pr.log` files; the native workflow below was exercised before this rebase.

The 16 new checkpoint-store tests use temporary Git repositories. They cover immutable before/after refs and concurrent publication, unchanged real indexes and branches, split indexes, same-size edits with restored epoch timestamps and ctime checks disabled, tracked ignored additions, ordinary untracked files, linked-worktree isolation, unborn and empty repositories, binary and oversized blobs, unusual paths, absent refs, ignored collisions including macOS case and Unicode aliases, unsafe ignore-rule changes, nested repositories, submodules, directory symlinks, CRLF restore retry, and bounded cleanup when a descendant retains pipes after Git exits. Removing explicit private-index rehashing made the timestamp regression fail with stale contents. The CRLF retry regression failed against raw-byte hashing and passed with Git's configured clean filters.

The 14 new public runtime tests drive the App API with a scripted provider and real temporary repositories. They cover three editing turns and turn 2's isolated diff, both rewind modes, first-turn rewind, exact-input receipt replay after later edits and restart, restart recovery from Preparing, ConversationReady and FilesRestored, failed before/after/folder snapshot saves and folder-save exclusion after another thread loses the provider, final-save failure after successful restoration, concurrent turn and Git exclusion, provider loss during a live restore, native-prefix mismatch refusal, preflight refusal releasing its hold, prepare/start failures leaving usable controls, and historical diffs plus conversation rewind after worktree removal. Completed capture outcomes stay under the checkout hold until their saves succeed. A durable FilesRestored phase preserves later edits when only final persistence retries. These tests do not claim an atomic filesystem/SQLite transaction; a crash before that phase is durable can repeat restoration.

Live app-server probes found no `thread/rollback`. `thread/revert` worked for paginated history, rejected legacy history, and rejected an exact successful retry because its target turn was gone. Bot Code's actual start payload created paginated history. `thread/fork` with `beforeTurnId` returned the exact earlier native turn IDs for both history modes while leaving the source thread intact. Bot Code therefore uses the prefix fork for both rewind choices and tells the user that native identity changes.

The actual Tauri bundle used identifier `dev.bot.code.checkpointverify`, a 1400×900 window, disposable repository `/tmp/bot-checkpoints-native/repository`, and `BOT_CODE_DATA_DIR=/tmp/bot-checkpoints-native/state`. Its committed baseline contained `notes.txt` and `.gitignore`; ignored `ignored.txt` held preservation evidence. The final exercise used local checkout, GPT-6.1-Sol, Low effort, and Auto-accept edits.

| Native workflow                          | Observed result                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three real editing turns                 | Turn 1 wrote `notes.txt` and `one.txt`; turn 2 wrote `notes.txt` and `two.txt`; turn 3 wrote `notes.txt` and `three.txt`. Each completed with its own two-file card and before/after refs. Edit from here and Git actions were disabled during execution.                                                                                                        |
| Turn 2 alone                             | Open diff selected **Turn 2**. Only `notes.txt` and `two.txt` appeared, with +2 and -1. Stacked and split hunks visibly showed “turn one” changing to “turn two”, and `two.txt` containing “two”. The checkout still contained “turn three”.                                                                                                                     |
| Edit from here                           | The turn 2 dialog showed both choices, described the prefix fork and ignored-file coverage, and warned that file rewind replaces current checkout changes.                                                                                                                                                                                                       |
| Revert files too                         | The timeline retained turn 1 alone. Turn 2's prompt returned to the focused composer without being sent. The selected historical diff returned to Working tree.                                                                                                                                                                                                  |
| Full quit and relaunch                   | The retained turn, its changed-files card and turn 2's recovered prompt returned. The fork resumed without reintroducing removed turns.                                                                                                                                                                                                                          |
| Independent filesystem and storage reads | `notes.txt` contained “turn one”, `one.txt` remained, `two.txt` and `three.txt` were absent, and `ignored.txt` was unchanged. HEAD and branch stayed fixed; the index matched HEAD and restored edits were unstaged. SQLite held one retained turn, a changed native thread ID, cleared context and pending intent, and the saved prompt plus operation receipt. |

Native verification exposed a WKWebView paint failure in the copied `@starting-style` diff fade-in animation. The hunk DOM and accessibility text were correct but pixels stayed blank. Disabling the animation in the native inspector made the working-tree hunk paint. The animation was removed from the port; the rebuilt app visibly rendered historical hunks in both layouts without an inspector override. No pixel-exact comparison or light-mode/minimum-width observation was made for this feature.

During a quit check, the native driver reopened the verification bundle with default state. It was immediately closed without interacting with that state. Every editing and rewind exercise used the explicit isolated directory. A later stale native-window binding was recovered by resetting the driver; the isolated process and completed turns remained intact.

Evidence, native before/after SQLite and filesystem snapshots, protocol probes, mutation logs, test logs and build logs are under `/tmp/bot-checkpoints-native/evidence`. Independent design, Git, runtime and comment reviews are under `/tmp/bot-checkpoints-*-review.md`; `decisions.tsv` records the accepted fixes. Checkpoint-ref deletion and unused native-fork reclamation are deferred. Native verification covers the requested file-rewind path; keep-changes rewind, crash recovery and busy-checkout refusal also have core coverage.

### Integration after image attachments, thread actions and notifications

On 2026-10-07, PR #48 merged into `main` at `a202a02b87a3992166495f93738edc83b683c7bf`, and this feature was rebased onto that revision. `pnpm typecheck`, all 246 UI tests, all 296 core tests, `cargo fmt --check`, and workspace Clippy with warnings denied passed.

The new App tests reproduced missing recovered image metadata before the fix. They cover mixed and image-only prompts, ordered image recovery, aged-image retention across startup cleanup and archive, unrelated orphan removal, local-image request paths in the scripted peer, accepted and rejected sends, persistence failures, legacy result decoding, and exact receipt retry after restart. Composer tests cover preserving unsent input, deduplication, whole-message staging and capacity deferral, removal without replay, stale A-to-B-to-A callbacks, in-flight edits, and stale revert snapshots. A notification-observer test covers three completed turns, rewind to the first, stale refreshes, and one new completion without replaying the retained turns.

An independent verifier exercised the packaged native app at head `296d4d20dd41e0b7c530d594e70f26666a7a0fe5` against the exact merged parent above. The stable base-to-head patch-id was `919bdffde6e99bfdea0663ee846949b2a59aa827`. Separate parent/head bundles, private build targets, disposable repositories and isolated `BOT_CODE_DATA_DIR` values kept the run separate from normal app data. The parent completed a real Codex turn, accepted an image thumbnail, and exposed notification settings; it had no turn rewind controls. Head used real installed Codex 0.160.1 through a transparent protocol logger. Native interaction used CUA, including copying the fixture PNG in Preview and pasting it into the composer.

| Workflow                       | Observed result                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three editing turns            | Turn 1 wrote `notes.txt` and `one.txt`; image-bearing Turn 2 wrote `notes.txt` and `two.txt`; Turn 3 wrote `notes.txt` and `three.txt`. No turn committed.                                                                                                                                                                                                |
| Turn 2 alone                   | After Turn 3, the saved diff showed only `notes.txt` changing from “turn one” to “turn two” and `two.txt` adding “two”. Both native hunks were opened.                                                                                                                                                                                                    |
| Revert files too               | Edit from here on Turn 2 retained only Turn 1 and restored the exact Turn 2 prompt plus its thumbnail. Files matched the before-Turn-2 checkpoint: `one.txt` remained; `two.txt` and `three.txt` were absent. Ignored sentinel bytes, HEAD and branch stayed unchanged. The deliberately changed index returned to HEAD, leaving restored edits unstaged. |
| Native conversation prefix     | The real `thread/fork` request named Turn 2's native ID as `beforeTurnId`. Its response contained exactly Turn 1, and Bot Code persisted that fork as the continuation identity.                                                                                                                                                                          |
| Full quit, cleanup and restart | Both the recovered PNG and an unrelated orphan were aged to 26 hours. Startup removed the orphan but retained the PNG unchanged. The native timeline, recovered prompt and thumbnail, fork identity, files, index, HEAD and branch matched the rewound snapshot.                                                                                          |
| Resend                         | Sending the recovered text and image targeted the retained-prefix fork with the preserved `localImage` path. Codex described a blue square centered on a yellow background. The timeline contained Turn 1 and the new Turn 2, the requested files changed again, and accepted submission cleared `lastRevert`.                                            |
| Notification integration       | With a new draft open during the resent turn's completion, one real Thread completed toast appeared. No old-completion toast was observed during either rewind or afterward on the idle draft.                                                                                                                                                            |

The rewind dialog keeps the conversation selected during the transition, so native toast absence alone cannot distinguish deduplication from focused-thread suppression. The observer regression supplies the suppression-independent stale-refresh check. OS notifications and sound were not reverified in this lane. Image-only recovery, capacity/staging deferral, archived recovery and crash-phase retries have automated coverage rather than additional native observations here.

The independent native result was `PASS+NOTES`, with no product defect found. Evidence is under `/tmp/bot-checkpoints-shipping/verification/evidence`, including `h1-native-report.md`, `head-native-assertions.json`, native fork/resend protocol records and attachment-aging snapshots. Native accessibility observations and screenshots remain in the verifier's tool transcript. Both parent and head processes were stopped after verification.

Two builds of the observed head established artifact noise before reassessing the documentation-only final revision. Every app file matched except the Mach-O binary: its differences were confined to 256 `N_OSO` debug object-path rustc suffixes and the `LC_CODE_SIGNATURE` blob. Code/data sections, `LC_UUID` and all other bytes matched. The saved artifact comparator accepts only those proven differences and validates app signatures; a differing hash alone is insufficient to carry the native result forward.

## Follow-up queue and steering

Verified on macOS on 2026-10-07 against T3 Code v0.0.45 with installed Codex 0.160.1. Generated app-server schemas expose `turn/steer` with `expectedTurnId` and `clientUserMessageId`. A live disposable turn accepted steering, and `thread/resume` returned both original and steering client IDs. Steering is enabled for this verified provider.

`pnpm typecheck`, `pnpm test:ui` (260 tests), `cargo test -p bot-core` (302 tests), the production web build, Prettier, rustfmt, and whitespace checks passed. UI regressions cover FIFO claims, hidden threads, checkpoint/approval/failure gates, fixed receipt retries, Stop during awaited settings, retained-row reclaim races, delayed thread reads, input restoration, and setting persistence/reset. Core checks cover exact active targets, durable input and receipts, storage failure before wire, wrong-target acknowledgments and events, correlated positive evidence, approvals, attachment retention, restart reconciliation, and no replay. The wrong-native-turn event test failed before its acceptance-correlation fix.

The real Tauri bundle used `/tmp/botcode-followup-native/repository`, an isolated `BOT_CODE_DATA_DIR=/tmp/botcode-followup-native/data`, a separate Codex home, and temporary app identifier `dev.bot.code.followupverify2`. A transparent process wrapper logged the installed app-server protocol. Native accessibility and screenshots were observed at 1100×780 and, using a temporary window configuration, 1000×620. The final claim-identity fix was rebuilt and the queue flow repeated in the minimum-size bundle.

| Workflow            | Observed result                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Running-turn input  | Stop remained available; text could be queued with Enter without interrupting the turn.                                                                                                                                                                |
| Two queued messages | Both appeared as T3 dashed bubbles. Later input could not overtake the first row.                                                                                                                                                                      |
| Approval            | Queueing stayed available, while Send now was disabled until the harmless sleep command was approved. Steer preference correctly displayed Queue during the approval.                                                                                  |
| Remove              | Removing the second row returned its exact text to the composer. Clearing that restored draft left the first row queued.                                                                                                                               |
| Automatic follow-up | With Settings open, successful completion and final checkpoint capture released the retained row. Its own turn replied `QUEUE_KEEP_DONE`. The removed row never reached the provider.                                                                  |
| Send now            | A queued instruction became a normal Copy-only user bubble inside the current turn. Real `turn/steer` named that same native turn, which replied `STEER_FINAL_DONE`.                                                                                   |
| Restart             | Accepted queued and steered input remained in history, including the Copy-only steering bubble. General retained the saved Steer value. A waiting `EPHEMERAL_QUEUE_ONLY` row disappeared on quit/restart without provider dispatch.                    |
| Default Steer       | On the final minimum-size build, the eligible button read Steer current run. Enter sent one steering input and its same parent replied `CLAIM_STEER_FINAL_DONE`.                                                                                       |
| Stop                | Two waiting rows returned in FIFO order after the existing composer draft. The turn stopped, no queued rows remained, and none of the recovered input reached the provider.                                                                            |
| Restore defaults    | General returned Follow-up behavior to Queue.                                                                                                                                                                                                          |
| Layout              | The conversation sidebar, compact header, centered chat, bottom composer and optional Files panel retained the baseline structure. At minimum size, Scroll to end exposed both queued rows above the approval/composer without clipping their actions. |

Protocol and SQLite assertions confirmed one provider start for retained input, no dispatch of removed input, one steer per instruction, accepted steering inside each parent turn, no dispatch of recovered or expired waiting input, and the expected final replies. Evidence and rerunnable assertion scripts are under `/tmp/botcode-followup-native/evidence`; the decision trail and independent review are under `/tmp/botcode-followup-design`. Native screenshots and accessibility states remain in the tool transcript. Initial native launches lacked accessible content; quitting and relaunching after native automation recovered resolved the verification setup. One post-quit accessibility read auto-reopened the bundle without the isolated environment; that instance was immediately closed and its snapshot excluded. The restart check was repeated through an explicit isolated launch.

Waiting queues intentionally live in renderer memory and disappear on reload or exit. Accepted input is durable. Failures, interruptions, and lost turns hold later input for explicit action; approvals block delivery. Uncertain receipt checks repeat only the same local operation and never automatically resend a provider prompt. Storage-fault and uncertain-recovery cases have automated coverage, rather than injected failures in the real account session. No new pixel-difference measurement or other-platform verification is claimed.

## Composer typing triggers and Plan mode

Verified on 2026-10-07 against T3 Code v0.0.45 at `/tmp/t3ref/t3code` and the installed Codex 0.160.1 app-server. Generated protocol types and a live `collaborationMode/list` call confirmed Plan and Default support. The installed client-request protocol has no native slash-command discovery endpoint. The menu therefore exposes `/model`, `/plan`, `/default`, and `/usage-limits`; PR and skill triggers remain absent.

Automated checks passed: `pnpm typecheck`, `pnpm test:ui` with 268 tests, and `cargo test -p bot-core` with 310 tests. The UI tests use the actual Tiptap editor schema for canonical prompt and caret mapping, special-character path round trips, trigger boundaries, search results, capability filtering, and proposed plan actions. Core tests cover unsupported or failed mode discovery, explicit Plan and Default payloads, displayed model-default effort versus preset effort, streamed and resumed plan items, question callbacks including absent and empty option arrays, expiry, and checkout sharing. Switching a shared worktree's branch updates both owners, and shared worktrees skip automatic naming.

Native verification used the debug Tauri `.app`, temporary identifier `dev.bot.code.composerverify`, disposable repository `/tmp/bot-composer-work/native/repository`, isolated `BOT_CODE_DATA_DIR=/tmp/bot-composer-work/native/data`, and an isolated `CODEX_HOME`. A transparent wrapper forwarded requests to the installed Codex binary and recorded JSONL protocol traffic. Builds, test logs, and native protocol evidence are under `/tmp/bot-composer-work`. The real window retained the conversation sidebar, centered composer, compact header, neutral dark palette, and optional tools toggle. No new pixel-difference measurement was made.

Keyboard checks in the actual Tauri window passed:

- `@` opened checkout file results. Enter inserted `src/My file.ts` as an inline chip. Tab inserted a mention in the middle of a sentence while retaining its prefix and suffix. Undo restored the complete `@My` query, redo restored the chip, and cut/paste retained the full path.
- `/` opened all four commands. Down and Up changed the shaded selection; Enter selected Plan. `/def` with Tab returned to Build. `/model` opened the live picker, arrow keys selected GPT-6-Luna, and Enter returned focus to the editor with its Medium default effort.
- `/usage` with Enter opened the existing live usage notice and cleared the command. Escape dismissed the slash menu while preserving `/`. Shift+Enter created a second line, where `/plan` executed without consuming the preceding context. An unmatched slash query allowed normal Tab navigation.

A real Plan turn ran in a new worktree with Supervised access. Read-only commands used the existing approval drawer. Codex requested a structured punctuation question; its panel showed options and permitted free text, and Tab then Enter submitted the selected answer. The callback unblocked the provider, which emitted an explicit completed plan item. The timeline rendered its title and test step, and the empty composer offered Implement and Implementation actions. The captured request used Plan with the selected GPT-6-Luna model and Medium effort.

After a full quit and explicit relaunch with the same isolated environment, reopening the source thread restored Plan, GPT-6-Luna, Medium, Supervised, and its plan card. A file created only in its worktree, `worktree-only.txt`, appeared in `@worktree` results and inserted with Tab. Typed feedback changed the primary action to Refine; Enter sent the chip's canonical path and feedback on the same native thread with Plan settings. The provider completed a revised explicit plan with an empty-name test.

The Implementation actions menu opened by its composer button, and Enter selected Implement in a new thread. A new conversation opened in Build with the same worktree path and branch. Its `thread/start.cwd` matched the source checkout, and its `turn/start` explicitly sent Default with the source model and effort. Reviewed command approvals allowed the fixture's `src/greeting.ts` creation. The turn completed with the new file visible in its changed-files card. Independent execution of that TypeScript export confirmed both `greet("Ada") === "Hello Ada!"` and `greet("") === "Hello !"`.

Returning to the source thread retained its completed plan and Plan selection. Enter in its empty composer invoked Implement, inserted T3's implementation prompt in the timeline, changed the composer to Build, and sent Default on the original native thread. The source turn completed after inspecting the already implemented file. Tab reached the Plan/Build toggle, and Space switched it in both directions. Native screenshots with the tools panel open confirmed that file and slash menus stayed above the composer within the narrower conversation column. This verifies clearing the provider's earlier Plan state. A compact payload summary is saved at `/tmp/bot-composer-work/native/payload-summary.json`.

Independent read-only GPT-6-Astra review found issues in empty-result keyboard handling, WebKit composition guarding, empty question options, shared branch metadata, effort resolution, and failed-send recovery. Accepted fixes were applied, required suites rerun, and the final source review reported no open correctness findings. The native keyboard pass also caught and corrected a synthetic editor update resetting menu selection and an undo transaction grouping the typed query with chip insertion. Final formatting, rustfmt, whitespace checks, and the debug Mac bundle passed.

The independent PR shipping check reproduced a further editor regression after React rerenders: Tiptap restored its initial editor options, dropping the copied layout classes and the Message accessibility label. The correction supplies the same memoized attributes to initial editor options and updates the initialized view with T3's `view.setProps` pattern. Typecheck, all 268 UI tests, and the production build passed after this correction. [PR #54](https://github.com/ImNallen/BotCode/pull/54) tracks the current-head native shipping verdict and evidence; [#55](https://github.com/ImNallen/BotCode/issues/55) tracks the regression.

After integrating main's command palette change, its test fixtures were updated for question state and interaction settings. Typecheck, all 278 combined UI tests, all 310 core tests, and the production build passed. The shipping check also covers opening and dismissing the palette over active composer triggers before resuming menu keyboard navigation.

## Command palette

Verified on macOS on 2026-10-07 against T3 Code v0.0.45 at `6c8fed35dded9ff71c5b46807125457acbb76be6`. The palette components, command primitives, message excerpts, keycaps, and dialog geometry carry source headers. A source audit confirmed the copied class strings against that checkout. Native dialog and React Query adapters use Bot Code's existing components and snapshots.

`pnpm typecheck`, `pnpm test:ui` (270 tests), the production frontend build, the debug Tauri app bundle, Prettier, and whitespace checks passed. UI tests cover shared palette/shortcut execution, exact modifiers and terminal ownership, action eligibility, normalized title and cached-message search, title-first ranking, and archived-snapshot exclusion.

The actual Tauri app used two disposable one-commit repositories under `/tmp/botcode-command-palette`, `BOT_CODE_DATA_DIR=/tmp/botcode-command-palette/data`, and temporary identifier `dev.bot.code.paletteverify`. Six seeded conversations supplied active, snoozed, settled, archived, and cross-project cases. The repository's scripted app-server peer supplied models and resume responses. No real account turn or provider prompt was sent. Temporary window configuration supplied 1100×780 and 1000×620 windows; the project's Tauri configuration was unchanged.

| Native keyboard workflow    | Observed result                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Open and dismiss            | Cmd+K opened from the composer, Settings search, Usage, and the right-panel header. A second Cmd+K, Escape, and backdrop click closed it. The input received typing immediately.                                                                                                                                                                       |
| Thread titles               | Search found titles across both projects, including snoozed and settled threads. Archived titles were absent from ordinary search. Enter selected the matching conversation.                                                                                                                                                                           |
| Loaded messages             | `Orange` initially found nothing. Opening Beta billing made its Orange message searchable. Opening Alpha made `nébula` find its Nebula message; the plain query showed T3's highlighted Agent excerpt.                                                                                                                                                 |
| Result navigation           | Up and Down changed selection; Up wrapped to the last result and scrolled it into view at minimum size. Enter executed it. Leading `>` excluded matching thread titles. Empty submenu Backspace returned to its parent.                                                                                                                                |
| Draft actions               | New thread opened the selected project's draft and left Usage. Down/Up/Enter selected New thread without a project. That draft omitted the unavailable terminal action.                                                                                                                                                                                |
| Shared thread actions       | Palette pin followed by Cmd+Shift+P unpinned the same selected thread. Palette settle followed by Cmd+Shift+S un-settled it in place. The reverse sequences changed the palette labels to Unpin and Un-settle and executed successfully.                                                                                                               |
| Snooze and wake             | In 1 hour persisted a one-hour snooze and selected the next conversation. Searching the snoozed title reopened it; Wake cleared the snooze.                                                                                                                                                                                                            |
| Rename                      | A collapsed, filtered sidebar reopened with its existing title editor selected. Enter saved Alpha renamed; Escape cancelled another edit.                                                                                                                                                                                                              |
| Copy                        | Copy path, branch, and thread ID produced the exact repository path, `main`, and selected thread UUID. Each was pasted into the composer and cleared without sending.                                                                                                                                                                                  |
| Archive and restore         | Archive hid Alpha and selected Beta. Restore archived thread opened its separate title and action submenus. Unarchive restored Alpha's prior placement.                                                                                                                                                                                                |
| Delete confirmation         | Delete reached the existing native confirmation. Escape cancelled it; all six conversations and their saved turns remained.                                                                                                                                                                                                                            |
| Panels and terminal         | Palette actions toggled the sidebar, right panel, and terminal drawer. Closing a maximized right panel returned to chat. Terminal-focused Cmd+K visibly cleared both drawer and right-panel shell output without opening the palette. Cmd+N created Terminal 2; Ctrl+L retained terminal behavior.                                                     |
| Shortcut isolation          | Cmd+N, Cmd+J, and Cmd+B did not affect the background while the palette was open. Typing T with its submenu Back button focused did not launch the right-panel terminal.                                                                                                                                                                               |
| Focus and existing overlays | Escape restored Settings search; the next Escape cleared search while staying in Settings. The model menu survived palette dismissal and then closed on its own Escape. Opening over Edit from here cancelled that dialog through its normal handler, and Rename focused its editor.                                                                   |
| Restart and layout          | Relaunching with the same isolated environment retained Alpha's renamed title and restored placement, Beta's pin, and the other shelves. Both window sizes retained the conversation sidebar, compact header, chat, bottom composer, and optional tools panel. Palette input, selected rows, and footer fit; keyboard navigation scrolled the results. |

Independent review found a stale toggle request that replayed after returning to a project draft. The defect was reproduced in the app, fixed by expiring the captured request when its workspace or thread changes, and the rebuilt app passed that sequence. Native overlay checks also found and resolved lost Settings-search focus and an older dialog blocking Rename. The review accepted both fixes. A dialog that refuses cancellation during a pending operation retains ownership; the palette shows a wait message without executable results. That refusal path was reviewed against the existing revert guard, without injecting a pending revert in this native run.

A later independent native run at 1000×620 reproduced lost Settings-search focus after palette Escape. The lead reproduced it in the same isolated reviewer app. Focus restoration now runs in a layout effect after the close commits and releases the modal and background. The rebuilt app accepted typing in the retained Settings query after dismissal and kept Settings open while clearing the query with Escape; native text suggestions consumed their own Escape first. Typecheck, all 270 UI tests, formatting, and the rebuilt Tauri bundle passed again.

Evidence is under `/tmp/botcode-command-palette/evidence`, including suite and bundle logs, source-class comparison, independent review, SQLite states, and final assertions. Native accessibility observations and screenshots remain in the tool transcript. Assertions confirmed unchanged thread/workspace state across restart, six retained histories after deletion cancellation, zero provider turn dispatches, and a clean disposable checkout. The isolated app was stopped afterward. No new pixel-difference measurement or other-platform verification is claimed.

## Codex skills in the composer

Verified on 2026-10-07 against T3 Code v0.0.45 at `/tmp/t3ref/t3code` and installed Codex 0.160.1. Before implementation, generated app-server TypeScript bindings and a live initialized `skills/list` call confirmed `{ cwds: [cwd], forceReload?: boolean }` and `{ data: [{ cwd, skills, errors }] }`. The initial live catalog contained 117 skills, including `pstack:poteto-mode`. Rust parses the required name, path, and enabled fields, plus optional scope, descriptions, and interface display metadata. The legacy short description takes precedence over the interface summary, as in T3.

`pnpm typecheck`, all 283 `pnpm test:ui` tests, all 321 `cargo test -p bot-core` tests, the production frontend build, and the debug Tauri app bundle passed. Changed frontend files passed Prettier, Rust passed `cargo fmt --all --check`, and `git diff --check` passed. Eleven new Rust tests exercise metadata parsing, cwd matching, fallback ordering, configured binary use, unsupported/malformed/lost providers, timeouts, and process cleanup. UI tests exercise ranking, disabled and duplicate entries, skill atoms and cursor/clipboard serialization, Markdown chips, currency exclusions, separate checkout catalogs, stale refresh, and failed discovery replacing cached results with an empty list. One existing naming timing test failed in the delegate's first full run; it passed in isolation and both subsequent full runs without source changes.

The actual native bundle used identifier `dev.bot.code.skillsverify`, disposable repository `/tmp/botcode-skills/native/repository`, and `BOT_CODE_DATA_DIR=/tmp/botcode-skills/native/data`. It used the existing installed Codex home to discover the real user and plugin skills. A transparent wrapper selected through `BOT_CODE_CODEX_BIN` captured skill requests, turn text, completed reads, and replies. Native interaction used CUA, the normal folder picker, GPT-6.1-Sol with Low effort, and Supervised access. Skill-file reads were approved individually.

| Check | Observed result |
| --- | --- |
| `$pot` and `/pot` | Both menus listed Pstack Poteto Mode. The slash row had T3's `/skill:` prefix, description, and App source badge. Invalid legacy names containing spaces stayed out of the final menus. |
| Keyboard and Escape | Down selected poteto-mode. Enter and Tab inserted its atomic chip. Escape dismissed the menu while retaining typed text. |
| Provider delivery | The captured text input contained `$pstack:poteto-mode`. Codex read the installed plugin's `poteto-mode/SKILL.md`, exited that command successfully, and replied `SKILL_LOADED`. The sent user message showed the skill chip. |
| Repository scope | `$repo` listed the fixture's `repo-proof` with a Repo Skill badge. Selecting and sending it produced `$repo-proof` in the captured turn. Codex successfully read `.agents/skills/repo-proof/SKILL.md` and replied with `REPO_SKILL_LOADED`. |
| Currency | Typing `$5` opened no menu and produced no chip. The repository prompt included literal `$5` in its user bubble and captured turn input. Codex's reply retained `$5`. |
| Stale refresh | The verifier added `fresh-proof` after the catalog was cached. Reopening `$fresh` after 30 seconds listed it, with a fresh `skills/list` request using the repository's canonical cwd and `forceReload: true`. The added fixture file appeared in the turn's changed-files card because the verifier created it during that turn. |
| Empty results and layout | An unmatched skill query showed T3's empty message and kept Send available. The sidebar, compact header, chat, bottom composer, neutral colors, and optional tools panel retained their layout at 1100×780. |

Independent review found the unsupported-name selection bug and an incorrect slash-menu loading label. Both were fixed before the final native run. The original skill metadata is retained; only names that cannot round-trip through T3's `$name` grammar are excluded from selectable rows. T3's provider ranking was compared after import/type and formatting adaptation. Ported components retain source headers and T3's class strings. Existing file and Plan behavior remains outside this change's feature scope.

Evidence is under `/tmp/botcode-skills`, including generated protocol bindings, the initial live response, test/build logs, design comparisons, review findings, and `native/protocol.jsonl`. Native accessibility observations and screenshots are in the tool transcript. No new pixel-difference measurement or other-platform verification is claimed. The isolated app was stopped after verification. All project changes remain uncommitted.

## Editable files with autosave

Verified on macOS on 2026-10-07 against T3 Code v0.0.45. `pnpm test:ui` (306 tests), `pnpm build`, Prettier for the changed frontend files, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test -p bot-core` (325 tests) passed. The UI tests port T3's nine `FileSaveCoordinator` cases and its hook's StrictMode cases, and they check the overlay against a real `QueryClient`. The core tests write through real paths and real `git diff`. They refuse a file symlink, a folder symlink, and a dangling symlink that lead outside the repository, and they check that nothing outside changed. A mutation run confirmed that the `.git` check catches `new/.GIT/config` only when the comparison ignores letter case.

The debug bundle used the temporary identifier `dev.bot.code.fileeditverify`, `BOT_CODE_DATA_DIR=/tmp/botcode-file-edit/data`, and the disposable repository `/tmp/botcode-file-edit/repository`. `BOT_CODE_CODEX_BIN` selected a scripted app-server peer that prepends `agent line` to `notes.txt` and reports a file change. One prompt makes it write at once. Another makes it wait for a signal file. The repository was added through the native folder picker. At 1100×780:

- Typing ` edited` in `notes.txt` showed the tab's dot. The dot cleared after the save, and `git diff` showed `-gamma` and `+gamma edited`.
- An edit started at 14.464 s, and the peer wrote the file at 14.606 s, during the unsaved edit. The editor kept the typed text. The autosave replaced the Codex write, and the final file had no `agent line`.
- With no unsaved edit, a Codex write appeared in the editor without a dot. The file's modification time equaled the peer's write time, so loading the new contents wrote nothing back.
- `escape.txt`, a tracked symlink to `../outside/secret.txt`, showed "This symlink points outside the repository." with no editor, and the outside file stayed unchanged.
- An edit followed at once by a tab switch reached disk. The run did not time the switch against the 500 ms delay, so the unit tests remain the evidence for the save on close.
