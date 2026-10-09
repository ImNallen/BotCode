# Smaller feature gaps

Reference source is `pingdotgg/t3code` tag `v0.0.45`, commit `6c8fed35dded9ff71c5b46807125457acbb76be6`. The source audit used that exact checkout at `/tmp/t3ref/t3code`. The initial Bot Code checkout had no working-tree changes. Documentation alone does not establish a missing feature.

| Requested workflow | Confirmed before implementation | Work to verify |
| --- | --- | --- |
| Usage history | `src/usage/UsagePage.tsx` renders limits only. `crates/bot-core/src/usage.rs` stores the latest context usage, not dated history. | Codex transcript history, dated model totals, token and estimated-cost views, periods, coverage and refresh. |
| Richer file rendering | `src/panel/FilesSurface.tsx` renders source with autosave and draft overlays. No rendered mode exists. | Markdown, CSV/TSV tables, HTML and native asset previews within the existing file tab. |
| PR commit selection | `src/panel/prReview.ts` exposes commits as timeline events. `PullRequestCodeTab.tsx` always uses the whole PR's files. | All commits and exact commit scopes, with comments disabled for commit scopes. |
| Viewed markers | Neither `PrFile` nor the Code header carries viewed state. No host read or mutation exists. | GitHub-backed per-file Viewed state, progress, failures and changed-file status. |
| Multiline review comments | Local Diff already sends range comments to chat. PR Code keeps only the selected end line. | PR range selection and range review drafts. Actual multiline GitHub posting extends the reference behavior. |
| Unchanged-context expansion | Local Diff and turn Diff already parse full old/new contents. PR Code parses partial remote patches without a full-file loader. | Load immutable remote contents for PR context expansion, including renames and commit scopes. |

Upstream evidence is `apps/web/src/components/usage/UsagePage.tsx`, `apps/server/src/usage/UsageService.ts`, `usageTranscripts.ts`, and `usageAggregation.ts` for history. Rich file modes come from `components/files/FilePreviewPanel.tsx`, `filePreviewMode.ts`, `FileMarkdownPreview.tsx`, `DelimitedTablePreview.tsx`, `BrowserDocumentFrame.tsx`, and `packages/shared/src/delimitedPreview.ts`.

PR evidence is `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx`, `usePullRequestFilesViewed.ts`, `pullRequestFilesViewed.logic.ts`, `apps/web/src/lib/diffFileContents.ts`, and `apps/server/src/pullRequest/GitHubPullRequestCli.ts`. The reference Code tab at lines 699-710 explicitly collapses a submitted remote review range to its last line. Its `packages/contracts/src/pullRequest.ts` draft contract also stores one position. Bot Code's existing local range handling is in `src/panel/DiffSurface.tsx` and `composerReviewContext.ts`.

## Verification sequence

- [x] Confirm all requested gaps against current source and exact upstream source.
- [x] Launch the pre-change Tauri bundle with a disposable repository and isolated `BOT_CODE_DATA_DIR`. Its Usage page shows only subscription limits.
- [x] Usage history. Behavioral checks, native checks, then update the baseline.
- [x] Richer file rendering. Behavioral checks, native checks, then update the baseline.
- [x] PR commit selection. Behavioral checks, native checks, then update the baseline.
- [x] Viewed markers. Behavioral checks, native checks, then update the baseline.
- [ ] Multiline review comments. Behavioral checks, native checks, then update the baseline.
- [ ] Unchanged-context expansion. Behavioral checks, native checks, then update the baseline.

The native fixture starts at `/tmp/bot-smaller-gaps-native`, with disposable Git repositories, a local GitHub fixture peer, and its own data directory. Feature completion requires direct native observations. Compilation and browser mocks do not satisfy that gate.

## Current status

Usage history shipped in #76 and passed native verification on October 9, 2026. The isolated Tauri app matched the fixture totals in Tokens and Cost across all four periods. Model and time breakdowns, keyboard chart values, refresh after appended usage, restart preferences, scan-cache reuse, and retained partial coverage passed. The Usage baseline now describes the implemented history views. Richer file rendering passed native verification on October 9, 2026. In the isolated Tauri app, rendered Markdown saved task toggles to disk and loaded relative images and links. CSV and TSV rendered as tables, and the HTML frame loaded its sibling assets while its script could not reach Tauri, storage, `fetch` or a dot folder. An image reloaded after a disk change, and audio played through. PR commit selection passed behavioral and native verification on October 9, 2026. Exact commit patches, comment gating, scope navigation, failed and empty reads, force-push reset, delayed responses, and the 25-commit menu passed. Viewed markers passed behavioral and native verification on October 9, 2026. GitHub persistence, scope progress, box and label toggles, fold behavior, refused writes, retained and initial read failures, changed-file resets, bounded coverage, delayed writes, reopening and restart passed. The remaining two features have not entered implementation. [Verification notes](smaller-gaps-verification.md) record the checks and evidence.
