# Unit two concurrency independent review

## Verdict

PASS source gate.

I found no concrete P0, P1, or P2 defect in the frozen unit-two source. Both P1 findings from the preceding independent review are closed. The five earlier accepted fixes remain intact.

This was a read-only review of `/tmp/z1-pr-review-implementation` against `0fadc16b22ec917b3f2c7124ae8f326926d98522`, including untracked source and fixture files. I did not edit application source, run Cargo, start a native build, create agents, commit, push, or mutate a production pull request.

## Frozen source and incremental patch

Every one of the 41 source entries in `/tmp/z1-pr-lifecycle/unit-two-concurrency-source-sha256.tsv` matches the current worktree. The manifest also correctly records the three deleted files. The current tracked and untracked source set has no path outside that manifest.

The incremental patch at `/tmp/z1-pr-lifecycle/unit-two-concurrency-incremental.patch` applies cleanly in reverse with `patch --dry-run -R -p1`. Comparison with `/tmp/z1-pr-lifecycle/snapshots/unit-two-fixed` confirms that the only production change after the prior five-fix snapshot is `crates/z1-core/src/runtime/pr_review.rs`. The remaining incremental files are the new runtime regression, the public App concurrency tests, the fixture, and its guide. I also inspected the complete current unit-two source rather than treating that snapshot or the owner report as proof.

## Same-key admission closure

The reciprocal admission rule is correct in `crates/z1-core/src/runtime/pr_review.rs:53-147`. `read_review` validates membership, checks `changing` at lines 66-72, and only then coalesces or starts a detail read. `change_review` validates membership and input, loads an exact durable receipt at lines 109-113, and only then checks the global bound, `changing`, and the same-key `reads` entry at lines 114-122. The Owner runs these steps serially. It inserts `reads` before spawning a reader and inserts `changing` before spawning a mutation, so there is no admission window between the guard and reservation.

Receipt replay therefore remains available while the PR is busy. A completed same-input request returns its saved applied, refused, or uncertain result. A started same-input request returns the saved uncertain result. A changed input returns the request-conflict refusal before the busy guard. Canonical `PullRequestKey` values normalize repository case, so the same-key guards apply across linked conversations.

The public App tests at `crates/z1-core/tests/reviews.rs:860-1058` force both directions with file barriers. They prove cross-conversation refusal, zero mutation dispatch during a held detail read, zero detail dispatch during a held mutation, same-key reader coalescing, exact receipt replay, changed-input refusal, and an unrelated PR read while the first key is busy. Both cases release the operation and then prove that a new detail job observes the resolved host thread. The fixture logs before waiting, derives explicit PR identity when `matchNumber` is enabled, and uses locked atomic state replacement, so these assertions do not depend on an unobserved sleep or lost concurrent fixture update.

The prior source fails these tests for the expected behavioral reason. `unit-two-concurrency-read-red.log` shows the mutation was not refused. `unit-two-concurrency-mutation-red.log` shows a same-key detail read returned data during the mutation. The focused passing log `unit-two-concurrency-reviews.log` records all 19 public App review tests passing after the fix.

## Cleanup and persistence closure

The original worker result now controls cleanup state before receipt persistence in `crates/z1-core/src/runtime/pr_review.rs:149-164`. `finish_review` extracts an original `process_cleanup` error from either read or mutation completion and stores the first such error with `get_or_insert_with` before calling `accept_review_completion`.

Mutation completion at lines 216-240 preserves the uncertain receipt. If both the worker and `finish_pr_operation` fail, the response keeps code `process_cleanup` and the original cleanup message, then appends the storage code and diagnostic. A storage failure after an applied host result still returns the storage error and leaves the original started receipt uncertain. `stop_reviews` at lines 266-274 drains every admitted completion, then returns the sticky cleanup failure in preference to later review-drain errors. The runtime combines review shutdown before PR-worker and store close results at `crates/z1-core/src/runtime.rs:1158-1167`, so that cleanup failure also remains the returned shutdown result across those later stages.

The regression at `crates/z1-core/src/runtime/pr_review/tests.rs:4-140` injects the original cleanup error through the real completion boundary and rejects the SQLite completion `UPDATE` with a real trigger. It checks the combined caller error, the unchanged started row, exact saved input, a later applied-result storage failure, sticky shutdown failure after storage recovery, and startup conversion of both started rows to uncertain. `unit-two-concurrency-cleanup-red.log` shows that the prior source returned `storage` instead of `process_cleanup`. `unit-two-concurrency-cleanup.log` records the corrected test passing.

## Preserved unit-two behavior

The prior five accepted fixes remain present in the actual source. Optional section failures retain successful detail sections and one typed problem per section. Core or final metadata failures persist one shared stale transition while retaining the snapshot and notifying every linked conversation. Timeline events include opened, commits, comments, reviews, and merged or closed state in newest-first order, with merged taking precedence and unavailable dates sorting last. Known pre-dispatch denials return refused without host mutation. All four Codex handoffs carry the bounded typed coverage problems while preserving draft text, captured conversation targeting, focus, and explicit Send.

The host boundary still validates exact PR node, head, viewer, remote anchors, thread membership, and thread capability. It pins `github.com`, keeps review bodies in create-new mode-0600 files, and requires the expected nonempty returned host ID before reporting applied. Durable receipts keep exact input and startup uncertainty. Session review and reply drafts retain late revisions and clear only unchanged captured revisions. The deleted branch-bound Reviews path has no remaining caller.

## Recorded checks and native boundary

I read the exact final logs rather than relying on the owner report. `unit-two-concurrency-core-final.log` records 146 passing core tests, including 19 public App review tests and the private cleanup regression. `unit-two-concurrency-ui-final.log` records 102 passing UI tests. The final typecheck, Vite build, workspace Clippy, Rustfmt, changed-file Prettier, and `git diff --check` logs all pass. The build log contains only the recorded CSS parser and large-chunk advisories.

This PASS covers the source gate. I did not execute the Tauri application. The parent owns native proof and reports that the exact final-source local bundle is now running after correcting an earlier executable hash mismatch. Parent-observed final-source native interaction remains separate evidence and does not change this source verdict.

No reviewer-owned background process remains. A parent-owned final-source native app was running as PID 1403 when I checked, and I did not alter it.

Model the Domain shaped the decision to inspect `reads` and `changing` as one per-key admission state rather than as isolated flags. Boundary Discipline shaped the checks for exact receipt ordering and native identity validation. Type System Discipline shaped the review of the Rust enums and TypeScript discriminated unions across IPC. Test Behavior, Not Implementation shaped the requirement that the tests force both interleavings and inspect dispatch effects. Prove It Works shaped the direct manifest, patch, full-source, red-log, and final-log checks.
