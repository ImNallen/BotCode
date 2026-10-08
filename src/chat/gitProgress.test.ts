import assert from "node:assert/strict";
import { it } from "node:test";
import { initialGitProgress, updateGitProgress } from "./gitProgress.ts";

it("hook and output events preserve the phase clock and retain failed hook output", () => {
  let state = updateGitProgress(
    initialGitProgress,
    { kind: "phase", phase: { kind: "commit" } },
    100,
  );
  state = updateGitProgress(
    state,
    { kind: "hook_started", name: "pre-commit" },
    300,
  );
  state = updateGitProgress(
    state,
    { kind: "output", stream: "stderr", line: "validation failed" },
    800,
  );
  state = updateGitProgress(
    state,
    { kind: "hook_finished", name: "pre-commit", code: 7 },
    900,
  );
  assert.equal(state.phaseStartedAtMs, 100);
  assert.deepEqual(state.phase, { kind: "commit" });
  assert.deepEqual(state.hooks, []);
  assert.deepEqual(state.lines, [
    "Running pre-commit hook...",
    "validation failed",
    "pre-commit hook failed (exit 7).",
  ]);
  const push = updateGitProgress(
    state,
    { kind: "phase", phase: { kind: "push", remote: "origin" } },
    1000,
  );
  assert.equal(push.phaseStartedAtMs, 1000);
  assert.deepEqual(push.lines, state.lines);
});

it("long-running hooks retain a bounded tail while accepting later events", () => {
  let state = initialGitProgress;
  for (let i = 0; i < 500; i++) {
    state = updateGitProgress(
      state,
      { kind: "output", stream: "stdout", line: `${i} ${"x".repeat(10000)}` },
      i,
    );
  }
  assert.equal(state.lines.length, 200);
  assert.ok(state.lines.every((line) => line.length <= 2000));
  assert.ok(state.lines[0]?.startsWith("300 "));
  assert.ok(state.lines.at(-1)?.startsWith("499 "));
});
