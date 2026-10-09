import assert from "node:assert/strict";
import { it } from "node:test";
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import {
  ConversationDrafts,
  commentDrafts,
  ReviewDrafts,
  reviewDrafts,
  draftKey,
} from "./reviewDrafts";
import { prReviewDetail, prObservation, type PrReviewChange } from "./prReview";
import {
  commentSubmitShortcut,
  commentFollowUp,
} from "./pullRequestComment.logic";
import { PullRequestReviewComposer } from "./PullRequestReviewComposer";
import { PullRequestCommentForm } from "./PullRequestCommentForm";
import {
  applyPendingPullRequestReactions,
  PULL_REQUEST_REACTION_ORDER,
  pullRequestReactionTooltip,
} from "./pullRequestReactions.logic";

const target = prObservation.parse({
  key: "github.com/fixture/project/42",
  nodeId: "PR_42",
  headOid: "a".repeat(40),
  viewer: "viewer",
});
const input = (body: string): PrReviewChange => ({
  requestId: crypto.randomUUID(),
  target,
  action: { kind: "add_comment", body },
});
const flush = async () => {
  for (let i = 0; i < 8; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};
it("keeps non-idempotent comment outcomes and captured text across restart until acknowledgment", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const store = new ConversationDrafts("comments-test");
    store.edit("key", "Retain this remark");
    const captured = store.start("key", input("Retain this remark"));
    const restarted = new ConversationDrafts("comments-test");
    assert.equal(restarted.get("key").operation?.result?.kind, "uncertain");
    assert.equal(restarted.get("key").body, "Retain this remark");
    store.finish("key", captured, { kind: "refused", message: "Host refused" });
    assert.equal(store.get("key").body, "Retain this remark");
    const posted = store.start("key", input("Retain this remark"));
    store.edit("key", "A newer draft");
    store.finish("key", posted, { kind: "applied", hostId: "COMMENT_saved" });
    assert.equal(store.get("key").body, "A newer draft");
    const current = store.start("key", input("A newer draft"));
    store.finish("key", current, { kind: "applied", hostId: "COMMENT_next" });
    assert.equal(store.get("key").body, "");
    restarted.acknowledge("key");
    assert.equal(
      new ConversationDrafts("comments-test").get("key").operation,
      null,
    );
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
it("recovers persisted siblings independently and retains every actionable draft beyond 100 keys", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const store = new ConversationDrafts("many-comments");
    store.edit("uncertain", "Already possibly posted");
    store.start("uncertain", input("Already possibly posted"));
    store.edit("normal", "Keep this draft");
    store.edit("oversized", "x".repeat(64001));
    for (let i = 0; i < 101; i++) store.edit(`draft-${i}`, `Text ${i}`);
    const records: unknown[] = JSON.parse(values.get("many-comments")!);
    records.push(["malformed", { body: 42 }]);
    values.set("many-comments", JSON.stringify(records));
    const restored = new ConversationDrafts("many-comments");
    assert.equal(restored.get("normal").body, "Keep this draft");
    assert.equal(restored.get("oversized").body.length, 64001);
    assert.equal(restored.get("uncertain").body, "Already possibly posted");
    assert.equal(
      restored.get("uncertain").operation?.result?.kind,
      "uncertain",
    );
    assert.equal(restored.get("draft-100").body, "Text 100");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error("Quota exceeded");
        },
      },
    });
    const failing = new ConversationDrafts("full-storage");
    failing.edit("key", "Keep in memory");
    assert.match(
      failing.get("key").persistenceError ?? "",
      /could not be saved/,
    );
    assert.equal(failing.get("key").body, "Keep in memory");
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
it("retains the chosen review verdict with its draft when a composer is dismissed", () => {
  const drafts = new ReviewDrafts();
  drafts.summary("pr", "Request a revision");
  drafts.verdict("pr", "request_changes");
  drafts.clearComments("pr");
  assert.equal(drafts.get("pr").verdict, "request_changes");
  assert.equal(drafts.get("pr").summary.body, "Request a revision");
});
it("uses source reaction order, optimistic add/remove/rollback and count-safe actor tooltips", () => {
  assert.deepEqual(PULL_REQUEST_REACTION_ORDER, [
    "thumbs-up",
    "thumbs-down",
    "laugh",
    "hooray",
    "confused",
    "heart",
    "rocket",
    "eyes",
  ]);
  const host = [
    {
      content: "heart" as const,
      count: 3,
      actors: ["alice", "bob"],
      viewerHasReacted: true,
    },
  ];
  const pending = applyPendingPullRequestReactions(
    host,
    new Map([
      ["heart", false],
      ["thumbs-up", true],
    ]),
  );
  assert.deepEqual(
    pending.map((reaction) => [
      reaction.content,
      reaction.count,
      reaction.viewerHasReacted,
    ]),
    [
      ["thumbs-up", 1, true],
      ["heart", 2, false],
    ],
  );
  assert.deepEqual(applyPendingPullRequestReactions(host, new Map()), host);
  assert.equal(
    pullRequestReactionTooltip(host[0]!),
    "You, alice, and bob reacted with heart emoji",
  );
  assert.equal(
    pullRequestReactionTooltip({ ...host[0]!, count: 14 }),
    "You, alice, bob, and 11 others reacted with heart emoji",
  );
});
it("plain-comment shortcuts reject IME, shifted and alternate Enter, and only offer allowed close/reopen", () => {
  const event = {
    key: "Enter",
    keyCode: 13,
    nativeEvent: { isComposing: false },
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  assert.equal(commentSubmitShortcut(event), true);
  assert.equal(
    commentSubmitShortcut({ ...event, metaKey: false, ctrlKey: true }),
    true,
  );
  for (const patch of [
    { keyCode: 229 },
    { nativeEvent: { isComposing: true } },
    { shiftKey: true },
    { altKey: true },
  ])
    assert.equal(commentSubmitShortcut({ ...event, ...patch }), false);
});
it("actual plain-comment form blocks blank/double/uncertain posts and clears once before lifecycle followup", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  let storageFails = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {
        if (storageFails) throw new Error("Quota exceeded");
      },
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { crypto: globalThis.crypto },
  });
  const detail = prReviewDetail.parse({
    observation: target,
    snapshot: {
      nodeId: "PR_42",
      title: "Title",
      lifecycle: { kind: "open", draft: false },
      base: "main",
      head: "feature",
      headRepository: "fixture/project",
      headOid: target.headOid,
      hostUpdatedAt: "2026-10-01T00:00:00Z",
    },
    body: "",
    author: null,
    labels: [],
    reviewers: [],
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    autoMergeMethod: null,
    reviewDecision: null,
    verdicts: ["comment"],
    findings: [],
    checks: [],
    files: [],
    problems: [],
    timeline: [],
    operations: [],
    capabilities: {
      primary: "closed",
      actions: [{ kind: "set_closed", closed: true }],
      edit: false,
      explanation: null,
      comment: true,
      react: true,
    },
  });
  assert.equal(commentFollowUp(detail), "close");
  assert.equal(
    commentFollowUp({
      ...detail,
      snapshot: {
        ...detail.snapshot,
        lifecycle: { kind: "closed", closedAt: null },
      },
      capabilities: {
        ...detail.capabilities,
        actions: [{ kind: "set_closed", closed: false }],
      },
    }),
    "reopen",
  );
  const key = JSON.stringify([target.key, target.viewer, "comment"]);
  let calls = 0,
    closed = 0,
    followups = 0;
  let resolve: (value: unknown) => void = () => {};
  mockIPC((command) => {
    assert.equal(command, "change_pull_request");
    calls++;
    return new Promise((complete) => {
      resolve = complete;
    });
  });
  function handlers() {
    const result = new Map<string, () => void>();
    function Capture() {
      const tree = PullRequestCommentForm({
        access: "thread",
        detail,
        actionPending: false,
        textareaRef: { current: null },
        onCommented: () => {},
        onClose: () => closed++,
        onFollowUp: async () => {
          followups++;
        },
      });
      const visit = (node: ReactNode): void =>
        Children.forEach(node, (child) => {
          if (
            !isValidElement<{ children?: ReactNode; onClick?: () => void }>(
              child,
            )
          )
            return;
          if (child.props.onClick) {
            let text = "";
            Children.forEach(child.props.children, (part) => {
              if (typeof part === "string") text += part;
            });
            result.set(text, child.props.onClick);
          }
          visit(child.props.children);
        });
      visit(tree);
      return null;
    }
    renderToStaticMarkup(createElement(Capture));
    return result;
  }
  try {
    const reviewKey = draftKey(detail.observation);
    function reviewSelect() {
      let selected = "";
      let change: (event: { target: { value: string } }) => void = () => {};
      function CaptureReview() {
        const tree = PullRequestReviewComposer({
          threadId: "thread",
          detail: { ...detail, verdicts: ["comment", "request_changes"] },
          disabled: false,
          onSubmitted: () => {},
          embedded: true,
        });
        const visit = (node: ReactNode): void =>
          Children.forEach(node, (child) => {
            if (
              !isValidElement<{
                children?: ReactNode;
                value?: string;
                onChange?: typeof change;
              }>(child)
            )
              return;
            if (child.type === "select") {
              selected = child.props.value ?? "";
              change = child.props.onChange ?? change;
            }
            visit(child.props.children);
          });
        visit(tree);
        return null;
      }
      renderToStaticMarkup(createElement(CaptureReview));
      return { selected, change };
    }
    reviewSelect().change({ target: { value: "request_changes" } });
    assert.equal(reviewSelect().selected, "request_changes");
    reviewDrafts.discard(reviewKey);
    commentDrafts.acknowledge(key);
    commentDrafts.edit(key, "   ");
    handlers().get("Comment")?.();
    assert.equal(calls, 0);
    commentDrafts.edit(key, "Saved before posting");
    storageFails = true;
    handlers().get("Comment")?.();
    await flush();
    assert.equal(calls, 0);
    assert.equal(commentDrafts.get(key).body, "Saved before posting");
    const failedStart = commentDrafts.get(key).operation?.result;
    assert.equal(failedStart?.kind, "refused");
    assert.match(
      failedStart?.kind === "refused" ? failedStart.message : "",
      /Nothing was posted/,
    );
    storageFails = false;
    commentDrafts.edit(key, "Before closing");
    const send = handlers().get("Close with comment");
    send?.();
    send?.();
    assert.equal(calls, 1);
    resolve({ kind: "applied", hostId: "COMMENT_once" });
    await flush();
    assert.equal(commentDrafts.get(key).body, "");
    assert.equal(closed, 1);
    assert.equal(followups, 1);
    handlers().get("Close with comment")?.();
    assert.equal(calls, 1);
    commentDrafts.edit(key, "Unknown remark");
    handlers().get("Comment")?.();
    resolve({
      kind: "uncertain",
      message: "Check GitHub before submitting again",
    });
    await flush();
    assert.equal(commentDrafts.get(key).body, "Unknown remark");
    handlers().get("Comment")?.();
    assert.equal(calls, 2);
    handlers().get("I checked GitHub. Allow a new submission")?.();
    handlers().get("Comment")?.();
    assert.equal(calls, 3);
    resolve({ kind: "refused", message: "Host refused" });
    await flush();
    assert.equal(commentDrafts.get(key).body, "Unknown remark");
  } finally {
    commentDrafts.acknowledge(key);
    commentDrafts.edit(key, "");
    clearMocks();
    if (storageDescriptor)
      Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
