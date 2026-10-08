# Smaller gaps verification

## Baseline

The pre-change Tauri bundle was built and launched from `/tmp/bot-smaller-gaps-native/Bot Code.app`, with a disposable repository and `BOT_CODE_DATA_DIR=/tmp/bot-smaller-gaps-native/data`. Native observations confirmed the limits-only Usage page and the PR Code toolbar without commit selection or Viewed controls. The observation index and screenshots are under `/tmp/bot-smaller-gaps-native/evidence/index.json`.

## Usage history: native verification pending

Implemented behavior includes external Codex transcript discovery, disjoint token categories, duplicate and copied-prefix suppression, archived sessions, 90-day retained scan records, local calendar periods, unknown-model coverage, and cached API-price estimates with source and content fingerprint. History is owned separately from the live provider actor. Preferences use the existing native UI storage, scoped to `BOT_CODE_DATA_DIR`.

Checks completed:

- `pnpm test:ui`: all 464 tests pass, including the five new history tests. Log: `/tmp/bot-smaller-gaps-usage-ui.log`.
- `cargo test -p bot-core usage_history --lib`: all 15 history tests pass. Log: `/tmp/bot-smaller-gaps-usage-core.log`.
- `cargo test -p bot-core`: the full core suite passes. Log: `/tmp/bot-smaller-gaps-usage-core-full.log`.
- A Tauri debug app bundle builds with verification identifier `dev.bot.code.gapsverify`. Log: `/tmp/bot-smaller-gaps-usage-build.log`.
- `pnpm format:check`, `cargo fmt --check`, and `cargo clippy --workspace --all-targets --locked -- -D warnings` pass with the repository's Rust 1.93 toolchain. Logs: `/tmp/bot-usage-pr-format.log`, `/tmp/bot-smaller-gaps-usage-format.log`, and `/tmp/bot-usage-pr-clippy.log`.
- An independent read-only review found no actionable correctness defect. Report: `/tmp/bot-smaller-gaps-design/usage-review.md`.
- Comment review removed one redundant comment and renamed the local-date helper to express its meaning. Report: `/tmp/bot-smaller-gaps-design/usage-comments.md`.

`scripts/smaller-gaps-fixture.py prepare /tmp/bot-smaller-gaps-usage-native` creates the disposable repository, isolated provider, GitHub fixture, `codex-home` and synthetic rates. Its manifest expects 3,960 processed tokens, 2,750 uncached input, 800 cached input, 50 cache creation, 360 output, 110 reasoning, $0.00865 of known-model estimates and 110 unpriced tokens. The rolling 24-hour period expects 2,860 tokens. The history session has no Bot Code conversation, so discovery exercises external usage.

The bundle was launched with this fixture's data directory and `CODEX_HOME`, but no post-change native interaction succeeded. The computer-use service repeatedly returns `Sky Computer Use native pipe startup failed`. The failure also affects global app inventory. Fresh REPL sessions, both app path and bundle identifier, and a restart of the tool-owned native helper did not restore the connection. This is a verification blocker, not a native pass. The source-backed checklist remains unchecked for this feature and implementation of the next feature has not started.

Next native checks:

1. Rebuild and copy the app into the fixture directory, then launch with its isolated environment. Stamp `fixture-rates.json`'s `fetchedAtMs` with the current milliseconds and copy it into `data/usage-model-rates.json` before each refresh to keep the fixture rates deterministic.
2. Check Limits, Tokens and Cost; all four periods; model and time breakdowns; focusable chart values; and visible unknown-model coverage against the manifest.
3. Run `scripts/smaller-gaps-fixture.py append-usage /tmp/bot-smaller-gaps-usage-native` and refresh. It adds 11,000 tokens and $0.025 of known-model estimates.
4. Restart and check preference persistence and unchanged-file cache reuse. Temporarily remove the transcript source, refresh, and verify retained partial coverage before restoring it.
5. Inspect the layout in the actual app and capture native evidence. Update `docs/ui-baseline.md` and check off Usage only after the behavior passes.

Model the Domain shaped the normalized token and report types. Sequence Verifiable Units keeps each feature behind its native check. Prove It Works keeps the unobserved Usage UI marked pending.
