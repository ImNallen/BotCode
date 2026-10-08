// Adapted from pingdotgg/t3code v0.0.45 components/Sidebar.logic.ts and Sidebar.tsx (MIT).
import type { ThreadSummary } from "./ipc";

export function isSidebarThreadWorking(thread: ThreadSummary): boolean {
  if (
    thread.awaitingApproval ||
    thread.pendingApprovalIds.length ||
    thread.pendingUserQuestionIds.length
  )
    return false;
  const execution = thread.latestTurn?.execution.kind;
  return (
    (execution === "running" || execution === "not_started") &&
    (thread.session.kind === "connecting" ||
      thread.session.kind === "running" ||
      thread.session.kind === "interrupting")
  );
}

export function createInboxReturnObserver() {
  let previous: Set<string> | undefined;
  const returns = new Map<string, number>();
  return (threads: readonly ThreadSummary[], enabled: boolean, now: number) => {
    if (!enabled) {
      previous = undefined;
      returns.clear();
      return returns;
    }
    const ids = new Set(threads.map((thread) => thread.id));
    for (const id of returns.keys()) if (!ids.has(id)) returns.delete(id);
    const working = new Set(
      threads.filter(isSidebarThreadWorking).map((thread) => thread.id),
    );
    if (previous) {
      for (const thread of threads) {
        if (previous.has(thread.id) && !working.has(thread.id))
          returns.set(thread.id, now);
      }
    }
    previous = working;
    return returns;
  };
}

export const observeInboxReturns = createInboxReturnObserver();

export function compareInboxReturns(
  a: ThreadSummary,
  b: ThreadSummary,
  returns: ReadonlyMap<string, number>,
): number {
  const clock = (thread: ThreadSummary) =>
    Math.max(
      thread.createdAtMs ?? 0,
      thread.unsettledAtMs ?? 0,
      thread.latestTurn?.startedAtMs ?? thread.updatedAtMs ?? 0,
      thread.latestTurn?.completedAtMs ?? 0,
      returns.get(thread.id) ?? 0,
    );
  return clock(b) - clock(a) || a.id.localeCompare(b.id);
}

export function formatWorkingDurationLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs)
    ? Math.max(0, Math.floor(elapsedMs / 1000))
    : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
