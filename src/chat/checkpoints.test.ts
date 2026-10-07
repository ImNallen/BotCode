import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { QueryClient } from "@tanstack/react-query";
import { ipc, setThreadSnapshot, type Thread } from "../ipc";
import { buildTurnDiffTree, summarizeTurnDiffStats } from "../lib/turnDiffTree";
import {
  completedCheckpointTurns,
  selectedCheckpointTurn,
} from "../panel/turnDiffSelection";
import { deriveRows } from "./timelineRows";
import { Timeline } from "./Timeline";
import { EditFromHereDialog } from "./EditFromHereDialog";

const threadId = "018ba719-19f4-4fdb-bd79-aa4a676ea054";
const workspaceId = "018ba719-19f4-4fdb-bd79-aa4a676ea055";
const ids = [
  "018ba719-19f4-4fdb-bd79-aa4a676ea056",
  "018ba719-19f4-4fdb-bd79-aa4a676ea057",
  "018ba719-19f4-4fdb-bd79-aa4a676ea058",
];
const boundary = {
  reference: "refs/botcode/checkpoints/test/before",
  commit: "a".repeat(40),
};

function fixture(): Thread {
  return {
    id: threadId,
    workspaceId,
    title: "Checkpoint test",
    nativeThreadId: "native",
    revision: 4,
    session: { kind: "ready" },
    checkout: { kind: "local" },
    settings: {
      model: null,
      effort: null,
      permissionMode: "approval-required",
    },
    context: null,
    approvals: [],
    diagnostic: null,
    pendingRevert: null,
    lastRevert: null,
    turns: ids.map((id, index) => ({
      id,
      prompt: `Edit ${index + 1}`,
      attachments: [],
      nativeTurnId: `native-${index + 1}`,
      delivery: { kind: "accepted" },
      execution: { kind: "completed" },
      items: [
        {
          kind: "assistant",
          id: `reply-${index}`,
          text: "Done",
          complete: true,
        },
      ],
      settings: null,
      startedAtMs: index,
      completedAtMs: index + 1,
      checkpoint: {
        kind: "complete",
        before: boundary,
        after: boundary,
        files: [{ path: `turn-${index + 1}.txt`, additions: 1, deletions: 0 }],
      },
    })),
  };
}

it("selects turn 2's saved files and rejects a different thread or a reverted turn", () => {
  const thread = fixture();
  const second = thread.turns[1];
  assert.ok(second);
  const turnId = second.id;
  const selection = { threadId, turnId, filePath: null, request: 1 };
  const selected = selectedCheckpointTurn(thread, selection);
  assert.equal(selected?.number, 2);
  assert.equal(selected?.turn.checkpoint.kind, "complete");
  if (selected?.turn.checkpoint.kind === "complete")
    assert.deepEqual(
      selected.turn.checkpoint.files.map((file) => file.path),
      ["turn-2.txt"],
    );
  assert.deepEqual(
    completedCheckpointTurns(thread).map(({ number }) => number),
    [3, 2, 1],
  );
  assert.equal(
    selectedCheckpointTurn({ ...thread, id: workspaceId }, selection),
    undefined,
  );
  assert.equal(
    selectedCheckpointTurn(
      { ...thread, turns: thread.turns.slice(0, 1) },
      selection,
    ),
    undefined,
  );
});

it("ties Edit from here and each changed-files card to the owning turn", () => {
  const thread = fixture();
  const rows = deriveRows(thread, new Set(), new Set());
  assert.deepEqual(
    rows.filter((row) => row.kind === "user").map((row) => row.turnId),
    ids,
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "checkpoint").map((row) => row.turnId),
    ids,
  );
  const render = (busy: boolean) =>
    renderToStaticMarkup(
      createElement(Timeline, {
        thread,
        clearance: 0,
        reverting: false,
        busy,
        onEdit() {},
        onRemoveQueued() {},
        onOpenTurnDiff() {},
      }),
    );
  const ready = render(false);
  assert.equal(ready.match(/aria-label="Edit from here"/g)?.length, 3);
  assert.equal(ready.match(/aria-label="Open diff"/g)?.length, 3);
  assert.ok(ready.includes("turn-2.txt"));
  assert.equal(
    render(true).match(/disabled=""[^>]*aria-label="Edit from here"/g)?.length,
    3,
  );
});

it("groups nested changed files and excludes unknown binary counts from totals", () => {
  const files = [
    { path: "src/chat/a.ts", additions: 3, deletions: 2 },
    { path: "src/chat/b.ts", additions: 4, deletions: 1 },
    { path: "image.png", additions: null, deletions: null },
  ];
  assert.deepEqual(summarizeTurnDiffStats(files), {
    additions: 7,
    deletions: 3,
  });
  const tree = buildTurnDiffTree(files);
  assert.equal(tree[0]?.kind, "directory");
  assert.equal(tree[0]?.name, "src/chat");
  if (tree[0]?.kind === "directory") {
    assert.deepEqual(tree[0].stat, { additions: 7, deletions: 3 });
    assert.deepEqual(
      tree[0].children.map((node) => node.name),
      ["a.ts", "b.ts"],
    );
  }
  assert.equal(tree[1]?.kind, "file");
});

it("describes native forking and ignored-file coverage and offers only the persisted retry mode", () => {
  const thread = fixture();
  const second = thread.turns[1];
  assert.ok(second);
  const turnId = second.id;
  const render = () =>
    renderToStaticMarkup(
      createElement(EditFromHereDialog, {
        thread,
        turnId,
        working: false,
        error: undefined,
        onClose() {},
        onRevert() {},
        checkoutAvailable: true,
      }),
    );
  const initial = render();
  assert.ok(initial.includes("new Codex thread"));
  assert.ok(initial.includes("Ignored files stay as they are"));
  assert.ok(initial.includes("Revert files too"));
  thread.pendingRevert = { requestId: "saved-operation", turnId, files: true };
  const retry = render();
  assert.ok(retry.includes("Retry revert files too"));
  assert.ok(!retry.includes("Revert and keep changes"));
});

it("parses old saved turns as unavailable instead of inventing HEAD-based turn diffs", async () => {
  const old: Record<string, unknown> = { ...fixture() };
  old.turns = fixture().turns.map(
    ({ checkpoint: _checkpoint, ...turn }) => turn,
  );
  delete old.pendingRevert;
  old.lastRevert = {
    requestId: "legacy",
    turnId: ids[0],
    prompt: "Saved",
    turnCount: 3,
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  mockIPC(() => old);
  try {
    const parsed = await ipc.thread(threadId);
    assert.equal(parsed.pendingRevert, null);
    assert.deepEqual(parsed.lastRevert?.attachments, []);
    assert.deepEqual(parsed.turns[1]?.checkpoint, {
      kind: "unavailable",
      before: null,
      reason: "This turn predates checkpoints.",
    });
    assert.deepEqual(completedCheckpointTurns(parsed), []);
  } finally {
    clearMocks();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

it("ignores a stale revert snapshot after a later accepted send", () => {
  const client = new QueryClient();
  const current = fixture();
  setThreadSnapshot(client, current);
  setThreadSnapshot(client, {
    ...current,
    revision: current.revision - 1,
    lastRevert: {
      requestId: "old",
      turnId: ids[0] ?? "",
      prompt: "Old prompt",
      attachments: [],
      turnCount: 0,
    },
    turns: [],
  });
  assert.equal(
    client.getQueryData<Thread>(["thread", current.id])?.lastRevert,
    null,
  );
  assert.equal(
    client.getQueryData<Thread>(["thread", current.id])?.turns.length,
    3,
  );
});
