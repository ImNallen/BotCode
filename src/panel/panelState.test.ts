import assert from "node:assert/strict";
import { it } from "node:test";
import {
  eligibleSurfaces,
  openSurface,
  pullRequestSurface,
  surfaceTitle,
} from "./panelState.ts";
import { pullRequestKey, type ThreadPrSummary } from "./pullRequests.ts";
import type { PanelState } from "./RightPanel.tsx";

const emptyPanel: PanelState = { surfaces: [], active: null };

function links(...numbers: number[]): ThreadPrSummary["links"] {
  return numbers.map((number) => ({
    pr: {
      key: pullRequestKey.parse(`github.com/fixture/project/${number}`),
      revision: 0,
      snapshot: null,
      freshness: { kind: "never_loaded" },
    },
    source: "manual",
    linkedAt: number,
  }));
}

it("names the pull request action after the only linked PR", () => {
  assert.equal(surfaceTitle(pullRequestSurface(links(24))), "#24");
  assert.equal(surfaceTitle(pullRequestSurface(links())), "Pull requests");
  assert.equal(
    surfaceTitle(pullRequestSurface(links(24, 25))),
    "Pull requests",
  );
});

it("opens one tab per pull request and reuses an open one", () => {
  const [first, second] = links(24, 25).map(({ pr }) => ({
    kind: "pull_request" as const,
    key: pr.key,
  }));
  assert.ok(first && second);
  const both = openSurface(openSurface(emptyPanel, first), second);
  assert.deepEqual(both.surfaces.map(surfaceTitle), ["#24", "#25"]);
  assert.deepEqual(openSurface(both, first), { ...both, active: 0 });
});

it("hides pull request tabs the conversation does not link", () => {
  const state = openSurface(emptyPanel, pullRequestSurface(links(24)));
  assert.deepEqual(eligibleSurfaces(state, true, links(24, 25)), state);
  assert.deepEqual(eligibleSurfaces(state, true, links(25)), emptyPanel);
  assert.deepEqual(eligibleSurfaces(state, true, undefined), emptyPanel);
});
