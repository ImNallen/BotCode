import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { taskProgressSchema, type Thread } from "../ipc";
import { composerTasks } from "./taskProgress";
import { ComposerTasksBadge, ComposerTasksContent } from "./ComposerTasksBadge";

const turn: Thread["turns"][number] = {
  id: "turn",
  prompt: "Work",
  nativeTurnId: "native-turn",
  delivery: { kind: "accepted" },
  execution: { kind: "running" },
  items: [],
  settings: null,
  startedAtMs: 1,
  completedAtMs: null,
  attachments: [],
  checkpoint: { kind: "pending" },
  tasks: {
    explanation: null,
    steps: [
      { step: "Read", status: "completed", durationMs: 1234 },
      { step: "Implement", status: "inProgress" },
      { step: "Verify", status: "pending" },
    ],
  },
};

it("validates the whole typed checklist and strips persisted timing from the frontend projection", () => {
  assert.deepEqual(
    taskProgressSchema.parse({
      ...turn.tasks,
      timings: [{ step: "Read" }],
      firstObservedAtMs: 1,
    }),
    turn.tasks,
  );
  for (const status of ["in_progress", "unknown", false]) {
    assert.equal(
      taskProgressSchema.safeParse({
        explanation: null,
        steps: [{ step: "Bad", status }],
      }).success,
      false,
    );
  }
  assert.equal(
    taskProgressSchema.safeParse({
      explanation: null,
      steps: [{ step: "Bad", status: "completed", durationMs: -1 }],
    }).success,
    false,
  );
});

it("projects the running step and counts complete steps independently of Plan mode", () => {
  const projected = composerTasks(turn);
  assert.ok(projected);
  assert.deepEqual(projected.progress, {
    step: "Implement",
    completedSteps: 1,
    totalSteps: 3,
  });
  assert.equal(
    composerTasks({
      ...turn,
      settings: {
        model: null,
        effort: null,
        permissionMode: "full-access",
        interactionMode: "plan",
      },
    })?.progress.step,
    "Implement",
  );
  assert.equal(
    composerTasks({
      ...turn,
      tasks: {
        explanation: null,
        steps: [{ step: "Next", status: "pending" }],
      },
    })?.progress.step,
    "Next",
  );
  assert.equal(
    composerTasks({
      ...turn,
      tasks: {
        explanation: null,
        steps: [{ step: "Done", status: "completed" }],
      },
    }),
    null,
  );
  assert.equal(
    composerTasks({ ...turn, tasks: { explanation: null, steps: [] } }),
    null,
  );
  assert.equal(composerTasks({ ...turn, tasks: null }), null);
  assert.equal(composerTasks(undefined), null);
  for (const execution of [
    { kind: "completed" },
    { kind: "interrupted" },
    { kind: "failed", reason: "failed" },
    { kind: "lost", reason: "restart" },
  ] satisfies Array<Thread["turns"][number]["execution"]>) {
    assert.equal(composerTasks({ ...turn, execution }), null);
  }
});

it("renders T3 Tasks, statuses, count, mini segments and completed duration", () => {
  const tasks = composerTasks(turn);
  assert.ok(tasks);
  const html = renderToStaticMarkup(
    createElement(ComposerTasksContent, {
      ...tasks,
      expanded: true,
      onToggle: () => {},
    }),
  );
  assert.ok(
    /Collapse tasks: 1 of 3 complete. Current task: Implement/.test(html),
  );
  assert.ok(/data-composer-task-current="true">Implement/.test(html));
  assert.ok(/data-composer-task-progress="true">1\/3/.test(html));
  assert.ok(/Completed: /.test(html));
  assert.ok(/Running: /.test(html));
  assert.ok(/Pending: /.test(html));
  assert.ok(/data-composer-task-duration="true">1.2s/.test(html));
  assert.ok(/data-composer-task-duration="true">now/.test(html));
  assert.equal(
    (html.match(/data-composer-task-duration="true">now/g) ?? []).length,
    1,
  );
  assert.equal((html.match(/h-\[3px\]/g) ?? []).length, 3);
  assert.ok(html.includes('role="list"'));
  for (const count of [1, 2, 10, 11]) {
    const steps = Array.from({ length: count }, () => ({
      step: "Duplicate",
      status: "pending" as const,
    }));
    const badge = renderToStaticMarkup(
      createElement(ComposerTasksBadge, {
        progress: { step: "Duplicate", completedSteps: 0, totalSteps: count },
        steps,
        expanded: false,
        onToggle: () => {},
      }),
    );
    assert.equal(
      (badge.match(/h-\[3px\]/g) ?? []).length,
      count >= 2 && count <= 10 ? count : 0,
    );
  }
});
