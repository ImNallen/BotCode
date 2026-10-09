import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { storage } from "../lib/storage";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterContextProvider,
} from "@tanstack/react-router";
import { PullRequestCodeTab } from "./PullRequestCodeTab";
import {
  currentPrScope,
  orderedPrCommits,
  prScopeIdentity,
} from "./pullRequestScope";
import { prReviewDetail, type PrReviewDetail } from "./prReview";
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
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  autoMergeMethod: null,
  reviewDecision: null,
  verdicts: ["comment"],
  findings: [],
  checks: [],
  files: [],
  problems: [],
  timeline: [
    {
      at: "2026-10-04T10:00:00Z",
      event: {
        kind: "commit",
        oid: "c".repeat(40),
        headline: "Earlier commit",
        author: null,
      },
    },
  ],
});
const scope = { kind: "commit", oid: "c".repeat(40) } as const;
function render(
  overrides: Partial<Parameters<typeof PullRequestCodeTab>[0]> = {},
) {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const previousGetItem = storage.getItem;
  storage.getItem = () => null;
  try {
    return renderToStaticMarkup(
      createElement(RouterContextProvider, {
        router,
        children: createElement(PullRequestCodeTab, {
          detail,
          scope,
          onScopeChange: () => {},
          files: [],
          problems: [],
          loading: false,
          disabled: false,
          onViewFiles: () => {},
          onRetry: () => {},
          ...overrides,
        }),
      }),
    );
  } finally {
    storage.getItem = previousGetItem;
  }
}
describe("pull request commit scope", () => {
  it("orders newest by instant including UTC offsets and leaves the source roster unchanged", () => {
    const timeline: PrReviewDetail["timeline"] = [
      ...detail.timeline,
      {
        at: "2026-10-04T12:30:00+03:00",
        event: {
          kind: "commit",
          oid: "b".repeat(40),
          headline: "Older instant",
          author: null,
        },
      },
      {
        at: "2026-10-04T07:30:00-03:00",
        event: {
          kind: "commit",
          oid: "d".repeat(40),
          headline: "Newer instant",
          author: null,
        },
      },
    ];
    assert.deepEqual(
      orderedPrCommits(timeline).map((entry) => entry.headline),
      ["Newer instant", "Earlier commit", "Older instant"],
    );
    assert.equal(
      timeline[0]?.event.kind === "commit" && timeline[0].event.headline,
      "Earlier commit",
    );
  });
  it("retains a current selection and returns to All commits after removal including an empty roster", () => {
    assert.equal(currentPrScope(scope, detail.timeline), scope);
    assert.deepEqual(currentPrScope(scope, []), { kind: "all" });
    assert.deepEqual(
      currentPrScope(scope, [
        {
          at: null,
          event: {
            kind: "commit",
            oid: "d".repeat(40),
            headline: "Replacement",
            author: null,
          },
        },
      ]),
      { kind: "all" },
    );
  });
  it("changes viewer identity for every scope, full SHA, account, head and PR observation", () => {
    const initial = prScopeIdentity(detail, scope);
    for (const other of [
      { ...detail, observation: { ...detail.observation, viewer: "other" } },
      {
        ...detail,
        observation: { ...detail.observation, headOid: "b".repeat(40) },
      },
      { ...detail, observation: { ...detail.observation, nodeId: "PR_other" } },
    ]) {
      assert.notEqual(prScopeIdentity(other, scope), initial);
    }
    assert.notEqual(prScopeIdentity(detail, { kind: "all" }), initial);
    assert.notEqual(
      prScopeIdentity(detail, { kind: "commit", oid: "c".repeat(39) + "d" }),
      initial,
    );
  });
  it("keeps the scope toolbar in loading, failed and empty branches and explains disabled line comments", () => {
    for (const overrides of [
      { loading: true },
      { error: "GitHub unavailable" },
      {},
    ]) {
      const html = render(overrides);
      assert.ok(html.includes("Diff scope: Earlier commit"));
      assert.ok(
        html.includes("Line comments are written from the whole change"),
      );
      assert.ok(
        html.includes(
          "A comment is anchored to the whole change, so switch to All commits to write one.",
        ),
      );
    }
    assert.ok(render({ loading: true }).includes("Loading file changes"));
    assert.ok(render({ error: "GitHub unavailable" }).includes("Retry"));
    assert.ok(
      !render({ error: "GitHub unavailable" }).includes(
        "This commit has no file changes",
      ),
    );
    assert.ok(render().includes("This commit has no file changes"));
    assert.ok(
      !render({ scope: { kind: "all" } }).includes(
        "Line comments are written from the whole change",
      ),
    );
    assert.ok(
      !render({
        detail: { ...detail, timeline: [] },
        scope: { kind: "all" },
      }).includes("Diff scope:"),
    );
  });
});
