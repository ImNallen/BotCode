import assert from "node:assert/strict";
import { it, mock, afterEach } from "node:test";
import {
  ThreadMessageSearchController,
  contentQuery,
  type MessageSearchState,
} from "./threadMessageSearch";
import type { ThreadMessageSearch } from "../ipc";
afterEach(() => mock.timers.reset());
it("bounds native requests by Unicode scalars, useful words and mode", () => {
  for (const query of ["", "a", "\u0301\u0903", "x".repeat(201)])
    assert.equal(contentQuery(query, true), null);
  assert.equal(contentQuery("query", false), null);
  assert.equal(contentQuery("😀".repeat(200), true)?.length, 400);
});
it("debounces, clears stale rows, rejects old successes/errors and retries current query", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const wait = async (ms: number) => {
    mock.timers.tick(ms);
    await Promise.resolve();
  };
  const states: MessageSearchState[] = [];
  const requests: {
    query: string;
    resolve: (result: ThreadMessageSearch) => void;
    reject: (error: Error) => void;
  }[] = [];
  const controller = new ThreadMessageSearchController(
    (query) =>
      new Promise((resolve, reject) =>
        requests.push({ query, resolve, reject }),
      ),
    (state) => states.push(state),
  );
  controller.update("first");
  await wait(100);
  assert.equal(requests.length, 0);
  await wait(120);
  assert.equal(requests[0]?.query, "first");
  controller.update("second");
  assert.deepEqual(states.at(-1), { kind: "loading", query: "second" });
  requests[0]?.resolve({ matches: [], hasMore: false });
  await Promise.resolve();
  assert.equal(states.at(-1)?.kind, "loading");
  await wait(220);
  requests[1]?.reject(new Error("failed"));
  await Promise.resolve();
  assert.equal(states.at(-1)?.kind, "error");
  controller.retry();
  assert.equal(states.at(-1)?.kind, "loading");
  await wait(220);
  controller.update(null);
  requests[2]?.reject(new Error("stale"));
  await Promise.resolve();
  assert.deepEqual(states.at(-1), { kind: "idle" });
  controller.update("second");
  await wait(220);
  controller.retry();
  requests[3]?.resolve({ matches: [], hasMore: false });
  await Promise.resolve();
  assert.equal(states.at(-1)?.kind, "loading");
  await wait(220);
  requests[4]?.resolve({ matches: [], hasMore: true });
  await Promise.resolve();
  assert.deepEqual(states.at(-1), {
    kind: "ready",
    query: "second",
    result: { matches: [], hasMore: true },
  });
  controller.cancel();
});

it("makes progress while the corpus changes every 90 ms", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const states: MessageSearchState[] = [];
  let count = 0;
  const controller = new ThreadMessageSearchController(
    async () => {
      count++;
      return { matches: [], hasMore: false };
    },
    (state) => states.push(state),
  );
  controller.update("needle");
  for (let i = 0; i < 8; i++) {
    mock.timers.tick(90);
    controller.invalidate({
      kind: "thread",
      threadId: "streaming",
      revision: i + 1,
    });
    await Promise.resolve();
  }
  assert.ok(count > 0, "a search must complete while changes continue");
  assert.equal(states.at(-1)?.kind, "ready");
  controller.cancel();
});
it("retains unrelated slow results and suppresses changed, deleted and old-query hits", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const states: MessageSearchState[] = [];
  const requests: ((result: ThreadMessageSearch) => void)[] = [];
  const controller = new ThreadMessageSearchController(
    () => new Promise((resolve) => requests.push(resolve)),
    (state) => states.push(state),
  );
  const hit = (threadId: string, workspaceId = "workspace") => ({
    threadId,
    workspaceId,
    workspaceLabel: "Project",
    title: "Conversation",
    updatedAtMs: 1,
    revision: 1,
    source: "assistant" as const,
    snippet: "needle",
  });
  const readyIds = () => {
    const state = states.at(-1);
    assert.ok(state?.kind === "ready");
    return state.result.matches.map((match) => match.threadId);
  };
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  controller.update("needle");
  mock.timers.tick(200);
  for (let revision = 2; revision < 10; revision++) {
    mock.timers.tick(90);
    controller.invalidate({ kind: "thread", threadId: "streaming", revision });
  }
  controller.invalidate({ kind: "thread", threadId: "rewound", revision: 2 });
  requests[0]?.({
    matches: [hit("completed"), hit("rewound"), hit("streaming")],
    hasMore: false,
  });
  await flush();
  assert.deepEqual(readyIds(), ["completed"]);
  assert.equal(requests.length, 1);
  for (let revision = 10; revision < 14; revision++) {
    mock.timers.tick(90);
    controller.invalidate({ kind: "thread", threadId: "streaming", revision });
    assert.deepEqual(readyIds(), ["completed"]);
  }
  assert.equal(requests.length, 2);
  controller.invalidate({ kind: "workspace", workspaceId: "deleted" });
  requests[1]?.({
    matches: [hit("completed"), hit("removed", "deleted")],
    hasMore: false,
  });
  await flush();
  assert.deepEqual(readyIds(), ["completed"]);
  controller.invalidate({ kind: "thread", threadId: "completed", revision: 2 });
  assert.deepEqual(readyIds(), []);
  mock.timers.tick(200);
  controller.update("new query");
  requests[2]?.({ matches: [hit("old query")], hasMore: false });
  await flush();
  assert.deepEqual(states.at(-1), { kind: "loading", query: "new query" });
  mock.timers.tick(200);
  controller.invalidate({ kind: "all" });
  requests[3]?.({ matches: [hit("stale refresh")], hasMore: false });
  await flush();
  assert.deepEqual(readyIds(), []);
  controller.cancel();
});
