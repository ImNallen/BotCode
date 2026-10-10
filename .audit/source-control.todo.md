# Source control parity

1. `how` over the affected subsystem.
2. `architect` for parallel design exploration.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the **separate-before-serializing-shared-state** principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.
4. Delegate code-writing to a subagent using your configured feature model (default in poteto-mode's Models section) with a specific scope (file paths, named data shape and its organizing structure per **principle-model-the-domain**, a state machine over scattered booleans, a table/registry over branching, a typed model over repeated shape assumptions, chosen before the delegate writes logic, and success criteria). When the implementation admits multiple valid shapes (error handling, abstraction layer, test structure), delegate via the **arena** skill instead so the runners surface the alternatives and the cross-judge guards the pick. Mandatory: no skip-with-reason escape, and Laziness Protocol does not override it (the gain is review separation, not lines saved). A subagent forbidden to spawn satisfies this by owning the diff directly with the same review separation. No "standing by" reply that waits on a nested agent. **Give every file-writing delegate its own worktree** (spawn it with `isolation: "worktree"`, or hand it an exclusive branch), and do not write files or run a suite in a worktree a delegate still holds. On Claude Code, `isolation: "worktree"` branches from the remote default branch unless the `worktree.baseRef` setting is `"head"`. When the delegate builds on commits the default branch lacks, commit them, create its worktree with `git worktree add <path> -b <delegate-branch> HEAD`, and name that base commit in the brief. Fencing a file in the brief's prose is not a lock (**principle-separate-before-serializing-shared-state**). Comments per **Comments**. Surgical edits, re-ground against the source for upstream-derived files. Port shared-primitive improvements to all consumers and verify each. Commit liberally.
5. Verify on the matching surface. "Inconclusive" or wrong-surface is not a pass. Flag it.
6. Rebase into small, ordered commits. Stack follow-ups.
   Use the **sequence-verifiable-units** principle skill, building, verifying, and committing each small unit before the next.
7. If the design is contested, `interrogate` before shipping.
8. Run **Opening a PR**.


## Session constraints

- The implementation phase skipped commits, pushes and PRs as requested. The user subsequently asked to create a PR, authorizing this follow-up commit, push and PR.
- [x] Confirm all three gaps against Bot Code and exact T3 reference.
- [x] Item 1 settings, behavior tests, build, actual isolated Tauri verification, then baseline and architecture documentation.
- [x] Item 2 publishing, behavior tests, build, actual isolated Tauri verification, then baseline documentation.
- [x] Item 3 default-branch feature choice, behavior tests, build, actual isolated Tauri verification, then baseline documentation.
- [x] Final independent review and focused checks. Current settings clearance and cross-model evidence audit saved beside this checklist.

## Throughput checkpoint

- Blocking first steps. Read the baseline, confirm gaps, and choose the data shape before implementation. Verify each item before starting the next.
- Independent workstreams. Read-only subsystem investigations run in parallel. A single owner implements each item in an isolated worktree. The lead owns native verification fixtures and documentation after each pass.
- Shared mutable state. Separate delegate worktrees, disposable Git repositories, and isolated BOT_CODE_DATA_DIR values prevent shared writes. Transfer patches only after the writer finishes.
- Smallest safe decomposition. One implementation owner per item keeps renderer, IPC, native behavior, and tests consistent. The lead independently reviews and drives Tauri.

## Publish design

- [x] Ground. Current missing controls, native ownership and exact T3 publication flow confirmed.
- [x] Sketch. Three independent design packages.
- [x] Agree. skip: default proceeds without a human checkpoint.
- [x] Implement. Writer owns /tmp/bot-publish-work seeded from completed item1 without a commit.
- [x] Scrap. n/a: implementation passed after two focused review fixes.
- [x] Frame. Behavior parity, small typed API, failure/remote integrity, literal wizard UI and native verification rubric.
- [x] Fan out.
- [x] Cross-judge.
- [x] Pick.
- [x] Graft.
- [x] Verify.

## Publish review findings

- [x] P1. Revalidated branch and HEAD identity after creation and push a named branch ref, preventing another branch from being published under the captured name. Reproduction is /tmp/bot-publish-review-repro.rs.
- [x] P2. Preserve actionable bounded create, remote-add and push error details with the known partial outcome and selected-remote recovery. Review is /tmp/bot-publish-review.md.

## Feature-branch design

- [x] Ground. Trace default confirmation, pending request, native planning, branch preparation and result metadata.
- [x] Sketch. Three independent design packages.
- [x] Agree. skip: default proceeds without a human checkpoint.
- [x] Implement. Exclusive writer seeded with completed settings and publication.
- [x] Scrap. n/a: implementation passed after the scoped clean-default quick-action correction.
- [x] Frame. Preserve approved message and files, full stacked target, native checkout ownership, exact T3 control and refusal behavior.
- [x] Fan out.
- [x] Cross-judge.
- [x] Pick.
- [x] Graft.
- [x] Verify.

## PR follow-up

- [x] Check branch, repository, existing PRs and live agents. No active delegate holds the main worktree.
- [x] Run Deslop against the reviewed diff. No additional code cleanup required.
- [x] Resolve precommit CI Clippy findings through an isolated writer and independent review.
- [x] Run remaining required CI checks, then commit and push this branch. Full bot-core tests and strict workspace Clippy passed.
- [x] Create a ready PR and register it with this T3 Code thread. PR #88 targets main and is linked.
