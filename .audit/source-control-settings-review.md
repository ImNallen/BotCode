# Source Control settings final independent review

Verdict: PASS. No blocking findings or required settings fixes remain in the reviewed source. This report replaces agent-label-only clearance for the settings work. Review date: 2026-10-10.

The review covers the requested GitHub-only Source Control settings: writing modes and custom instructions, PR templates, automatic pull, fetch interval, default PR merge method, and their native behavior. Publication and feature-branch workflows are outside this verdict except where shared settings integration is relevant. No repository source was edited, committed, pushed, or published during this review.

## Reference and source inspected

The local reference at `/tmp/t3ref/t3code` reports tag `v0.0.45`. I compared `apps/web/src/components/settings/SourceControlSettings.tsx`, `SourceControlWritingSettings.tsx`, and the relevant automatic-pull and merge-default rows in `ProjectDefaultsSettings.tsx` against Bot Code. The port retains the writing-mode labels and descriptions, template toggle, conventional-commit guidance, 5-second fetch adjustments, 30-second default, and last-selected/merge/squash/rebase default choices. Device fetch scope and repository project inheritance adapt these controls to Bot Code's single native owner. The requested subset does not introduce unsupported non-GitHub providers or a separate writer-model selector.

I inspected the original `/tmp/bot-source-control-settings.patch` scope and runtime integration hunks, then reviewed the current versions of:

- `crates/bot-core/src/runtime/source_control.rs`, the owner admission, settings-save, completion and shutdown integration in `runtime.rs`, and preview admission and policy capture in `runtime/writing.rs`.
- `crates/bot-core/src/settings.rs`, writing generation and template discovery in `text_generation.rs`, and `automatic_refresh` plus its tests in `vcs.rs`.
- `src/settings/SourceControlSettings.tsx`, `preferences.tsx`, `settingsCatalog.ts`, `ProjectSettingRow.tsx`, and settings page dispatch; `src/panel/pullRequestMergeMethod.ts` and its integration in `PullRequestDetail.tsx` and lifecycle payload tests.
- The settings and source-control tests in `src/settings/sourceControl.test.ts`, `src/panel/pullRequestMergeMethod.test.ts`, and `crates/bot-core/tests/git_actions.rs`.

## Findings and behavior checked

No actionable defects were found in the settings scope.

Writing policy is captured when a preview or Git action is admitted, so later settings saves do not rewrite an in-flight job. Global and project values preserve explicit false and null values and support resetting to inherited values. Unknown writing-style fields are discarded consistently. Custom instructions are trimmed. Repository conventions collect recent commit subjects and a bounded, contained AGENTS.md. Conventional commit guidance differs appropriately between commit subjects and PR titles.

PR generation resolves a committed base OID and reads templates from that tree. It applies the GitHub path precedence, ignores symlink blobs, rejects ambiguous template directories, bounds template text and listing output, and propagates cancellation. Disabling templates restores the normal Summary/Testing prompt. The integration test captures actual generator prompts for both enabled and disabled templates and verifies that a feature-branch replacement template does not become the selected base template.

Automatic refresh enumerates registered repository roots and linked checkouts, deduplicates canonical paths, caps jobs at four, and serializes checkouts within each workspace. A checkout is marked as started only when admitted, so exceeding the cap or encountering a busy checkout does not permanently skip startup. Missing worktrees are not recreated. The owner excludes held paths, active leases, setup and active turns; pending previews defer refresh. Source-control claims do not invalidate pending naming work.

A zero interval disables periodic fetch. An enabled startup automatic pull first requires cached evidence that the checkout is behind. Automatic pull requires a known `origin/HEAD`, its matching local branch, no local paths, zero ahead commits, a matching upstream branch and no merge/rebase/sequencer state. The fresh status is checked again after fetch and the update uses `merge --ff-only`. Fetch-only leaves HEAD unchanged. Cancellation kills and drains network children and shutdown releases the held work.

Merge selection respects repository-allowed methods and orders the current PR choice, configured project/global default, last selection, then the allowed fallback. The resolved method reaches ordinary merge and auto-merge payloads.

## Independent test runs

All following commands were run during this review and passed. Native tests use disposable fixture repositories and local bare remotes.

- `node --import ./src/test/tsx.mjs --test src/settings/sourceControl.test.ts src/panel/pullRequestMergeMethod.test.ts`: 8 passed. Log: `/tmp/bot-source-control-settings-final-review-ui.log`.
- `/tmp/bot-feature-branch-target/debug/deps/bot_core-a747ab5a9da2186e source_control --test-threads=1`: 6 passed. Log: `/tmp/bot-source-control-settings-final-review-unit.log`.
- `/tmp/bot-feature-branch-target/debug/deps/bot_core-a747ab5a9da2186e automatic_refresh --test-threads=1`: 5 passed. Log: `/tmp/bot-source-control-settings-final-review-refresh.log`.
- `/tmp/bot-feature-branch-target/debug/deps/git_actions-5c5c1c59eda2e977 source_control --test-threads=1`: 9 passed. Log: `/tmp/bot-source-control-settings-final-review-git.log`.

The Rust binaries were reused without recompilation. The parent confirmed they were built from `/tmp/bot-feature-branch-work` before only later TypeScript, documentation and verification-script changes. I independently compared every Rust file under `crates/bot-core/src` and `crates/bot-core/tests` between the main worktree and that build worktree. 96 files matched; there were 0 differences. This makes the focused native reruns applicable to the reviewed current Rust source without modifying a shared build target.

## Existing native evidence checked and limits

I read `/tmp/bot-source-control-native-report.md` and the five passed JSON records under `/tmp/bot-source-control-settings-native`: `settings-check.json`, `fetch-check.json`, `auto-pull-check.json`, `custom-preview-check.json`, and `template-pr-check.json`. The parent reports actual Tauri verification at 1100x780 and 1000x620 with an isolated BOT_CODE_DATA_DIR and disposable repository, including scope, inheritance, persistence and prompt capture. I did not launch or interact with the native app during this review; the layout evidence is the parent's native verification, not a new visual clearance by this reviewer.

I also inspected the final combined native log `/tmp/bot-source-control-final-native-tests.log`, which records 153 unit, 53 Git and 15 publication tests passing. The native report records the final 641 renderer tests. These broader runs supplement the 28 focused tests independently rerun above. The separate naming regression remains supported by the prior naming-suite log and the reviewed owner logic; it was not rerun here.

## Source fingerprints

SHA-256 values identify the principal reviewed Rust files and the original settings patch:

- `6edb07f380d88d53d7100e7a5a87915681a22043f23e3aa1494a4f7b1bb35355` `crates/bot-core/src/runtime/source_control.rs`
- `f25bfbca81efc953e4dcc0c32ce471f20f6b4713ba9a38808377153a03415c0d` `crates/bot-core/src/runtime.rs`
- `bbc1684a6780d04956266c088f3186ca5e2376bfee23ea238d589b3dc94d894d` `crates/bot-core/src/settings.rs`
- `39cee86e101011d07f4418a29ae73e6c38ed69e221613d9c0b1edd27cd49fbe4` `crates/bot-core/src/runtime/writing.rs`
- `82f067a6647bccabd7eb0037e7950b3b67302e400f1c47e4d7078ef90071a6d4` `crates/bot-core/src/text_generation.rs`
- `8ae85daff02594b25caab3662238de3092ac6187307c42a811d6b243c0b8e54c` `crates/bot-core/src/vcs.rs`
- `2e8ac35b344a198cda6322d88e6a3bf77b36c88739346a93549cca67325501f1` `crates/bot-core/tests/git_actions.rs`
- `2a4d58f79557bdb294046858a4448b30ebbcb65375cbd29f2c75dc4dfc693a95` `/tmp/bot-source-control-settings.patch`
