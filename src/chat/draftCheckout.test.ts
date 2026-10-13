import assert from "node:assert/strict";
import { it } from "node:test";
import {
  draftNewCheckout,
  picksBase,
  sandboxOption,
  type DraftCheckout,
} from "./draftCheckout.ts";

const mac: DraftCheckout = {
  placement: "mac",
  mode: "local",
  base: null,
  fromOrigin: false,
};

it("sends a sandbox checkout with the chosen base whatever the Mac workspace mode", () => {
  for (const mode of ["local", "worktree"] as const) {
    const draft: DraftCheckout = { ...mac, placement: "sandbox", mode };
    assert.equal(picksBase(draft), true);
    assert.deepEqual(draftNewCheckout(draft, "main", true), {
      kind: "sandbox",
      base: "main",
      fromOrigin: true,
    });
  }
});

it("keeps the Mac workspace mode on This Mac", () => {
  assert.equal(picksBase(mac), false);
  assert.deepEqual(draftNewCheckout(mac, "main", true), { kind: "local" });
  const worktree: DraftCheckout = { ...mac, mode: "worktree" };
  assert.equal(picksBase(worktree), true);
  assert.deepEqual(draftNewCheckout(worktree, "dev", false), {
    kind: "worktree",
    base: "dev",
    fromOrigin: false,
  });
});

it("offers Sandbox only once the core reports it ready", () => {
  assert.deepEqual(sandboxOption(undefined, undefined), { kind: "checking" });
  assert.deepEqual(
    sandboxOption(
      {
        kind: "unavailable",
        reason:
          "Docker Desktop is not running. Start Docker Desktop to use sandboxes.",
      },
      undefined,
    ),
    {
      kind: "unavailable",
      reason:
        "Docker Desktop is not running. Start Docker Desktop to use sandboxes.",
    },
  );
  assert.deepEqual(sandboxOption(undefined, "IPC failed"), {
    kind: "unavailable",
    reason: "IPC failed",
  });
  assert.deepEqual(
    sandboxOption(
      { kind: "ready", memoryBytes: 32 * 1024 ** 3, lowMemory: false },
      undefined,
    ),
    { kind: "ready", note: null },
  );
});

it("names Docker Desktop's memory setting when memory is low", () => {
  const option = sandboxOption(
    { kind: "ready", memoryBytes: 4 * 1024 ** 3, lowMemory: true },
    undefined,
  );
  assert.deepEqual(option, {
    kind: "ready",
    note: "Docker has 4.0 GB of memory. Raise it in Docker Desktop > Settings > Resources > Memory.",
  });
});
