// Ported from T3 Code v0.0.45 queuedMessageStore.ts and sendQueuedMessage.ts (MIT).
import type { Attachment, SessionSettings, Thread } from "../ipc";

import type { MessageContext } from "./composerContext";

export type DispatchIntent =
  | { kind: "start" }
  | { kind: "steer"; expectedTurnId: string };
export type FollowUp = {
  id: string;
  text: string;
  context?: MessageContext;
  attachments: Attachment[];
  settings: SessionSettings;
  state:
    | { kind: "waiting" }
    | { kind: "held"; reason: string; intent: DispatchIntent | null }
    | { kind: "preparing"; intent: DispatchIntent }
    | { kind: "dispatching"; intent: DispatchIntent }
    | { kind: "checking"; intent: DispatchIntent; reason: string };
};
type Queue = {
  threadId: string;
  workspaceId: string;
  predecessor: { kind: "visible" | "accepted"; turnId: string } | null;
  held: boolean;
  rows: FollowUp[];
};
export function unresolvedInput(thread: Thread): boolean {
  return thread.turns.some((turn) =>
    turn.items.some(
      (item) =>
        item.kind === "user_input" &&
        ["preparing", "sending", "uncertain"].includes(item.delivery.kind),
    ),
  );
}
export function sendingBlocked(thread: Thread): boolean {
  return (
    thread.placement?.kind === "archived" ||
    Boolean(thread.pendingRevert) ||
    thread.approvals.some((approval) =>
      ["pending", "answering"].includes(approval.state),
    ) ||
    thread.userQuestions.some((request) =>
      ["pending", "answering"].includes(request.state),
    ) ||
    unresolvedInput(thread)
  );
}
function checkpointsClosed(thread: Thread): boolean {
  return !thread.turns.some((turn) =>
    ["pending", "before"].includes(turn.checkpoint.kind),
  );
}
export function immediateIntent(thread: Thread): DispatchIntent | null {
  if (sendingBlocked(thread)) return null;
  const turn = thread.turns.at(-1);
  if (
    thread.session.kind === "running" &&
    turn?.execution.kind === "running" &&
    turn.delivery.kind === "accepted" &&
    turn.nativeTurnId
  )
    return { kind: "steer", expectedTurnId: turn.id };
  return ["ready", "draft"].includes(thread.session.kind) &&
    checkpointsClosed(thread)
    ? { kind: "start" }
    : null;
}
function lastTurn(thread: Thread): Queue["predecessor"] {
  const turn = thread.turns.at(-1);
  return turn ? { kind: "visible", turnId: turn.id } : null;
}
export class FollowUpStore {
  private queues: Queue[] = [];
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.queues;
  private publish() {
    this.queues = [...this.queues];
    for (const listener of this.listeners) listener();
  }
  rows(threadId: string): FollowUp[] {
    return this.queues.find((queue) => queue.threadId === threadId)?.rows ?? [];
  }
  enqueue(thread: Thread, input: Omit<FollowUp, "state">): void {
    let queue = this.queues.find((queue) => queue.threadId === thread.id);
    if (!queue) {
      queue = {
        threadId: thread.id,
        workspaceId: thread.workspaceId,
        predecessor: lastTurn(thread),
        held: false,
        rows: [],
      };
      this.queues.push(queue);
    }
    if (
      !queue.rows.length &&
      (queue.predecessor === null ||
        thread.turns.some((turn) => turn.id === queue.predecessor?.turnId))
    ) {
      queue.predecessor = lastTurn(thread);
      queue.held = false;
    }
    queue.rows.push({
      ...structuredClone(input),
      settings: { ...input.settings },
      attachments: [...input.attachments],
      state: queue.held
        ? { kind: "held", reason: "Waits for Send now", intent: null }
        : { kind: "waiting" },
    });
    this.publish();
  }
  hold(threadId: string, reason = "Waits for Send now"): void {
    const queue = this.queues.find((queue) => queue.threadId === threadId);
    if (!queue) return;
    if (
      queue.held &&
      queue.rows.every(
        (row) =>
          (row.state.kind === "held" && row.state.reason === reason) ||
          row.state.kind === "dispatching" ||
          row.state.kind === "checking",
      )
    )
      return;
    queue.held = true;
    for (const row of queue.rows)
      if (["waiting", "held", "preparing"].includes(row.state.kind))
        row.state = {
          kind: "held",
          reason,
          intent: row.state.kind === "held" ? row.state.intent : null,
        };
    this.publish();
  }
  remove(threadId: string, id: string): void {
    const queue = this.queues.find((queue) => queue.threadId === threadId);
    const row = queue?.rows.find((row) => row.id === id);
    if (
      !queue ||
      !row ||
      !["waiting", "held", "preparing"].includes(row.state.kind)
    )
      return;
    queue.rows = queue.rows.filter((row) => row.id !== id);
    this.publish();
  }
  claim(thread: Thread, id?: string): FollowUp | null {
    const queue = this.queues.find((queue) => queue.threadId === thread.id);
    const row = queue?.rows[0];
    if (!queue || !row || (id && row.id !== id)) return null;
    if (!["waiting", "held"].includes(row.state.kind)) return null;
    let intent: DispatchIntent | null;
    if (id && sendingBlocked(thread)) return null;
    if (id)
      intent =
        row.state.kind === "held" && row.state.intent
          ? row.state.intent
          : immediateIntent(thread);
    else {
      if (queue.held || sendingBlocked(thread)) return null;
      const predecessor = thread.turns.find(
        (turn) => turn.id === queue.predecessor?.turnId,
      );
      if (queue.predecessor?.kind === "accepted") {
        if (!predecessor) return null;
        queue.predecessor = { kind: "visible", turnId: predecessor.id };
      }
      if (
        !predecessor ||
        predecessor.id !== thread.turns.at(-1)?.id ||
        predecessor.execution.kind !== "completed" ||
        predecessor.delivery.kind !== "accepted" ||
        thread.session.kind !== "ready" ||
        !checkpointsClosed(thread)
      ) {
        if (
          (predecessor &&
            ["failed", "lost", "interrupted"].includes(
              predecessor.execution.kind,
            )) ||
          ["unavailable", "dormant", "interrupting"].includes(
            thread.session.kind,
          ) ||
          (queue.predecessor !== null && !predecessor)
        )
          this.hold(thread.id, "Turn stopped or changed. Waits for Send now");
        return null;
      }
      if (
        predecessor.items.some(
          (item) =>
            item.kind === "user_input" && item.delivery.kind === "not_sent",
        )
      ) {
        this.hold(thread.id, "Follow-up was not sent. Waits for Send now");
        return null;
      }
      intent = { kind: "start" };
    }
    if (!intent) return null;
    row.state = { kind: "preparing", intent };
    this.publish();
    return { ...row };
  }
  dispatching(
    threadId: string,
    id: string,
    expected: FollowUp["state"],
  ): Extract<FollowUp["state"], { kind: "dispatching" }> | null {
    const row = this.rows(threadId).find((row) => row.id === id);
    if (row?.state !== expected || row.state.kind !== "preparing") return null;
    const { intent } = row.state;
    const state = { kind: "dispatching", intent } satisfies FollowUp["state"];
    row.state = state;
    this.publish();
    return state;
  }
  accepted(
    threadId: string,
    id: string,
    expected: FollowUp["state"],
    turnId: string,
  ): void {
    const queue = this.queues.find((queue) => queue.threadId === threadId);
    if (!queue || queue.rows[0]?.id !== id || queue.rows[0].state !== expected)
      return;
    queue.rows.shift();
    queue.predecessor = { kind: "accepted", turnId };
    this.publish();
  }
  failed(
    threadId: string,
    id: string,
    expected: FollowUp["state"],
    error: unknown,
    definitive: boolean,
  ): void {
    const row = this.rows(threadId).find((row) => row.id === id);
    if (
      !row ||
      row.state !== expected ||
      (row.state.kind !== "dispatching" && row.state.kind !== "preparing")
    )
      return;
    const reason =
      error instanceof Error
        ? error.message
        : "Delivery could not be confirmed.";
    const { intent } = row.state;
    this.hold(threadId, "Waits for Send now");
    row.state = definitive
      ? { kind: "held", reason, intent }
      : { kind: "checking", intent, reason };
    this.publish();
  }
  check(threadId: string, id: string): FollowUp | null {
    const row = this.rows(threadId).find((row) => row.id === id);
    if (row?.state.kind !== "checking") return null;
    const { intent } = row.state;
    row.state = { kind: "dispatching", intent };
    this.publish();
    return { ...row };
  }
}
export const followUps = new FollowUpStore();
