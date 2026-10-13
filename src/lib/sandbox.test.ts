import assert from "node:assert/strict";
import { it } from "node:test";
import { inSandbox, terminalUnavailable } from "./sandbox.ts";

const worktree = { kind: "worktree" as const, path: "/w", branch: "b" };
const sandboxed = {
  ...worktree,
  sandbox: { kind: "docker" as const, id: "0123456789ab" },
};

it("tells a sandbox mirror from an ordinary worktree", () => {
  assert.equal(inSandbox(sandboxed), true);
  assert.equal(inSandbox(worktree), false);
  assert.equal(inSandbox({ kind: "local" }), false);
  assert.equal(inSandbox(undefined), false);
});

it("refuses the terminal in a sandbox with the reason the launcher shows", () => {
  assert.deepEqual(
    terminalUnavailable({ projectDraftOrThread: true, checkout: sandboxed }),
    {
      hint: "The sandbox terminal is not available yet.",
      reason: "The sandbox terminal is not available yet.",
    },
  );
  assert.equal(
    terminalUnavailable({ projectDraftOrThread: true, checkout: worktree }),
    null,
  );
  assert.equal(
    terminalUnavailable({ projectDraftOrThread: true, checkout: undefined }),
    null,
  );
  assert.equal(
    terminalUnavailable({ projectDraftOrThread: false, checkout: undefined })
      ?.hint,
    "Available when a project is open.",
  );
});
