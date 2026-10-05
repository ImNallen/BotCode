# Remote PR review verification

The review layer passes independent source review and native Tauri interaction. It covers remote detail and explicit review actions after saved PR association. Merge, queue, auto-merge and conversation settlement belong to the next layer.

## Automated checks

The complete core suite passes 146 tests, including 19 public App review tests. The UI suite passes 102 tests. Typecheck, Vite build, workspace all-target Clippy with warnings denied, Rustfmt, changed-file Prettier and `git diff --check` pass.

The tests exercise original feedback, remote anchors, ordinary reviewer permissions, protected mutation input, exact receipts and startup uncertainty. Optional failures preserve usable core data and successful sections. Final metadata governs lifecycle after exact PR, node, head and viewer validation.

Cross-conversation tests force both read and mutation admission orders. Same-PR work excludes conflicting work before dispatch. Readers still coalesce and unrelated PRs run in parallel. Exact receipt replay precedes the busy guard. A fresh read after an applied mutation observes its feedback.

A real SQLite trigger rejects receipt completion while the worker reports process cleanup failure. The caller retains the cleanup code and storage diagnostic. Shutdown retains the cleanup failure after storage recovers, and restart preserves the uncertain exact input. All three concurrency regressions failed against the previous source for the expected behavior, then passed after the fix.

## Native cases

Verification uses a disposable repository, isolated `Z1_DATA_DIR` and the executable fixture described in [the fixture guide](../review-fixtures.md). The local checkout stays on main while the saved PR references another head. One selected conversation has a removed worktree.

| Case                 | Observed result                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Summary and Timeline | Title, body, branches, checks, opened and commit events appear. Original review hunk, commit, author and thread state remain visible.           |
| Remote Code          | The PR patch and PR-only file appear while local main has different content.                                                                    |
| Refused review       | The draft remains after host refusal. Changed head and viewer refuse before mutation dispatch.                                                  |
| Late edits           | Summary and inline edits made during submission remain after the original capture succeeds.                                                     |
| Failed refresh       | A returned review ID remains success when the next read fails. The warning retains the last detail and disables actions.                        |
| Uncertain review     | The draft remains, submission stays disabled and explicit inspection acknowledgment permits a new submission without automatically posting.     |
| Reply and resolve    | Replies target the exact inline thread. Resolve and unresolve reflect confirmed host state.                                                     |
| Local triage         | The original observation and dismissal reason persist through restart.                                                                          |
| Composer handoff     | Existing draft text remains before finding, check or explanation context. Incomplete coverage adds a warning. No Codex turn starts before Send. |
| Partial detail       | Failed checks and files have unavailable labels. Four-page limits have explicit warnings and GitHub links. Successful sections remain usable.   |
| Narrow panel         | At 360 pixels, long text wraps, patches scroll and review actions remain accessible. The sidebar and chat composer stay unobstructed.           |

The first fixed bundle established the full matrix. After the final concurrency fix, the exact new bundle repeated saved-link opening, remote detail, original feedback, triage restart, refusal, late edits, failed refresh, reply and resolution. Executable hashes identified and corrected an earlier restart that had selected the previous bundle. The final app exited zero after native Quit.

The combined fixture history has 237 calls, 14 mutation requests, 11 confirmed actions and no transport violations. Inspection after native shutdown finds 16 exact-input receipts and one saved dismissal. These counts include deliberately refused and uncertain attempts. They prove the fixture boundary, not production GitHub mutation behavior.

## Live reads and limits

The exact metadata and commit queries were accepted by GitHub with pinned host and explicit repository variables. The other selected detail queries and remote file endpoint were also accepted. No production mutation was used for verification.

Screenshots exist in the native CUA transcript. Window-edge resizing was inconclusive, while the required narrow-panel case passed using the panel splitter. Session review drafts persist across navigation, not app restart. Original local triage and mutation receipts persist in SQLite.

## Independent review

The final reviewer was GPT-5.6-Sol at high effort. The verdict is PASS with no P0, P1 or P2 findings. The reviewer checked the complete source, all 41 frozen source entries, the incremental patch, failing regression logs and final check logs. The comment audits found no added suppressions or actionable comment flags. The existing MIT attributions remain.

Detailed native, source and log artifacts are retained in `/tmp/z1-pr-lifecycle`. The repeatable fixture and public App cases are committed with this layer.
