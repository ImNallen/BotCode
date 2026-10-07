// Ported from pingdotgg/t3code v0.0.45 components/files/useFileSaveCoordinator.test.tsx (MIT).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import type { CheckoutRef } from "../ipc";
import { mockIpc } from "../test/mockIpc";
import { advanceTimersByTimeAsync, runAllTimersAsync } from "../test/timers";
import { readFileDraft, readPendingFiles, setFileDraft } from "./fileDrafts";
import { createFileSaveSession } from "./useFileSaveCoordinator";

type Write = {
  workspaceId: string;
  threadId: string | null;
  path: string;
  contents: string;
};

const checkout = { workspaceId: "workspace", threadId: "thread" };
let client: QueryClient;
let writes: Write[];
let failWrites = false;
let restoreIpc = () => {};

// Mounts the session the way StrictMode does: setup, cleanup, setup again.
function mount(target: CheckoutRef, path: string) {
  const session = createFileSaveSession(client, target, path);
  session.setup()();
  const unmount = session.setup();
  return { change: session.change, unmount };
}

describe("file-save session lifecycle", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    client = new QueryClient();
    writes = [];
    failWrites = false;
    restoreIpc = mockIpc((command, args) => {
      if (command === "write_file") {
        if (failWrites) throw { code: "io", message: "disk full" };
        writes.push(args as Write);
        return null;
      }
      if (command === "read_file") {
        const { path } = args as { path: string };
        const written = writes.findLast((write) => write.path === path);
        return { kind: "text", name: path, contents: written?.contents ?? "" };
      }
      throw new Error(`Unexpected command ${command}`);
    });
  });
  afterEach(() => {
    restoreIpc();
    client.clear();
    mock.timers.reset();
  });

  it("persists editor model changes after StrictMode setup replay", async () => {
    const path = "file.txt";
    const surface = mount(checkout, path);
    setFileDraft(checkout, path, "AUDIT7907NATIVE\n");
    surface.change("AUDIT7907NATIVE\n");
    assert.ok(readPendingFiles(checkout).has(path));

    await advanceTimersByTimeAsync(500);
    assert.deepEqual(writes, [
      {
        workspaceId: "workspace",
        threadId: "thread",
        path,
        contents: "AUDIT7907NATIVE\n",
      },
    ]);
    assert.equal(readFileDraft(checkout, path), undefined);
    assert.ok(!readPendingFiles(checkout).has(path));
    surface.unmount();
  });

  it("keeps a failed write pending and reports it with a warning", async () => {
    const path = "failed.txt";
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    failWrites = true;
    const surface = mount(checkout, path);
    setFileDraft(checkout, path, "unsaved");
    surface.change("unsaved");
    await advanceTimersByTimeAsync(500);
    console.warn = warn;

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.[0], "[file-save] write failed");
    assert.ok(readPendingFiles(checkout).has(path));
    assert.deepEqual(readFileDraft(checkout, path), {
      contents: "unsaved",
      confirmed: false,
    });
    failWrites = false;
    surface.unmount();
    await runAllTimersAsync();
    assert.ok(!readPendingFiles(checkout).has(path));
  });

  it("flushes on unmount and ignores a retired editor callback", async () => {
    const surface = mount(checkout, "flush.txt");
    surface.change("pending edit");
    surface.unmount();
    surface.change("stale editor contents");
    await runAllTimersAsync();

    assert.deepEqual(
      writes.map((write) => write.contents),
      ["pending edit"],
    );
  });

  for (const change of [
    { path: "other.txt" },
    { threadId: "other-thread" },
    { workspaceId: "other-workspace" },
  ])
    it(`retires callbacks when the file identity changes: ${JSON.stringify(change)}`, async () => {
      const before = { ...checkout, path: "identity.txt" };
      const after = { ...before, ...change };
      const retired = mount(before, before.path);
      retired.change("old file edit");
      retired.unmount();
      const current = mount(after, after.path);
      retired.change("stale editor contents");
      current.change("new file edit");
      await runAllTimersAsync();

      assert.deepEqual(writes, [
        { ...before, contents: "old file edit" },
        { ...after, contents: "new file edit" },
      ]);
      current.unmount();
    });

  it("does not reactivate a retired callback when the same file mounts again", async () => {
    const path = "remount.txt";
    const retired = mount(checkout, path);
    retired.unmount();
    const current = mount(checkout, path);
    retired.change("stale contents");
    current.change("current contents");
    await runAllTimersAsync();

    assert.deepEqual(
      writes.map((write) => write.contents),
      ["current contents"],
    );
    current.unmount();
  });
});
