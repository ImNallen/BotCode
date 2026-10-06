import assert from "node:assert/strict";
import { it } from "node:test";
import {
  NotificationHistory,
  presentation,
  type ThreadAlert,
} from "./observer";
import type { ThreadSummary } from "../ipc";

const workspace = {
  id: "workspace-a",
  root: "/fixture",
  label: "Fixture",
  kind: "repository",
} as const;
function summary(
  id: string,
  revision: number,
  patch: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    id,
    revision,
    title: id,
    session: { kind: "running" },
    checkout: { kind: "local" },
    latestTurn: null,
    pendingApprovalIds: [],
    awaitingApproval: false,
    updatedAtMs: 0,
    pinnedAtMs: null,
    snoozedUntilMs: null,
    settledAtMs: null,
    pullRequests: {
      sequence: 0,
      links: [],
      discovering: false,
      discoveryError: null,
    },
    ...patch,
  };
}
const completed = (id: string): ThreadSummary["latestTurn"] => ({
  id,
  execution: { kind: "completed" },
  completedAtMs: 5,
});

it("alerts for distinct approvals and completions in two threads exactly once despite repeats and stale refreshes", () => {
  const history = new NotificationHistory();
  const alerts: ThreadAlert[] = [];
  history.subscribe((alert) => alerts.push(alert));
  history.seed({ workspace, threads: [summary("a", 1), summary("b", 1)] });
  history.observe(
    workspace.id,
    summary("a", 2, { pendingApprovalIds: ["approval-1"] }),
  );
  history.observe(
    workspace.id,
    summary("a", 3, { pendingApprovalIds: ["approval-1", "approval-2"] }),
  );
  history.observe(
    workspace.id,
    summary("b", 2, { latestTurn: completed("turn-b") }),
  );
  history.observe(
    workspace.id,
    summary("a", 4, { latestTurn: completed("turn-a") }),
  );
  history.observe(
    workspace.id,
    summary("a", 4, { latestTurn: completed("turn-a") }),
  );
  history.observe(
    workspace.id,
    summary("a", 2, { pendingApprovalIds: ["approval-1"] }),
  );
  history.seed({ workspace, threads: [summary("a", 1), summary("b", 1)] });
  history.observe(
    workspace.id,
    summary("a", 5, { latestTurn: completed("turn-a") }),
  );
  assert.deepEqual(
    alerts.map(({ threadId, kind, eventKey }) => ({
      threadId,
      kind,
      eventKey,
    })),
    [
      { threadId: "a", kind: "approval", eventKey: "approval:approval-1" },
      { threadId: "a", kind: "approval", eventKey: "approval:approval-2" },
      { threadId: "b", kind: "completion", eventKey: "turn:turn-b" },
      { threadId: "a", kind: "completion", eventKey: "turn:turn-a" },
    ],
  );
});

it("seeds startup, newly discovered threads and pre-baseline hints without replay", () => {
  const history = new NotificationHistory();
  const alerts: ThreadAlert[] = [];
  history.subscribe((alert) => alerts.push(alert));
  history.observe(
    workspace.id,
    summary("a", 3, { latestTurn: completed("old-turn") }),
  );
  history.seed({
    workspace,
    threads: [
      summary("a", 1),
      summary("b", 1, { pendingApprovalIds: ["old-approval"] }),
    ],
  });
  history.observe(
    workspace.id,
    summary("a", 4, { latestTurn: completed("old-turn") }),
  );
  history.observe(
    workspace.id,
    summary("b", 2, { pendingApprovalIds: ["old-approval"] }),
  );
  history.observe(
    workspace.id,
    summary("new", 1, { latestTurn: completed("new-old-turn") }),
  );
  history.seed({
    workspace,
    threads: [
      summary("discovered", 1, {
        latestTurn: completed("discovered-old-turn"),
      }),
    ],
  });
  history.observe(
    workspace.id,
    summary("discovered", 2, { latestTurn: completed("discovered-old-turn") }),
  );
  assert.equal(alerts.length, 0);
});

it("recovers completion, approval and failure from workspace refreshes exactly once after dropped hints", () => {
  const history = new NotificationHistory();
  const alerts: ThreadAlert[] = [];
  history.subscribe((alert) => alerts.push(alert));
  const runningA = summary("a", 1, {
    latestTurn: {
      id: "turn-a",
      execution: { kind: "running" },
      completedAtMs: null,
    },
  });
  const runningB = summary("b", 1, {
    latestTurn: {
      id: "turn-b",
      execution: { kind: "running" },
      completedAtMs: null,
    },
  });
  history.seed({ workspace, threads: [runningA, runningB] });
  const completion = summary("a", 2, { latestTurn: completed("turn-a") });
  history.seed({ workspace, threads: [completion, runningB] });
  history.seed({ workspace, threads: [completion, runningB] });
  history.seed({ workspace, threads: [runningA, runningB] });
  history.observe(workspace.id, completion);
  const approval = summary("b", 2, { pendingApprovalIds: ["approval-b"] });
  history.seed({ workspace, threads: [completion, approval] });
  history.seed({ workspace, threads: [completion, approval] });
  const failure = summary("b", 3, {
    latestTurn: {
      id: "turn-b",
      execution: { kind: "failed", reason: "Failed" },
      completedAtMs: 3,
    },
  });
  history.seed({ workspace, threads: [completion, failure] });
  history.seed({ workspace, threads: [completion, failure] });
  history.seed({ workspace, threads: [runningA, approval] });
  history.observe(
    workspace.id,
    summary("b", 4, { latestTurn: failure.latestTurn }),
  );
  assert.deepEqual(
    alerts.map(({ threadId, kind, eventKey }) => ({
      threadId,
      kind,
      eventKey,
    })),
    [
      { threadId: "a", kind: "completion", eventKey: "turn:turn-a" },
      { threadId: "b", kind: "approval", eventKey: "approval:approval-b" },
      { threadId: "b", kind: "failure", eventKey: "turn:turn-b" },
    ],
  );
});

it("failure alerts have stable turn identities while interruption and provider loss do not claim completion", () => {
  const history = new NotificationHistory();
  const alerts: ThreadAlert[] = [];
  history.subscribe((alert) => alerts.push(alert));
  history.seed({ workspace, threads: [summary("a", 1)] });
  history.observe(
    workspace.id,
    summary("a", 2, {
      latestTurn: {
        id: "cancelled",
        execution: { kind: "interrupted" },
        completedAtMs: 2,
      },
    }),
  );
  history.observe(
    workspace.id,
    summary("a", 3, {
      latestTurn: {
        id: "lost",
        execution: { kind: "lost", reason: "Disconnected" },
        completedAtMs: null,
      },
    }),
  );
  history.observe(
    workspace.id,
    summary("a", 4, {
      latestTurn: {
        id: "failed",
        execution: { kind: "failed", reason: "Failed" },
        completedAtMs: 3,
      },
    }),
  );
  assert.deepEqual(
    alerts.map((alert) => alert.kind),
    ["failure"],
  );
});

it("consumes attention even while off or suppressed so changing modes or focus cannot replay it", () => {
  const history = new NotificationHistory();
  const effects: ReturnType<typeof presentation>[] = [];
  const target = { workspaceId: workspace.id, threadId: "a" };
  const context = {
    focused: true,
    visibleThread: target,
    mode: "off",
    inAppNotificationsEnabled: false,
  } as const;
  history.subscribe((alert) => effects.push(presentation(alert, context)));
  history.seed({ workspace, threads: [summary("a", 1)] });
  history.observe(
    workspace.id,
    summary("a", 2, { latestTurn: completed("old") }),
  );
  assert.deepEqual(effects, [{ sound: false, desktop: false, toast: false }]);
  history.observe(
    workspace.id,
    summary("a", 3, { latestTurn: completed("old") }),
  );
  assert.equal(effects.length, 1);
});

it("suppresses every effect for the visible focused thread and follows all mode choices elsewhere", () => {
  const target = { workspaceId: workspace.id, threadId: "a" };
  const modes = [
    "off",
    "notifications",
    "sound",
    "notifications-and-sound",
  ] as const;
  for (const mode of modes) {
    assert.deepEqual(
      presentation(target, {
        focused: true,
        visibleThread: target,
        mode,
        inAppNotificationsEnabled: true,
      }),
      { sound: false, desktop: false, toast: false },
    );
    assert.deepEqual(
      presentation(target, {
        focused: false,
        visibleThread: target,
        mode,
        inAppNotificationsEnabled: true,
      }),
      {
        sound: mode === "sound" || mode === "notifications-and-sound",
        desktop: mode === "notifications" || mode === "notifications-and-sound",
        toast: false,
      },
    );
    assert.deepEqual(
      presentation(target, {
        focused: true,
        visibleThread: { ...target, threadId: "b" },
        mode,
        inAppNotificationsEnabled: true,
      }),
      {
        sound: mode === "sound" || mode === "notifications-and-sound",
        desktop: false,
        toast: true,
      },
    );
    assert.deepEqual(
      presentation(target, {
        focused: true,
        visibleThread: null,
        mode,
        inAppNotificationsEnabled: true,
      }),
      {
        sound: mode === "sound" || mode === "notifications-and-sound",
        desktop: false,
        toast: true,
      },
    );
  }
});
