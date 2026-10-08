# PR checkout and worktree selection verification

Verified on 2026-10-08 in the macOS Tauri app. The reference was T3 Code v0.0.45, commit `6c8fed35dded9ff71c5b46807125457acbb76be6`. Its PR detail handoff prepares the checkout and opens the destination conversation before adding task context. Bot Code follows that ordering and adds selection of any registered worktree.

## Repeat the native fixture

Build the actual desktop bundle with embedded assets. A debug bundle without `tauri/custom-protocol` expects the development server.

```sh
pnpm tauri build --debug --features tauri/custom-protocol \
  --config '{"identifier":"dev.bot.code.prhandoffverify"}'
verification_root=$(mktemp -d /tmp/bot-code-pr-handoff.XXXXXX)
python3 scripts/pr-handoff-fixture.py "$verification_root/fixture" \
  --app 'target/debug/bundle/macos/Bot Code.app'
```

The script refuses an existing fixture directory. It creates a disposable Git repository, local bare remote, external and detached worktrees, and a missing registered worktree. It seeds a separate native database with `SOURCE_UNSENT`, `DESTINATION_UNSENT`, and a linked PR. `manifest.json` records paths, thread IDs, and commit IDs. `app.pid` identifies the launched test process.

The app receives an isolated `BOT_CODE_DATA_DIR`, the scripted GitHub fixture through `BOT_CODE_GH_BIN` and `BOT_CODE_PR_FIXTURE_STATE`, and an executable Codex fixture through `BOT_CODE_CODEX_BIN`. A repository-local Git URL rewrite sends PR fetches to the local bare remote. This procedure uses no live GitHub mutation or real Codex turn. Quit the fixture app when finished.

1. In a new project draft, type a marker and select the external worktree from **Workspace**. Confirm a fresh conversation opens with that marker and its branch. Open the seeded existing conversation and confirm `DESTINATION_UNSENT` remains. Select the detached worktree from another project draft and confirm its own branch picker opens. Generic adoption does not run setup.
2. Open **Source conversation**, then the right panel's **Pull requests** surface. **Check out** opens a destination dialog with a separate worktree selected. Cancel and confirm `SOURCE_UNSENT` remains.
3. Choose **Fix findings** from the PR menu. Prepare a separate worktree. Confirm the new conversation has the PR badge, setup card, correct branch, and captured repair draft. Inspect its actual Git HEAD against `manifest.json`. No turn should be sent.
4. Prepare the external existing worktree. Its original branch remains as a Git ref, while all conversations sharing the path display the new PR branch. The original conversation's unsent draft remains intact. Once setup succeeds, reuse that exact-head checkout and confirm setup does not rerun.
5. While a checkout dialog is open, change `head` in the fixture's `gh.json`. The captured request must refuse. Restore the expected head and refresh the PR before continuing. Add an untracked file to the existing target and confirm preparation refuses without changing that file or branch.
6. Set `headRepository` to `fork-owner/project` and point the local `feature` branch at `main`. The PR ref in the local bare remote still points to the PR head. Prepare a dedicated checkout and confirm the actual HEAD matches the PR, while local `feature` remains unchanged.
7. Use a setup script that waits for a fixture release file. While its setup card runs, open another checkout dialog and confirm that path is disabled with a busy reason. Release setup and confirm completion. Remove only that disposable worktree after completion. Its saved conversation can still prepare a fresh PR checkout through the repository root, preserving its old draft.
8. Restart the fixture app. Confirm saved drafts, PR memberships, and completed setup survive. Test long registered-worktree lists at the minimum 1000 by 620 window size. Both the destination dialog and general Workspace menu must scroll, with the dialog actions remaining visible.

## Observed results

The native run used the final source in a 1100 by 780 light window. A second bundle from the same source used a temporary Tauri config with a 1000 by 620 window and appeared in dark mode. The shell retained the sidebar, centered chat, bottom composer, compact header, and optional tools panel.

| Native case                        | Observed result                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| External and detached adoption     | Fresh correctly scoped conversation, carried project draft, no setup rerun.                                         |
| Missing registered target          | Disabled with an explanation in both selectors.                                                                     |
| Dedicated repair                   | Exact PR head, persisted PR link, setup output and success card, captured repair draft, zero sent turns.            |
| Existing PR checkout               | Exact head, unique branch, shared conversation branch metadata updated, original branch and other drafts preserved. |
| Changed head after opening dialog  | Refused with unchanged source checkout, draft, and conversation count.                                              |
| Dirty existing target              | Refused and preserved its local file and branch.                                                                    |
| Edit during final GitHub refresh   | Refused even when the target already matched the PR head. No new conversation or setup.                             |
| Fork with a local branch collision | Exact PR ref used; unrelated same-named local branch preserved.                                                     |
| Setup in progress                  | Target disabled with a busy reason; completion remained visible.                                                    |
| Removed source worktree            | Fresh destination preparation succeeded; removed source draft remained saved.                                       |
| Restart and exact-head reuse       | Drafts and PR links persisted; completed setup did not rerun.                                                       |
| Long lists at minimum size         | Dialog and Workspace menu scrolled to lower rows; dialog footer remained visible.                                   |

Git, SQLite, and setup-log assertions corroborated the UI observations. Local evidence is under `/tmp/bot-code-pr-handoff`, including `verification.json`, per-case `final-native/after-*.json`, build logs, and test logs. Native accessibility observations and screenshots are in the task transcript. `native-evidence` contains returned screenshots and accessibility text extracted from that transcript by stable tool call ID.

## Automated checks

```sh
pnpm typecheck
pnpm test:ui
cargo test -p bot-core
cargo fmt --all -- --check
git diff --check
```

All 450 UI tests and 429 Rust tests passed. UI tests cover delayed source edits, preparation reuse, destination activation, edits during durable saves, navigation during persistence, context and attachment preservation, and IPC contracts. Rust tests cover registry membership, foreign and missing paths, forks, stale identities, dirty targets, setup provenance, checkout exclusion, project removal, shutdown cancellation, and persisted memberships. A new late-edit regression failed before the final cleanliness fix and passed afterward.

After rebasing onto the updated main branch, all 459 UI tests and 439 Rust tests passed. Typecheck, formatting, and the native build also passed. A fresh disposable native fixture confirmed existing-worktree adoption, dedicated PR repair, exact HEAD, completed setup, PR membership, preserved drafts, and zero sent turns. Its Git and SQLite assertions are in `pr-native/after-handoff.json` under the local evidence directory.

The independent source review found that exact-head reuse skipped a late cleanliness check. Preparation now rechecks HEAD and cleanliness after its final GitHub refresh. The native late-edit fixture confirmed the corrected refusal.

Live GitHub service behavior was not tested. This run exercised its scripted metadata contract and real local Git operations. Attachment and concurrent renderer-save cases were verified in the UI tests rather than through native file-picker automation. PR preparation creates a unique local branch and links its conversation to the selected PR. It leaves Git Push behavior unchanged and does not configure a push upstream. This run stopped at unsent repair drafts.
