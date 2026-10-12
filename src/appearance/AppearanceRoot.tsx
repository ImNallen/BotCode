import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { resolveTerminalFont, type TerminalFont } from "../appearanceFonts";
import { useMediaQuery } from "../lib/useMediaQuery";
import { usePreferences } from "../settings/preferences";
import { useThemeEditorStore } from "../settings/themeEditorStore";
import {
  getCustomThemes,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../themePalette";
import {
  applyRootState,
  needsNoTransitionsFrame,
  resolveRootState,
  resolveThemeSelection,
  type RootInputs,
  type RootState,
} from "./root";
import type { AppearanceSettings, ThemeMode } from "./settings";

export const systemDarkQuery = "(prefers-color-scheme: dark)";

type AppearancePatch = Partial<AppearanceSettings>;

let draft: AppearancePatch = {};
const draftListeners = new Set<() => void>();
function setDraft(next: AppearancePatch) {
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
  update: (
    change:
      | AppearancePatch
      | ((current: AppearanceSettings) => AppearancePatch),
  ) => Promise<boolean>;
  preview: (patch: AppearancePatch) => void;
}>;

export function useAppearance(): AppearanceApi {
  const { preferences, updateAppearance } = usePreferences();
  const current = useSyncExternalStore(subscribeDraft, readDraft, readDraft);
  const appearance = useMemo(
    () => ({ ...preferences.appearance, ...current }),
    [preferences.appearance, current],
  );
  return {
    appearance,
    update: (change) =>
      updateAppearance((saved) => {
        const patch = typeof change === "function" ? change(saved) : change;
        const remaining = { ...draft };
        for (const key of Object.keys(patch) as (keyof AppearancePatch)[])
          delete remaining[key];
        setDraft(remaining);
        return patch;
      }),
    preview: (patch) => setDraft({ ...draft, ...patch }),
  };
}

export function useTerminalFont(): TerminalFont {
  const { appearance } = useAppearance();
  const { family, size } = resolveTerminalFont(appearance);
  return useMemo(() => ({ family, size }), [family, size]);
}

const noCustomThemes: ReadonlyArray<ThemeDefinition> = [];

// Ported from pingdotgg/t3code v0.0.45 apps/web/src/hooks/useCustomThemes.ts (MIT).
export function useCustomThemes(): ReadonlyArray<ThemeDefinition> {
  return useSyncExternalStore(
    subscribeToCustomThemes,
    getCustomThemes,
    () => noCustomThemes,
  );
}

export function useThemeSelection() {
  const { appearance, update } = useAppearance();
  const customThemes = useCustomThemes();
  const systemDark = useMediaQuery(systemDarkQuery);
  const resolved = resolveThemeSelection(appearance, systemDark, customThemes);
  return {
    theme: appearance.theme,
    appearanceMode: appearance.themeAppearanceMode,
    resolvedTheme: resolved.appearance,
    themeHalves: resolved.halves,
    themeHalvesRaw: appearance.themeHalves,
    setTheme: (theme: string) => update({ theme, themeHalves: {} }),
    setAppearanceMode: (themeAppearanceMode: ThemeMode) =>
      update({ themeAppearanceMode }),
    setThemeHalf: (side: ThemeAppearance, themeId: string | null) =>
      update(({ themeHalves }) => {
        const { [side]: _, ...other } = themeHalves;
        return {
          themeHalves: themeId === null ? other : { ...other, [side]: themeId },
        };
      }),
  };
}

let painted: RootState | null = null;

export function paintRoot(inputs: RootInputs): void {
  const next = resolveRootState(inputs);
  const root = document.documentElement;
  const noTransitionsFrame = needsNoTransitionsFrame(painted, next);
  if (noTransitionsFrame) root.classList.add("no-transitions");
  applyRootState(root, painted, next);
  painted = next;
  if (noTransitionsFrame) {
    // T3 useTheme.ts: a reflow commits the class before the next frame removes it.
    void root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("no-transitions"));
  }
}

export function AppearanceRoot() {
  const { appearance } = useAppearance();
  const customThemes = useCustomThemes();
  const systemDark = useMediaQuery(systemDarkQuery);
  const preview = useThemeEditorStore((store) => store.preview);
  useLayoutEffect(
    () => paintRoot({ appearance, systemDark, customThemes, preview }),
    [appearance, systemDark, customThemes, preview],
  );
  return null;
}
