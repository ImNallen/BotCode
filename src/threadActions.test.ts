import assert from "node:assert/strict";
import { it } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { partitionSidebarRows } from "./Sidebar";
import { ipc, type ThreadSummary, type Workspace } from "./ipc";
import {
  categories,
  settingsSection,
  visibleSections,
} from "./settings/settingsCatalog";

const workspace: Workspace = {
  id: "67ce24cf-70e2-44b3-99f4-53bd8d155d19",
  root: "/project",
  label: "Project",
  kind: "repository",
  projectIcon: null,
  faviconPath: null,
};
const thread: ThreadSummary = {
  id: "058478ab-2c41-40e0-83b7-dd2c71b3c368",
  revision: 0,
  latestTurn: null,
  pendingApprovalIds: [],
  pendingUserQuestionIds: [],
  title: "Hidden thread",
  session: { kind: "draft" },
  checkout: { kind: "local" },
  createdAtMs: 10,
  archivedAtMs: 20,
  updatedAtMs: 10,
  awaitingApproval: false,
  pinnedAtMs: null,
  settledAtMs: null,
  snoozedUntilMs: null,
  pullRequests: {
    sequence: 0,
    links: [],
    discovering: false,
    discoveryError: null,
  },
};

it("excludes archived threads from search, open rows, shelves, counts and forward cards", () => {
  for (const overlay of [
    {},
    { pinnedAtMs: 1 },
    { settledAtMs: 2 },
    { snoozedUntilMs: 100 },
  ]) {
    for (const query of ["", "Hidden"]) {
      const groups = partitionSidebarRows({
        rows: [
          { workspace, branch: "main", thread: { ...thread, ...overlay } },
        ],
        query,
        scopeId: undefined,
        openThreadId: thread.id,
        now: 50,
        snoozedExpanded: true,
        settledExpanded: true,
        settledVisibleCount: 10,
      });
      assert.deepEqual(groups, {
        pinned: [],
        active: [],
        working: [],
        workingTotal: 0,
        snoozed: [],
        settled: [],
        snoozedTotal: 0,
        settledTotal: 0,
        hiddenCount: 0,
      });
    }
  }
});

it("exposes archived restore and deletion-time storage in the searchable settings catalog", () => {
  assert.equal(settingsSection.parse("archived"), "archived");
  assert.ok(visibleSections({ kind: "all" }).includes("archived"));
  assert.equal(categories.archived.scoped, true);
  assert.ok(
    categories.archived.groups
      .flatMap((group) => group.rows)
      .some((row) => row.keywords?.includes("restore")),
  );
  assert.ok(
    categories.storage.groups
      .flatMap((group) => group.rows)
      .some(
        (row) =>
          row.id === "worktree-on-delete" &&
          row.title === "Delete worktrees with deleted threads",
      ),
  );
});

it("validates retained-worktree deletion and metadata-only archive summaries at IPC", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { crypto: globalThis.crypto }),
  });
  mockIPC((command, args) => {
    if (command === "delete_thread") {
      assert.deepEqual(args, { threadId: thread.id });
      return { kind: "retained", reason: "working tree has changes" };
    }
    if (command === "list_thread_summaries") {
      assert.deepEqual(args, { workspaceId: workspace.id });
      return [thread];
    }
    throw new Error(`Unexpected command ${command}`);
  });
  try {
    assert.deepEqual(await ipc.deleteThread(thread.id), {
      kind: "retained",
      reason: "working tree has changes",
    });
    assert.deepEqual(await ipc.threadSummaries(workspace.id), [thread]);
  } finally {
    clearMocks();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

it("offers manual deletion only for a sole-owner repository worktree, including archived owners", async () => {
  const {
    orphanedWorktreePath,
    formatWorktreePathForDisplay,
    manualWorktreePath,
  } = await import("./threadActions");
  const target = {
    ...thread,
    checkout: {
      kind: "worktree" as const,
      path: "/repo/worktrees/feature",
      branch: "feature",
    },
  };
  const shared = {
    ...target,
    id: "00000000-0000-4000-8000-000000000002",
    archivedAtMs: 20,
  };
  assert.equal(orphanedWorktreePath(target, [target]), target.checkout.path);
  assert.equal(orphanedWorktreePath(target, [target, shared]), null);
  assert.equal(orphanedWorktreePath(thread, [thread]), null);
  assert.equal(
    formatWorktreePathForDisplay(" /repo/worktrees/feature/ "),
    "feature",
  );
  assert.equal(
    formatWorktreePathForDisplay("C:\\repo\\worktrees\\feature"),
    "feature",
  );
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { crypto: globalThis.crypto }),
  });
  let reads = 0;
  let rows = [target];
  let kind = "repository";
  mockIPC((command, args) => {
    reads++;
    if (command === "list_workspaces") return [{ ...workspace, kind }];
    if (command === "list_thread_summaries") return rows;
    if (command === "delete_thread") {
      assert.deepEqual(args, { threadId: thread.id, deleteWorktree: true });
      return { kind: "removed" };
    }
    throw new Error(`Unexpected ${command}`);
  });
  try {
    assert.equal(await manualWorktreePath(target, true), null);
    assert.equal(reads, 0);
    assert.equal(await manualWorktreePath(target, false), target.checkout.path);
    rows = [target, shared];
    assert.equal(await manualWorktreePath(target, false), null);
    rows = [target];
    kind = "scratch";
    assert.equal(await manualWorktreePath(target, false), null);
    assert.deepEqual(await ipc.deleteThread(thread.id, true), {
      kind: "removed",
    });
  } finally {
    clearMocks();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
