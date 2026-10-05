Reviewer model is gpt-5.6-sol.

# Unit one final correctness review

## Scope

This read-only pass reviewed only the fixes added after `unit-one-fix-review.md` in the frozen worktree at `/tmp/z1-pr-lifecycle-implementation`, based on `3a3eaac`. I traced the complete paths for Owner-managed native Git completion, shutdown ordering, uncertain creation results, lightweight creation identity, nullable titles, Owner projection sequencing, and both TanStack Query caches. I also read the relevant fixture and behavior tests. I did not edit source, run Cargo, start the application, use a shared target, contact a remote, or post a comment.

## Verdict

**PASS. No P0, P1, or P2 findings in the final fix set.** The two P1 findings in `unit-one-fix-review.md` are resolved. The final creation changes also meet the later accepted contract.

## Correctness evidence

### Owner shutdown preserves admitted creation results

`Owner` captures the originating thread and membership generation before it spawns each admitted native Git job (`crates/z1-core/src/runtime.rs:1218-1245`). `finish_git_job` accepts a returned PR only when that captured generation is still current, persists the `GitCreated` or `GitReused` membership, releases the checkout hold, and then answers the caller (`runtime.rs:839-875`).

Shutdown closes command admission before leaving the receive loop. It then drains the Git `JoinSet` with `refresh=false`, stops existing PR workers, closes SQLite, and only then acknowledges shutdown (`runtime.rs:1136-1141,1181-1196`). The `refresh=false` branch prevents drained actions from starting new PR reads or discovery. `pr_membership` may mark the persisted key due, but no poll or worker start runs during this drain.

The public `App` test starts a delayed create, waits until the fixture records the invocation, calls shutdown, immediately reopens the same data directory, and observes one persisted `GitCreated` membership before it awaits the original action task (`crates/z1-core/tests/pull_requests.rs:613-646`). This test would fail under the previous detached-task behavior because shutdown would return before the membership write and database reopen.

### Creation has an explicit uncertain result and no retry

`open_pr` maps timeout, process cleanup, and post-spawn I/O uncertainty to `pr_creation_uncertain` with reconciliation guidance (`crates/z1-core/src/vcs.rs:847-873`). No loop or recursive call can issue another `gh pr create`. The timeout test uses a create delay longer than the network bound, requires the uncertain code and no PR result, shuts down, and counts exactly one create invocation (`crates/z1-core/tests/pull_requests.rs:678-692`). The current full core-suite log includes this test and reports 131 passing tests.

### Successful creation keeps known identity without a metadata dependency

After `gh pr create` succeeds, `open_pr` parses its final URL through `PullRequestKey`, verifies that its normalized repository matches the explicit `--repo`, and returns the canonical URL and number with the requested base and head (`crates/z1-core/src/vcs.rs:852-891`). It does not run `gh pr view`. `PullRequest.title` is optional in Rust and nullable in the IPC schema (`crates/z1-core/src/domain.rs:685-693`; `src/ipc.ts:230-236`). Observed list results still populate a title.

The frontend model accepts a nullable title, and the success toast omits the description when the title is absent (`src/chat/GitActionsControl.logic.ts:20-27`; `src/chat/gitActions.ts:344-353`). The core test proves that a successful create survives a failing shared metadata read, saves one `GitCreated` association with an unknown snapshot, performs one create, and performs no `pr view` (`crates/z1-core/tests/pull_requests.rs:649-675`). The parent's final native artifact, `/tmp/z1-pr-lifecycle/native/unit-one-final-native-result.json`, independently records one create, zero redundant views, saved creation with unavailable metadata, later title recovery, unlink, and tombstone-safe refresh in the actual Tauri app.

### Projection ordering protects both caches

Every Owner-generated `ThreadPrSummary` receives the next session-scoped sequence before it enters a list response, workspace response, or change hint (`crates/z1-core/src/runtime/pull_requests.rs:172-189`). The frontend installs query defaults before any prefetch or subscription. The `thread-prs` rule retains a cached summary only when its sequence is newer. The workspace rule always accepts the incoming workspace fields and other thread fields, while it chooses the newest PR projection from the response, the previous workspace value, and the matching `thread-prs` cache (`src/ipc.ts:542-570`; `src/main.tsx:1-16`).

Six tests use a real `QueryClient` and deferred old responses. They cover link and unlink for the list cache, an existing workspace cache, and a first workspace response with only the list cache populated. They also require the incoming branch, files, and other thread fields to win (`src/panel/pullRequests.test.ts:71-112`). Removing either structural-sharing rule or preserving the whole old workspace response would fail these assertions, so the tests check the reported behavior rather than the implementation shape.

## Verification evidence

The current final logs report 131 core tests, including all 15 lifecycle integration tests, 100 UI tests, a passing typecheck, a passing Vite build, Clippy with warnings denied, formatting, and `git diff --check`. The build has only the previously reported large-chunk advisory. I ran only `git diff --check` during this review because the task prohibited Cargo and build use.

## Bounded concerns

No correctness concern remains within this final-fix scope. The final native run exercises creation with unavailable metadata and recovery. The slow-create shutdown guarantee is covered at the public `App` boundary with the real fixture process and immediate database reopen, as required by the accepted contract. Cache ordering is covered with TanStack Query itself rather than a copied merge helper. Later review, mutation, merge, and settlement behavior remains outside unit one.

No matching application, fixture, or worktree process remained after the review.
