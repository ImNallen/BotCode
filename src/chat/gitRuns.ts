import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import {
  IpcError,
  invalidateCheckouts,
  ipc,
  type CheckoutRef,
  type GitAction,
  type PrLookup,
} from "../ipc";
import type { VcsStatus } from "./GitActionsControl.logic.ts";
import type { GitRun } from "./gitActions";

const runs = new Map<string, GitRun>();
const listeners = new Set<() => void>();

const runKey = ({ workspaceId, threadId }: CheckoutRef) =>
  `${workspaceId}:${threadId ?? ""}`;

function set(key: string, run: GitRun | undefined) {
  if (run) runs.set(key, run);
  else runs.delete(key);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGitRun(checkout: CheckoutRef): GitRun | undefined {
  const key = runKey(checkout);
  return useSyncExternalStore(
    subscribe,
    useCallback(() => runs.get(key), [key]),
  );
}

export function startGitRun({
  client,
  checkout,
  originThreadId,
  action,
  before,
  pr,
  onPullRequest,
}: {
  client: QueryClient;
  checkout: CheckoutRef;
  originThreadId: string;
  action: GitAction;
  before: VcsStatus;
  pr: PrLookup | undefined;
  onPullRequest?: () => void;
}): boolean {
  const key = runKey(checkout);
  if (runs.get(key)?.state === "running") return false;
  set(key, {
    state: "running",
    action,
    phase: null,
    phaseStartedAtMs: Date.now(),
  });
  ipc
    .runGitAction(checkout, originThreadId, action, (phase) =>
      set(key, {
        state: "running",
        action,
        phase,
        phaseStartedAtMs: Date.now(),
      }),
    )
    .then(
      (outcome) => {
        set(key, { state: "done", outcome, before, pr });
        if (outcome.pr && !outcome.failure) onPullRequest?.();
      },
      (error: unknown) =>
        set(key, {
          state: "refused",
          action,
          error:
            error instanceof IpcError
              ? error
              : new IpcError("ipc", String(error)),
        }),
    )
    .finally(() => invalidateCheckouts(client, checkout.workspaceId));
  return true;
}

export function dismissGitRun(checkout: CheckoutRef): void {
  const key = runKey(checkout);
  if (runs.get(key)?.state !== "running") set(key, undefined);
}
