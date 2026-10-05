# PR association verification

This layer saves GitHub PR links on conversations and shows them in the existing sidebar and optional right panel. It is the first part of the full lifecycle. Review detail/submission and merge/settlement are later layers.

## Native proof

The actual Tauri app ran against a disposable Git repository and an isolated Z1_DATA_DIR. GitHub and Codex were replaced only at their process boundaries by scripted peers. No production PR was created, reviewed or merged during these checks.

The original build showed a Created PR27 toast but saved no PR association. The corrected build saved the originating local conversation as GitCreated, discovered the same PR for another local conversation, and held one shared PR record with two memberships. A removed-worktree conversation could manually link that PR and open the remote list without Files/Diff controls. Switching the disposable checkout to main and restarting preserved all saved links. Unlink removed only the selected conversation membership. Returning to the matching branch and refreshing did not restore the dismissed association.

The final build created fixturePR28 while all following metadata reads failed. The sidebar and automatically opened panel retained its canonical link with Status unavailable. SQLite held one GitCreated membership and an unknown stale record. The creation toast omitted the unknown title. After the host fixture recovered, refresh showed the observed title and Open state. Unlink removed the badge and row. Another discovery refresh left the tombstone dismissed. Fixture logs proved exactly one create and no redundant pr view. The app then closed with exit0.

The native window retained its left conversation sidebar, centered chat with bottom composer, compact header, neutral colors and optional right panel. Full review/merge behavior and narrow-panel verification remain required in the later layers.

## Behavioral checks

131 core tests and 100 UI tests passed. The public App tests use real Git, SQLite and isolated scripted host processes. They cover create/reuse association, shared refresh, guarded discovery, ambiguity, fork context, stale retention, restart, unlink during create, late discovery and removed worktrees. A delayed create during shutdown saves the association before acknowledgment and immediate database reopen. Creation timeout reports uncertainty with exactly one create. Successful creation followed by failed metadata keeps its known identity.

Six real TanStack QueryClient arrangements defer older list/workspace responses across newer link and unlink hints. The newest PR projection survives while incoming branch, files and other thread fields apply. The first workspace response also preserves a hint received while its query was pending.

Cancellation tests verify descendant absence before shutdown acknowledgment and immediate data-directory reopen. A separate fork experiment showed that closing the parent lock file while a live child inherits its description keeps the lock. Explicit unlock releases it. The Store test reproduces that descriptor behavior and confirms the replacement runtime retains exclusive ownership.

Typecheck, Vite build, the debug Tauri bundle, workspace clippy with warnings denied, Rustfmt, changed-file Prettier and diff whitespace checks passed. The Vite build reports its existing large-chunk advisory.

## Evidence and limits

The development record is /tmp/z1-pr-lifecycle. Native structured results include native/unit-one-final-native-result.json, native/unit-one-fixed-created-db.json, native/unit-one-before-restart-db.json, native/unit-one-unlinked-db.json, native/unit-one-final-created-db.json and native/unit-one-final-unlinked-db.json. Native screenshots are in the CUA transcript. They are not saved image files. Check logs use logs/unit-one-final-\* and native/unit-one-final-build.log.

The reusable scripted host is checked in at crates/z1-core/tests/fixtures/gh-lifecycle.py. Core tests copy it beside an isolated state file. Live read-only GitHub probes validated the exact core and discovery queries. These probes establish wire shape, not account permissions or live mutation outcomes.

GitHub.com is the supported host. Native creation/reuse targets origin. A PR created against another base repository can be linked by URL. Other providers, native stack algorithms and automatic branch/worktree deletion are outside this change. Review/merge controls are not exposed by this layer.
