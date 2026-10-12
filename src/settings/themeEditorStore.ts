// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/settings/themeEditorStore.ts (MIT). A module store replaces zustand, and it also holds the draft AppearanceRoot paints while a session is open.
import { useSyncExternalStore } from "react";
import type { ThemePreview } from "../appearance/root";
import {
  getThemeDefinition,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";

/**
 * The theme editor lives above the router so a draft survives navigation: the
 * palette is painted on the live app, and judging it means browsing the app
 * while the editor stays open. Themes are referenced by id because the stored
 * definitions change underneath an open session (an edit, an import).
 */
export type ThemeEditorSessionInput = {
  /** Set when editing an installed theme; null creates a new one. */
  editingThemeId: string | null;
  /** Theme a new theme starts from: the active one, or a duplicate target. */
  seedThemeId: string | null;
  /** Prefilled name, used by duplicate. */
  seedName: string | null;
  initialAppearance: ThemeAppearance;
};

export type ThemeEditorSession = ThemeEditorSessionInput & {
  /**
   * Distinguishes two sessions that name the same themes, so asking for a
   * fresh draft while the panel is already open still reseeds it.
   */
  id: number;
};

type ThemeEditorStore = {
  session: ThemeEditorSession | null;
  preview: ThemePreview | null;
  openThemeEditor: (session: ThemeEditorSessionInput) => void;
  closeThemeEditor: () => void;
  setThemeEditorPreview: (preview: ThemePreview | null) => void;
};

let nextSessionId = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function set(patch: Partial<ThemeEditorStore>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
let state: ThemeEditorStore = {
  session: null,
  preview: null,
  openThemeEditor: (session) =>
    set({ session: { ...session, id: ++nextSessionId } }),
  // Dropping the draft with the session is what restores the stored theme.
  closeThemeEditor: () => set({ session: null, preview: null }),
  setThemeEditorPreview: (preview) =>
    set({ preview: state.session ? preview : null }),
};

export function useThemeEditorStore<T>(
  select: (store: ThemeEditorStore) => T,
): T {
  const read = () => select(state);
  return useSyncExternalStore(subscribe, read, read);
}
useThemeEditorStore.getState = (): ThemeEditorStore => state;

export function toggleThemeEditorForTheme(input: {
  theme: ThemePreference;
  themeHalves: ThemeHalves | null;
  initialAppearance: ThemeAppearance;
}): void {
  const store = useThemeEditorStore.getState();
  if (store.session) {
    store.closeThemeEditor();
    return;
  }

  const baseThemeId = getThemeDefinition(input.theme)?.id ?? null;
  const activeThemeId =
    input.themeHalves?.[input.initialAppearance] ?? baseThemeId;
  const seedThemeId = activeThemeId
    ? (getThemeDefinition(activeThemeId)?.id ?? null)
    : null;
  store.openThemeEditor({
    editingThemeId: null,
    seedThemeId,
    seedName: null,
    initialAppearance: input.initialAppearance,
  });
}
