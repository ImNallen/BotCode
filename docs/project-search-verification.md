# Project search verification

Measured on 2026-10-07 in the delivered working tree. The fixture contains 50,000 generated text files in 500 directories, plus README.md and .gitignore. Those 50,002 searchable files contain 3,312,354 bytes. Two ignored sentinels are outside search coverage. The rare target is shard-499/file-099.txt at one-based line 321.

The release example exercises actual `App` methods with a new isolated data directory for each of five iterations. Cold means a new in-process index. OS filesystem caches were not flushed; the first complete content read was slower and remains in the reported range. Timings include awaiting the runtime request and validating its results. They exclude Tauri IPC, React rendering and the frontend's 100 ms path / 180 ms content debounce.

| Request | Median, ms | Range over five runs, ms |
| --- | ---: | ---: |
| Cold workspace inventory | 105.620 | 104.608 to 269.832 |
| Serialize complete workspace view | 3.191 | 3.134 to 3.304 |
| Warm picker, 200 rows | 3.739 | 3.602 to 3.742 |
| Warm mentions, 50 rows | 3.637 | 3.555 to 3.870 |
| Complete absent-string scan | 1150.269 | 1146.297 to 2863.679 |
| Complete tail-file match, line 321 | 1098.619 | 1083.059 to 1153.723 |
| Common string, 500 matching lines | 68.540 | 20.606 to 77.232 |

Every cold and warm path request verified all 50,002 indexed files and complete index coverage. Picker and mention queries shared generation 1. Every absent and tail query searched all 50,002 files with zero skips; every tail query returned the expected file and line. Every common query returned 500 rows after searching 502 files and explicitly reported limited coverage. No request failed. Content request timings include any refresh required by the two-second snapshot interval, including the common query.

The complete workspace JSON payload was 6,200,286 bytes because the fixture also has 50,000 untracked Git changes. The benchmark process reached 47,136,768 bytes maximum resident memory, about 45 MiB; this excludes the native webview. The machine was an Apple M4 Max with 16 logical CPUs and 128 GiB RAM, macOS 27.0.1 and Rust 1.93.0. Load averages before measurement were 6.91, 8.42 and 10.41. Other applications stayed running.

A separate, unreported run was sampled for two seconds. Its active content worker spent most sampled work in filesystem operations, including open, read and metadata/canonical-path checks. The timed process spent 11.17 seconds in system CPU time versus 1.62 in user CPU time across all five iterations. The evidence points to per-file filesystem work as the content-scan limiter on this tiny-file fixture. These are absolute measurements, with no comparative speedup claim. Larger or slower inputs can reach the declared scan limits.

Repeat the measurement after creating an equivalent disposable repository:

```sh
CARGO_TARGET_DIR=/tmp/botcode-project-search/release-target cargo build -p bot-core --release --example project_search_bench
/tmp/botcode-project-search/release-target/release/examples/project_search_bench /tmp/botcode-project-search/repository
```

The retained fixture generator is `/tmp/botcode-project-search/create-fixture.py`. Raw timings, per-request counts, process statistics, machine state and profiler output are in `/tmp/botcode-project-search/evidence/benchmark.tsv`, `benchmark-summary.json`, `benchmark-process-stats.txt`, `benchmark-machine.txt` and `search-profile.txt`. The reusable Rust example asserts the fixture's count, ignore exclusions, complete tail coverage and result cap within its timed requests.

All required root checks passed. `pnpm test:ui` passed 288 tests, `pnpm build` passed, `cargo fmt --check` passed, `cargo clippy --workspace --all-targets -- -D warnings` passed and the full default-parallel `cargo test -p bot-core` passed 333 tests. The final diagnostic-free source also built as a Tauri app bundle. Root logs are retained under `/tmp/botcode-project-search/evidence/root-*.log` and `tauri-build-production.log`.

Native acceptance passed in the actual Tauri app using `BOT_CODE_DATA_DIR=/tmp/botcode-project-search/data`, the disposable repository, and a scripted provider peer. Command+P found and opened the tail file; Command+Shift+F found its sentinel and selected and revealed line 321. The same tab then revealed lines 499, 2 and 321. Selecting line 321 again after manually scrolling to the top revealed it again. Ignored path and content sentinels were absent. Mentions inserted the same canonical path, and both palette actions opened their working dialogs.

Case, Unicode whole-word and regex options returned the expected rows in a separate small worktree, and an invalid regex showed an error. The common query reported its 500-line cap; replacing it and pressing Enter while pending opened no stale row. Worktree paths stayed separate from the main checkout. Refresh found an externally added nested file, then excluded it after an ignore edit. An external edit to an already-open file moved its matching line from 3 to 4; opening the new hit displayed the new contents and selected line 4. Both dialogs fit at 1000×620 with the right panel open. Restarting the isolated production app still found and revealed line 321. No provider `turn/start` request was sent.

Native checks first found a Pierre prepared-layout error. The correction preserves the file object while its path and contents are equal; the installed renderer checks object identity. A subsequent intermediate run stayed at line 1 without an established cause. Temporary diagnostics and all final diagnostic-free repeated-navigation checks passed; no second production fix was added. This observation remains in the audit trail rather than being presented as a diagnosed lifecycle bug. Native AX and screenshot evidence is in the task transcript; the observation record is `/tmp/botcode-project-search/evidence/native-verification.md`, and decisions are in `/tmp/botcode-project-search/decisions.tsv`.

The runtime policy caps indexing at 250,000 paths, 64 MiB estimated path memory or 15 seconds. Two blocking workers serve search. Content scans stop at five seconds, 256 MiB read, 500 matching lines, 100 per file or 2 MiB response data. Files above the viewer's 1,000,000-byte limit, binary data, invalid UTF-8 and unreadable entries are skipped. Deadlines are cooperative around filesystem operations. The dialogs report limited coverage and skips. The fixture proves responsiveness for roughly 50k small files; it does not establish complete coverage for every repository size or file distribution.
