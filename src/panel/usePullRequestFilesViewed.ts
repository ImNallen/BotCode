import type { PrAccess } from "./prInbox";
// Queue, overlay and request ownership ported from pingdotgg/t3code v0.0.45 usePullRequestFilesViewed.ts (MIT).
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "../ipc";
import type { PrObservation } from "./prReview";
import {
  countViewedFiles,
  isFileViewed,
  isStaleViewedState,
  revertFileViewedOverlay,
  settleFileViewedOverlay,
  toFileViewedBatch,
  toFileViewedStates,
  type FileViewedOverlay,
  type FileViewedStates,
} from "./pullRequestFilesViewed.logic";

const NO_OVERLAY: FileViewedOverlay = new Map();
const FLUSH_DELAY_MS = 400;
export interface PullRequestFilesViewedView {
  readonly enabled: boolean;
  readonly isViewed: (path: string) => boolean;
  readonly isStale: (path: string) => boolean;
  readonly setViewed: (path: string, viewed: boolean) => void;
  readonly viewedCount: number;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly mutationError: string | null;
  readonly refresh: () => void;
}
export function usePullRequestFilesViewed({
  threadId,
  target,
  paths,
}: {
  threadId: PrAccess;
  target: PrObservation | undefined;
  paths: readonly string[];
}): PullRequestFilesViewedView {
  const reads = useRef(0);
  const readOwner = useRef(Symbol("viewed reader"));
  const scopeKey = target
    ? JSON.stringify([threadId, target.key, target.nodeId, target.viewer])
    : "unloaded";
  const scope = useRef(scopeKey);
  const query = useQuery({
    queryKey: ["pr-files-viewed", threadId, target],
    queryFn: async () => {
      if (!target) throw new Error("The pull request is not loaded.");
      const read = ++reads.current;
      return {
        result: await ipc.readPullRequestFilesViewed(threadId, target),
        read,
        owner: readOwner.current,
      };
    },
    enabled: !!target,
    retry: false,
    refetchOnWindowFocus: false,
    structuralSharing: false,
  });
  const lastKnown = useRef<{
    scope: string;
    states: FileViewedStates | null;
    truncated: boolean;
  }>({ scope: scopeKey, states: null, truncated: false });
  const received = useMemo(
    () => toFileViewedStates(query.data?.result ?? null),
    [query.data],
  );
  if (lastKnown.current.scope !== scopeKey)
    lastKnown.current = { scope: scopeKey, states: null, truncated: false };
  if (received)
    lastKnown.current = {
      scope: scopeKey,
      states: received,
      truncated: query.data?.result.truncated === true,
    };
  const states = lastKnown.current.states;
  const [overlay, setOverlay] = useState<FileViewedOverlay>(NO_OVERLAY);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const queued = useRef(new Map<string, boolean>());
  const queueTarget = useRef<{
    threadId: PrAccess;
    target: PrObservation;
    scope: string;
  } | null>(null);
  const currentTarget = useRef({ threadId, target, scope: scopeKey });
  currentTarget.current = { threadId, target, scope: scopeKey };
  const sentBy = useRef(new Map<string, number>());
  const answeredAfter = useRef(new Map<string, number>());
  const requests = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const pending = new Set([
      ...queued.current.keys(),
      ...sentBy.current.keys(),
    ]);
    const answered = new Set<string>();
    for (const [path, after] of answeredAfter.current) {
      if (pending.has(path)) continue;
      if (
        !query.data ||
        query.data.owner !== readOwner.current ||
        query.data.read <= after
      ) {
        pending.add(path);
        continue;
      }
      answered.add(path);
      answeredAfter.current.delete(path);
    }
    setOverlay((current) =>
      settleFileViewedOverlay(current, states, pending, answered),
    );
  }, [query.data, states]);

  const refresh = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);
  const flush = useCallback(() => {
    flushTimer.current = null;
    const batch = toFileViewedBatch(queued.current);
    const captured = queueTarget.current;
    if (batch.length === 0 || !captured) return;
    queued.current = new Map();
    queueTarget.current = null;
    const sentFrom = captured.scope;
    const request = ++requests.current;
    for (const file of batch) sentBy.current.set(file.path, request);
    writes.current = writes.current.then(async () => {
      try {
        for (let offset = 0; offset < batch.length; offset += 100) {
          await ipc.setPullRequestFilesViewed(captured.threadId, {
            target: captured.target,
            files: batch.slice(offset, offset + 100),
          });
        }
      } catch {
        if (scope.current !== sentFrom) return;
        const owned = new Set(
          batch
            .map((file) => file.path)
            .filter(
              (path) =>
                sentBy.current.get(path) === request &&
                !queued.current.has(path),
            ),
        );
        for (const path of owned) sentBy.current.delete(path);
        setOverlay((current) => revertFileViewedOverlay(current, batch, owned));
        if (owned.size > 0) setMutationError("Could not update viewed files");
        return;
      }
      if (scope.current !== sentFrom) return;
      for (const file of batch) {
        if (sentBy.current.get(file.path) !== request) continue;
        sentBy.current.delete(file.path);
        answeredAfter.current.set(file.path, reads.current);
      }
      const acknowledgedAt = reads.current;
      void query.refetch().then((result) => {
        if (
          scope.current === sentFrom &&
          result.data &&
          (result.data.owner !== readOwner.current ||
            result.data.read <= acknowledgedAt)
        )
          void query.refetch();
      });
    });
  }, [query.refetch]);
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    scope.current = scopeKey;
    return () => {
      if (flushTimer.current !== null) {
        clearTimeout(flushTimer.current);
        flushRef.current();
      }
      scope.current = "departed";
      queued.current = new Map();
      queueTarget.current = null;
      sentBy.current = new Map();
      answeredAfter.current = new Map();
      setOverlay(NO_OVERLAY);
      setMutationError(null);
    };
  }, [scopeKey]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const refreshFromHost = useCallback(() => refreshRef.current(), []);
  const setViewed = useCallback((path: string, viewed: boolean) => {
    const current = currentTarget.current;
    if (!current.target) return;
    if (
      queueTarget.current &&
      queueTarget.current.target.headOid !== current.target.headOid
    ) {
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
      flushRef.current();
    }
    queueTarget.current = {
      threadId: current.threadId,
      target: current.target,
      scope: current.scope,
    };
    setMutationError(null);
    setOverlay((current) => new Map(current).set(path, viewed));
    queued.current.set(path, viewed);
    if (flushTimer.current !== null) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => flushRef.current(), FLUSH_DELAY_MS);
  }, []);
  const scopedOverlay = scope.current === scopeKey ? overlay : NO_OVERLAY;
  const scopedMutationError = scope.current === scopeKey ? mutationError : null;
  const isViewed = useCallback(
    (path: string) => isFileViewed(path, states, scopedOverlay),
    [states, scopedOverlay],
  );
  const isStale = useCallback(
    (path: string) =>
      !scopedOverlay.has(path) && isStaleViewedState(states?.get(path)),
    [states, scopedOverlay],
  );
  return useMemo(
    () => ({
      enabled: !!target,
      isViewed,
      isStale,
      setViewed,
      viewedCount: countViewedFiles(paths, states, scopedOverlay),
      truncated: lastKnown.current.truncated,
      error: query.error?.message ?? null,
      mutationError: scopedMutationError,
      refresh: refreshFromHost,
    }),
    [
      target,
      isViewed,
      isStale,
      setViewed,
      paths,
      states,
      scopedOverlay,
      query.error,
      scopedMutationError,
      refreshFromHost,
    ],
  );
}
