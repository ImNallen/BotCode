import assert from "node:assert/strict";
import { it } from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { QueryClient } from "@tanstack/react-query";
import { readThreadSnapshot, setThreadSnapshot, type Thread } from "../ipc";
import { FollowUpStore, followUps } from "./followUps";
import { sendFollowUpNow, checkFollowUp } from "./FollowUpSender";
import { activateComposer, restoreFollowUps } from "./composerImages";
import { deriveRows } from "./timelineRows";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: globalThis,
});

const threadId = "018ba719-19f4-4fdb-bd79-aa4a676ea054";
const turnId = "018ba719-19f4-4fdb-bd79-aa4a676ea056";
const nextTurn = "018ba719-19f4-4fdb-bd79-aa4a676ea057";
function fixture(): Thread {
  return {
    id: threadId,
    workspaceId: "018ba719-19f4-4fdb-bd79-aa4a676ea055",
    title: "Follow-ups",
    worktreeSetup: null,
    nativeThreadId: "native-thread",
    revision: 1,
    session: { kind: "running" },
    settings: {
      model: null,
      effort: null,
      permissionMode: "full-access",
      interactionMode: "default",
    },
    checkout: { kind: "local" },
    approvals: [],
    userQuestions: [],
    diagnostic: null,
    pendingRevert: null,
    lastRevert: null,
    context: null,
    turns: [
      {
        id: turnId,
        prompt: "First",
        nativeTurnId: "native-turn",
        delivery: { kind: "accepted" },
        execution: { kind: "running" },
        items: [],
        settings: null,
        startedAtMs: 1,
        completedAtMs: null,
        attachments: [],
        checkpoint: { kind: "unavailable", before: null, reason: "No Git" },
      },
    ],
  };
}
const input = (thread: Thread, id: string) => ({
  id,
  text: id,
  attachments: [],
  settings: thread.settings,
});
function complete(thread: Thread) {
  thread.session = { kind: "ready" };
  const turn = thread.turns.at(-1);
  assert.ok(turn);
  turn.execution = { kind: "completed" };
}
it("claims FIFO once and waits for the accepted turn's actual completion, including hidden threads", () => {
  const store = new FollowUpStore();
  const thread = fixture();
  const hidden = { ...fixture(), id: "hidden" };
  store.enqueue(thread, input(thread, "one"));
  store.enqueue(thread, input(thread, "two"));
  store.enqueue(hidden, input(hidden, "hidden-input"));
  assert.equal(store.claim(thread), null);
  complete(thread);
  complete(hidden);
  const claimed = store.claim(thread);
  assert.equal(claimed?.id, "one");
  assert.ok(claimed);
  assert.equal(store.claim(thread), null);
  assert.equal(store.claim(thread, "two"), null);
  const dispatched = store.dispatching(thread.id, "one", claimed.state);
  assert.deepEqual(dispatched?.intent, { kind: "start" });
  assert.ok(dispatched);
  store.accepted(thread.id, "one", dispatched, nextTurn);
  assert.equal(store.claim(thread), null);
  const first = thread.turns[0];
  assert.ok(first);
  thread.turns.push({ ...first, id: nextTurn, execution: { kind: "running" } });
  thread.session = { kind: "running" };
  assert.equal(store.claim(thread), null);
  complete(thread);
  assert.equal(store.claim(thread)?.id, "two");
  assert.equal(store.claim(hidden)?.id, "hidden-input");
});
it("closes checkpoint, approval, rejected steer and terminal failure gates before automatic dispatch", () => {
  for (const gate of [
    "checkpoint",
    "approval",
    "rejected",
    "uncertain",
    "interrupted",
    "failed",
    "lost",
  ] as const) {
    const store = new FollowUpStore();
    const thread = fixture();
    store.enqueue(thread, input(thread, gate));
    complete(thread);
    const turn = thread.turns[0];
    assert.ok(turn);
    if (gate === "checkpoint") turn.checkpoint = { kind: "pending" };
    else if (gate === "approval")
      thread.approvals.push({
        id: "approval",
        turnId,
        state: "answering",
        action: { kind: "command", command: "echo", cwd: "/", reason: "" },
      });
    else if (gate === "rejected" || gate === "uncertain")
      turn.items.push({
        kind: "user_input",
        id: "steer",
        text: "Do this",
        attachments: [],
        delivery:
          gate === "rejected"
            ? { kind: "not_sent", reason: "Refused" }
            : { kind: "uncertain", reason: "Lost" },
      });
    else
      turn.execution =
        gate === "interrupted"
          ? { kind: gate }
          : { kind: gate, reason: "Stopped" };
    assert.equal(store.claim(thread), null, gate);
  }
});
it("Stop cancels preparation before wire dispatch and cannot restore dispatching input", () => {
  const store = new FollowUpStore();
  const thread = fixture();
  store.enqueue(thread, input(thread, "first"));
  store.enqueue(thread, input(thread, "second"));
  const first = store.claim(thread, "first");
  assert.ok(first);
  store.hold(thread.id);
  assert.equal(store.dispatching(thread.id, "first", first.state), null);
  assert.deepEqual(
    store.rows(thread.id).map((row) => row.state.kind),
    ["held", "held"],
  );
  const retry = store.claim(thread, "first");
  assert.ok(retry);
  store.dispatching(thread.id, "first", retry.state);
  store.hold(thread.id);
  store.remove(thread.id, "first");
  assert.equal(store.rows(thread.id)[0]?.state.kind, "dispatching");
});
it("retains a fixed steer target through uncertainty and definitive refusal after parent completion", () => {
  const store = new FollowUpStore();
  const thread = fixture();
  store.enqueue(thread, input(thread, "steer"));
  const claim = store.claim(thread, "steer");
  assert.ok(claim);
  const dispatch = store.dispatching(thread.id, "steer", claim.state);
  assert.ok(dispatch);
  const { intent } = dispatch;
  assert.deepEqual(intent, { kind: "steer", expectedTurnId: turnId });
  store.failed(thread.id, "steer", dispatch, new Error("Lost reply"), false);
  complete(thread);
  assert.equal(store.claim(thread), null);
  const checked = store.check(thread.id, "steer");
  assert.ok(checked?.state.kind === "dispatching");
  assert.deepEqual(checked.state.intent, intent);
  store.failed(
    thread.id,
    "steer",
    checked.state,
    new Error("Target ended"),
    true,
  );
  const retry = store.claim(thread, "steer");
  assert.ok(retry);
  assert.deepEqual(
    store.dispatching(thread.id, "steer", retry.state)?.intent,
    intent,
  );
});
it("a new batch follows the latest ordinary turn after an earlier queue empties", () => {
  const store = new FollowUpStore();
  const thread = fixture();
  store.enqueue(thread, input(thread, "one"));
  complete(thread);
  const claim = store.claim(thread);
  assert.ok(claim);
  const dispatched = store.dispatching(thread.id, "one", claim.state);
  assert.ok(dispatched);
  store.accepted(thread.id, "one", dispatched, nextTurn);
  const first = thread.turns[0];
  assert.ok(first);
  thread.turns.push(
    { ...first, id: nextTurn },
    { ...first, id: "later-normal" },
  );
  store.enqueue(thread, input(thread, "new-batch"));
  assert.equal(store.claim(thread)?.id, "new-batch");
});
it("restores queued text and images atomically while preserving current draft and staging", () => {
  const composer = { ...activateComposer(threadId), text: "Current" };
  const image = {
    id: "a".repeat(64),
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 12,
  } as const;
  const rows = [
    { id: "one", text: "One", attachments: [image] },
    { id: "two", text: "Two", attachments: [image] },
  ];
  const restored = restoreFollowUps(composer, rows);
  assert.equal(restored.input.text, "Current\n\nOne\n\nTwo");
  assert.equal(restored.input.images.length, 1);
  const staging = {
    ...composer,
    images: [{ key: "staging", name: "new", status: "staging" } as const],
  };
  const refused = restoreFollowUps(staging, rows);
  assert.equal(refused.input, staging);
  assert.ok(refused.error);
});
it("steered bubbles stay outside completed work folds and have no rewind action", () => {
  const thread = fixture();
  complete(thread);
  const turn = thread.turns[0];
  assert.ok(turn);
  turn.items = [
    { kind: "assistant", id: "early", text: "Earlier", complete: true },
    {
      kind: "user_input",
      id: "steer",
      text: "Follow-up",
      attachments: [],
      delivery: { kind: "accepted" },
    },
    { kind: "assistant", id: "final", text: "Done", complete: true },
  ];
  const rows = deriveRows(thread, new Set(), new Set());
  assert.equal(
    rows.some((row) => row.id === "early"),
    false,
  );
  const steer = rows.find((row) => row.id === "input:steer");
  assert.ok(steer?.kind === "user");
  assert.equal(steer.editable, false);
});
it("retries a lost IPC receipt with the exact steer target without issuing an ordinary submit", async () => {
  const thread = fixture();
  const client = new QueryClient();
  const id = "lost-ipc-test";
  followUps.enqueue(thread, input(thread, id));
  const calls: unknown[] = [];
  let reject = true;
  mockIPC((command, args) => {
    assert.equal(command, "submit");
    calls.push(args);
    if (reject) {
      reject = false;
      throw new Error("Response lost");
    }
    return { turnId };
  });
  try {
    sendFollowUpNow(client, thread, id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      followUps.rows(thread.id).find((row) => row.id === id)?.state.kind,
      "checking",
    );
    complete(thread);
    checkFollowUp(client, thread.id, id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.deepEqual(calls[0], {
      threadId,
      text: id,
      requestId: id,
      attachments: [],
      expectedTurnId: turnId,
    });
    assert.equal(followUps.rows(thread.id).length, 0);
  } finally {
    clearMocks();
    client.clear();
  }
});
it("does not submit after Stop restores a row while its settings preparation awaits IPC", async () => {
  const thread = fixture();
  complete(thread);
  const client = new QueryClient();
  const id = "cancel-settings-test";
  followUps.enqueue(thread, input(thread, id));
  let finishSettings: ((value: Thread) => void) | undefined;
  let submits = 0;
  mockIPC((command) => {
    if (command === "update_thread_settings")
      return new Promise<Thread>((resolve) => {
        finishSettings = resolve;
      });
    if (command === "submit") {
      submits++;
      return { turnId };
    }
    throw new Error(`Unexpected command ${command}`);
  });
  try {
    sendFollowUpNow(client, thread, id);
    assert.equal(followUps.rows(thread.id)[0]?.state.kind, "preparing");
    followUps.hold(thread.id);
    const recovered = restoreFollowUps(
      activateComposer(thread.id),
      followUps.rows(thread.id),
    );
    assert.equal(recovered.error, null);
    assert.equal(recovered.input.text, id);
    followUps.remove(thread.id, id);
    assert.ok(finishSettings);
    finishSettings(thread);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(submits, 0);
    assert.equal(followUps.rows(thread.id).length, 0);
  } finally {
    clearMocks();
    client.clear();
  }
});
it("holding an unavailable queue repeatedly publishes only the first state change", () => {
  const store = new FollowUpStore();
  const thread = fixture();
  store.enqueue(thread, input(thread, "held"));
  let notifications = 0;
  store.subscribe(() => {
    notifications++;
  });
  store.hold(thread.id, "Conversation unavailable");
  const held = store.snapshot();
  for (let count = 0; count < 10; count++)
    store.hold(thread.id, "Conversation unavailable");
  assert.equal(notifications, 1);
  assert.equal(store.snapshot(), held);
});
it("a lost settings preparation reply remains unsent and retries the captured settings before submit", async () => {
  const thread = fixture();
  complete(thread);
  const client = new QueryClient();
  const id = "lost-settings-test";
  followUps.enqueue(thread, input(thread, id));
  const calls: string[] = [];
  let failSettings = true;
  mockIPC((command) => {
    calls.push(command);
    if (command === "update_thread_settings") {
      if (failSettings) {
        failSettings = false;
        throw new Error("Settings response lost");
      }
      return thread;
    }
    if (command === "submit") return { turnId };
    throw new Error(`Unexpected command ${command}`);
  });
  try {
    sendFollowUpNow(client, thread, id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(followUps.rows(thread.id)[0]?.state.kind, "held");
    assert.deepEqual(calls, ["update_thread_settings"]);
    sendFollowUpNow(client, thread, id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls, [
      "update_thread_settings",
      "update_thread_settings",
      "submit",
    ]);
    assert.equal(followUps.rows(thread.id).length, 0);
  } finally {
    clearMocks();
    client.clear();
  }
});

it("a delayed thread read cannot replace a newer snapshot or release its queued input", async () => {
  const stale = fixture();
  complete(stale);
  const current = fixture();
  current.revision = stale.revision + 1;
  const store = new FollowUpStore();
  store.enqueue(current, input(current, "waiting"));
  const client = new QueryClient();
  let finishRead: ((value: Thread) => void) | undefined;
  mockIPC((command) => {
    assert.equal(command, "thread_snapshot");
    return new Promise<Thread>((resolve) => {
      finishRead = resolve;
    });
  });
  try {
    const result = client.fetchQuery({
      queryKey: ["thread", current.id],
      queryFn: () => readThreadSnapshot(client, current.id),
    });
    setThreadSnapshot(client, current);
    assert.ok(finishRead);
    finishRead(stale);
    const observed = await result;
    assert.equal(observed.revision, current.revision);
    assert.equal(
      client.getQueryData<Thread>(["thread", current.id])?.revision,
      current.revision,
    );
    assert.equal(store.claim(observed), null);
    assert.equal(store.rows(current.id)[0]?.state.kind, "waiting");
  } finally {
    clearMocks();
    client.clear();
  }
});

it("stale settings attempts cannot dispatch a reclaimed row or make its in-flight input removable", async () => {
  for (const staleFails of [false, true]) {
    const thread = fixture();
    complete(thread);
    const client = new QueryClient();
    const id = `reclaimed-settings-${staleFails}`;
    followUps.enqueue(thread, input(thread, id));
    const preparations: {
      resolve: (value: Thread) => void;
      reject: (error: Error) => void;
    }[] = [];
    let submits = 0;
    let finishSubmit: ((value: { turnId: string }) => void) | undefined;
    mockIPC((command) => {
      if (command === "update_thread_settings")
        return new Promise<Thread>((resolve, reject) => {
          preparations.push({ resolve, reject });
        });
      if (command === "submit") {
        submits++;
        return new Promise<{ turnId: string }>((resolve) => {
          finishSubmit = resolve;
        });
      }
      throw new Error(`Unexpected command ${command}`);
    });
    try {
      sendFollowUpNow(client, thread, id);
      followUps.hold(thread.id);
      sendFollowUpNow(client, thread, id);
      const [stale, current] = preparations;
      assert.ok(stale && current);
      const refused = Object.assign(new Error("Settings refused"), {
        code: "storage",
      });
      if (staleFails) {
        current.resolve(thread);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(submits, 1);
        stale.reject(refused);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(followUps.rows(thread.id)[0]?.state.kind, "dispatching");
        followUps.remove(thread.id, id);
        assert.equal(followUps.rows(thread.id).length, 1);
        followUps.hold(thread.id);
        assert.ok(finishSubmit);
        finishSubmit({ turnId });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(followUps.rows(thread.id).length, 0);
      } else {
        stale.resolve(thread);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(submits, 0);
        current.reject(refused);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(followUps.rows(thread.id)[0]?.state.kind, "held");
        assert.equal(submits, 0);
        followUps.remove(thread.id, id);
        assert.equal(followUps.rows(thread.id).length, 0);
      }
    } finally {
      finishSubmit?.({ turnId });
      clearMocks();
      client.clear();
    }
  }
});
