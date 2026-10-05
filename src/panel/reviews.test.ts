import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "../test/chai.ts";
import {
  appendReviewDraft,
  dispositionState,
  reviewFinding,
  type ReviewDraftRequest,
} from "./reviews.ts";
import { ReviewDetails } from "./ReviewFinding.tsx";
import {
  prReviewDetail,
  type PrChangeResult,
  type PrReviewChange,
} from "./prReview.ts";
import {
  ConversationDrafts,
  ReviewDrafts,
  draftKey,
  reviewDrafts,
  conversationDrafts,
} from "./reviewDrafts.ts";
import { PullRequestReviewComposer } from "./PullRequestReviewComposer.tsx";
import { PullRequestTimeline } from "./PullRequestTimeline.tsx";
import type { PrSectionProblem } from "./prCoverage.ts";
import { PullRequestDetail } from "./PullRequestDetail.tsx";
const finding = reviewFinding.parse({
  observation: {
    prId: "PR_fixture",
    findingId: "THREAD_fixture",
    headSha: "a".repeat(40),
    contentDigest: "b".repeat(64),
  },
  source: { kind: "thread", resolved: true, outdated: true },
  comments: [
    {
      id: "COMMENT_fixture",
      author: "review-bot",
      body: "Check the boundary.",
      url: "https://github.com/test/repo/pull/7#comment",
      createdAt: "2026-10-04T10:00:00Z",
      updatedAt: "2026-10-04T10:00:00Z",
      context: {
        originalCommit: "c".repeat(40),
        path: "src/file.ts",
        originalLine: 1,
        diffHunk: "@@ -1 +1 @@\n-old\n+new",
      },
    },
  ],
  saved: null,
});
const request: ReviewDraftRequest = {
  workspaceId: "workspace",
  threadId: "thread",
  key: "github.com/test/repo/7",
  intent: "ask",
  problems: [],
  finding,
};
const target = {
  workspaceId: "workspace",
  threadId: "thread",
  canAccept: true,
};
const detail = prReviewDetail.parse({
  observation: {
    key: request.key,
    nodeId: "PR_fixture",
    headOid: "a".repeat(40),
    viewer: "reviewer",
  },
  snapshot: {
    nodeId: "PR_fixture",
    title: "Calculation update",
    lifecycle: { kind: "open", draft: false },
    base: "main",
    head: "feature",
    headRepository: "test/repo",
    headOid: "a".repeat(40),
    hostUpdatedAt: "2026-10-05T12:00:00Z",
  },
  body: "The remote description.",
  reviewDecision: "CHANGES_REQUESTED",
  verdicts: ["comment", "approve", "request_changes"],
  findings: [
    {
      finding,
      outcome: null,
      canReply: true,
      canResolve: true,
      canUnresolve: true,
    },
  ],
  checks: [{ name: "Unit tests", state: "FAILURE", url: null }],
  files: [],
  problems: [],
  timeline: [
    {
      at: "2026-10-04T10:00:00Z",
      event: { kind: "comment", findingId: finding.observation.findingId },
    },
  ],
});
function input(): PrReviewChange {
  return {
    requestId: "request-one",
    target: detail.observation,
    action: {
      kind: "submit_review",
      verdict: "comment",
      body: "Captured",
      comments: [],
    },
  };
}
describe("linked review draft handoff", () => {
  it("appends original evidence while preserving existing text and targeting the captured conversation", () => {
    const text = "  Existing draft\nwith spaces  \n";
    const appended = appendReviewDraft(text, request, target);
    assert.equal(appended?.slice(0, text.length), text);
    assert.isTrue(appended?.includes("c".repeat(40)));
    assert.isTrue(appended?.includes("@@ -1 +1 @@"));
    assert.isTrue(appended?.includes(request.key));
    assert.equal(
      appendReviewDraft(text, request, { ...target, threadId: "other" }),
      null,
    );
    assert.equal(
      appendReviewDraft(text, request, { ...target, canAccept: false }),
      null,
    );
  });
  it("renders original context and persisted stale local triage", () => {
    const saved = {
      observation: { ...finding.observation, headSha: "d".repeat(40) },
      choice: { kind: "dismiss", reason: "Not applicable" },
    } satisfies NonNullable<typeof finding.saved>;
    const current = { ...finding, saved };
    assert.equal(dispositionState(current), "stale");
    const html = renderToStaticMarkup(
      createElement(ReviewDetails, {
        finding: current,
        saving: false,
        disabled: false,
        saveError: undefined,
        onSave() {},
        canAskCodex: true,
        onAskCodex() {},
        onFixCodex() {},
        openUrl() {},
      }),
    );
    for (const text of [
      "resolved",
      "outdated",
      "Original reviewed commit",
      "Original review diff hunk",
      "Not applicable",
      "Stale decision",
      "You send it",
    ])
      assert.isTrue(html.includes(text));
  });
  it("renders remote summary and checks through the real query cache without checkout context", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(
      ["pr-detail", "thread", detail.observation.key],
      detail,
    );
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PullRequestDetail, {
          prKey: detail.observation.key,
          onBack() {},
          ...target,
          onAskCodex() {},
          canAskCodex: true,
        }),
      ),
    );
    assert.isTrue(html.includes("Calculation update"));
    assert.isTrue(html.includes("Unit tests"));
    assert.isTrue(html.includes("FAILURE"));
    assert.isTrue(html.includes("Summary"));
    assert.isTrue(html.includes("Timeline"));
    assert.isTrue(html.includes("Code"));
    client.clear();
  });
});
describe("session review capture", () => {
  it("retains late summary and comment edits and removes only unchanged captured revisions", () => {
    const store = new ReviewDrafts();
    const key = draftKey(detail.observation);
    store.summary(key, "Captured");
    store.add(key, { path: "one.ts", side: "RIGHT", line: 1 });
    store.add(key, { path: "two.ts", side: "LEFT", line: 2 });
    const first = store.get(key).comments[0];
    const second = store.get(key).comments[1];
    assert.isTrue(Boolean(first));
    assert.isTrue(Boolean(second));
    if (!first || !second) return;
    store.edit(key, first.id, "Original first");
    store.edit(key, second.id, "Original second");
    const captured = store.start(key, input());
    store.summary(key, "Edited");
    store.summary(key, "Captured");
    store.edit(key, first.id, "Late edit");
    store.add(key, { path: "three.ts", side: "RIGHT", line: 3 });
    store.finish(key, captured, { kind: "applied", hostId: "REVIEW_saved" });
    const after = store.get(key);
    assert.equal(after.summary.body, "Captured");
    assert.equal(after.comments.length, 2);
    assert.equal(after.comments[0]?.body, "Late edit");
    assert.isFalse(after.comments.some((c) => c.id === second.id));
  });
  it("keeps refused and uncertain drafts with original operation identity and separates head and viewer", () => {
    for (const result of [
      { kind: "refused", message: "Refused" },
      { kind: "uncertain", message: "Check GitHub" },
    ] satisfies PrChangeResult[]) {
      const store = new ReviewDrafts();
      const key = draftKey(detail.observation);
      store.summary(key, "Keep this");
      const captured = store.start(key, input());
      store.finish(key, captured, result);
      assert.equal(store.get(key).summary.body, "Keep this");
      assert.equal(store.get(key).operation?.input.requestId, "request-one");
      assert.equal(
        store.get(draftKey({ ...detail.observation, viewer: "other" })).summary
          .body,
        "",
      );
      assert.equal(
        store.older({ ...detail.observation, headOid: "b".repeat(40) }).length,
        1,
      );
    }
  });
  it("clears unchanged success even when no confirmation read is available", () => {
    const store = new ReviewDrafts();
    const key = draftKey(detail.observation);
    store.summary(key, "Captured");
    const captured = store.start(key, input());
    store.finish(key, captured, { kind: "applied", hostId: "REVIEW_saved" });
    assert.equal(store.get(key).summary.body, "");
    assert.equal(store.get(key).operation?.result?.kind, "applied");
  });
});

it("retains late reply edits and uncertain operation identity across panel remounts", () => {
  const store = new ConversationDrafts();
  const key = `${draftKey(detail.observation)}:THREAD_fixture`;
  store.edit(key, "Captured reply");
  const command = {
    ...input(),
    action: {
      kind: "reply",
      threadId: "THREAD_fixture",
      body: "Captured reply",
    },
  } satisfies PrReviewChange;
  const revision = store.start(key, command);
  store.edit(key, "Late reply");
  store.finish(key, revision, { kind: "applied", hostId: "COMMENT_saved" });
  assert.equal(store.get(key).body, "Late reply");
  const next = store.start(key, { ...command, requestId: "reply-two" });
  store.finish(key, next, { kind: "uncertain", message: "Check GitHub" });
  assert.equal(store.get(key).operation?.input.requestId, "reply-two");
  assert.equal(store.get(key).operation?.result?.kind, "uncertain");
  assert.equal(store.get(key).body, "Late reply");
});

it("renders unavailable optional sections without claiming an empty successful read", () => {
  const client = new QueryClient();
  const problems = [
    { kind: "failed", section: "checks", message: "GitHub refused this read." },
    { kind: "failed", section: "files", message: "GitHub refused this read." },
  ] satisfies PrSectionProblem[];
  client.setQueryData(["pr-detail", "thread", detail.observation.key], {
    ...detail,
    checks: [],
    files: [],
    problems,
  });
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(PullRequestDetail, {
        prKey: detail.observation.key,
        onBack() {},
        ...target,
        onAskCodex() {},
        canAskCodex: true,
      }),
    ),
  );
  assert.isTrue(html.includes("Checks unavailable."));
  assert.isTrue(html.includes("Files unavailable."));
  assert.isTrue(html.includes("The remote description."));
  assert.isFalse(html.includes("No checks reported."));
  client.clear();
});

it("renders refused review and reply outcomes while keeping drafts available without reconciliation", () => {
  const key = draftKey(detail.observation);
  reviewDrafts.summary(key, "Keep this review");
  const captured = reviewDrafts.start(key, input());
  reviewDrafts.finish(key, captured, {
    kind: "refused",
    message:
      "A pull request operation is already running. Wait for its result.",
  });
  const html = renderToStaticMarkup(
    createElement(PullRequestReviewComposer, {
      detail,
      threadId: "thread",
      disabled: false,
      onSubmitted() {},
    }),
  );
  assert.isTrue(html.includes("A pull request operation is already running."));
  assert.isFalse(html.includes("I checked GitHub"));
  assert.equal(reviewDrafts.get(key).summary.body, "Keep this review");
  const replyKey = `${key}:${finding.observation.findingId}`;
  conversationDrafts.edit(replyKey, "Keep this reply");
  const revision = conversationDrafts.start(replyKey, {
    ...input(),
    action: {
      kind: "reply",
      threadId: finding.observation.findingId,
      body: "Keep this reply",
    },
  });
  conversationDrafts.finish(replyKey, revision, {
    kind: "refused",
    message: "This request ID was already used for different input.",
  });
  const timeline = renderToStaticMarkup(
    createElement(PullRequestTimeline, {
      detail,
      disabled: false,
      refresh() {},
      ...target,
      canAskCodex: true,
      onAskCodex() {},
    }),
  );
  assert.isTrue(timeline.includes("Keep this reply"));
  assert.isTrue(timeline.includes("already used for different input"));
  assert.isFalse(timeline.includes("I checked GitHub"));
  reviewDrafts.discard(key);
});

it("carries bounded typed coverage warnings into every agent handoff", () => {
  const problems = [
    { kind: "failed", section: "checks", message: "Could not load checks." },
    {
      kind: "limited",
      section: "files",
      message: "Only the first 400 files were loaded.",
    },
  ] satisfies PrSectionProblem[];
  for (const intent of [
    "ask",
    "explain",
    "fix_check",
    "fix",
  ] satisfies ReviewDraftRequest["intent"][]) {
    const text = appendReviewDraft(
      "Existing draft",
      { ...request, intent, problems },
      target,
    );
    assert.isTrue(text?.startsWith("Existing draft"));
    assert.isTrue(text?.includes("Checks unavailable."));
    assert.isTrue(text?.includes("Files limited."));
    assert.isTrue(
      text?.includes(
        "Do not claim all findings, checks, or changes were assessed.",
      ),
    );
  }
});

it("renders lifecycle and commit entries alongside original finding context and unavailable dates", () => {
  const timeline = prReviewDetail.parse({
    ...detail,
    timeline: [
      { at: "2026-10-06T12:00:00Z", event: { kind: "merged" } },
      ...detail.timeline,
      {
        at: "2026-10-03T12:00:00Z",
        event: {
          kind: "commit",
          oid: "c".repeat(40),
          headline: "Validate input",
          author: "contributor",
        },
      },
      { at: null, event: { kind: "opened", author: "author" } },
    ],
  });
  const html = renderToStaticMarkup(
    createElement(PullRequestTimeline, {
      detail: timeline,
      disabled: false,
      refresh() {},
      ...target,
      canAskCodex: true,
      onAskCodex() {},
    }),
  );
  assert.isTrue(
    html.indexOf("Pull request merged") < html.indexOf("Check the boundary"),
  );
  assert.isTrue(
    html.indexOf("Check the boundary") < html.indexOf("Commit ccccccc"),
  );
  assert.isTrue(html.includes("Original review diff hunk"));
  assert.isTrue(html.includes("Date unavailable"));
  assert.isFalse(html.includes("Invalid Date"));
});
