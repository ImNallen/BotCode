# Smaller gaps verification

## Baseline

The pre-change Tauri bundle was built and launched from `/tmp/bot-smaller-gaps-native/Bot Code.app`, with a disposable repository and `BOT_CODE_DATA_DIR=/tmp/bot-smaller-gaps-native/data`. Native observations confirmed the limits-only Usage page and the PR Code toolbar without commit selection or Viewed controls. The observation index and screenshots are under `/tmp/bot-smaller-gaps-native/evidence/index.json`.

## Usage history verified

Implemented behavior includes external Codex transcript discovery, disjoint token categories, duplicate and copied-prefix suppression, archived sessions, 90-day retained scan records, local calendar periods, unknown-model coverage, and cached API-price estimates with source and content fingerprint. History is owned separately from the live provider actor. Preferences use the existing native UI storage, scoped to `BOT_CODE_DATA_DIR`.

Earlier behavioral and review checks:

- `pnpm test:ui`: all 464 tests pass, including the five new history tests. Log: `/tmp/bot-smaller-gaps-usage-ui.log`.
- `cargo test -p bot-core usage_history --lib`: all 15 history tests pass. Log: `/tmp/bot-smaller-gaps-usage-core.log`.
- `cargo test -p bot-core`: the full core suite passes. Log: `/tmp/bot-smaller-gaps-usage-core-full.log`.
- A Tauri debug app bundle builds with verification identifier `dev.bot.code.gapsverify`. Log: `/tmp/bot-smaller-gaps-usage-build.log`.
- `pnpm format:check`, `cargo fmt --check`, and `cargo clippy --workspace --all-targets --locked -- -D warnings` pass with the repository's Rust 1.93 toolchain. Logs: `/tmp/bot-usage-pr-format.log`, `/tmp/bot-smaller-gaps-usage-format.log`, and `/tmp/bot-usage-pr-clippy.log`.
- An independent read-only review found no actionable correctness defect. Report: `/tmp/bot-smaller-gaps-design/usage-review.md`.
- Comment review removed one redundant comment and renamed the local-date helper to express its meaning. Report: `/tmp/bot-smaller-gaps-design/usage-comments.md`.

`scripts/smaller-gaps-fixture.py prepare /tmp/bot-usage-docs-native-20261009` creates the disposable repository, isolated provider, GitHub fixture, `codex-home` and synthetic rates. Its manifest expects 3,960 processed tokens, 2,750 uncached input, 800 cached input, 50 cache creation, 360 output, 110 reasoning, $0.00865 of known-model estimates and 110 unpriced tokens. The rolling 24-hour period expects 2,860 tokens. The history session has no Bot Code conversation, so discovery exercises external usage.

Native verification completed on October 9, 2026 using a freshly built Tauri debug bundle with identifier `dev.bot.code.usagedocsverify`. The app ran from `/tmp/bot-usage-docs-native-20261009/Bot Code.app` with `BOT_CODE_DATA_DIR=/tmp/bot-usage-docs-native-20261009/data` and `CODEX_HOME=/tmp/bot-usage-docs-native-20261009/codex-home`. `scripts/smaller-gaps-fixture.py prepare` created the disposable repository, provider, GitHub peer, and external transcript. The previous computer-use startup failure no longer occurred. No real account history or repository was used.

Before launch and each explicit refresh, the fixture's rate table was copied into `data/usage-model-rates.json` with a current `fetchedAtMs`. This kept estimates deterministic and avoided replacing the synthetic rates during refresh.

The native checks passed:

| Check | Observed result | Evidence under the fixture's `evidence` directory |
| --- | --- | --- |
| Limits | Codex fixture plan and Weekly 56% left. The period control is disabled. | `01-limits.txt`, `01-limits.jpg` |
| Tokens and disjoint totals | 3,960 processed tokens, 2,750 uncached input, 800 cached input, 50 cache creation, 360 output, and 110 reasoning included in output. | `02-tokens-30d-keyboard.txt`, `02-tokens-30d-keyboard.jpg` |
| All four periods in Tokens and Cost | Past 24h shows 2,860 tokens and $0.00615. The 7-, 30-, and 90-day windows each show 3,960 tokens and $0.00865. Hourly and daily charts have the expected bucket counts. | `02` through `09` captures |
| Model and time breakdowns | Model A has 3,300 tokens and $0.00735, model B has 550 and $0.0013, and the unknown model has 110 tokens with cost Unavailable. Hour and Day tables match the chart values. | `02-tokens-30d-keyboard.txt`, `03-tokens-24h-hour.txt`, `04-tokens-7d-day.txt` |
| Keyboard chart values | Tab and Shift+Tab focus chart buttons. The focused October 8 bar shows 1,100 tokens and a visible focus ring. | `02-tokens-30d-keyboard.txt`, `02-tokens-30d-keyboard.jpg` |
| Coverage and pricing | One duplicate event is suppressed. The unknown model's 110 unpriced tokens, cached-rate source, timestamp, and content fingerprint are visible. | `02-tokens-30d-keyboard.txt`, `12-cost-7d-day-coverage.jpg` |
| Append and refresh | `append-usage` adds 11,000 tokens and $0.025. Refresh shows 14,960 tokens and $0.03365 in 7 days, or 13,860 and $0.03115 in Past 24h. | `10-cost-24h-after-append.txt`, `11-cost-7d-after-append.txt` |
| Restart and cache reuse | The original process exits and a new process opens with Cost, 7 days, and Day selected. Totals remain 14,960 and $0.03365. Coverage shows 0 files scanned and 1 reused. | `13-restart-preferences-cache.txt`, `preferences.json`, `../launch.json` |
| Removed and restored source | Moving `sessions` outside Codex home keeps 14,960 tokens and $0.03365, shows Partial coverage, and explains retained records. Restoring it clears the warning and reuses the file. | `14-source-removed-retained.txt`, `14-source-removed-retained.jpg`, `15-source-restored.txt` |
| Native layout | The 1100×780 window keeps the sidebar, compact header dropdowns, chart, totals, and breakdown readable. A zoomed window exposes working segmented metric and period controls. | `02-tokens-30d-keyboard.jpg`, `12-cost-7d-day-coverage.jpg`, `16-wide-native-layout.jpg`, `17-wide-native-tokens.txt`, `18-wide-native-period.txt` |

The observation index is `/tmp/bot-usage-docs-native-20261009/evidence/index.json`. Each capture includes the native accessibility tree and a JPEG. The adjacent `verify.py` checks captured totals, period bucket counts, model and time rows, focus, persistence, cache reuse, and removal/restoration coverage. The transcript source was restored after verification.

Current checks also pass:

- `pnpm tauri build --debug --bundles app --config '{"identifier":"dev.bot.code.usagedocsverify"}'`. Log at `/tmp/bot-usage-docs-build.log`.
- `node --import ./src/test/tsx.mjs --test src/usage/history.test.ts`. All 5 history UI tests pass. Log at `/tmp/bot-usage-docs-ui-tests.log`.
- `cargo test -p bot-core usage_history --lib`. All 15 history tests pass. Log at `/tmp/bot-usage-docs-core-tests.log`.

The Usage baseline now describes token and estimated-cost history, and Usage history is checked off in `smaller-gaps.md`. The remaining five features are outside this verification pass.

Sequence Verifiable Units kept each native check ahead of the next fixture change. Prove It Works required direct observations in the isolated Tauri app before closing the checklist.

## PR commit selection verified

Commit selection passed on October 9, 2026 before Viewed implementation began. The source was confirmed missing in current Bot Code and ported from T3 v0.0.45 at `6c8fed35dded9ff71c5b46807125457acbb76be6`.

`scripts/smaller-gaps-fixture.py prepare-pr-code <directory>` extends the existing disposable GitHub fixture with two commits and distinct whole-PR and commit patches. The native run used `/tmp/bot-pr-code-native-20261009`, its isolated data directory, and a fresh Tauri debug bundle with identifier `dev.bot.code.prcodeverify`. The GitHub peer log records full-SHA commit REST requests. No real GitHub repository or account was used.

Behavioral checks passed. All 544 UI tests and the full core suite pass, including six new commit-read tests. The tests cover exact commit changes, membership pagination, malformed and foreign SHAs, captured identity, account and head races, unlinking during a read, empty commits, unavailable patches, and partial file pages. Static rendering checks keep the picker and comment explanation above loading, failure, and empty states. Logs are `/tmp/bot-commit-ui-tests.log`, `/tmp/bot-commit-core-tests.log`, and `/tmp/bot-commit-build.log`. The native build log is `/tmp/bot-pr-commit-native-build.log`. Independent correctness review found no actionable defect.

Direct native observations passed:

- All commits shows both added files. Each commit shows only its own file. The earlier commit shows the removed calculation line as well as its replacement, proving the diff is the commit's own change.
- The menu orders headlines newest first and shows seven-character SHAs. A 26-commit roster shows 25 entries and **Show more (1 left)**. That button reveals the last commit without changing scope or closing the menu.
- Summary and Code navigation retains the selected commit. Commit scope shows the disabled-comment explanation, and clicking its gutter creates no draft.
- A failed first file read shows an error and **Retry** while the picker remains usable. Returning to All commits restores both files. An omitted files field shows **0 files** and **This commit has no file changes.**
- Refreshing an empty commit roster returns an obsolete selection to the whole PR and hides the picker. A four-second earlier-commit response does not replace a newer selection.
- The normal 1100×780 window retains the sidebar, chat, bottom composer, compact header, and readable Code toolbar.

The native observation record is `/tmp/bot-pr-code-native-20261009/evidence/01-commit-picker.txt`. Screenshots were captured through native computer use in the conversation. The baseline now describes the picker and removes it from the matching omission sentence.
