import assert from "node:assert/strict";
import { it } from "node:test";
import { inSandbox } from "./sandbox.ts";

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
