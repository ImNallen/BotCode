# PR lifecycle verification

The final lifecycle layer passed source review, automated checks and the required native Tauri gates on 2026-10-05. The app used a disposable repository and isolated `Z1_DATA_DIR`. Verification never mutated a production pull request.

## Source and automated checks

The [source manifest](lifecycle-source-sha256.tsv) records the 36 changed source paths tested over the accepted review layer at `024a3e7`. Its SHA-256 is `73f7693f7015cc3cd2bf8759022023e3a6e34715323c684416a8a117d9dc9747`. The copied delivery source matches all 36 hashes.

- Rust core tests passed 172 tests. UI tests passed 109 tests.
- Typecheck, Vite build, workspace all-target Clippy with warnings denied, Rustfmt, changed-file Prettier and whitespace checks passed.
- Independent source review found no actionable P0, P1 or P2 defect. The comment audit found no deletion or suppression required.

The Vite build retains its existing CSS optimization and large-chunk advisories.

## Native acceptance

Both launches used the exact finished executable with SHA-256 `3b5e68a2049d0008d199192e1da6db6f0c34bbbcce434d4cb47b72497eef0dce`. Native access recovered after the user foregrounded the test window. The driver then observed the following behavior.

| Workflow                 | Result                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create, review and merge | A real Send created activity, native Git creation saved PR31, and switching to main retained remote Code. Explicit summary and line review returned a review ID. Squash confirmation and dispatch used the captured PR, head and account.                                |
| Confirmation failure     | The accepted merge stayed Active while reads failed. Reconcile confirmed Merged after reads recovered and moved the conversation to Settled.                                                                                                                             |
| New activity             | A later accepted prompt returned the merged conversation to Active.                                                                                                                                                                                                      |
| Lifecycle changes        | Draft, ready, close and reopen displayed host-confirmed results. Auto-merge stayed pending while Open. Disabling it worked during a held agent turn; branch update during that turn was refused.                                                                         |
| Changed head             | Changing the remote head after confirmation opened refused the update before dispatch.                                                                                                                                                                                   |
| Interrupted update       | After normal Quit, an emulated lost completion changed only receipt state and result. Restart and Reconcile kept its outcome unknown. Cancel and changed-account refusal retained it. Fresh explicit Continue saved the inspected identity without replaying the update. |
| Required queue           | Queue acceptance stayed Active. Fresh merged confirmation settled the conversation when both linked PRs were merged. The request had an expected head and no queue jump.                                                                                                 |
| Settings and placement   | Merge settlement worked with idle settlement disabled and a project override above a disabled device default. Reset restored inheritance. Native un-settle kept the merged conversation Active across refresh.                                                           |
| Repair and conflicts     | The aggregate repair draft visibly included STARTUP_FAILURE. Conflict resolution prepared a captured draft; permitted secondary auto-merge remained available and direct merge was absent. Neither draft started a turn.                                                 |
| Layout                   | Actual 1100x780 and 1000x650 windows preserved the sidebar, chat, bottom composer and optional 360px PR panel. Code scrolled horizontally within its panel; review context and controls stayed usable.                                                                   |

Both native runs exited 0 through Command+Q. Closed database inspection found no pending receipts, three saved links and three accepted user turns. The fixture recorded 266 calls and 10 mutations, including exactly one branch update. Recovery added zero mutations. All mutation inputs passed hostname, privacy, expected-head and bypass checks.

## Evidence and limits

The local run artifacts are under `/tmp/z1-pr-lifecycle`. The native report, source review and consistency validator are `native/recovery-native-report.md`, `recovery-independent-review.md` and `native/validate-recovery-native.py`. Exact launch, receipt, settings and host evidence accompany them. Actual screenshots remain in this session's native transcript; there are no saved screenshot files to link.

The restart arrangement emulates missing completion data after normal shutdown. It is not a real-crash claim. Fresh merged supersession and precise membership, epoch, cleanup, storage, approval, snooze and removed-checkout combinations passed public App tests. They are not all claimed as native interactions.

Private fixture runs establish application behavior. Live read-only GraphQL checks establish the selected provider fields. Neither establishes GitHub scheduling, cancellation or a live remote merge. Browser checks used mocked IPC and were supplemental; browser screenshot capture failed.
