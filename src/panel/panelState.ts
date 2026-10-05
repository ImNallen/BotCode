// Surface transitions follow pingdotgg/t3code v0.0.45 apps/web/src/rightPanelStore.ts (MIT).
import type { PanelState, Surface } from "./RightPanel";

const sameSurface = (a: Surface, b: Surface) =>
  a.kind === b.kind &&
  (a.kind !== "file" || (b.kind === "file" && a.path === b.path));

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

export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function eligibleSurfaces(
  state: PanelState,
  repository: boolean,
  conversation = false,
): PanelState {
  const allowed = (surface: Surface) =>
    surface.kind === "pull_requests"
      ? conversation
      : repository || surface.kind === "files" || surface.kind === "file";
  if (state.surfaces.every(allowed)) return state;
  const active =
    state.active === null ? undefined : state.surfaces[state.active];
  const surfaces = state.surfaces.filter(allowed);
  const index = active
    ? surfaces.findIndex((surface) => surface === active)
    : -1;
  return { surfaces, active: index < 0 ? null : index };
}

export function surfaceTitle(surface: Surface): string {
  switch (surface.kind) {
    case "files":
      return "Files";
    case "diff":
      return "Diff";
    case "pull_requests":
      return "Pull requests";
    case "file":
      return basename(surface.path);
  }
}

export function surfaceKey(surface: Surface): string {
  return surface.kind === "file" ? `file:${surface.path}` : surface.kind;
}
