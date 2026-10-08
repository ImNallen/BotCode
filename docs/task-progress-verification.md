# Task progress verification

Verified on 2026-10-08 against T3 Code v0.0.45, commit `6c8fed35dded9ff71c5b46807125457acbb76be6`.

Codex `turn/plan/updated` notifications replace a typed checklist on the latest active turn. The composer shows the current step, completed count, statuses and observed durations. The checklist is independent of Plan mode and proposed plan cards. The optional **Working section (beta)** device setting defaults off and follows T3's placement, collapse, return ordering and reset behavior.

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm test:ui` | 436 passed. |
| `cargo test -p bot-core -- --test-threads=4` | 415 passed. |
| `pnpm build` | TypeScript and production build passed. |
| `cargo clippy -p bot-core --all-targets -- -D warnings` | Passed. |
| `cargo fmt --all --check` | Passed. |
| `pnpm format:check` | Passed in the integrated worktree. |
| `git diff --check` | Passed. |
| Debug Tauri bundle | Built and launched with the isolated verification configuration. |

Core tests cover exact thread and turn routing, early start notifications, stale and malformed updates, idempotent replacements, empty resets, duplicate labels, timing, completion, interruption, failure, provider loss, active restart and rewind. Frontend tests cover IPC compatibility, task projection, status and count rendering, Plan independence, drawer gates, sidebar placement, filtering, return clocks and device settings. Un-settle tests cover the actual transition, repeated no-ops, old snapshots, summary projection and reopening.

One unrestricted core run timed out in an existing worktree-naming fixture during provider preparation. That suite passed all 14 tests in isolation. The subsequent complete run with four workers passed all 415 tests. No source change was made for that timeout.

## Native acceptance

The actual macOS Tauri app used a disposable repository at `/tmp/botcode-task-progress/native/repository`. The application identifier was `dev.bot.code.taskprogressverify`. Its data directory was `/tmp/botcode-task-progress/native/data`. The repository stayed clean throughout verification. The initial bundle was followed by a rebuilt final bundle, which reopened the same database.

The native app ran the repository's scripted Codex peer over its normal app-server transport. Accessibility observations and screenshots checked the real window, sidebar, chat and composer.

After quitting the initial app, an accessibility read reopened that bundle without the environment overrides. That unused window was discovered and closed during cleanup without further interaction. The acceptance scenarios and saved database snapshots came from the explicitly isolated initial and final processes. Do not request another accessibility read after quitting a verification app, because the driver may launch it again.

| Scenario | Observed result |
| --- | --- |
| Initial progress in Build mode | Tasks showed 0/3 and the first running step. The drawer showed Running and Pending rows. |
| Replacement update | Count advanced to 1/3, the current step changed, and the completed row showed its observed duration. The final bundle also showed 2/3 and the third running step. |
| Malformed update | The prior valid snapshot remained visible. |
| All steps completed during a running turn | Tasks disappeared while the thread remained Working. |
| Turn completion and late telemetry | The thread returned to Active. Persisted steps remained completed despite a late update. |
| Approval and input requests | The thread returned to Active, Tasks disappeared, and the request occupied the composer. Resolving the request restored progress. |
| Thread switching | The idle thread had no task banner. Collapsed Working hid the background card. Expansion revealed it. Returning to the running thread reset the task drawer. |
| Pinning while running | The full card stayed pinned above Active. |
| Interruption | Tasks disappeared and the unpinned thread returned to Active. SQLite retained the reported statuses with interrupted execution. The final bundle also interrupted correctly while preserving its pin. |
| Restart during a running turn | The final bundle retained the 1/3 snapshot and marked execution lost. No live Tasks banner or Working section remained. No prompt was replayed. |
| Settings persistence and scopes | Working remained enabled after restart. Its device switch was visible under both All projects and repository scope. |
| Settings resets | Individual reset and Restore defaults both returned Working to off. |
| Manual inbox return | Un-settling the older reference thread placed it above the newer thread. SQLite retained the separate un-settle timestamp. |

Search, navigation, placement precedence, empty-list resets and stale routing have automated coverage. They were not all repeated manually in the native app.

## Real Codex smoke test

A separate native session used Codex CLI 0.161.0 with `/tmp/botcode-task-progress/native/real-data`. The real turn read the fixture, checked its branch and completed without changing files or making commits. A transport wrapper recorded only turn lifecycle and plan notification methods.

This session reported that `update_plan` was unavailable. It emitted `turn/started` and `turn/completed`, with no `turn/plan/updated` notifications. The app correctly showed no Tasks banner. Real-provider task updates were therefore inconclusive; the native task lifecycle results above use the controlled provider. The notification contract is also documented in the [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).

## Repeating native task scenarios

Build a debug Tauri bundle with a separate identifier and window title. Copy `crates/bot-core/tests/support/codex_peer.py` into an isolated provider directory and make it executable. Set `BOT_CODE_DATA_DIR` to a disposable directory and `BOT_CODE_CODEX_BIN` to that copy before launching the bundled executable.

Add a disposable repository in the app. Send `task-progress` to hold a turn open, or `task-progress-early` to exercise progress before the start response. The peer's sibling `task-progress.json` contains each native thread ID, turn ID and control path.

Write a JSON control object with an increasing revision to the listed control path. For example, `{"revision":1,"action":"advance","stage":1}` completes the first step and starts the second. Stages 0 through 3 represent initial progress, the next step, the final step and all steps completed. Stage 3 keeps execution running. Other actions include `clear`, `finish`, `fail`, `approval`, `question`, `malformed`, `stale`, `missing` and `wrong-thread`. Stop generation uses the ordinary interrupt request. Remove the previous control file before starting another task turn on the same native thread.

Local evidence is retained under `/tmp/botcode-task-progress/evidence`, including test logs, native SQLite snapshots, the real protocol trace and independent review reports. Native screenshots are in the task transcript. The user requested a pull request after verification.
