// Ported from pingdotgg/t3code v0.0.45 packages/shared/src/terminalLabels.ts resolveTerminalSessionLabel (MIT).
import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";
import { getTerminalLabel, terminalScopeKey } from "./terminalState";

export const terminalLabelsPayload = z.object({
  sequence: z.number(),
  labels: z.array(
    z.object({
      workspaceId: z.string(),
      threadId: z.string().nullable(),
      terminalId: z.string(),
      label: z.string(),
    }),
  ),
});

type ScopeLabels = ReadonlyMap<string, string>;

const NO_LABELS: ScopeLabels = new Map();
let sequence = -1;
let scopes: ReadonlyMap<string, ScopeLabels> = new Map();
const listeners = new Set<() => void>();

export function applyTerminalLabels(payload: unknown): void {
  const parsed = terminalLabelsPayload.safeParse(payload);
  if (!parsed.success || parsed.data.sequence <= sequence) return;
  sequence = parsed.data.sequence;
  const next = new Map<string, Map<string, string>>();
  for (const entry of parsed.data.labels) {
    const scope = terminalScopeKey(entry.workspaceId, entry.threadId);
    const labels = next.get(scope) ?? new Map<string, string>();
    labels.set(entry.terminalId, entry.label);
    next.set(scope, labels);
  }
  scopes = next;
  for (const listener of listeners) listener();
}

function resolve(labels: ScopeLabels, terminalId: string): string {
  return labels.get(terminalId)?.trim() || getTerminalLabel(terminalId);
}

export function readTerminalLabel(
  scopeKey: string,
  terminalId: string,
): string {
  return resolve(scopes.get(scopeKey) ?? NO_LABELS, terminalId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTerminalLabelFor(
  scopeKey: string,
): (terminalId: string) => string {
  const labels = useSyncExternalStore(
    subscribe,
    () => scopes.get(scopeKey) ?? NO_LABELS,
  );
  return useCallback(
    (terminalId: string) => resolve(labels, terminalId),
    [labels],
  );
}
