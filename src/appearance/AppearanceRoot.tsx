import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useMediaQuery } from "../lib/useMediaQuery";
import { usePreferences } from "../settings/preferences";
import {
  applyRootState,
  resolveRootState,
  type RootInputs,
  type RootState,
} from "./root";
import type { AppearanceSettings } from "./settings";

export const systemDarkQuery = "(prefers-color-scheme: dark)";

// Slider values shown while dragging. Never persisted; a commit removes its keys.
type Draft = Partial<AppearanceSettings>;
let draft: Draft = {};
const draftListeners = new Set<() => void>();
function setDraft(next: Draft) {
  draft = next;
  for (const listener of draftListeners) listener();
}
function subscribeDraft(listener: () => void) {
  draftListeners.add(listener);
  return () => draftListeners.delete(listener);
}
const readDraft = () => draft;

export type AppearanceApi = Readonly<{
  appearance: AppearanceSettings;
  update: (patch: Partial<AppearanceSettings>) => void;
  preview: (patch: Partial<AppearanceSettings>) => void;
}>;

export function useAppearance(): AppearanceApi {
  const { preferences, update } = usePreferences();
  const current = useSyncExternalStore(subscribeDraft, readDraft, readDraft);
  const appearance = useMemo(
    () => ({ ...preferences.appearance, ...current }),
    [preferences.appearance, current],
  );
  return {
    appearance,
    update: (patch) => {
      update({ appearance: { ...preferences.appearance, ...patch } });
      const remaining = { ...draft };
      for (const key of Object.keys(patch) as (keyof Draft)[])
        delete remaining[key];
      setDraft(remaining);
    },
    preview: (patch) => setDraft({ ...draft, ...patch }),
  };
}

let painted: RootState | null = null;

// The only writer of appearance state onto <html>.
export function paintRoot(inputs: RootInputs): void {
  const next = resolveRootState(inputs);
  const root = document.documentElement;
  const schemeChanged = painted !== null && painted.dark !== next.dark;
  if (schemeChanged) root.classList.add("no-transitions");
  applyRootState(root, painted, next);
  painted = next;
  if (schemeChanged) {
    // T3 useTheme.ts: a reflow commits the class before the next frame removes it.
    void root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("no-transitions"));
  }
}

export function AppearanceRoot() {
  const { appearance } = useAppearance();
  const systemDark = useMediaQuery(systemDarkQuery);
  useLayoutEffect(
    () => paintRoot({ appearance, systemDark }),
    [appearance, systemDark],
  );
  return null;
}
