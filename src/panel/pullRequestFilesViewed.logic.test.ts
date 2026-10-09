// Behavioral cases adapted from pingdotgg/t3code v0.0.45 pullRequestFilesViewed.logic.test.ts (MIT).
import assert from "node:assert/strict";
import type { PrFileViewedState } from "./prReview";
import { it as test } from "node:test";
import {
  countViewedFiles,
  isFileViewed,
  isStaleViewedState,
  revertFileViewedOverlay,
  settleFileViewedOverlay,
  toFileViewedBatch,
  toFileViewedStates,
} from "./pullRequestFilesViewed.logic";

const states = new Map<string, PrFileViewedState>([
  ["a.ts", "viewed"],
  ["b.ts", "unviewed"],
  ["c.ts", "dismissed"],
]);
const empty = new Map<string, boolean>();
const none = new Set<string>();

test("host states, dismissed files and absent paths have the upstream viewed meaning", () => {
  assert.equal(isFileViewed("a.ts", states, empty), true);
  assert.equal(isFileViewed("b.ts", states, empty), false);
  assert.equal(isFileViewed("c.ts", states, empty), false);
  assert.equal(isStaleViewedState(states.get("c.ts")), true);
  assert.equal(isFileViewed("absent.ts", null, empty), false);
  assert.equal(toFileViewedStates(null), null);
});
test("optimistic marks count only displayed paths across commit scopes", () => {
  const overlay = new Map([
    ["b.ts", true],
    ["a.ts", false],
  ]);
  assert.equal(countViewedFiles(["a.ts", "b.ts", "c.ts"], states, overlay), 1);
  assert.equal(countViewedFiles(["b.ts"], states, overlay), 1);
  assert.equal(countViewedFiles(["c.ts"], states, overlay), 0);
  assert.equal(
    isFileViewed("absent.ts", null, new Map([["absent.ts", true]])),
    true,
  );
});
test("pending writes survive old reads even if the host disagrees or agrees", () => {
  const overlay = new Map([
    ["a.ts", false],
    ["b.ts", true],
  ]);
  assert.equal(
    settleFileViewedOverlay(overlay, states, new Set(["a.ts", "b.ts"]), none),
    overlay,
  );
  assert.equal(settleFileViewedOverlay(overlay, null, none, none), overlay);
  assert.equal(
    settleFileViewedOverlay(
      new Map([["a.ts", true]]),
      states,
      new Set(["a.ts"]),
      none,
    ).get("a.ts"),
    true,
  );
});
test("a post-ack answer retires a viewed press even if DISMISSED is identical to the prior snapshot", () => {
  const overlay = new Map([["c.ts", true]]);
  assert.equal(settleFileViewedOverlay(overlay, states, none, none), overlay);
  const settled = settleFileViewedOverlay(
    overlay,
    states,
    none,
    new Set(["c.ts"]),
  );
  assert.equal(settled.size, 0);
  assert.equal(isFileViewed("c.ts", states, settled), false);
  assert.equal(isStaleViewedState(states.get("c.ts")), true);
  assert.equal(
    settleFileViewedOverlay(
      overlay,
      states,
      new Set(["c.ts"]),
      new Set(["c.ts"]),
    ),
    overlay,
  );
});
test("only failed-owned presses roll back, preserving newer presses including the same value", () => {
  const batch = [
    { path: "a.ts", viewed: true },
    { path: "b.ts", viewed: false },
  ];
  const overlay = new Map([
    ["a.ts", true],
    ["b.ts", false],
    ["c.ts", true],
  ]);
  assert.deepEqual(
    [...revertFileViewedOverlay(overlay, batch, new Set(["b.ts"]))],
    [
      ["a.ts", true],
      ["c.ts", true],
    ],
  );
  assert.deepEqual(
    [...revertFileViewedOverlay(overlay, batch, new Set(["a.ts", "b.ts"]))],
    [["c.ts", true]],
  );
  const newer = new Map([["a.ts", false]]);
  assert.equal(revertFileViewedOverlay(newer, batch, new Set(["a.ts"])), newer);
  assert.equal(revertFileViewedOverlay(overlay, batch, none), overlay);
});
test("batching preserves both mark and unmark preferences", () => {
  assert.deepEqual(
    toFileViewedBatch(
      new Map([
        ["a.ts", false],
        ["b.ts", true],
      ]),
    ),
    [
      { path: "a.ts", viewed: false },
      { path: "b.ts", viewed: true },
    ],
  );
});
