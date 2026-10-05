import assert from "node:assert/strict";
import { it } from "node:test";
import {
  checkStatus,
  checksRollup,
  prChecks,
  summarizeChecks,
} from "./prChecks.ts";

function checks(...states: string[]) {
  return prChecks(
    states.map((state, index) => ({
      name: `check ${index}`,
      state,
      url: null,
    })),
  );
}

it("maps every GitHub check state to T3's check status", () => {
  const expected = {
    SUCCESS: "success",
    FAILURE: "failure",
    ERROR: "failure",
    TIMED_OUT: "failure",
    STARTUP_FAILURE: "failure",
    CANCELLED: "cancelled",
    SKIPPED: "skipped",
    NEUTRAL: "neutral",
    STALE: "neutral",
    ACTION_REQUIRED: "action-required",
    QUEUED: "pending",
    IN_PROGRESS: "pending",
    PENDING: "pending",
    WAITING: "pending",
    REQUESTED: "pending",
    EXPECTED: "pending",
    COMPLETED: "neutral",
    toString: "neutral",
  } as const;
  for (const [state, status] of Object.entries(expected))
    assert.equal(checkStatus(state), status, state);
});

it("lets a failing check outrank running ones in the rollup and summary", () => {
  const mixed = checks("IN_PROGRESS", "TIMED_OUT", "SUCCESS");
  assert.equal(checksRollup(mixed), "failing");
  assert.equal(summarizeChecks(mixed), "1 of 3 failing");
  assert.equal(checksRollup(checks("CANCELLED", "QUEUED")), "failing");
});

it("counts only known running states as running", () => {
  const running = checks("QUEUED", "IN_PROGRESS", "SUCCESS");
  assert.equal(checksRollup(running), "pending");
  assert.equal(summarizeChecks(running), "2 of 3 running");
  const unknown = checks("SOMETHING_NEW", "SUCCESS");
  assert.equal(checksRollup(unknown), "passing");
  assert.equal(summarizeChecks(unknown), "1 of 2 passing");
});

it("reports passing, empty and skipped-only check sets", () => {
  assert.equal(
    summarizeChecks(checks("SUCCESS", "SUCCESS")),
    "All checks passed",
  );
  assert.equal(checksRollup(checks("SUCCESS")), "passing");
  assert.equal(summarizeChecks([]), "No checks reported");
  assert.equal(checksRollup([]), null);
  assert.equal(checksRollup(checks("SKIPPED", "NEUTRAL")), null);
});

it("separates workflow approvals from other checks awaiting action", () => {
  const approval = prChecks([
    {
      name: "CI",
      state: "ACTION_REQUIRED",
      url: "https://github.com/fixture/project/actions/runs/12",
    },
    { name: "External", state: "ACTION_REQUIRED", url: null },
  ]);
  assert.equal(checksRollup(approval), "pending");
  assert.equal(
    summarizeChecks(approval),
    "1 workflow and 1 check awaiting action",
  );
});
