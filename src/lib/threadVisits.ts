// Ported from T3 Code v0.0.45 apps/web/src/uiStateStore.ts and components/Sidebar.tsx (MIT).
import { useSyncExternalStore } from "react";
import { storage, type Storage } from "./storage";

export const THREAD_VISITS_KEY = "thread-last-visited:v1";
export type ThreadVisits = Readonly<Record<string, number>>;

export function markThreadVisited(
  visits: ThreadVisits,
  threadId: string,
  visitedAtMs: number,
): ThreadVisits {
  if (!Number.isFinite(visitedAtMs)) return visits;
  const previous = visits[threadId];
  if (previous !== undefined && previous >= visitedAtMs) return visits;
  return { ...visits, [threadId]: visitedAtMs };
}

export function markThreadUnread(
  visits: ThreadVisits,
  threadId: string,
  latestTurnCompletedAtMs: number | null | undefined,
): ThreadVisits {
  if (latestTurnCompletedAtMs == null) return visits;
  if (!Number.isFinite(latestTurnCompletedAtMs)) return visits;
  const unreadVisitedAtMs = latestTurnCompletedAtMs - 1;
  if (visits[threadId] === unreadVisitedAtMs) return visits;
  return { ...visits, [threadId]: unreadVisitedAtMs };
}

export function hasUnseenCompletion({
  latestCompletedAtMs,
  lastVisitedAtMs,
}: {
  latestCompletedAtMs: number | null | undefined;
  lastVisitedAtMs: number | undefined;
}): boolean {
  if (latestCompletedAtMs == null || lastVisitedAtMs === undefined)
    return false;
  return latestCompletedAtMs > lastVisitedAtMs;
}

type WokeInput = {
  wokeAtMs: number | null;
  lastVisitedAtMs: number | undefined;
  settled: boolean;
};

export function isThreadWoke({
  wokeAtMs,
  lastVisitedAtMs,
  settled,
}: WokeInput): boolean {
  if (wokeAtMs === null || settled) return false;
  return !(lastVisitedAtMs !== undefined && lastVisitedAtMs >= wokeAtMs);
}

export function isOpenThreadWokeVisible({
  latestCompletedAtMs,
  ...input
}: WokeInput & { latestCompletedAtMs: number | null | undefined }): boolean {
  const visits = [input.lastVisitedAtMs, latestCompletedAtMs].filter(
    (at): at is number => at != null && Number.isFinite(at),
  );
  return isThreadWoke({
    ...input,
    lastVisitedAtMs: visits.length ? Math.max(...visits) : undefined,
  });
}

function parseVisits(raw: string | null): ThreadVisits {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        entry[0].length > 0 &&
        typeof entry[1] === "number" &&
        Number.isFinite(entry[1]),
    ),
  );
}

export function createThreadVisitStore(persistence: Storage) {
  const listeners = new Set<() => void>();
  let raw: string | null | undefined;
  let visits: ThreadVisits = {};
  const read = (): ThreadVisits => {
    const saved = persistence.getItem(THREAD_VISITS_KEY);
    if (saved !== raw) {
      raw = saved;
      visits = parseVisits(saved);
    }
    return visits;
  };
  const write = (next: ThreadVisits) => {
    if (next === read()) return;
    raw = JSON.stringify(next);
    visits = next;
    void persistence.setItem(THREAD_VISITS_KEY, raw);
    for (const listener of listeners) listener();
  };
  return {
    read,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    markVisited: (threadId: string, visitedAtMs: number) =>
      write(markThreadVisited(read(), threadId, visitedAtMs)),
    markUnread: (
      threadId: string,
      latestTurnCompletedAtMs: number | null | undefined,
    ) => write(markThreadUnread(read(), threadId, latestTurnCompletedAtMs)),
  };
}

export const threadVisits = createThreadVisitStore(storage);

export function useThreadLastVisitedAt(threadId: string): number | undefined {
  return useSyncExternalStore(
    threadVisits.subscribe,
    () => threadVisits.read()[threadId],
  );
}
