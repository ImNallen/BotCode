import assert from "node:assert/strict";
import { it } from "node:test";
import { cachedPr, type ThreadPrSummary } from "./pullRequests";
import { pullRequestKey } from "./pullRequestKey";
import {
  pullRequestStack,
  stackActionState,
  savedPullRequestStack as savedStackSchema,
} from "./pullRequestStack";
import {
  pullRequestStackView,
  savedPullRequestStack,
} from "./pullRequestStackSnapshot";
import { eligibleSurfaces, openSurface } from "./panelState";

const reference = {
  key: pullRequestKey.parse("github.com/fixture/project/42"),
  number: 42,
};
const stack = savedStackSchema.parse({
  id: "50",
  number: 50,
  url: "https://github.com/fixture/project/stacks/50",
  base: "main",
  observedAt: 500,
  layers: [41, 42, 43].map((number) => ({
    number,
    headBranch: `layer-${number}`,
    state: "open",
    isDraft: true,
  })),
});
type Link = ThreadPrSummary["links"][number];
function link(
  number: number,
  changes: Partial<Link["pr"]> = {},
  linkedAt = 1,
): Link {
  return {
    pr: cachedPr.parse({
      key: `github.com/fixture/project/${number}`,
      revision: 1,
      stack,
      snapshot: {
        nodeId: `PR${number}`,
        title: `Cached ${number}`,
        lifecycle: { kind: "open", draft: false },
        base: "main",
        head: `layer-${number}`,
        headRepository: "fixture/project",
        headOid: "a".repeat(40),
        hostUpdatedAt: "now",
      },
      freshness: { kind: "current", fetchedAt: 100 },
      ...changes,
    }),
    source: "manual",
    linkedAt,
  };
}

it("restores every layer from a single link and enriches known titles/drafts without action heads or permissions", () => {
  const saved = savedPullRequestStack([link(42)], reference);
  assert.ok(saved);
  assert.equal(saved.layers.length, 3);
  assert.equal(saved.layers[1]?.title, "Cached 42");
  assert.equal(saved.layers[1]?.isDraft, false);
  assert.equal(saved.layers[0]?.isDraft, true);
  assert.ok(saved.layers.every((layer) => layer.headSha === undefined));
  assert.deepEqual(saved.capabilities, { mergeMethods: [], canRebase: false });
  assert.equal(stackActionState(saved, reference, false).mergeDisabled, true);
  assert.equal(stackActionState(saved, reference, false).rebaseDisabled, true);
  assert.equal(savedPullRequestStack([link(41)], reference)?.number, 50);
});

it("prefers exact PR links even when their newest snapshot records no stack", () => {
  assert.equal(
    savedPullRequestStack([link(41), link(42, { stack: null })], reference),
    null,
  );
  assert.equal(
    savedPullRequestStack(
      [
        link(42),
        link(42, {
          stack: null,
          freshness: { kind: "current", fetchedAt: 200 },
        }),
      ],
      reference,
    ),
    null,
  );
});

it("chooses the latest successful snapshot before link time and uses link time for never-loaded records", () => {
  const latest = { ...stack, number: 51 };
  assert.equal(
    savedPullRequestStack(
      [
        link(
          42,
          {
            stack: latest,
            freshness: { kind: "stale", lastSuccess: 200, message: "offline" },
          },
          1,
        ),
        link(42, {}, 1000),
      ],
      reference,
    )?.number,
    51,
  );
  assert.equal(
    savedPullRequestStack(
      [
        link(42),
        link(
          42,
          { stack: null, snapshot: null, freshness: { kind: "never_loaded" } },
          300,
        ),
      ],
      reference,
    ),
    null,
  );
  assert.equal(
    savedPullRequestStack(
      [
        link(42),
        link(
          42,
          {
            stack: null,
            freshness: { kind: "stale", lastSuccess: null, message: "offline" },
          },
          300,
        ),
      ],
      reference,
    ),
    null,
  );
});

it("enriches with the newest same-repository layer snapshot and preserves a known draft flag for closed snapshots", () => {
  const closed = link(43);
  assert.ok(closed.pr.snapshot);
  closed.pr.snapshot = {
    ...closed.pr.snapshot,
    title: "Closed top",
    lifecycle: { kind: "closed", closedAt: null },
  };
  closed.pr.freshness = { kind: "current", fetchedAt: 200 };
  const saved = savedPullRequestStack([link(41), link(43), closed], reference);
  assert.equal(saved?.layers[2]?.title, "Closed top");
  assert.equal(saved?.layers[2]?.isDraft, true);
});

it("does not restore from another repository or a stack that no longer contains the requested PR", () => {
  const other = link(42, {
    key: pullRequestKey.parse("github.com/other/project/42"),
  });
  assert.equal(savedPullRequestStack([other], reference), null);
  assert.equal(
    savedPullRequestStack(
      [link(42, { stack: { ...stack, layers: [] } })],
      reference,
    ),
    null,
  );
  assert.equal(
    savedPullRequestStack([link(42, { stack: undefined })], reference),
    null,
  );
});

it("keeps saved navigation pending or failed with the exact T3 notice and no fresh action authority", () => {
  const saved = savedPullRequestStack([link(42)], reference);
  const pending = {
    data: null,
    isSuccess: false,
    isPending: true,
    error: null,
  };
  assert.deepEqual(pullRequestStackView(pending, saved), {
    data: saved,
    isFresh: false,
    notice: "Refreshing stack… Showing saved data.",
  });
  assert.deepEqual(
    pullRequestStackView(
      { ...pending, isPending: false, error: "offline" },
      saved,
    ),
    {
      data: saved,
      isFresh: false,
      notice: "Stack data may be stale. We couldn’t refresh it.",
    },
  );
  assert.equal(pullRequestStackView(pending, null).notice, null);
});

it("prefers live layers, marks cached live refreshes unavailable for actions, and honors fresh absence", () => {
  const saved = savedPullRequestStack([link(42)], reference);
  const live = pullRequestStack.parse({
    ...stack,
    capabilities: { mergeMethods: ["merge"], canRebase: true },
    layers: stack.layers.map((layer) => ({
      ...layer,
      headSha: "b".repeat(40),
    })),
  });
  const query = { data: live, isSuccess: true, isPending: false, error: null };
  assert.deepEqual(pullRequestStackView(query, saved), {
    data: live,
    isFresh: true,
    notice: null,
  });
  assert.deepEqual(pullRequestStackView({ ...query, isPending: true }, saved), {
    data: live,
    isFresh: false,
    notice: "Refreshing stack… Showing saved data.",
  });
  assert.equal(
    pullRequestStackView(
      { ...query, isSuccess: false, error: "offline" },
      saved,
    ).data,
    live,
  );
  assert.deepEqual(pullRequestStackView({ ...query, data: null }, saved), {
    data: null,
    isFresh: true,
    notice: null,
  });
});

it("keeps an already opened sibling review after fresh stack removal, and closes it after the last repository unlink", () => {
  const opened = openSurface(
    { surfaces: [], active: null },
    { kind: "pull_request", key: reference.key },
  );
  const original = link(41);
  assert.deepEqual(eligibleSurfaces(opened, true, [original]), opened);
  assert.deepEqual(
    eligibleSurfaces(opened, true, [
      { ...original, pr: { ...original.pr, stack: null } },
    ]),
    opened,
  );
  assert.deepEqual(eligibleSurfaces(opened, true, []), {
    surfaces: [],
    active: null,
  });
  assert.deepEqual(
    eligibleSurfaces(opened, true, [
      link(41, { key: pullRequestKey.parse("github.com/other/project/41") }),
    ]),
    { surfaces: [], active: null },
  );
});
