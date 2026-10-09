import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterContextProvider,
} from "@tanstack/react-router";
import {
  capturePrCodeHeader,
  capturedFileCollapsed,
  capturedViewedPress,
  clickCheckbox,
  completePrCodeGesture,
} from "../test/capturePrCodeHeader.mjs";
import { Checkbox } from "../ui/checkbox";
import { storage } from "../lib/storage";
import { draftKey, reviewDrafts } from "./reviewDrafts";
import { prReviewDetail } from "./prReview";

const detail = prReviewDetail.parse({
  capabilities: {
    primary: "unavailable",
    actions: [],
    explanation: null,
    edit: false,
  },
  operations: [],
  observation: {
    key: "github.com/test/repo/7",
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
  body: "",
  author: null,
  labels: [],
  reviewers: [],
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  autoMergeMethod: null,
  reviewDecision: null,
  verdicts: [],
  findings: [],
  checks: [],
  problems: [],
  timeline: [],
  files: [
    {
      path: "a.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+new",
      unavailable: null,
      anchors: [],
    },
  ],
});

it("a retained collapsed file header checkbox alternates marks using current Viewed state", async () => {
  const stopCapture = capturePrCodeHeader();
  const previousGetItem = storage.getItem;
  storage.getItem = () => null;
  try {
    const { PullRequestCodeTab } = await import("./PullRequestCodeTab");
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    let viewed = false;
    const writes: { path: string; viewed: boolean }[] = [];
    renderToStaticMarkup(
      createElement(RouterContextProvider, {
        router,
        children: createElement(PullRequestCodeTab, {
          detail,
          scope: { kind: "all" },
          onScopeChange: () => {},
          files: detail.files,
          problems: [],
          loading: false,
          disabled: false,
          onViewFiles: () => {},
          onRetry: () => {},
          filesViewed: {
            enabled: true,
            isViewed: () => viewed,
            isStale: () => false,
            setViewed: (path, next) => {
              writes.push({ path, viewed: next });
              viewed = next;
            },
            viewedCount: 0,
            truncated: false,
            error: null,
            mutationError: null,
            refresh: () => {},
          },
        }),
      }),
    );
    assert.equal(capturedFileCollapsed(), true);
    const press = capturedViewedPress();
    press();
    assert.equal(viewed, true);
    press();
    assert.equal(viewed, false);
    press();
    assert.deepEqual(writes, [
      { path: "a.ts", viewed: true },
      { path: "a.ts", viewed: false },
      { path: "a.ts", viewed: true },
    ]);
  } finally {
    stopCapture();
    storage.getItem = previousGetItem;
  }
});

it("the custom checkbox cancels label default activation and reports a click exactly once", () => {
  let presses = 0;
  const checkbox = Checkbox({
    checked: true,
    label: "Viewed",
    onCheckedChange: () => {
      presses++;
    },
  });
  assert.equal(clickCheckbox(checkbox), true);
  assert.equal(presses, 1);
});

it("completed comment gutter clicks and drags each add one draft while number drags still add ranges", async () => {
  const stopCapture = capturePrCodeHeader();
  const previousGetItem = storage.getItem;
  storage.getItem = () => null;
  const target = prReviewDetail.parse({
    ...detail,
    verdicts: ["comment"],
    files: [
      {
        ...detail.files[0],
        anchors: [1, 2, 3].map((line) => ({
          side: "RIGHT",
          line,
          text: "source",
        })),
        patch: "@@ -1,3 +1,3 @@\n first\n second\n-old\n+new",
      },
    ],
  });
  const key = draftKey(target.observation);
  reviewDrafts.discard(key);
  try {
    const { PullRequestCodeTab } = await import("./PullRequestCodeTab");
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    renderToStaticMarkup(
      createElement(RouterContextProvider, {
        router,
        children: createElement(PullRequestCodeTab, {
          detail: target,
          scope: { kind: "all" },
          onScopeChange: () => {},
          files: target.files,
          problems: [],
          loading: false,
          disabled: false,
          onViewFiles: () => {},
          onRetry: () => {},
          filesViewed: {
            enabled: true,
            isViewed: () => false,
            isStale: () => false,
            setViewed: () => {},
            viewedCount: 0,
            truncated: false,
            error: null,
            mutationError: null,
            refresh: () => {},
          },
        }),
      }),
    );
    await completePrCodeGesture("gutter", 1, 1);
    assert.equal(reviewDrafts.get(key).comments.length, 1);
    await completePrCodeGesture("gutter", 1, 2);
    assert.equal(reviewDrafts.get(key).comments.length, 2);
    await completePrCodeGesture("number", 1, 3);
    assert.deepEqual(
      reviewDrafts
        .get(key)
        .comments.map(({ line, startLine }) => ({ line, startLine })),
      [
        { line: 1, startLine: undefined },
        { line: 2, startLine: 1 },
        { line: 3, startLine: 1 },
      ],
    );
  } finally {
    reviewDrafts.discard(key);
    stopCapture();
    storage.getItem = previousGetItem;
  }
});
