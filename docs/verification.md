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

Core checks cover the `z1/<id>` branch and its directory under `worktrees/<repository>/`, the `thread/start` cwd for local and worktree threads, and a worktree turn that completes while a local turn holds the checkout lease. A second local thread still receives `checkout_busy`. A repository without commits rejects a worktree thread and creates no directory. Legacy snapshots load as local threads. Worktree views list worktree files and branches only, and a thread from another repository is rejected. Moving the lease key or the cwd back to the repository root fails the concurrency and cwd tests.

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
- The filter's gear and a right-click on a project row each opened Settings, Projects, focused on that project.
- Renaming saved on Return and on blur. SQLite held the new label, and the sidebar, header, draft heading and badge updated. An empty name reverted and showed "Project name cannot be empty."
- **Copy path** put the exact repository root on the macOS clipboard.
- **Remove project** showed a native warning sheet that named the project, its two threads and its path. Cancel changed nothing. Remove deleted the project row and both thread rows, and the repository's files stayed on disk.
- While a Codex turn waited on a command approval, **Remove project** was disabled and its row read "Stop this project's running conversations before removing it." Declining the approval ended the turn.
- After a full restart, the removed project stayed gone, the new name stayed, and the sidebar filter was restored.

Keys sent through `cliclick` did not reach the WebView's text fields, so Return and Delete were sent as System Events key codes.
