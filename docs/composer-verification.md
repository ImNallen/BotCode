# Composer wave 2 verification

Verified on macOS on 2026-10-08 against T3 Code tag `v0.0.45`. Composer chips had already landed before this work began.

## Native setup

Built an actual debug Tauri application named **Bot Code Composer W2**, with a separate bundle identifier. Launched its binary with `BOT_CODE_DATA_DIR=/tmp/botcode-composer-w2/native/data` and selected the disposable Git repository at `/tmp/botcode-composer-w2/native/repository`. Normal application data was not used. Native input, file pickers, TextEdit clipboard operations, and window inspection used CUA.

The provider ran the installed Codex through a transparent JSONL proxy. The proxy recorded turn inputs and completed items, excluding account responses. Tests instructed the agent to read attachment fixtures without changing repository files.

## Results

| Behavior           | Native result                                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt history     | ArrowUp recalled the newest prompt, then older prompts from the first visual line. ArrowUp at the end of a wrapped prompt stayed within that prompt. ArrowDown advanced and cleared after the newest.                                                |
| Complete stash     | Command+S saved surrounding text and two mention chips. Restore retained their backing records and reminted identities. A file attachment also survived stash and restore.                                                                           |
| Stash picker       | Multiple entries supported keyboard selection. Restoring into another thread appended to its nonempty draft. The destination retained its settings.                                                                                                  |
| Keyboard ownership | With the stash open, terminal Enter executed a shell command and Command+Backspace cleared terminal input. Command-palette navigation retained its own keys. Neither changed the stash.                                                              |
| Generic attachment | The native picker attached `agent-readable.txt`. Codex read it with a shell command and returned `Composer attachment sentinel: cobalt-river-842.`                                                                                                   |
| Large paste        | An exact 32,768-byte UTF-8 clipboard became `pasted-text.txt`. Codex read its first line and returned `PASTE-SENTINEL amber-oak-715`.                                                                                                                |
| Editable paste     | Command+Shift+V inserted the same 32,768 bytes as editable text, with no attachment or chip. The following ordinary Command+V folded that clipboard again.                                                                                           |
| HEIC               | The picker accepted a real HEIC fixture and displayed `photo.jpg`. Stored bytes had JPEG magic. Codex received the converted image and acknowledged it.                                                                                              |
| Size limit         | A 50 MiB + 1 byte text file produced `'too-large.txt' exceeds the 50 MB attachment limit.`                                                                                                                                                           |
| Count limit        | Selecting 101 distinct files staged exactly 100 and showed `You can attach up to 100 files per message.`                                                                                                                                             |
| Restart and sweep  | A stash-only generic file and a draft-only JPEG aged beyond 24 hours survived restart. An old unreferenced generic file and incomplete upload were removed. Restored references remained readable.                                                   |
| Layout             | The actual Tauri window retained the conversation sidebar, centered chat, bottom composer, compact header, optional tools panel, and neutral colors.                                                                                                 |
| Sidebar OS drop    | Pending manual confirmation. CUA's native drag control selected the destination instead of dragging; the same failure occurred when dragging a disposable file into a Finder folder. Automated tests cover destination routing and draft activation. |

Protocol inspection confirmed T3's exact absolute-path notes for attached files, pasted text, and images. Generic and pasted-text files were absent from `localImage` inputs. The HEIC conversion was present as both an image note and a `localImage` path. All paths resolved inside the isolated attachment directory, and stored bytes matched the fixtures.

Native history testing exposed a WKWebView DOM selection range that described the paragraph rather than the caret after prompt replacement. The editor now measures the ProseMirror document selection with `coordsAtPos`. Native editable-paste testing also established that Command+Shift+V has no WKWebView paste event; a text-only native clipboard command supplies that operation, guarded against changed drafts, thread switches, and lost focus.

## Automated checks

The final UI run passed 384 tests, and the complete core retry passed 393 tests. The production build, `cargo fmt --check`, and `cargo clippy --workspace --all-targets -- -D warnings` passed. One initial core attempt failed in the existing skill-discovery timeout fixture before its subprocess wrote a PID file; both attempts remain in the evidence directory.

Tests cover mixed attachment limits, UTF-8 thresholds, rich clipboard preservation, chip capacity, failed durable stash writes, draft publication ordering, stale staging, file handoff for start and steer, legacy image receipt serialization, and attachment retention across turns, steering, rewind, drafts, and stash entries. Malformed recognized saved owners prevent sweeping until references can be checked.

The local evidence directory is `/tmp/botcode-composer-w2/evidence`. It contains required-check logs, native payload summaries, saved draft/stash comparisons, restart references, and the independent review. The decision trail is `/tmp/botcode-composer-w2/decisions.tsv`.
