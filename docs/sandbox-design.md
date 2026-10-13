# Sandbox threads design

A thread can run Codex inside a local Docker container instead of on the Mac. This document records the design those threads are built on. [Architecture](architecture.md) describes the code as it stands, under "Sandbox containers" and "Sandbox threads".

## Product decisions

- A new thread chooses where it runs, **This Mac** or **Sandbox**. A sandbox runs the Codex agent in a local Docker container with a full Linux userland. A cloud VM can become one more kind of sandbox later. Only Docker is built now.
- A sandbox thread always creates a new git worktree on the Mac from a chosen base branch, with the existing **Start from origin** switch. A sandbox has no "current checkout" option.
- Placement is fixed at creation. A Mac thread never moves into a sandbox, and a sandbox thread never moves to the Mac. Rewind and fork stay in the same sandbox.
- The container holds the authoritative working copy. The Mac worktree is a mirror that Bot Code refreshes from the container. The container never mounts the Mac worktree or the main `.git`, because host git runs commands from repository config such as `core.fsmonitor` and hooks, so a writable mount would let the container run code on the Mac.
- Writes from the Bot Code interface, such as Files edits, rewind and branch switches, go into the container and are then mirrored back. Commit runs in the container, because hooks need the container's toolchain. Push and Create PR run on the Mac, where GitHub credentials stay. **Open in editor** is hidden for sandbox threads.
- Docker Desktop must be installed and running, and the Mac must be signed in to Codex. Otherwise the Sandbox option is disabled and shows the reason. Bot Code reads Docker's memory cap and shows a note when it is low.

## Problem

Four facts make the shape non-obvious.

1. About 40 host code paths key on `ThreadSnapshot::root`. They include leases and holds, Files, Diff, search, `vcs.rs`, `checkpoints.rs` and cleanup, and they read and write that directory directly. The design must keep them working without letting a host write silently diverge from the container, because the next refresh would overwrite that write.
2. The runtime had exactly one Codex provider and one epoch. Every completion, callback route and tool scope compared against that epoch.
3. Isolation rules out mounting the worktree. The container must never run code on the Mac. Only git object transfer over the `ext::` transport crosses the boundary.
4. Docker leaves `docker exec` children running when the client dies. Process cleanup therefore has to happen inside the container.

`Checkout` and `NewCheckout` are serde JSON blobs with `#[serde(default)]`. `NewCheckout::Existing` copies a checkout to a second thread, so a sandbox belongs to a checkout, not to a thread. A checkpoint capture must persist before `turn/start`. Dynamic tools must be declared on the first `thread/start`.

## Shape

### Stored versus derived

| Fact | Where it lives | Why |
|---|---|---|
| `SandboxId`, 12 random hex digits | `Checkout::Worktree { sandbox: Some(Sandbox::Docker { id }) }` | It is the only fact Docker cannot tell us. It belongs to the checkout, so threads that share a checkout share a sandbox. |
| Container name `botcode-<instance>-<id>`, labels, Codex home `<data>/sandboxes/<id>/codex-home`, `EnvKey` | Derived from the id, the data directory and an instance hash | Nothing needs to stay in sync. The instance hash scopes every label filter, so runs with their own `BOT_CODE_DATA_DIR` never touch each other. |
| Whether the container exists, its run state and its image | Docker, through inspect and the `dev.botcode.*` labels | Docker is the authority. A SQLite copy would go stale as soon as the user quits Docker Desktop. |
| Last synced state | Git refs, `refs/botcode/sandbox/<id>/base` on the Mac and `refs/botcode/sync/base` in the container | They survive a crash and are written last. An old base only costs a redundant transfer. |
| Provider slots, handles, the mirror lock, the last pull time | Memory | All of it can be rebuilt after a restart. |

A sandbox is a field of `Checkout::Worktree`, not a new `Checkout` variant. On the Mac a sandbox checkout is a worktree, so cleanup, naming, restore, pull request discovery, leases and the removed-worktree path apply as written. A sandbox without a worktree cannot be represented. `Sandbox` is an enum, so a cloud VM can be added as another variant.

### Docker

`sandbox.rs` owns Docker and knows nothing about threads, git or Codex. Its surface is `Docker` and `Container`.

- `Docker::status` reports Docker as ready with its version and memory, not installed, or not running. It never fails, because the composer shows the result.
- `Docker::image` builds `botcode-sandbox:<version>` once. The version hashes the embedded Dockerfile, the in-image scripts and the host Codex version. Codex in the container therefore speaks the host's protocol, and the model and mode catalogs stay valid across agents.
- `Container::converge` takes a desired state, `Running`, `Paused`, `Stopped` or `Removed`. A pure `plan(current, desired)` covers every pair, and a per-sandbox lock serializes inspect and act. Running it twice does nothing the second time, and a crash between steps plans again from what Docker reports.
- `docker exec` runs through an in-image wrapper. With a lifeline, the wrapper kills the command's process group when the client's stdin closes, so a host-side timeout or kill is real inside the container.

Startup repair is the pure `reconcile_plan(observed, referenced)`. A referenced container that is running or paused is pulled and stopped, because the app crashed or quit without stopping it. A container that no checkout references is removed. A stale image is left for the next `ready`, which pulls before it recreates.

### Providers per execution environment

`runtime/providers.rs` keeps one app-server slot per execution environment. `EnvKey` is `Mac` or `Sandbox(id)` and derives from the checkout. A slot is Idle, Launching or Live, and the type allows no other combination.

One global epoch counter serves every slot, so no two slots hold the same epoch. A signal names its slot by its epoch alone, the existing epoch checks keep their meaning of "the same live process", and route, scope and completion epochs are unchanged. Frames are scoped to their environment. A frame from a sandbox agent can address only the threads of that sandbox, and rate-limit updates from sandbox agents are ignored.

Restart backoff is per slot, so a failing sandbox never delays Mac threads. Losing one slot expires callbacks, leases and active turns only for that slot's threads. A planned stop retires the epoch first, so the following exit neither counts toward backoff nor marks threads with a loss headline.

`Launcher` is the one place an agent starts. The Mac arm runs `codex app-server` as before. The sandbox arm reads the Mac's Codex credentials first and fails with "Sign in to Codex on this Mac first." before any Docker work. It then readies the container, starts the in-image `agent` script over `docker exec`, initializes, signs the agent in and discovers its modes.

### Token broker

`codex/auth.rs` reads the host `auth.json` into typed credentials whose secrets are redacted. A sandbox agent signs in with `account/login/start` and the ChatGPT access token or API key. When a sandbox agent asks for a refresh, the live Mac agent refreshes through `account/read { refreshToken: true }`, or a throwaway host app-server does when the Mac agent is not running, and the broker reads the file again. The host Codex stays the only refresher, and no token is written into a sandbox's Codex home. A refresh whose previous account differs from the host's current account is refused, so a Mac account switch never leaks into a running sandbox.

### Mirror sync

`mirror.rs` is the single writer of the mirror worktree, its HEAD and index, and the sync refs. Each operation holds the mirror's own lock. There is no lock across sandboxes and no owner involvement.

A sync point is one git commit with the same shape on both sides. Its tree is the worktree snapshot, its parents are HEAD and an index commit, and its message names the HEAD ref.

- **Pull** brings the container's state to the Mac. The container captures through one exec without `--renormalize`, using a private index copied from the real one, so tracked but ignored files are included. An `ext::` fetch follows, then the host applies the tree, the index and HEAD. The fetch runs with object checks and HFS and NTFS path protection, and the tree is validated before anything touches the Mac. A pull is a no-op while the container is not running, because every transition away from Running pulls first.
- **A write session** pulls exactly, then holds the lock. Finishing it pushes from the Mac to the container as a fast-forward. The container applies it with a two-way `read-tree -m -u`, which refuses when the container drifted or when untracked or ignored files block it. A commit pushes, runs `git commit` in the container, then pulls.
- **Seed** bundles the mirror's HEAD, copies it into the container, clones it, copies the git identity and pushes the mirror's uncommitted state. A marker makes it idempotent.

A turn keeps the Mac ordering with the mirror added. It accepts the turn and takes the lease, pulls exactly, captures the checkpoint on the mirror, persists it, copies attachments in and sends `turn/start`. The exact pull holds the mirror lock through the capture, so a UI read cannot rewrite the mirror under it. On completion it pulls, captures again and releases the lease. Rewind restores on the mirror inside a write session, and a push refusal fails the existing RestoringFiles phase, so Retry revert works unchanged.

The mutating host functions take a `WriteRoot`, which only a write session or a Mac checkout can produce. A future mutation that forgets the push does not compile.

### Path mapping

`AgentPaths` derives from the workdir.

| Direction | Mac | Sandbox |
|---|---|---|
| Working directory for thread start, resume and fork | The mirror root | `/workspace` |
| Attachments in the prompt note and `localImage` | `<data>/attachments/<hash>.<ext>` | `/botcode/attachments/<name>`, copied in before the turn |
| Paths the agent names in image views and chat links | As before | `/workspace/<rel>` and relative paths map to the mirror. Other absolute paths stay in the container. |

Inbound mapping is partial on purpose. A path a sandbox agent names is never resolved on the Mac. An image view outside `/workspace` is fetched out of the container with a size cap, and a chat link to it is refused.

### Every host versus sandbox branch

1. `App::create_thread` has the `NewCheckout::Sandbox` arm.
2. `Owner::workdir` is the only match from checkout to location. Everything below dispatches on `Workdir` or `EnvKey`.
3. `Workdir` operations, such as sync, write, commit and agent paths, are a no-op or the identity on the Mac.
4. `EnvKey` and `Launcher` route and start agents.
5. Tool registration forces dynamic tools for a sandbox and leaves out the host preview backend.
6. Background source-control refresh skips sandbox checkouts, because a Mac-side fast-forward would bypass the write session.

The renderer reads `checkout.sandbox` for the composer's Run on choice, the sidebar indicator, and hiding Open in.

`Workdir::terminal` picks a terminal's launch, so the terminal module dispatches on `Launch` and never on the checkout.

## Tradeoffs accepted

- A UI write, commit or checkpoint costs 200 to 300 ms of sync. In exchange, `repo.rs`, `checkpoints.rs` and most of `vcs.rs` run unchanged on the mirror with every safety check intact.
- Checkpoints use the full host capture with `--renormalize`, the same cost as a Mac worktree. In exchange, the Diff panel, checkpoint refs and restore keep one implementation.
- Ignored files such as `node_modules` and build output never reach the Mac, so Files and search show only what git tracks or would track. This also keeps sync fast and the mirror safe.
- A pull overwrites edits made to the mirror outside Bot Code. The container is authoritative, and Open in editor is hidden.
- A write refuses rather than merges when the container changed the same path between pull and push. The window is short, and most writes already run under a hold that excludes turns.
- A field on `Worktree` instead of a new variant means code that ignores the field treats a sandbox as a worktree. The `WriteRoot` type keeps that from becoming a silent bug for mutations.
- One global epoch counter couples the slots. It is what lets the existing epoch checks stay one-line edits.
- Codex's own sandbox cannot create namespaces under Docker's default seccomp profile, so a sandbox thread sends `danger-full-access` and keeps the permission mode's approval policy. The container is the boundary.

## Alternatives considered

- **Container-first execution.** Every mutation would run in the container and only reads would use the mirror. This lost because restore and file writes rely on host filesystem probes for identity, symlinks and containment. Each would need a second implementation, and the two would drift.
- **A new `Checkout::Sandbox` variant.** The compiler would force a decision at each site, but every worktree behavior would be duplicated for something that is a worktree on the Mac.
- **One provider per thread.** Threads created with `NewCheckout::Existing` share a checkout, and two agents writing one `/workspace` would race. Keying by sandbox matches what is actually shared.
- **Sandbox state in a SQLite table.** It would duplicate what Docker labels and inspect answer, and every Docker Desktop restart would make it wrong.
- **The worktree folder name as the sandbox id.** It removes one identifier but couples the sandbox to worktree naming and to restore recreating the same path.

## Open questions and risks

- Does `account/read { refreshToken: true }` force a refresh when the host thinks its token is still valid? If not, a sandbox 401 could loop on the same token. A host that keeps credentials in the keychain has no `auth.json`.
- When the agent switches the container to a branch that a Mac worktree has checked out, the mirror detaches and shows a diagnostic. Should commit and push refuse instead?
- Should the container repository have an `origin` URL without credentials, so `git fetch` works for public repositories?
- Commit signing and other host-only git config do not apply in the container.
- Should usage history also read `<data>/sandboxes/*/codex-home/sessions`?
- Line-ending and LFS filters run on both sides with different config. A repository with `.gitattributes` eol rules could show spurious diffs.
- The first image build takes minutes and needs the network. An offline first sandbox fails.

## Slices

Each slice ends verified in the real Tauri app.

1. **Done.** The domain field and variant, `sandbox.rs` and `reconcile_plan`, tested against real Docker: status, image build, every `plan` pair, converge idempotence, labels and instance scoping, and lifeline cleanup.
2. **Done.** `workdir.rs`, `mirror.rs`, `providers.rs`, `codex/auth.rs`, the agent process and the `WriteRoot` signatures, then the composer's Run on choice and `App::sandbox_availability`. Worktree setup runs in the container. Shutdown stops every agent and then stops every running sandbox, which pulls first.
3. **Done.** The terminal runs `bash -l` inside the container through `docker exec --tty` and the in-image `terminal` script, which records each shell so Bot Code stops its whole session when the client ends. Labels come from one `ps` exec per watched container, and a prompt mark from the shell pulls the mirror after each command. Project scripts run there with container paths.
4. A Desktop tab shows noVNC on a published loopback port. Preview reaches the container's dev server, and agent browser tools run in the container.
5. Idle sandboxes pause after about 10 minutes and stop after about 2 hours. Settle and archive stop the container. Cleanup and delete do a final sync and remove it, and delete also removes the sandbox's Codex home. The next message after removal recreates the container from the Mac worktree and the kept Codex home.
