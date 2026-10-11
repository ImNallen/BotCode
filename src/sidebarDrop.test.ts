import assert from "node:assert/strict";
import { it } from "node:test";
import { partitionSidebarRows, sidebarListItems } from "./Sidebar";
import {
  planSidebarThreadDrop,
  releasesSidebarDrop,
  resolveSidebarDropTarget,
  sidebarDropCommands,
  type SidebarOptimisticDrop,
} from "./sidebarDrop";
import type { Arrange, ThreadSummary } from "./ipc";

const summary: ThreadSummary = {
  id: "thread",
  revision: 1,
  title: "Thread",
  checkout: { kind: "local" },
  session: { kind: "dormant" },
  latestTurn: null,
  pendingApprovalIds: [],
  pendingUserQuestionIds: [],
  awaitingApproval: false,
  createdAtMs: 1,
  updatedAtMs: 1,
  archivedAtMs: null,
  pinnedAtMs: null,
  pinOrderKey: null,
  activeOrderKey: null,
  snoozedUntilMs: null,
  wokeAtMs: null,
  autoSettleEnabled: true,
  isRegeneratingTitle: false,
  settledAtMs: null,
  pullRequests: {
    sequence: 0,
    links: [],
    discovering: false,
    discoveryError: null,
  },
};
const workspace = {
  id: "project",
  root: "/project",
  label: "Project",
  kind: "repository" as const,
  projectIcon: null,
  faviconPath: null,
};
type Row = Parameters<typeof partitionSidebarRows>[0]["rows"][number];
const row = (id: string, patch: Partial<ThreadSummary> = {}): Row => ({
  workspace,
  branch: "main",
  thread: { ...summary, id, ...patch },
});
const pin = (id: string, key: string | null, createdAtMs = 1) =>
  row(id, { pinnedAtMs: 1, pinOrderKey: key, createdAtMs });
const base = {
  query: "",
  scopeId: undefined,
  openThreadId: undefined,
  now: 50,
  snoozedExpanded: true,
  settledExpanded: true,
  settledVisibleCount: 10,
};
const order = (rows: Row[], workingEnabled = false) => {
  const sections = partitionSidebarRows({ ...base, rows, workingEnabled });
  return {
    pinned: sections.pinned.map((r) => r.thread.id),
    active: sections.active.map((r) => r.thread.id),
  };
};

function dragOnto(
  rows: Row[],
  activeKey: string,
  overId: string,
  workingEnabled = false,
) {
  const sections = partitionSidebarRows({ ...base, rows, workingEnabled });
  const items = sidebarListItems(sections);
  const source = items.find(
    (item) => item.kind === "thread" && item.key === activeKey,
  );
  assert.ok(source?.kind === "thread");
  const target = resolveSidebarDropTarget(items, activeKey, overId);
  assert.ok(target);
  const thread = rows.find((r) => r.thread.id === activeKey)!.thread;
  const plan = planSidebarThreadDrop({
    activeKey,
    activeSection: source.section,
    activePinned: thread.pinnedAtMs !== null,
    activeSettled: thread.settledAtMs !== null,
    target,
    pinnedOrder: sections.pinned.map((r) => r.thread.id),
    pinnedKeysById: new Map(
      rows.map((r) => [r.thread.id, r.thread.pinOrderKey]),
    ),
    activeOrder: sections.active.map((r) => r.thread.id),
    activeKeysById: new Map(
      rows.map((r) => [r.thread.id, r.thread.activeOrderKey]),
    ),
    activeTimeOrdered: workingEnabled,
  });
  assert.notEqual(plan.kind, "settle");
  return plan.kind === "settle" ? [] : sidebarDropCommands(activeKey, plan);
}

function apply(
  rows: Row[],
  commands: ReadonlyArray<{ threadId: string; action: Arrange }>,
) {
  return rows.map((r) => {
    let thread = r.thread;
    for (const { threadId, action } of commands) {
      if (threadId !== thread.id) continue;
      if (action.kind === "reorder_pin")
        thread = { ...thread, pinOrderKey: action.orderKey };
      else if (action.kind === "reorder_active")
        thread = { ...thread, activeOrderKey: action.orderKey };
      else if (action.kind === "pin")
        thread = {
          ...thread,
          pinnedAtMs: 99,
          pinOrderKey: action.orderKey ?? null,
        };
      else assert.fail(`unexpected ${action.kind}`);
    }
    return { ...r, thread };
  });
}

const keyOf = (
  commands: ReadonlyArray<{ threadId: string; action: Arrange }>,
) => {
  assert.equal(commands.length, 1);
  const { action } = commands[0]!;
  assert.ok("orderKey" in action && action.orderKey !== undefined);
  return action.orderKey;
};

it("sorts arranged pins by key above keyless pins, newest created first", () => {
  assert.deepEqual(
    order([
      pin("t-key", "t", 1),
      pin("f-key", "f", 2),
      pin("old-keyless", null, 3),
      pin("new-keyless", null, 9),
    ]).pinned,
    ["f-key", "t-key", "new-keyless", "old-keyless"],
  );
});

it("leads active with new and reopened keyless threads, then the arranged run, ignoring activity", () => {
  assert.deepEqual(
    order([
      row("m-key", { activeOrderKey: "m", createdAtMs: 1, updatedAtMs: 999 }),
      row("new", { createdAtMs: 5 }),
      row("reopened", { createdAtMs: 2, unsettledAtMs: 8 }),
      row("c-key", { activeOrderKey: "c", createdAtMs: 9 }),
    ]).active,
    ["reopened", "new", "c-key", "m-key"],
  );
});

const pinnedRun = () => [pin("p1", "f"), pin("p2", "m"), pin("p3", "t")];

it("writes one key between the pinned neighbors a card is dropped between", () => {
  const rows = pinnedRun();
  const commands = dragOnto(rows, "p3", "p2");
  assert.equal(commands[0]!.threadId, "p3");
  assert.equal(commands[0]!.action.kind, "reorder_pin");
  const key = keyOf(commands);
  assert.ok(key > "f" && key < "m");
  assert.deepEqual(order(apply(rows, commands)).pinned, ["p1", "p3", "p2"]);
});

it("writes a key above the first pin and below the last pin at the ends", () => {
  const rows = pinnedRun();
  const top = dragOnto(rows, "p3", "p1");
  assert.ok(keyOf(top) < "f");
  assert.deepEqual(order(apply(rows, top)).pinned, ["p3", "p1", "p2"]);
  const bottom = dragOnto(rows, "p1", "p3");
  assert.ok(keyOf(bottom) > "t");
  assert.deepEqual(order(apply(rows, bottom)).pinned, ["p2", "p3", "p1"]);
});

it("materializes keys for the whole section once when a neighbor is keyless", () => {
  const rows = [
    pin("newest", null, 3),
    pin("middle", null, 2),
    pin("oldest", null, 1),
  ];
  const commands = dragOnto(rows, "oldest", "newest");
  assert.deepEqual(
    commands.map(({ threadId, action }) => [threadId, action.kind]),
    [
      ["oldest", "reorder_pin"],
      ["newest", "reorder_pin"],
      ["middle", "reorder_pin"],
    ],
  );
  const arranged = apply(rows, commands);
  assert.deepEqual(order(arranged).pinned, ["oldest", "newest", "middle"]);
  const next = dragOnto(arranged, "middle", "newest");
  assert.equal(next.length, 1);
  assert.deepEqual(order(apply(arranged, next)).pinned, [
    "oldest",
    "middle",
    "newest",
  ]);
});

it("reorders the active list with active keys and leaves pins alone", () => {
  const rows = [
    pin("p1", "f"),
    row("a1", { activeOrderKey: "f" }),
    row("a2", { activeOrderKey: "m" }),
    row("a3", { activeOrderKey: "t" }),
  ];
  const commands = dragOnto(rows, "a1", "a2");
  assert.equal(commands[0]!.action.kind, "reorder_active");
  const key = keyOf(commands);
  assert.ok(key > "m" && key < "t");
  assert.deepEqual(order(apply(rows, commands)), {
    pinned: ["p1"],
    active: ["a2", "a1", "a3"],
  });
});

it("pins an active card dropped into the pinned block at the drop position", () => {
  const rows = [...pinnedRun(), row("a1")];
  const commands = dragOnto(rows, "a1", "p2");
  assert.deepEqual(
    commands.map(({ action }) => action.kind),
    ["pin"],
  );
  const key = keyOf(commands);
  assert.ok(key > "f" && key < "m");
  assert.deepEqual(order(apply(rows, commands)).pinned, [
    "p1",
    "a1",
    "p2",
    "p3",
  ]);
});

it("unpins a pinned card dragged into the active list", () => {
  const rows = [...pinnedRun(), row("a1", { activeOrderKey: "m" })];
  const commands = dragOnto(rows, "p1", "a1");
  assert.deepEqual(
    commands.map(({ threadId, action }) => [threadId, action.kind]),
    [
      ["p1", "unpin"],
      ["p1", "reorder_active"],
    ],
  );
});

it("keeps the time-ordered inbox unarrangeable while Working is on, but pins still reorder", () => {
  const rows = [
    ...pinnedRun(),
    row("a1", { activeOrderKey: "f" }),
    row("a2", { activeOrderKey: "m" }),
  ];
  assert.deepEqual(dragOnto(rows, "a1", "a2", true), []);
  const pins = dragOnto(rows, "p3", "p1", true);
  assert.deepEqual(order(apply(rows, pins), true).pinned, ["p3", "p1", "p2"]);
});

it("holds a dropped order until its key write lands, then releases it", () => {
  const rows = pinnedRun();
  const drop: SidebarOptimisticDrop = {
    key: "p3",
    sourceSection: "pinned",
    section: "pinned",
    atMs: 10,
    clearsSnooze: false,
    order: ["p1", "p3", "p2"],
    keysAtDrop: new Map([
      ["p1", "f"],
      ["p2", "m"],
      ["p3", "t"],
    ]),
    assignedKeys: new Map([["p3", "h"]]),
  };
  const releases = (rows: Row[]) =>
    releasesSidebarDrop({
      drop,
      threadsById: new Map(rows.map((r) => [r.thread.id, r.thread])),
      destinationIds: ["p1", "p3", "p2"],
      nowMs: 50,
    });
  const held = partitionSidebarRows({ ...base, rows, drop });
  assert.deepEqual(
    held.pinned.map((r) => r.thread.id),
    ["p1", "p3", "p2"],
  );
  assert.equal(releases(rows), false);
  assert.equal(
    releases(
      rows.map((r) =>
        r.thread.id === "p3"
          ? { ...r, thread: { ...r.thread, pinOrderKey: "h" } }
          : r,
      ),
    ),
    true,
  );
});
