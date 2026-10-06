// Ported from pingdotgg/t3code v0.0.45 apps/web/src/terminalUiStateStore.ts, types.ts,
// packages/shared/src/terminalLabels.ts and the terminal transitions of rightPanelStore.ts (MIT):
// the stores' transitions as pure functions.
import { z } from "zod";

export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const MAX_TERMINALS_PER_GROUP = 4;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
  splitDirection?: "horizontal" | "vertical";
}

export type TerminalSurfaceId = `terminal:${string}`;

/** A right-panel terminal tab. Its terminals never appear in the drawer. */
export interface TerminalPanelSurface {
  id: TerminalSurfaceId;
  terminalIds: string[];
  activeTerminalId: string;
  splitDirection?: "horizontal" | "vertical";
}

export interface ThreadTerminalUiState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  panelSurfaces: TerminalPanelSurface[];
}

export type TerminalStates = Readonly<Record<string, ThreadTerminalUiState>>;

export const DEFAULT_THREAD_TERMINAL_UI_STATE: ThreadTerminalUiState =
  Object.freeze({
    terminalOpen: false,
    terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: [],
    activeTerminalId: "",
    terminalGroups: [],
    activeTerminalGroupId: "",
    panelSurfaces: [],
  });

export function terminalScopeKey(
  workspaceId: string,
  threadId: string | null,
): string {
  return threadId ?? `draft:${workspaceId}`;
}

export function getTerminalLabel(terminalId: string): string {
  const numericSuffix = /^term(?:inal)?-(\d+)$/i.exec(terminalId)?.[1];
  if (numericSuffix) {
    return `Terminal ${numericSuffix}`;
  }

  return terminalId;
}

export function nextTerminalId(
  existingTerminalIds: ReadonlyArray<string>,
): string {
  const usedIds = new Set(
    existingTerminalIds.filter((id) => id.trim().length > 0),
  );
  let nextIndex = 1;
  while (usedIds.has(`term-${nextIndex}`)) {
    nextIndex += 1;
  }

  return `term-${nextIndex}`;
}

export function panelTerminalIds(state: ThreadTerminalUiState): string[] {
  return state.panelSurfaces.flatMap((surface) => surface.terminalIds);
}

/** The lowest free `term-N` across the drawer and the panel, as T3's allocatable ids are. */
export function allocateTerminalId(state: ThreadTerminalUiState): string {
  return nextTerminalId([...state.terminalIds, ...panelTerminalIds(state)]);
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const normalizedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of terminalIds) {
    const trimmedId = id.trim();
    if (trimmedId.length === 0 || seen.has(trimmedId)) continue;
    seen.add(trimmedId);
    normalizedIds.push(trimmedId);
  }
  return normalizedIds;
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(
  baseId: string,
  usedGroupIds: Set<string>,
): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) =>
    group.terminalIds.includes(terminalId),
  );
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  if (terminalIds.length === 0) {
    return [];
  }

  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalIds(group.terminalIds).filter(
      (terminalId) => {
        if (!validTerminalIdSet.has(terminalId)) return false;
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      },
    );
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? terminalIds[0] ?? "");
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
      ...(group.splitDirection === "vertical"
        ? { splitDirection: "vertical" as const }
        : {}),
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(
  left: ThreadTerminalGroup[],
  right: ThreadTerminalGroup[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (
      (leftGroup.splitDirection ?? "horizontal") !==
      (rightGroup.splitDirection ?? "horizontal")
    ) {
      return false;
    }
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds))
      return false;
  }
  return true;
}

function panelSurfacesEqual(
  left: TerminalPanelSurface[],
  right: TerminalPanelSurface[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftSurface = left[index];
    const rightSurface = right[index];
    if (!leftSurface || !rightSurface) return false;
    if (
      leftSurface.id !== rightSurface.id ||
      leftSurface.activeTerminalId !== rightSurface.activeTerminalId ||
      (leftSurface.splitDirection ?? "horizontal") !==
        (rightSurface.splitDirection ?? "horizontal") ||
      !arraysEqual(leftSurface.terminalIds, rightSurface.terminalIds)
    ) {
      return false;
    }
  }
  return true;
}

function threadTerminalUiStateEqual(
  left: ThreadTerminalUiState,
  right: ThreadTerminalUiState,
): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups) &&
    panelSurfacesEqual(left.panelSurfaces, right.panelSurfaces)
  );
}

function createDefaultThreadTerminalUiState(
  panelSurfaces: TerminalPanelSurface[],
): ThreadTerminalUiState {
  return {
    ...DEFAULT_THREAD_TERMINAL_UI_STATE,
    terminalIds: [],
    terminalGroups: [],
    panelSurfaces,
  };
}

function normalizePanelSurfaces(
  surfaces: TerminalPanelSurface[],
): TerminalPanelSurface[] {
  const usedTerminalIds = new Set<string>();
  const usedSurfaceIds = new Set<string>();
  const nextSurfaces: TerminalPanelSurface[] = [];
  for (const surface of surfaces) {
    if (usedSurfaceIds.has(surface.id)) continue;
    const terminalIds = normalizeTerminalIds(surface.terminalIds).filter(
      (terminalId) => !usedTerminalIds.has(terminalId),
    );
    const firstTerminalId = terminalIds[0];
    if (firstTerminalId === undefined) continue;
    usedSurfaceIds.add(surface.id);
    for (const terminalId of terminalIds) usedTerminalIds.add(terminalId);
    nextSurfaces.push({
      id: surface.id,
      terminalIds,
      activeTerminalId: terminalIds.includes(surface.activeTerminalId)
        ? surface.activeTerminalId
        : firstTerminalId,
      ...(surface.splitDirection === "vertical"
        ? { splitDirection: "vertical" as const }
        : {}),
    });
  }
  return nextSurfaces;
}

function normalizeThreadTerminalUiState(
  state: ThreadTerminalUiState,
): ThreadTerminalUiState {
  const panelSurfaces = normalizePanelSurfaces(state.panelSurfaces);
  const panelIds = new Set(
    panelSurfaces.flatMap((surface) => surface.terminalIds),
  );
  const nextTerminalIds = normalizeTerminalIds(state.terminalIds).filter(
    (terminalId) => !panelIds.has(terminalId),
  );
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? "");
  const terminalGroups = normalizeTerminalGroups(
    state.terminalGroups,
    nextTerminalIds,
  );
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))
      ?.id ?? null;

  const normalized: ThreadTerminalUiState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ??
      activeGroupIdFromTerminal ??
      terminalGroups[0]?.id ??
      "",
    panelSurfaces,
  };
  return threadTerminalUiStateEqual(state, normalized) ? state : normalized;
}

function isDefaultThreadTerminalUiState(state: ThreadTerminalUiState): boolean {
  return threadTerminalUiStateEqual(
    normalizeThreadTerminalUiState(state),
    DEFAULT_THREAD_TERMINAL_UI_STATE,
  );
}

function copyTerminalGroups(
  groups: ThreadTerminalGroup[],
): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
    ...(group.splitDirection === "vertical"
      ? { splitDirection: "vertical" as const }
      : {}),
  }));
}

function upsertTerminalIntoGroups(
  state: ThreadTerminalUiState,
  terminalId: string,
  mode: "split" | "new",
  splitDirection: "horizontal" | "vertical" = "horizontal",
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  const effectiveMode: "split" | "new" =
    normalized.terminalIds.length === 0 ? "new" : mode;
  if (
    terminalId.trim().length === 0 ||
    panelTerminalIds(normalized).includes(terminalId)
  ) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(
    terminalGroups,
    terminalId,
  );
  const existingGroup = terminalGroups[existingGroupIndex];
  if (existingGroup) {
    existingGroup.terminalIds = existingGroup.terminalIds.filter(
      (id) => id !== terminalId,
    );
    if (existingGroup.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (effectiveMode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(terminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return normalizeThreadTerminalUiState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(
      terminalGroups,
      normalized.activeTerminalId,
    );
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({
      id: nextGroupId,
      terminalIds: [normalized.activeTerminalId],
    });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }
  const destinationTerminalIdSet = new Set(destinationGroup.terminalIds);

  if (
    isNewTerminal &&
    !destinationTerminalIdSet.has(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationTerminalIdSet.has(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(
      normalized.activeTerminalId,
    );
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
  }
  if (splitDirection === "vertical") {
    destinationGroup.splitDirection = "vertical";
  } else {
    delete destinationGroup.splitDirection;
  }

  return normalizeThreadTerminalUiState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

export function setTerminalOpen(
  state: ThreadTerminalUiState,
  open: boolean,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (open && normalized.terminalIds.length === 0) {
    return upsertTerminalIntoGroups(
      normalized,
      allocateTerminalId(normalized),
      "new",
    );
  }
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

export function toggleTerminalOpen(
  state: ThreadTerminalUiState,
): ThreadTerminalUiState {
  return setTerminalOpen(state, !state.terminalOpen);
}

export function setTerminalHeight(
  state: ThreadTerminalUiState,
  height: number,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (
    !Number.isFinite(height) ||
    height <= 0 ||
    normalized.terminalHeight === height
  ) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

export function splitTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
  direction: "horizontal" | "vertical" = "horizontal",
): ThreadTerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "split", direction);
}

export function newTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

export function setActiveTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalId),
    )?.id ?? normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  };
}

export function ensureTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
  options?: { open?: boolean; active?: boolean },
): ThreadTerminalUiState {
  let nextState = state;
  if (!state.terminalIds.includes(terminalId)) {
    nextState = newTerminal(nextState, terminalId);
  }
  if (options?.active === false) {
    nextState = {
      ...nextState,
      activeTerminalId: state.activeTerminalId,
      activeTerminalGroupId: state.activeTerminalGroupId,
    };
  }
  if (options?.active ?? true) {
    nextState = setActiveTerminal(nextState, terminalId);
  }
  if (options?.open) {
    nextState = setTerminalOpen(nextState, true);
  }
  return normalizeThreadTerminalUiState(nextState);
}

export function closeTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter(
    (id) => id !== terminalId,
  );
  if (remainingTerminalIds.length === 0) {
    return createDefaultThreadTerminalUiState(normalized.panelSurfaces);
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (remainingTerminalIds[
          Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)
        ] ??
        remainingTerminalIds[0] ??
        "")
      : normalized.activeTerminalId;

  const terminalGroups: ThreadTerminalGroup[] = [];
  for (const group of normalized.terminalGroups) {
    const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
    if (terminalIds.length > 0) {
      terminalGroups.push({ ...group, terminalIds });
    }
  }

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) =>
      group.terminalIds.includes(nextActiveTerminalId),
    )?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeThreadTerminalUiState({
    terminalOpen: normalized.terminalOpen,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remainingTerminalIds,
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
    panelSurfaces: normalized.panelSurfaces,
  });
}

function updatePanelSurface(
  state: ThreadTerminalUiState,
  surfaceId: TerminalSurfaceId,
  update: (surface: TerminalPanelSurface) => TerminalPanelSurface,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  const surface = normalized.panelSurfaces.find(
    (entry) => entry.id === surfaceId,
  );
  if (!surface) return normalized;
  const next = update(surface);
  if (next === surface) return normalized;
  return {
    ...normalized,
    panelSurfaces: normalized.panelSurfaces.map((entry) =>
      entry === surface ? next : entry,
    ),
  };
}

export function openPanelTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (
    terminalId.trim().length === 0 ||
    normalized.terminalIds.includes(terminalId) ||
    panelTerminalIds(normalized).includes(terminalId)
  ) {
    return normalized;
  }
  return {
    ...normalized,
    panelSurfaces: [
      ...normalized.panelSurfaces,
      {
        id: `terminal:${terminalId}`,
        terminalIds: [terminalId],
        activeTerminalId: terminalId,
      },
    ],
  };
}

export function splitPanelTerminal(
  state: ThreadTerminalUiState,
  surfaceId: TerminalSurfaceId,
  terminalId: string,
  direction: "horizontal" | "vertical" = "horizontal",
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  if (
    terminalId.trim().length === 0 ||
    normalized.terminalIds.includes(terminalId) ||
    panelTerminalIds(normalized).includes(terminalId)
  ) {
    return normalized;
  }
  return updatePanelSurface(normalized, surfaceId, (surface) => {
    if (surface.terminalIds.length >= MAX_TERMINALS_PER_GROUP) return surface;
    const { splitDirection: _splitDirection, ...baseSurface } = surface;
    return {
      ...baseSurface,
      terminalIds: [...surface.terminalIds, terminalId],
      activeTerminalId: terminalId,
      ...(direction === "vertical"
        ? { splitDirection: "vertical" as const }
        : {}),
    };
  });
}

export function activatePanelTerminal(
  state: ThreadTerminalUiState,
  surfaceId: TerminalSurfaceId,
  terminalId: string,
): ThreadTerminalUiState {
  return updatePanelSurface(state, surfaceId, (surface) =>
    surface.terminalIds.includes(terminalId) &&
    surface.activeTerminalId !== terminalId
      ? { ...surface, activeTerminalId: terminalId }
      : surface,
  );
}

export function closePanelTerminal(
  state: ThreadTerminalUiState,
  terminalId: string,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  const surface = normalized.panelSurfaces.find((entry) =>
    entry.terminalIds.includes(terminalId),
  );
  if (!surface) return normalized;
  const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
  const lastTerminalId = terminalIds.at(-1);
  if (lastTerminalId === undefined) {
    return closePanelSurface(normalized, surface.id);
  }
  return updatePanelSurface(normalized, surface.id, (entry) => ({
    ...entry,
    terminalIds,
    activeTerminalId:
      entry.activeTerminalId === terminalId
        ? lastTerminalId
        : entry.activeTerminalId,
  }));
}

export function closePanelSurface(
  state: ThreadTerminalUiState,
  surfaceId: TerminalSurfaceId,
): ThreadTerminalUiState {
  const normalized = normalizeThreadTerminalUiState(state);
  const panelSurfaces = normalized.panelSurfaces.filter(
    (surface) => surface.id !== surfaceId,
  );
  if (panelSurfaces.length === normalized.panelSurfaces.length) {
    return normalized;
  }
  return { ...normalized, panelSurfaces };
}

export function selectTerminalState(
  states: TerminalStates,
  scopeKey: string,
): ThreadTerminalUiState {
  return states[scopeKey] ?? DEFAULT_THREAD_TERMINAL_UI_STATE;
}

export function updateTerminalStates(
  states: TerminalStates,
  scopeKey: string,
  update: (state: ThreadTerminalUiState) => ThreadTerminalUiState,
): TerminalStates {
  const current = selectTerminalState(states, scopeKey);
  const next = update(current);
  if (next === current) {
    return states;
  }

  if (isDefaultThreadTerminalUiState(next)) {
    if (states[scopeKey] === undefined) {
      return states;
    }
    const { [scopeKey]: _removed, ...rest } = states;
    return rest;
  }

  return { ...states, [scopeKey]: next };
}

const persistedState = z.object({
  terminalOpen: z.boolean(),
  terminalHeight: z.number(),
  terminalIds: z.array(z.string()),
  activeTerminalId: z.string(),
  terminalGroups: z.array(
    z.object({
      id: z.string(),
      terminalIds: z.array(z.string()),
      splitDirection: z.enum(["horizontal", "vertical"]).optional(),
    }),
  ),
  activeTerminalGroupId: z.string(),
  panelSurfaces: z
    .array(
      z.object({
        id: z.templateLiteral(["terminal:", z.string()]),
        terminalIds: z.array(z.string()),
        activeTerminalId: z.string(),
        splitDirection: z.enum(["horizontal", "vertical"]).optional(),
      }),
    )
    .default([]),
});

export function parseTerminalStates(stored: string | null): TerminalStates {
  if (stored === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return {};
  }
  const record = z.record(z.string(), z.unknown()).safeParse(value);
  if (!record.success) return {};
  const states: Record<string, ThreadTerminalUiState> = {};
  for (const [scopeKey, entry] of Object.entries(record.data)) {
    const parsed = persistedState.safeParse(entry);
    if (!parsed.success) continue;
    const state = normalizeThreadTerminalUiState(parsed.data);
    if (!isDefaultThreadTerminalUiState(state)) states[scopeKey] = state;
  }
  return states;
}
