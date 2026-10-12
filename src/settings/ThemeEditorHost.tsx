// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/settings/ThemeEditorHost.tsx (MIT). Toasts go through Bot Code's editor toasts, and AppearanceRoot repaints a saved theme without a refresh.
import { lazy, Suspense, useCallback, useSyncExternalStore } from "react";

import { useThemeSelection } from "../appearance/AppearanceRoot";
import { notifyEditorResult } from "../lib/editorActions";
import {
  getThemeDefinition,
  subscribeToCustomThemes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../themePalette";
import { useThemeEditorStore } from "./themeEditorStore";

// The host mounts above the router on every page, but the editor body only
// renders once a session opens; lazy-loading it keeps the editor UI out of
// the startup chunk.
const ThemeEditorPanel = lazy(() =>
  import("./ThemeEditorPanel").then((module) => ({
    default: module.ThemeEditorPanel,
  })),
);

function useThemeDefinition(id: string | null | undefined) {
  return useSyncExternalStore(
    subscribeToCustomThemes,
    () => (id ? (getThemeDefinition(id) ?? null) : null),
    () => null,
  );
}

// T3 says "Browser storage is unavailable"; Bot Code keeps themes and the
// selection in its own storage, so the reason names that instead.
function notifyThemeSaveFailure() {
  notifyEditorResult(
    "error",
    "Could not save your theme",
    "Theme storage is unavailable, so the change was not kept.",
  );
}

/**
 * Renders the theme editor above the router. The editor paints its draft on
 * the live app, so it has to outlive the settings route: the point is to walk
 * through threads, panels, and pages while the colors are being tuned.
 */
export function ThemeEditorHost() {
  const session = useThemeEditorStore((store) => store.session);
  const closeThemeEditor = useThemeEditorStore(
    (store) => store.closeThemeEditor,
  );
  const { theme, setTheme, themeHalves } = useThemeSelection();
  // A saved definition can change without its id changing between sessions.
  const editingTheme = useThemeDefinition(session?.editingThemeId);
  const seedTheme = useThemeDefinition(session?.seedThemeId);

  // The panel reports which path it actually took: a theme removed while its
  // editor is open resolves to null there, so the save becomes a create even
  // though the session still names it.
  const handleSaved = useCallback(
    async (
      savedTheme: ThemeDefinition,
      {
        created,
        mergedAppearance,
      }: { created: boolean; mergedAppearance?: ThemeAppearance },
    ) => {
      // A merge completed an existing theme's light/dark pair; activating the
      // whole theme shows the new palette right away.
      if (mergedAppearance) {
        if (!(await setTheme(savedTheme.id))) {
          notifyThemeSaveFailure();
          return false;
        }
        notifyEditorResult(
          "success",
          `${savedTheme.label} updated`,
          `Its ${mergedAppearance} palette was added.`,
        );
        return true;
      }
      if (!created) {
        // The edited theme may be showing through the base preference or
        // either half of the mix; AppearanceRoot repaints it from the library.
        const wasActive =
          getThemeDefinition(theme)?.id === savedTheme.id ||
          themeHalves?.light === savedTheme.id ||
          themeHalves?.dark === savedTheme.id;
        notifyEditorResult(
          "success",
          `${savedTheme.label} saved`,
          wasActive
            ? "Your changes are now active."
            : "Your changes are saved.",
        );
        return true;
      }

      if (!(await setTheme(savedTheme.id))) {
        notifyThemeSaveFailure();
        return false;
      }
      notifyEditorResult(
        "success",
        `${savedTheme.label} created`,
        "It’s now active.",
      );
      return true;
    },
    [setTheme, theme, themeHalves],
  );

  if (!session) return null;

  return (
    <Suspense fallback={null}>
      <ThemeEditorPanel
        editingTheme={editingTheme}
        initialAppearance={session.initialAppearance}
        key={session.id}
        onOpenChange={(open) => {
          if (!open) closeThemeEditor();
        }}
        onSaved={handleSaved}
        onStorageFailure={notifyThemeSaveFailure}
        open
        seedName={session.seedName ?? undefined}
        seedTheme={seedTheme}
      />
    </Suspense>
  );
}
