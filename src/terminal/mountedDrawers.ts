// Ported from T3 Code v0.0.45 apps/web/src/components/ChatView.logic.ts (MIT).
import type { TerminalCommand } from "./terminalKeys";
import { terminalScopeKey } from "./terminalState";

export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) =>
      threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export type TerminalOwner = {
  readonly workspaceId: string;
  readonly threadId: string | null;
};

export const ownerScope = (owner: TerminalOwner) =>
  terminalScopeKey(owner.workspaceId, owner.threadId);

export function reconcileMountedOwners(input: {
  current: readonly TerminalOwner[];
  openScopes: ReadonlySet<string>;
  liveWorkspaces: ReadonlySet<string>;
  active: TerminalOwner | null;
  activeOpen: boolean;
}): readonly TerminalOwner[] {
  const byScope = new Map(
    input.current.map((owner) => [ownerScope(owner), owner] as const),
  );
  const activeScope = input.active ? ownerScope(input.active) : null;
  if (input.active && activeScope && !byScope.has(activeScope))
    byScope.set(activeScope, input.active);
  const next = reconcileMountedTerminalThreadIds({
    currentThreadIds: input.current.map(ownerScope),
    openThreadIds: input.current
      .filter(
        (owner) =>
          input.liveWorkspaces.has(owner.workspaceId) &&
          input.openScopes.has(ownerScope(owner)),
      )
      .map(ownerScope),
    activeThreadId: activeScope,
    activeThreadTerminalOpen: input.activeOpen,
  }).flatMap((scope) => byScope.get(scope) ?? []);
  return next.length === input.current.length &&
    next.every((owner, index) => owner === input.current[index])
    ? input.current
    : next;
}

export function placeDrawerHosts(
  mounted: readonly string[],
  activeScope: string | null,
): Map<string, "slot" | "parking"> {
  return new Map(
    mounted.map((scope) => [scope, scope === activeScope ? "slot" : "parking"]),
  );
}

export function drawerShouldHandle(
  command: TerminalCommand,
  drawer: { readonly active: boolean; readonly focused: boolean },
): boolean {
  return command !== "terminal.toggle" && drawer.active && drawer.focused;
}
