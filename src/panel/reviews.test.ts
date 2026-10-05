import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "../test/chai.ts";
import {
  appendReviewDraft,
  dispositionState,
  findingPrompt,
  reviewFinding,
  reviewFindings,
  setReviewDisposition,
  validDismissReason,
  type ReviewDraftRequest,
  type ReviewDraftTarget,
} from "./reviews.ts";
import { eligibleSurfaces, openSurface } from "./panelState.ts";
import {
  ReviewDetails,
  ReviewsContent,
  ReviewsSurface,
  type ReviewsState,
} from "./ReviewsSurface.tsx";
import type { PanelState } from "./RightPanel";

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
  branch: "review-fixture",
  finding,
};
const target: ReviewDraftTarget = {
  workspaceId: "workspace",
  threadId: "thread",
  branch: "review-fixture",
  canAccept: true,
};
const data = reviewFindings.parse({
  kind: "ready",
  branch: "review-fixture",
  checkoutHead: "d".repeat(40),
  pr: {
    id: "PR_fixture",
    number: 7,
    title: "Review fixture",
    url: "https://github.com/test/repo/pull/7",
    headSha: "a".repeat(40),
  },
  findings: [finding],
});
function panel(state: ReviewsState, canAskCodex = true): string {
  return renderToStaticMarkup(
    createElement(ReviewsContent, {
      state,
      refreshing: false,
      onRefresh() {},
      saving: false,
      saveError: undefined,
      onSave() {},
      onClearError() {},
      workspaceId: "workspace",
      conversationId: "thread",
      canAskCodex,
      onAskCodex() {},
    }),
  );
}

describe("review draft handoff", () => {
  it("preserves existing draft bytes and supplies original evidence", () => {
    const draft = "  Existing draft\nwith trailing spaces  \n";
    const appended = appendReviewDraft(draft, request, target);
    assert.equal(appended?.slice(0, draft.length), draft);
    assert.isTrue(
      appended?.includes("Original reviewed commit: " + "c".repeat(40)),
    );
    assert.isTrue(appended?.includes("Original diff hunk:"));
    assert.isTrue(appended?.includes("GitHub thread: resolved; outdated"));
    assert.isFalse(appended?.includes("d".repeat(40)));
    assert.equal(
      appendReviewDraft("", request, target),
      findingPrompt(request),
    );
  });
  it("rejects late navigation, draft conversations and unavailable composers", () => {
    for (const changed of [
      { ...target, workspaceId: "other" },
      { ...target, threadId: "other" },
      { ...target, threadId: undefined },
      { ...target, branch: "other" },
      { ...target, canAccept: false },
    ]) {
      assert.equal(appendReviewDraft("Keep this", request, changed), null);
    }
  });
  it("honestly reports absent source context", () => {
    const general = reviewFinding.parse({
      ...finding,
      source: { kind: "conversation" },
      comments: [{ ...finding.comments[0], context: null }],
    });
    const prompt = findingPrompt({ ...request, finding: general });
    assert.isTrue(prompt.includes("Original reviewed commit: Unavailable"));
    assert.isFalse(prompt.includes("Original diff hunk:"));
  });
});

describe("review decisions and panel", () => {
  it("hides cached actionable evidence after a real query refetch error", () => {
    const client = new QueryClient();
    const key = ["reviews", "workspace", null, "review-fixture"];
    client.setQueryData(key, data);
    client
      .getQueryCache()
      .find({ queryKey: key })
      ?.setState({
        status: "error",
        error: new Error("Latest GitHub fetch failed"),
        fetchStatus: "idle",
      });
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ReviewsSurface, {
          checkout: { workspaceId: "workspace" },
          branch: "review-fixture",
          conversationId: "thread",
          canAskCodex: true,
          onAskCodex() {},
        }),
      ),
    );
    assert.isTrue(html.includes("Latest GitHub fetch failed"));
    assert.isFalse(html.includes("Ask Codex"));
    assert.isFalse(html.includes("Check the boundary"));
    client.clear();
  });
  it("requires a real dismissal reason and bounds UTF-8 bytes", () => {
    assert.isFalse(validDismissReason(" \n"));
    assert.isTrue(validDismissReason("Caller checks this."));
    assert.isFalse(validDismissReason("é".repeat(2001)));
    assert.isFalse(
      setReviewDisposition.safeParse({
        branch: "review-fixture",
        observation: finding.observation,
        expected: null,
        choice: { kind: "dismiss", reason: " " },
      }).success,
    );
  });
  it("derives stale state from changed head or changed content", () => {
    const saved = {
      observation: finding.observation,
      choice: { kind: "dismiss", reason: "Caller checks this." },
    };
    assert.equal(dispositionState(finding), "untouched");
    const current = reviewFinding.parse({ ...finding, saved });
    assert.equal(dispositionState(current), "current");
    assert.equal(
      dispositionState(
        reviewFinding.parse({
          ...current,
          observation: { ...current.observation, headSha: "e".repeat(40) },
        }),
      ),
      "stale",
    );
    const stale = reviewFinding.parse({
      ...current,
      observation: { ...current.observation, contentDigest: "f".repeat(64) },
    });
    assert.equal(dispositionState(stale), "stale");
    const html = renderToStaticMarkup(
      createElement(ReviewDetails, {
        finding: stale,
        saving: false,
        disabled: false,
        saveError: "disk failure",
        onSave() {},
        canAskCodex: false,
        onAskCodex() {},
        openUrl() {},
      }),
    );
    assert.isTrue(html.includes("Stale decision"));
    assert.isTrue(html.includes("Caller checks this."));
    assert.isTrue(html.includes("disk failure"));
    assert.isFalse(html.includes("Saved successfully"));
  });
  it("renders remote status independently, original hunk, sources and an explicit draft handoff", () => {
    const html = panel({ kind: "loaded", data });
    assert.isTrue(html.includes("GitHub thread resolved"));
    assert.isTrue(html.includes("outdated"));
    assert.isTrue(html.includes("Local intent Untouched"));
    assert.isTrue(html.includes("Original review diff hunk"));
    assert.isTrue(html.includes("Source"));
    assert.isTrue(html.includes("Adds to your draft. You send it."));
    assert.isTrue(html.includes("Checkout HEAD"));
    assert.isTrue(html.includes("PR head"));
    const disabled = panel({ kind: "loaded", data }, false);
    assert.isTrue(/disabled=""[^>]*>Ask Codex/.test(disabled));
  });
  it("shows loading, absent PR, empty feedback, and fetch errors without actionable old data", () => {
    assert.isTrue(panel({ kind: "loading" }).includes("Loading PR reviews"));
    assert.isTrue(
      panel({
        kind: "loaded",
        data: { kind: "none", branch: "review-fixture" },
      }).includes("No open PR"),
    );
    const empty = reviewFindings.parse({ ...data, findings: [] });
    assert.isTrue(
      panel({ kind: "loaded", data: empty }).includes("no review feedback"),
    );
    const failed = panel({
      kind: "error",
      message: "Sign in with gh auth login",
    });
    assert.isTrue(failed.includes("gh auth login"));
    assert.isTrue(failed.includes("Retry loading reviews"));
    assert.isFalse(failed.includes("Ask Codex"));
    assert.isFalse(failed.includes("Check the boundary"));
  });
  it("uses one Reviews tab and removes repository tools from scratch or removed checkouts", () => {
    const base = {
      surfaces: [{ kind: "files" }],
      active: 0,
    } satisfies PanelState;
    const opened = openSurface(base, { kind: "reviews" });
    assert.equal(openSurface(opened, { kind: "reviews" }).surfaces.length, 2);
    const restricted = eligibleSurfaces(opened, false);
    assert.deepEqual(restricted, {
      surfaces: [{ kind: "files" }],
      active: null,
    });
    assert.equal(eligibleSurfaces(opened, true), opened);
  });
});
