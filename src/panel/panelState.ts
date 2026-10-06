// Surface transitions follow pingdotgg/t3code v0.0.45 apps/web/src/rightPanelStore.ts (MIT).
import {
  getTerminalLabel,
  type TerminalPanelSurface,
  type TerminalSurfaceId,
} from "../terminal/terminalState";
import type { PanelState, Surface } from "./RightPanel";
import type { ThreadPrSummary } from "./pullRequests";

type PrLinks = ThreadPrSummary["links"];

const sameSurface = (a: Surface, b: Surface) => surfaceKey(a) === surfaceKey(b);

export function pullRequestSurface(links: PrLinks): Surface {
  const [only, ...rest] = links;
  return only && rest.length === 0
    ? { kind: "pull_request", key: only.pr.key }
    : { kind: "pull_requests" };
}

export function openSurface(state: PanelState, surface: Surface): PanelState {
  const index = state.surfaces.findIndex((entry) =>
    sameSurface(entry, surface),
  );
  if (index >= 0) return { ...state, active: index };
  return {
    surfaces: [...state.surfaces, surface],
    active: state.surfaces.length,
  };
}

export function openFile(state: PanelState, path: string): PanelState {
  return openSurface(
    {
      surfaces: state.surfaces.filter((entry) => entry.kind !== "files"),
      active: null,
    },
    { kind: "file", path },
  );
}

export function closeFiles(state: PanelState): PanelState {
  if (!state.surfaces.some((entry) => entry.kind === "file")) return state;
  const active = state.active === null ? null : state.surfaces[state.active];
  const rest: PanelState = {
    surfaces: state.surfaces.filter((entry) => entry.kind !== "file"),
    active: null,
  };
  if (!active) return rest;
  return openSurface(rest, active.kind === "file" ? { kind: "files" } : active);
}

export function closeSurface(state: PanelState, index: number): PanelState {
  const surfaces = state.surfaces.filter((_, position) => position !== index);
  if (state.active === null) return { surfaces, active: null };
  if (state.active !== index)
    return {
      surfaces,
      active: state.active > index ? state.active - 1 : state.active,
    };
  return {
    surfaces,
    active: surfaces.length === 0 ? null : Math.min(index, surfaces.length - 1),
  };
}

/**
 * Terminal tabs mirror the current scope's panel terminals, which the terminal
 * store owns: tabs it no longer holds close, and ones it holds appear without
 * taking over the active tab unless nothing is active.
 */
export function reconcileTerminalSurfaces(
  state: PanelState,
  surfaceIds: readonly TerminalSurfaceId[],
): PanelState {
  const kept = state.surfaces.filter(
    (surface) => surface.kind !== "terminal" || surfaceIds.includes(surface.id),
  );
  const missing = surfaceIds.filter(
    (id) =>
      !kept.some((surface) => surface.kind === "terminal" && surface.id === id),
  );
  if (kept.length === state.surfaces.length && missing.length === 0) {
    return state;
  }
  let active: number | null = null;
  if (state.active !== null) {
    const activeSurface = state.surfaces[state.active];
    const keptIndex = activeSurface ? kept.indexOf(activeSurface) : -1;
    if (keptIndex >= 0) {
      active = keptIndex;
    } else if (kept.length > 0) {
      const keptBefore = state.surfaces
        .slice(0, state.active)
        .filter((surface) => kept.includes(surface)).length;
      active = Math.min(keptBefore, kept.length - 1);
    }
  }
  const surfaces: Surface[] = [
    ...kept,
    ...missing.map((id) => ({ kind: "terminal" as const, id })),
  ];
  return {
    surfaces,
    active: active ?? (surfaces.length > kept.length ? kept.length : null),
  };
}

export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function eligibleSurfaces(
  state: PanelState,
  repository: boolean,
  links?: PrLinks,
): PanelState {
  const allowed = (surface: Surface) => {
    switch (surface.kind) {
      case "pull_requests":
        return links !== undefined;
      case "pull_request":
        return links?.some((link) => link.pr.key === surface.key) ?? false;
      case "terminal":
        return true;
      default:
        return (
          repository || surface.kind === "files" || surface.kind === "file"
        );
    }
  };
  if (state.surfaces.every(allowed)) return state;
  const active =
    state.active === null ? undefined : state.surfaces[state.active];
  const surfaces = state.surfaces.filter(allowed);
  const index = active
    ? surfaces.findIndex((surface) => surface === active)
    : -1;
  return { surfaces, active: index < 0 ? null : index };
}

export function surfaceTitle(
  surface: Surface,
  terminals: readonly TerminalPanelSurface[] = [],
): string {
  switch (surface.kind) {
    case "files":
      return "Files";
    case "diff":
      return "Diff";
    case "pull_requests":
      return "Pull requests";
    case "pull_request":
      return `#${surface.key.split("/").at(-1)}`;
    case "file":
      return basename(surface.path);
    case "terminal":
      return getTerminalLabel(
        terminals.find((terminal) => terminal.id === surface.id)
          ?.activeTerminalId ?? surface.id.slice("terminal:".length),
      );
  }
}

export function surfaceKey(surface: Surface): string {
  switch (surface.kind) {
    case "file":
      return `file:${surface.path}`;
    case "pull_request":
      return `pr:${surface.key}`;
    case "terminal":
      return surface.id;
    default:
      return surface.kind;
  }
}
