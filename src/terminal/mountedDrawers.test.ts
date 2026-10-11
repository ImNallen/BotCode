import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  drawerShouldHandle,
  placeDrawerHosts,
  reconcileMountedOwners,
  reconcileMountedTerminalThreadIds,
  type TerminalOwner,
} from "./mountedDrawers.ts";

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps open threads and makes the active thread most recent", () => {
    assert.deepEqual(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["thread-a", "thread-b", "thread-c"],
        openThreadIds: ["thread-a", "thread-b", "thread-c"],
        activeThreadId: "thread-a",
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
      ["thread-b", "thread-c", "thread-a"],
    );
  });

  it("drops closed threads and enforces the hidden mounted cap", () => {
    const ids = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => `thread-${index}`,
    );
    assert.deepEqual(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ids,
        openThreadIds: ids.slice(1),
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
      [
        "thread-2",
        "thread-3",
        "thread-4",
        "thread-5",
        "thread-6",
        "thread-7",
        "thread-8",
        "thread-9",
        "thread-10",
        "thread-11",
      ],
    );
  });

  it("mounts the active thread only while its drawer is open", () => {
    const input = {
      currentThreadIds: [],
      openThreadIds: ["x"],
      activeThreadId: "x",
    };
    assert.deepEqual(
      reconcileMountedTerminalThreadIds({
        ...input,
        activeThreadTerminalOpen: true,
      }),
      ["x"],
    );
    assert.deepEqual(
      reconcileMountedTerminalThreadIds({
        ...input,
        activeThreadTerminalOpen: false,
      }),
      [],
    );
  });

  it("unmounts the active thread when its drawer closes", () => {
    assert.deepEqual(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["a", "b"],
        openThreadIds: ["a"],
        activeThreadId: "b",
        activeThreadTerminalOpen: false,
      }),
      ["a"],
    );
  });

  it("keeps the order when the active thread is already most recent", () => {
    assert.deepEqual(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["a", "b"],
        openThreadIds: ["a", "b"],
        activeThreadId: "b",
        activeThreadTerminalOpen: true,
      }),
      ["a", "b"],
    );
  });

  it("drops a recent hidden thread whose drawer is no longer open", () => {
    assert.deepEqual(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: ["a", "b"],
        openThreadIds: ["b"],
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
      ["b"],
    );
  });
});

describe("reconcileMountedOwners", () => {
  const a: TerminalOwner = { workspaceId: "w1", threadId: "a" };
  const b: TerminalOwner = { workspaceId: "w2", threadId: "b" };
  const draft: TerminalOwner = { workspaceId: "w1", threadId: null };

  it("keeps a hidden drawer from another project mounted", () => {
    assert.deepEqual(
      reconcileMountedOwners({
        current: [a],
        openScopes: new Set(["a", "b"]),
        liveWorkspaces: new Set(["w1", "w2"]),
        active: b,
        activeOpen: true,
      }),
      [a, b],
    );
  });

  it("drops drawers of removed projects", () => {
    assert.deepEqual(
      reconcileMountedOwners({
        current: [a, b],
        openScopes: new Set(["a", "b"]),
        liveWorkspaces: new Set(["w1"]),
        active: null,
        activeOpen: false,
      }),
      [a],
    );
  });

  it("drops a deleted thread, whose terminal state is forgotten", () => {
    assert.deepEqual(
      reconcileMountedOwners({
        current: [a, b],
        openScopes: new Set(["b"]),
        liveWorkspaces: new Set(["w1", "w2"]),
        active: null,
        activeOpen: false,
      }),
      [b],
    );
  });

  it("keys a project draft's drawer by its draft scope", () => {
    assert.deepEqual(
      reconcileMountedOwners({
        current: [draft],
        openScopes: new Set(["draft:w1"]),
        liveWorkspaces: new Set(["w1"]),
        active: a,
        activeOpen: false,
      }),
      [draft],
    );
  });

  it("returns the same list when nothing changed", () => {
    const current = [a, b];
    assert.equal(
      reconcileMountedOwners({
        current,
        openScopes: new Set(["a", "b"]),
        liveWorkspaces: new Set(["w1", "w2"]),
        active: { workspaceId: "w2", threadId: "b" },
        activeOpen: true,
      }),
      current,
    );
  });
});

describe("placeDrawerHosts", () => {
  it("puts the active drawer in the slot and parks the rest", () => {
    assert.deepEqual(
      [...placeDrawerHosts(["a", "b"], "b")],
      [
        ["a", "parking"],
        ["b", "slot"],
      ],
    );
  });

  it("parks every drawer when no conversation is shown", () => {
    assert.deepEqual([...placeDrawerHosts(["a"], null)], [["a", "parking"]]);
  });
});

describe("drawerShouldHandle", () => {
  it("handles terminal shortcuts only in the focused active drawer", () => {
    assert.equal(
      drawerShouldHandle("terminal.split", { active: true, focused: true }),
      true,
    );
    assert.equal(
      drawerShouldHandle("terminal.split", { active: true, focused: false }),
      false,
    );
    assert.equal(
      drawerShouldHandle("terminal.new", { active: false, focused: true }),
      false,
    );
    assert.equal(
      drawerShouldHandle("terminal.close", { active: false, focused: false }),
      false,
    );
  });

  it("leaves Command+J to the conversation", () => {
    assert.equal(
      drawerShouldHandle("terminal.toggle", { active: true, focused: true }),
      false,
    );
  });
});
