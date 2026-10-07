// Ported from T3 Code v0.0.45 QueuedMessageSender.tsx and sendQueuedMessage.ts (MIT).
import { useEffect, useSyncExternalStore } from "react";
import {
  useQueries,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  ipc,
  readThreadSnapshot,
  setThreadSnapshot,
  type Thread,
} from "../ipc";
import { followUps, type FollowUp } from "./followUps";

async function deliver(client: QueryClient, threadId: string, row: FollowUp) {
  let attempt = row.state;
  if (attempt.kind !== "preparing" && attempt.kind !== "dispatching") return;
  try {
    if (attempt.kind === "preparing") {
      if (attempt.intent.kind === "start") {
        const snapshot = await ipc.settings(threadId, row.settings);
        setThreadSnapshot(client, snapshot);
      }
      const dispatched = followUps.dispatching(threadId, row.id, attempt);
      if (!dispatched) return;
      attempt = dispatched;
    }
    const { intent } = attempt;
    const receipt = await ipc.submit(
      threadId,
      row.text,
      row.id,
      row.attachments,
      intent.kind === "steer" ? intent.expectedTurnId : undefined,
      row.context,
    );
    followUps.accepted(threadId, row.id, attempt, receipt.turnId);
  } catch (error) {
    const definitive =
      attempt.kind === "preparing" ||
      (error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        ![
          "ipc",
          "io",
          "protocol",
          "provider_lost",
          "provider_timeout",
        ].includes(error.code));
    followUps.failed(threadId, row.id, attempt, error, definitive);
  } finally {
    void client.invalidateQueries({ queryKey: ["thread", threadId] });
    void client.invalidateQueries({ queryKey: ["workspace"] });
  }
}
export function sendFollowUpNow(
  client: QueryClient,
  thread: Thread,
  id: string,
): void {
  const row = followUps.claim(thread, id);
  if (row) void deliver(client, thread.id, row);
}
export function checkFollowUp(
  client: QueryClient,
  threadId: string,
  id: string,
): void {
  const row = followUps.check(threadId, id);
  if (row) void deliver(client, threadId, row);
}
export function FollowUpSender() {
  const client = useQueryClient();
  const queues = useSyncExternalStore(
    followUps.subscribe,
    followUps.snapshot,
    followUps.snapshot,
  );
  const threads = useQueries({
    queries: queues
      .filter((queue) => queue.rows.length)
      .map((queue) => ({
        queryKey: ["thread", queue.threadId],
        queryFn: () => readThreadSnapshot(client, queue.threadId),
      })),
  });
  useEffect(() => {
    for (const query of threads) {
      if (query.error) {
        const threadId = queues.filter((queue) => queue.rows.length)[
          threads.indexOf(query)
        ]?.threadId;
        if (threadId)
          followUps.hold(
            threadId,
            "Conversation unavailable. Remove or retry this input when it returns.",
          );
        continue;
      }
      if (!query.data) continue;
      const row = followUps.claim(query.data);
      if (row) void deliver(client, query.data.id, row);
    }
  }, [client, queues, threads]);
  return null;
}
