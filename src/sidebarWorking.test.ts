import assert from "node:assert/strict";
import { it } from "node:test";
import { partitionSidebarRows } from "./Sidebar";
import {
  compareInboxReturns,
  createInboxReturnObserver,
  formatWorkingDurationLabel,
  isSidebarThreadWorking,
} from "./sidebarWorking";
import type { ThreadSummary } from "./ipc";

const summary: ThreadSummary = {
  id: "working",
  revision: 1,
  title: "Working thread",
  checkout: { kind: "local" },
  session: { kind: "running" },
  latestTurn: {
    id: "turn",
    execution: { kind: "running" },
    startedAtMs: 10,
    completedAtMs: null,
  },
  pendingApprovalIds: [],
  pendingUserQuestionIds: [],
  awaitingApproval: false,
  createdAtMs: 5,
  updatedAtMs: 10,
  archivedAtMs: null,
  pinnedAtMs: null,
  snoozedUntilMs: null,
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
const row = (id: string, patch: Partial<ThreadSummary> = {}) => ({
  workspace,
  branch: "main",
  thread: { ...summary, id, ...patch },
});
const base: Parameters<typeof partitionSidebarRows>[0] = {
  rows: [],
  query: "",
  scopeId: undefined,
  openThreadId: undefined,
  now: 50,
  snoozedExpanded: false,
  settledExpanded: false,
  settledVisibleCount: 10,
  workingEnabled: true,
  workingExpanded: false,
};

it("classifies Working from active execution while approvals, input and lost work stay actionable", () => {
  assert.equal(isSidebarThreadWorking(summary), true);
  for (const session of [
    { kind: "connecting" },
    { kind: "interrupting" },
  ] satisfies Array<ThreadSummary["session"]>)
    assert.equal(isSidebarThreadWorking({ ...summary, session }), true);
  for (const patch of [
    { awaitingApproval: true },
    { pendingApprovalIds: ["approval"] },
    { pendingUserQuestionIds: ["input"] },
    { session: { kind: "dormant" } },
    { latestTurn: null },
    {
      latestTurn: {
        id: "turn",
        execution: { kind: "lost", reason: "restart" },
        completedAtMs: 20,
      },
    },
    {
      latestTurn: {
        id: "turn",
        execution: { kind: "completed" },
        completedAtMs: 20,
      },
    },
  ] satisfies Array<Partial<ThreadSummary>>)
    assert.equal(isSidebarThreadWorking({ ...summary, ...patch }), false);
});

it("preserves archive, snooze, settle and pin precedence and the selected collapsed card", () => {
  const rows = [
    row("archived", { archivedAtMs: 1 }),
    row("snoozed", { snoozedUntilMs: 100 }),
    row("settled", { settledAtMs: 1 }),
    row("pinned", { pinnedAtMs: 1 }),
    row("working"),
    row("other"),
    row("approval", { awaitingApproval: true }),
  ];
  const sections = partitionSidebarRows({
    ...base,
    rows,
    openThreadId: "working",
    snoozedExpanded: true,
    settledExpanded: true,
  });
  assert.deepEqual(
    sections.pinned.map((r) => r.thread.id),
    ["pinned"],
  );
  assert.deepEqual(
    sections.active.map((r) => r.thread.id),
    ["approval"],
  );
  assert.deepEqual(
    sections.working.map((r) => r.thread.id),
    ["working"],
  );
  assert.equal(sections.workingTotal, 2);
  assert.deepEqual(
    sections.snoozed.map((r) => r.thread.id),
    ["snoozed"],
  );
  assert.deepEqual(
    sections.settled.map((r) => r.thread.id),
    ["settled"],
  );
  assert.equal(partitionSidebarRows({ ...base, rows }).working.length, 0);
  assert.equal(
    partitionSidebarRows({ ...base, rows, workingExpanded: true }).working
      .length,
    2,
  );
  assert.equal(
    partitionSidebarRows({ ...base, rows, query: "Working" }).working.length,
    2,
  );
  assert.equal(
    partitionSidebarRows({ ...base, rows, workingEnabled: false }).workingTotal,
    0,
  );
  assert.equal(
    partitionSidebarRows({ ...base, rows, workingEnabled: false }).active
      .length,
    3,
  );
});

it("uses one return clock for Active and Working and observes before project and title filtering", () => {
  const observe = createInboxReturnObserver();
  const busy = row("busy").thread;
  const newer = row("newer", {
    createdAtMs: 40,
    latestTurn: {
      ...summary.latestTurn,
      id: "newer-turn",
      startedAtMs: 40,
      execution: { kind: "completed" },
      completedAtMs: 45,
    },
  }).thread;
  const first = observe([busy, newer], true, 50);
  assert.equal(first.size, 0);
  const approval = { ...busy, awaitingApproval: true };
  const returns = observe([approval, newer], true, 60);
  assert.equal(returns.get("busy"), 60);
  assert.ok(compareInboxReturns(approval, newer, returns) < 0);
  const rows = [row("busy", approval), row("newer", newer)];
  assert.deepEqual(
    partitionSidebarRows({
      ...base,
      rows,
      observedReturns: returns,
    }).active.map((r) => r.thread.id),
    ["busy", "newer"],
  );
  assert.equal(
    partitionSidebarRows({
      ...base,
      rows,
      scopeId: "other",
      observedReturns: returns,
    }).active.length,
    0,
  );
  assert.equal(observe([approval, newer], true, 100).get("busy"), 60);
  observe([newer], true, 110);
  assert.equal(returns.has("busy"), false);
  observe([busy], false, 120);
  assert.equal(returns.size, 0);
  assert.equal(observe([approval], true, 130).size, 0);
  const working = [
    row("old", { createdAtMs: 1 }),
    row("recent", { createdAtMs: 100 }),
  ];
  assert.deepEqual(
    partitionSidebarRows({
      ...base,
      rows: working,
      workingExpanded: true,
    }).working.map((r) => r.thread.id),
    ["recent", "old"],
  );
});

it("formats elapsed labels like T3 without announcing each tick", () => {
  assert.equal(formatWorkingDurationLabel(-1), "0s");
  assert.equal(formatWorkingDurationLabel(59999), "59s");
  assert.equal(formatWorkingDurationLabel(61000), "1m");
  assert.equal(formatWorkingDurationLabel(3661000), "1h 1m");
});

it("returns manually un-settled threads to the top only with Working enabled", () => {
  const rows = [
    row("recent", {
      session: { kind: "ready" },
      latestTurn: null,
      updatedAtMs: 100,
    }),
    row("un-settled", {
      session: { kind: "ready" },
      latestTurn: null,
      updatedAtMs: 10,
      unsettledAtMs: 200,
    }),
  ];
  assert.deepEqual(
    partitionSidebarRows({ ...base, rows }).active.map((r) => r.thread.id),
    ["un-settled", "recent"],
  );
  assert.deepEqual(
    partitionSidebarRows({ ...base, rows, workingEnabled: false }).active.map(
      (r) => r.thread.id,
    ),
    ["recent", "un-settled"],
  );
});
