// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/threadActionMenu.logic.test.ts (MIT).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildThreadActionMenuItems,
  sidebarThreadMenuSupports,
  type ThreadActionMenuItem,
  type ThreadActionMenuState,
} from "./threadActionMenu";

const sidebarState: ThreadActionMenuState = {
  branch: null,
  projectFilter: { label: "Beta Project", isActive: false },
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRenamePending: false,
  isRunning: false,
  supports: sidebarThreadMenuSupports,
  snoozePresets: [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: "3:00 PM",
      untilMs: Date.parse("2026-08-07T15:00:00Z"),
    },
  ],
};

const fullState: ThreadActionMenuState = {
  ...sidebarState,
  projectFilter: null,
  supports: {
    newThreadOnBranch: true,
    autoSettleOptOut: true,
    titleRegeneration: true,
  },
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

function labels(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.label);
}

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReadonlyArray<ThreadActionMenuItem>): string[] =>
    items.flatMap((item) => [
      item.id,
      ...(item.children ? flatten(item.children) : []),
    ]);
  return flatten(buildThreadActionMenuItems(state));
}

function find(state: ThreadActionMenuState, id: string) {
  return buildThreadActionMenuItems(state).find((item) => item.id === id);
}

describe("buildThreadActionMenuItems", () => {
  it("lists the sidebar menu of an active thread in T3's order", () => {
    assert.deepEqual(labels(sidebarState), [
      "Pin thread",
      "Settle thread",
      "Snooze",
      "Rename thread",
      "Regenerate title",
      "Mark unread",
      "Filter by Beta Project",
      "Auto-settle behavior",
      "Copy",
      "Project settings",
      "Archive thread",
      "Delete",
    ]);
    assert.deepEqual(
      buildThreadActionMenuItems(sidebarState)
        .filter((item) => item.separatorBefore)
        .map((item) => item.id),
      ["rename", "copy", "archive"],
    );
  });

  it("flips lifecycle labels with thread state", () => {
    assert.deepEqual(
      ids({
        ...sidebarState,
        isPinned: true,
        isSettled: true,
        isSnoozed: true,
      }),
      [
        "unpin",
        "unsettle",
        "unsnooze",
        "rename",
        "regenerate-title",
        "mark-unread",
        "filter-by-project",
        "auto-settle",
        "copy",
        "project-settings",
        "archive",
        "delete",
      ],
    );
    assert.deepEqual(
      labels({
        ...sidebarState,
        isPinned: true,
        isSettled: true,
        isSnoozed: true,
      }).slice(0, 3),
      ["Unpin thread", "Un-settle thread", "Wake thread"],
    );
    assert.deepEqual(ids(sidebarState).slice(0, 3), [
      "pin",
      "settle",
      "snooze",
    ]);
  });

  it("offers the snooze presets and Custom… after a separator", () => {
    const snooze = find(sidebarState, "snooze");
    assert.deepEqual(
      snooze?.children?.map((child) => [
        child.id,
        child.label,
        child.separatorBefore ?? false,
      ]),
      [
        ["snooze:hour", "In 1 hour (3:00 PM)", false],
        ["snooze:custom", "Custom…", true],
      ],
    );
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = find({ ...sidebarState, canSnoozeNow: false }, "snooze");
    assert.equal(snooze?.disabled, true);
    assert.deepEqual(
      snooze?.children?.map((child) => child.id),
      ["snooze:hour", "snooze:custom"],
    );
  });

  it("offers project filtering only for surfaces with a scoped thread list", () => {
    assert.ok(
      !ids({ ...sidebarState, projectFilter: null }).includes(
        "filter-by-project",
      ),
    );
    assert.deepEqual(find(sidebarState, "filter-by-project"), {
      id: "filter-by-project",
      label: "Filter by Beta Project",
      icon: "folder-tree",
    });
  });

  it("offers the way back to all projects once the list is scoped", () => {
    const items = buildThreadActionMenuItems({
      ...sidebarState,
      projectFilter: { label: "Beta Project", isActive: true },
    });
    const filterIndex = items.findIndex(
      (item) => item.id === "filter-by-project",
    );
    assert.equal(items[filterIndex]?.label, "Show all projects");
    assert.equal(items[filterIndex]?.icon, "folder-tree");
    assert.equal(items[filterIndex - 1]?.id, "mark-unread");
    assert.equal(items[filterIndex + 1]?.id, "auto-settle");
  });

  it("filters a thread without a project by the No project list", () => {
    assert.ok(
      labels({
        ...sidebarState,
        projectFilter: { label: "No project", isActive: false },
      }).includes("Filter by No project"),
    );
    assert.ok(ids(sidebarState).includes("project-settings"));
  });

  it("groups project settings with utility actions before archive", () => {
    const items = buildThreadActionMenuItems(fullState);
    const copyIndex = items.findIndex((item) => item.id === "copy");
    assert.deepEqual(items[copyIndex + 1], {
      id: "project-settings",
      label: "Project settings",
      icon: "settings",
    });
    assert.equal(items[copyIndex + 2]?.id, "archive");
  });

  it("shows Mark unread with T3's icon after Rename", () => {
    const items = buildThreadActionMenuItems(sidebarState);
    const index = items.findIndex((item) => item.id === "mark-unread");
    assert.deepEqual(items[index], {
      id: "mark-unread",
      label: "Mark unread",
      icon: "mail-open",
    });
    assert.equal(items[index - 1]?.id, "regenerate-title");
    assert.equal(items[index - 2]?.id, "rename");
  });

  it("offers Regenerate title with T3's icon while none is in flight", () => {
    assert.deepEqual(find(sidebarState, "regenerate-title"), {
      id: "regenerate-title",
      label: "Regenerate title",
      icon: "refresh-cw",
      disabled: false,
    });
    assert.equal(find(sidebarState, "auto-settle")?.icon, "timer");
  });

  it("copies a branch only for threads with one", () => {
    assert.deepEqual(
      find({ ...sidebarState, branch: "feat/menu" }, "copy")?.children?.map(
        (child) => child.id,
      ),
      ["copy-path", "copy-branch", "copy-thread-id"],
    );
    assert.deepEqual(
      find(sidebarState, "copy")?.children?.map((child) => child.id),
      ["copy-path", "copy-thread-id"],
    );
  });

  it("keeps entries Bot Code cannot run yet out of the menu", () => {
    const withBranch = allIds({ ...sidebarState, branch: "feat/menu" });
    assert.ok(!withBranch.includes("new-thread-on-branch"));
    const unsupported = allIds({
      ...sidebarState,
      supports: {
        newThreadOnBranch: false,
        autoSettleOptOut: false,
        titleRegeneration: false,
      },
    });
    for (const id of [
      "regenerate-title",
      "auto-settle",
      "auto-settle:enabled",
      "auto-settle:disabled",
    ])
      assert.ok(!unsupported.includes(id), id);
  });

  it("includes New thread on branch only for threads with a branch", () => {
    assert.deepEqual(
      find({ ...fullState, branch: "feat/menu" }, "new-thread-on-branch"),
      {
        id: "new-thread-on-branch",
        label: "New thread on feat/menu",
        icon: "message-square-plus",
      },
    );
    assert.ok(!allIds(fullState).includes("new-thread-on-branch"));
  });

  it("offers auto-settle as a submenu with the current option checked", () => {
    const on = find(fullState, "auto-settle");
    assert.equal(on?.label, "Auto-settle behavior");
    assert.deepEqual(
      on?.children?.map((child) => [child.id, child.checked]),
      [
        ["auto-settle:enabled", true],
        ["auto-settle:disabled", false],
      ],
    );
    const off = find({ ...fullState, autoSettleEnabled: false }, "auto-settle");
    assert.deepEqual(
      off?.children?.map((child) => child.checked),
      [false, true],
    );
    const items = buildThreadActionMenuItems(fullState);
    assert.equal(
      items[items.findIndex((item) => item.id === "mark-unread") + 1]?.id,
      "auto-settle",
    );
  });

  it("disables title regeneration while one is in flight", () => {
    const item = find(
      { ...fullState, isRegeneratingTitle: true },
      "regenerate-title",
    );
    assert.equal(item?.label, "Regenerating…");
    assert.equal(item?.disabled, true);
  });

  it("disables Rename while a rename is saving", () => {
    assert.equal(find(sidebarState, "rename")?.disabled, false);
    assert.equal(
      find({ ...sidebarState, isRenamePending: true }, "rename")?.disabled,
      true,
    );
  });

  it("marks delete as destructive and keeps it last", () => {
    const items = buildThreadActionMenuItems({ ...fullState, branch: "main" });
    assert.equal(items.at(-1)?.id, "delete");
    assert.equal(items.at(-1)?.destructive, true);
  });

  it("offers archive as a non-destructive action right before delete", () => {
    const items = buildThreadActionMenuItems(sidebarState);
    const archive = items.at(-2);
    assert.equal(archive?.id, "archive");
    assert.equal(archive?.icon, "archive");
    assert.equal(archive?.separatorBefore, true);
    assert.ok(!archive?.destructive);
  });

  it("disables archive and delete while the thread is running", () => {
    const running = { ...sidebarState, isRunning: true };
    assert.equal(find(running, "archive")?.disabled, true);
    assert.equal(find(running, "delete")?.disabled, true);
    assert.equal(find(sidebarState, "archive")?.disabled, false);
  });
});
