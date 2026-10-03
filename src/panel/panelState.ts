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

export function surfaceTitle(surface: Surface): string {
  switch (surface.kind) {
    case "files":
      return "Files";
    case "diff":
      return "Diff";
    case "file":
      return basename(surface.path);
  }
}

export function surfaceKey(surface: Surface): string {
  return surface.kind === "file" ? `file:${surface.path}` : surface.kind;
}
