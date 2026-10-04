# PR review fixture protocol

The core integration fixture is `crates/z1-core/tests/support/reviews_peer.py`. Install it as an executable and set `Z1_GH_BIN` to its path. It reads `reviews.json` beside itself and appends every argument vector to `reviews-calls.jsonl`. Use a disposable Git repository with at least one commit and an isolated `Z1_DATA_DIR`. Native verification must exercise the Tauri build, not mocked IPC.

A default control file is `{}`. Optional `head` sets the remote PR SHA and `body` changes the first inline finding's text. Optional `mode` accepts `ready`, `empty`, `no-pr`, `unauthenticated`, `failed`, `page-failure`, `repeated-cursor`, `conflicting-duplicate`, `graphql-errors`, `null-node`, `moving-head`, `checkout-change`, `unsupported-host`, `oversized`, or `slow`. The default ready fixture returns six findings, including two inline threads, two review summaries and two conversation comments, across outer and nested pages. The second thread is resolved and outdated. The inline original commit is `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`, the summary commit is `cccccccccccccccccccccccccccccccccccccccc`, and conversation source context is absent. The default PR head is `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` and differs from checkout HEAD.

The fetch first invokes `gh pr list --head <actual-branch> --state open --limit 20 --json number,title,url,baseRefName,headRefName,isCrossRepository,id,headRefOid`. The JSON array rows contain immutable `id`, `headRefOid`, the actual `headRefName`, `number`, `title`, `url`, and `isCrossRepository`. No open PR returns `[]`.

GraphQL calls are `gh api graphql -f query=<named-query> -f id=<node-id>`, with optional `-f cursor=<cursor>`. Query operations and response connections are:

| Operation | Node | Connection |
|---|---|---|
| ReviewsThreads | PullRequest | reviewThreads |
| ReviewReplies | PullRequestReviewThread | comments |
| ReviewSummaries | PullRequest | reviews |
| ReviewConversation | PullRequest | comments |
| ReviewHead | PullRequest | id and headRefOid |

Connections return `{ "nodes": [...], "pageInfo": { "hasNextPage": false, "endCursor": null } }` inside `{ "data": { "node": { "<connection>": ... } } }`. Each inline thread has `id`, `isResolved`, `isOutdated`, and its own comments connection. All comment/review nodes have `id`, `body`, `url`, nullable `author` with `login`, `createdAt`, and `updatedAt`. Inline comments additionally have nullable `originalCommit` with `oid`, nullable `diffHunk`, nullable `path`, and nullable `originalLine`. Summary nodes have nullable `commit` with `oid`. Conversation nodes have no reviewed source. ReviewHead returns `{ "data": { "node": { "id": "PR_fixture", "headRefOid": "<40 hex characters>" } } }`.

The fixture uses PR ID `PR_fixture` and number 7. GitHub node IDs are global within github.com, so there is no endpoint-number fallback. Exit code 4 means signed out. GraphQL `errors` or a null data/node abort the complete fetch.

For a restart check, dismiss a finding with a reason, close the app, and reopen with the same state directory. Change `body` and refresh to see content staleness. Change `head` and refresh to see head staleness. Enter draft text first, then Ask Codex. Confirm that the text remains at the beginning and the composer receives focus. Verify no new Codex request until explicit send. Select a thread without a project and verify Reviews is absent. Repeat at a narrow native window width.
