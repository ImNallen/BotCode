import assert from "node:assert/strict";
import { it } from "node:test";
import type { LimitWindow } from "../ipc";
import {
  elapsedShare,
  formatResetsIn,
  isUsageLimitsCommand,
  limitsNotice,
  paceOf,
  remainingPercent,
  usageNoticeKey,
} from "./limits";

const weekly: LimitWindow = {
  slot: "primary",
  kind: "weekly",
  usedPercent: 44,
  durationMins: 10080,
  resetsAtMs: 1_791_580_401_000,
};
const now = 1_791_580_401_000 - 3 * 86_400_000;

it("measures a weekly window against the clock", () => {
  assert.equal(remainingPercent(weekly), 56);
  const elapsed = elapsedShare(weekly, now);
  assert.ok(elapsed !== null && Math.abs(elapsed - 4 / 7) < 1e-9);
  assert.equal(paceOf(weekly, now), "under");
  assert.equal(paceOf({ ...weekly, usedPercent: 60 }, now), "on");
  assert.equal(paceOf({ ...weekly, usedPercent: 70 }, now), "ahead");
  assert.equal(paceOf({ ...weekly, resetsAtMs: null }, now), null);
});

it("phrases the reset countdown", () => {
  assert.equal(formatResetsIn(weekly, now), "resets in 3d 0h");
  assert.equal(
    formatResetsIn(weekly, 1_791_580_401_000 - (2 * 60 + 13) * 60_000),
    "resets in 2h 13m",
  );
  assert.equal(formatResetsIn(weekly, 1_791_580_401_000), "resets now");
  assert.equal(formatResetsIn({ ...weekly, resetsAtMs: null }, now), null);
});

it("explains limits that have no bars to draw", () => {
  assert.equal(
    limitsNotice({ kind: "unsupported" }),
    "This account has no subscription limits.",
  );
  assert.equal(
    limitsNotice({ kind: "failed", message: "Codex is not signed in." }),
    "Codex is not signed in.",
  );
  assert.equal(
    limitsNotice({ kind: "reported", plan: null, windows: [] }),
    "No limits reported.",
  );
  assert.equal(
    limitsNotice({ kind: "reported", plan: null, windows: [weekly] }),
    null,
  );
});

it("matches only the bare /usage-limits command", () => {
  assert.equal(isUsageLimitsCommand("/usage-limits"), true);
  assert.equal(isUsageLimitsCommand("  /Usage-Limits \n"), true);
  assert.equal(isUsageLimitsCommand("/usage-limits now"), false);
  assert.equal(isUsageLimitsCommand("usage-limits"), false);
  assert.equal(isUsageLimitsCommand("/usage"), false);
});

it("changes the notice identity when the thread, turn or approval changes", () => {
  const open = usageNoticeKey("thread-1", "turn-1", null);
  assert.equal(usageNoticeKey("thread-1", "turn-1", null), open);
  assert.ok(usageNoticeKey("thread-2", "turn-1", null) !== open);
  assert.ok(usageNoticeKey("thread-1", "turn-2", null) !== open);
  assert.ok(usageNoticeKey("thread-1", "turn-1", "approval-1") !== open);
});
