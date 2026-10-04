# First-slice architecture

The selected design uses one Rust runtime owner and one lazily started Codex app-server. The Tauri adapter validates IPC values through serde and forwards the core's public operations. The React renderer uses TanStack Query snapshots and committed invalidation hints. TanStack Router owns the selected repository and conversation. The right panel keeps its open tabs in component state for the current repository.

## Ownership

`runtime.rs` owns conversation transitions, canonical checkout leases, approval callback routes, and the single SQLite writer. Its loop processes commands, provider notifications, asynchronous request completions, and a streaming commit timer. Provider requests run outside that loop. The private Codex transport owns its request-correlation map and serialized JSONL writes.

`store.rs` stores workspaces, thread snapshots, and operation receipts. WAL and short transactions preserve the local intent and receipt together. A file lock excludes a second runtime using the same state directory. The snapshot format replaces the proposed normalized item tables for this bounded slice. Renderer UI state, such as preferences and panel widths, lives in the `ui_state` key-value table instead of WebView storage.

`repo.rs` validates Git roots and canonical path containment. It excludes `.git` reads and external symlinks. File and historical blob reads have a 1 MB text limit. Git arguments do not pass through a shell. Repository inspection runs outside the conversation owner. Refresh is explicit, on focus, and after turn completion.

`codex.rs` starts the installed binary, initializes app-server, correlates responses, and forwards notifications and reverse requests. Transport framing and writes are bounded. The child uses a separate Unix process group. Shutdown signals the group, reaps the provider leader, and kills remaining group members. Unsupported reverse requests receive an explicit protocol error.

## Checkouts

Each thread records a `Checkout`. A local thread runs in the repository's own checkout. A worktree thread runs in a Git worktree on a fresh `z1code/<id>` branch, under `<data dir>/worktrees/<repository>/z1code-<id>`. The draft's `NewCheckout` names the base branch. With `fromOrigin` and an `origin` remote, the runtime fetches the base from origin and starts from `origin/<base>` when it exists, else from the local base. A failed fetch fails the creation. The renderer sets `fromOrigin` only when origin has remote-tracking refs and the base is a local branch, which is when the picker reads "From origin/{base}". The runtime creates the worktree outside the owner loop when the thread is created, which happens on the first send. A repository without commits cannot start one.

`ThreadSnapshot::root` resolves the directory a thread runs in. The Codex `cwd`, the checkout lease, and the workspace view, file and diff reads all go through it. Leases are keyed by that root, so a worktree thread never waits on the local checkout or another worktree. Two local threads still exclude each other. `switch_branch` changes the branch of the checkout a thread resolves to. The owner rejects it with `checkout_busy` while that checkout's lease is held and holds submits back until it finishes. A worktree thread's stored branch follows the switch. The renderer scopes workspace, file, diff and branch queries by `CheckoutRef`. Local threads share the repository-scoped cache entry. Worktrees are not removed yet.

## Durable conversation behavior

A submit carries a caller operation ID. The owner validates the prompt and checkout lease, then commits the local turn and receipt together. Reusing the same ID and input returns the original turn. Reusing the ID for different input fails.

Preparing, Sending, Accepted, NotSent, and Uncertain are distinct delivery states. Execution has separate NotStarted, Running, Completed, Interrupted, Failed, and Lost states. The native thread ID commits before a turn is dispatched. Native started/completed notifications can establish acceptance even if the start response is lost. A stale response error cannot undo confirmed completion or stop a newer turn.

Streaming updates accumulate in the owner and commit about every 90 milliseconds. A queried snapshot flushes pending changes before returning. Completed native items replace accumulated partial content by item ID. Commit precedes every invalidation hint. The renderer batches thread invalidations and refreshes authoritative snapshots instead of replaying a frontend event log. Every query-cache write preserves a newer revision. Terminal hints refresh their workspace and file/diff queries even when that conversation is hidden; streamed tokens do not repeatedly run Git inspection.

Approval callbacks map an application approval ID to the reverse JSON-RPC request ID, provider epoch, and item ID. Missing action details prevent acceptance. Later file-change items can supply those details. Clone-save-install transitions preserve the pending callback and running state when an approval or interruption save fails. Repeated approval clicks cannot send the callback twice.

On provider loss, the runtime terminates managed execution, retires the epoch, expires callbacks, marks unresolved turns Lost or Uncertain, and releases checkout leases. It does not replay turn/start. Startup restores local history and marks previously live execution unresolved. Reconnect resumes the exact native thread and merges matching native turn or client-message identities when returned. Incomplete history never deletes local items or proves lost execution live.

## Reconciled design choices

Candidate A supplied the owner loop, shared provider, execution leases, and delivery model. Candidate B supplied caller operation receipts and simple snapshot invalidation. The independent review added canonical-root exclusion, revision guards, storage-failure rollback, bounded stdin writes, old-response ordering, and process-group cleanup.

Full event sourcing, generated protocol types, a frontend patch/replay framework, automatic provider restart, universal paginated history hydration, and filesystem watchers remain deferred. The current native resume is verified against installed Codex 0.160.0. A newer protocol can require changes in the private decoder.

## Verification boundary

Core tests and the real Codex smoke exercise the Tauri-independent App API. Typechecking and frontend/native builds verify package integration. The actual Tauri window passed interaction checks for folder selection, two repositories, Pierre file/diff rendering, streamed Codex output, command and file approvals, interruption, renderer reload with a live approval, and history continuation after a full application restart. These checks used disposable repositories and isolated Z1 state.
