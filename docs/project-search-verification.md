# Project search verification

Measured on 2026-10-07 on the integrated search source at feature commit `796cb9b`, after main added typed context chips. The fixture contains 50,000 generated text files in 500 directories, plus README.md and .gitignore. Those 50,002 searchable files contain 3,312,354 bytes. Two ignored sentinels are outside search coverage. The rare target is shard-499/file-099.txt at one-based line 321.

The release example exercises actual `App` methods with a new isolated data directory for each of five iterations. Cold means a new in-process index. OS filesystem caches were not flushed; the first complete content read was slower and remains in the reported range. Timings include awaiting the runtime request and validating its results. They exclude Tauri IPC, React rendering and the frontend's 100 ms path / 180 ms content debounce.

| Request | Median, ms | Range over five runs, ms |
| --- | ---: | ---: |
| Cold workspace inventory | 108.061 | 106.730 to 118.814 |
| Serialize complete workspace view | 3.128 | 3.075 to 3.164 |
| Warm picker, 200 rows | 3.708 | 3.638 to 3.723 |
| Warm mentions, 50 rows | 3.564 | 3.418 to 3.606 |
| Complete absent-string scan | 1169.042 | 1166.395 to 1219.962 |
| Complete tail-file match, line 321 | 1131.597 | 1109.188 to 1161.057 |
| Common string, 500 matching lines | 69.741 | 69.148 to 71.346 |

Every cold and warm path request verified all 50,002 indexed files and complete index coverage. Picker and mention queries shared generation 1. Every absent and tail query searched all 50,002 files with zero skips; every tail query returned the expected file and line. Every common query returned 500 rows after searching 502 files and explicitly reported limited coverage. No request failed. Content request timings include any refresh required by the two-second snapshot interval, including the common query.

The complete workspace JSON payload was 6,200,286 bytes because the fixture also has 50,000 untracked Git changes. The benchmark process reached 51,134,464 bytes maximum resident memory, about 49 MiB; this excludes the native webview. The machine was an Apple M4 Max with 16 logical CPUs and 128 GiB RAM, macOS 27.0.1 and Rust 1.93.0. Load averages before measurement were 4.03, 4.06 and 4.20. Other applications stayed running.

A separate run before integration was sampled for two seconds. Its active content worker spent most sampled work in filesystem operations, including open, read and metadata/canonical-path checks. The search engine is unchanged by integration. The fresh timed process spent 10.95 seconds in system CPU time versus 1.62 in user CPU time across all five iterations. Together, these observations suggest per-file filesystem work limits the content scan on this tiny-file fixture. These are absolute measurements, with no comparative speedup claim. Larger or slower inputs can reach the declared scan limits.

Repeat the measurement after creating an equivalent disposable repository:

```sh
CARGO_TARGET_DIR=/tmp/botcode-project-search/release-target cargo build -p bot-core --release --example project_search_bench
/tmp/botcode-project-search/release-target/release/examples/project_search_bench /tmp/botcode-project-search/repository
```

The retained fixture generator is `/tmp/botcode-project-search/create-fixture.py`. Fresh timings, per-request counts, process statistics and machine state are in `/tmp/botcode-project-search/evidence/pr-context-benchmark.tsv`, `pr-context-benchmark-summary.json`, `pr-context-benchmark-process-stats.txt` and `pr-context-benchmark-machine.txt`. The earlier profiler output is `search-profile.txt` in that directory. The reusable Rust example asserts the fixture's count, ignore exclusions, complete tail coverage and result cap within its timed requests.

All required checks passed after integration. `pnpm test:ui` passed 356 tests, `pnpm build` passed, `cargo fmt --all --check` passed, `cargo clippy --workspace --all-targets --locked -- -D warnings` passed and the full default-parallel `cargo test -p bot-core --locked` passed 381 tests. `pnpm typecheck` and `pnpm format:check` also passed. The same diagnostic-free source built as a Tauri app bundle. Logs are retained under `/tmp/botcode-project-search/evidence/pr-context-{ui,build,cargo-fmt,clippy,core,typecheck,format}.log` and `pr-context-tauri-build.log`.

Native acceptance before integration passed in the actual Tauri app using `BOT_CODE_DATA_DIR=/tmp/botcode-project-search/data`, the disposable repository, and a scripted provider peer. Command+P found and opened the tail file; Command+Shift+F found its sentinel and selected and revealed line 321. The same tab then revealed lines 499, 2 and 321. Selecting line 321 again after manually scrolling to the top revealed it again. Ignored path and content sentinels were absent. Mentions inserted the same canonical path, and both palette actions opened their working dialogs.

Case, Unicode whole-word and regex options returned the expected rows in a separate small worktree, and an invalid regex showed an error. The common query reported its 500-line cap; replacing it and pressing Enter while pending opened no stale row. Worktree paths stayed separate from the main checkout. Refresh found an externally added nested file, then excluded it after an ignore edit. An external edit to an already-open file moved its matching line from 3 to 4; opening the new hit displayed the new contents and selected line 4. Both dialogs fit at 1000×620 with the right panel open. Restarting the isolated production app still found and revealed line 321. No provider `turn/start` request was sent.

The fresh app bundle at `6ccf12b` repeated picker opening, content navigation to line 321 and selection of that line after manual scrolling. The existing editable Files view retained its editor-launch controls. In the small worktree, editing through the mounted editor autosaved a new sentinel at line 9; content search found it and opened the same tab with line 9 highlighted. An external edit then moved the sentinel to line 10. A new search opened the updated contents and highlighted line 10 in that existing tab. This run used the same isolated data directory and sent no provider `turn/start` request. The native record is `/tmp/botcode-project-search/evidence/pr-native-verification.md`.

After integrating main's typed context chips, the final native bundle repeated picker opening and content navigation to line 321. Two `@` selections inserted resolved mention chips for README.md and shard-499/file-099.txt beside surrounding draft text. Opening both dialogs, selecting a result, and dismissing each while an `@` lookup was pending retained both chips, the text and composer focus. Native SQLite storage contained both exact typed paths and the surrounding unsent draft. No provider turn was sent. The final native record is `/tmp/botcode-project-search/evidence/pr-context-native-verification.md`; the saved draft is `pr-context-native-draft.json` in that directory.

An independent final overlap probe used the installed ProseMirror document code. It verified that inserting a mention preserves existing terminal, skill, PR and mention records and surrounding text; removing a slash command preserves those records; changing query, checkout or trigger immediately rejects stale path results. The final review is `/tmp/botcode-project-search/pr-context-overlap-review.md`.

The integration regression also exercises successful saves and ignore edits through public App methods. An independent overlap review found no blocker and checked the installed editor and query libraries. Two retained policy risks remain: autosave invalidates indexes globally, so unrelated active searches can restart; completed results keep their snapshot line numbers until the query, Refresh or focus changes. The next request sees the invalidated index. The review record is `/tmp/botcode-project-search/pr-overlap-review.md`.

Native checks first found a Pierre prepared-layout error. The correction preserves the file object while its path and contents are equal; the installed renderer checks object identity. A subsequent intermediate run stayed at line 1 without an established cause. Temporary diagnostics and all final diagnostic-free repeated-navigation checks passed; no second production fix was added. This observation remains in the audit trail rather than being presented as a diagnosed lifecycle bug. Native AX and screenshot evidence is in the task transcript; the observation record is `/tmp/botcode-project-search/evidence/native-verification.md`, and decisions are in `/tmp/botcode-project-search/decisions.tsv`.

The runtime policy caps indexing at 250,000 paths, 64 MiB estimated path memory or 15 seconds. Two blocking workers serve search. Content scans stop at five seconds, 256 MiB read, 500 matching lines, 100 per file or 2 MiB response data. Files above the viewer's 1,000,000-byte limit, binary data, invalid UTF-8 and unreadable entries are skipped. Deadlines are cooperative around filesystem operations. The dialogs report limited coverage and skips. The fixture proves responsiveness for roughly 50k small files; it does not establish complete coverage for every repository size or file distribution.
