import assert from "node:assert/strict";
import { it } from "node:test";
import { inSandbox, sandboxLabel } from "./sandbox.ts";

const worktree = { kind: "worktree" as const, path: "/w", branch: "b" };
const sandboxed = {
  ...worktree,
  sandbox: { kind: "docker" as const, id: "0123456789ab" },
};

it("names the state only while the sandbox is paused or stopped", () => {
  assert.equal(sandboxLabel("paused"), "Sandbox \u00b7 paused");
  assert.equal(sandboxLabel("stopped"), "Sandbox \u00b7 stopped");
  assert.equal(sandboxLabel("running"), "Sandbox");
  assert.equal(sandboxLabel("starting"), "Sandbox");
  assert.equal(sandboxLabel(undefined), "Sandbox");
});

it("tells a sandbox mirror from an ordinary worktree", () => {
  assert.equal(inSandbox(sandboxed), true);
  assert.equal(inSandbox(worktree), false);
  assert.equal(inSandbox({ kind: "local" }), false);
  assert.equal(inSandbox(undefined), false);
});
