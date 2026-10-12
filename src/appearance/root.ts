// Token policy follows pingdotgg/t3code v0.0.45 apps/web/src/routes/__root.tsx appearance sync effects, appearanceContrast.ts, hooks/useTheme.ts applyTheme and themePalette.ts applyThemePalette (MIT).
import { appearanceFontStyle } from "../appearanceFonts";
import {
  APP_THEME_VARIABLES,
  getThemeColorsForMode,
  getThemeDefinition,
  isThemeColor,
  parseThemeHalves,
  resolveThemeAppearance,
  resolveThemeHalf,
  THEME_PREVIEW_ID,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeHalves,
} from "../themePalette";
import type { AppearanceSettings } from "./settings";

export type RootState = Readonly<{
  dark: boolean;
  attributes: Readonly<Record<string, string>>;
  style: Readonly<Record<string, string>>;
}>;

// The theme editor's unsaved draft. While present it wins over the selection.
export type ThemePreview = Readonly<{
  colors: ThemeColors;
  appearance: ThemeAppearance;
}>;

export type RootInputs = Readonly<{
  appearance: AppearanceSettings;
  systemDark: boolean;
  customThemes: ReadonlyArray<ThemeDefinition>;
  preview?: ThemePreview | null;
}>;

export type ResolvedThemeSelection = Readonly<{
  appearance: ThemeAppearance;
  // Halves that name an installed theme able to render their side.
  halves: ThemeHalves | null;
  theme: ThemeDefinition | null;
}>;

// T3 useTheme applyTheme: the appearance, then the theme that owns it.
export function resolveThemeSelection(
  appearance: Pick<
    AppearanceSettings,
    "theme" | "themeAppearanceMode" | "themeHalves"
  >,
  systemDark: boolean,
  customThemes: ReadonlyArray<ThemeDefinition>,
): ResolvedThemeSelection {
  const mode = appearance.themeAppearanceMode;
  const halves = parseThemeHalves(appearance.themeHalves, customThemes);
  const resolved = resolveThemeAppearance(
    appearance.theme,
    systemDark,
    mode === "system",
    mode,
    halves,
    customThemes,
  );
  return {
    appearance: resolved,
    halves,
    theme: getThemeDefinition(
      resolveThemeHalf(appearance.theme, halves, resolved),
      customThemes,
    ),
  };
}

function themeVariables(colors: ThemeColors): Record<string, string> {
  const style: Record<string, string> = {};
  for (const [role, value] of Object.entries(colors) as [
    ThemeColorRole,
    string,
  ][])
    // A half-typed draft color keeps the role on the stock token instead of blanking it.
    if (isThemeColor(value)) style[APP_THEME_VARIABLES[role]] = value;
  return style;
}

function resolveThemeLayer({
  appearance,
  systemDark,
  customThemes,
  preview,
}: RootInputs): RootState {
  if (preview)
    return {
      dark: preview.appearance === "dark",
      attributes: { "data-theme-id": THEME_PREVIEW_ID },
      style: themeVariables(preview.colors),
    };
  const selection = resolveThemeSelection(appearance, systemDark, customThemes);
  const theme = selection.theme;
  return {
    dark: selection.appearance === "dark",
    attributes: theme ? { "data-theme-id": theme.id } : {},
    style: theme
      ? themeVariables(
          getThemeColorsForMode(theme, selection.appearance) ?? theme.colors,
        )
      : {},
  };
}

export function resolveRootState(inputs: RootInputs): RootState {
  const { appearance } = inputs;
  const contrast = appearance.appearanceContrast;
  const boost = Math.max(contrast - 100, 0);
  const theme = resolveThemeLayer(inputs);
  return {
    dark: theme.dark,
    attributes: {
      "data-chat-width": appearance.chatWidth,
      "data-diff-color-scheme": appearance.diffColorScheme,
      ...theme.attributes,
    },
    style: {
      "--appearance-contrast-base": `${Math.min(contrast, 100)}%`,
      "--appearance-contrast-boost": `${boost}%`,
      "--appearance-contrast-border-boost": `${boost / 4}%`,
      "--glass-opacity": `${appearance.glassOpacity}%`,
      ...(appearance.glassOpacity === 100 ? { "--glass-blur": "0px" } : {}),
      ...appearanceFontStyle(appearance),
      ...theme.style,
    },
  };
}

// T3 applies a changed palette inside a no-transitions frame, but paints an
// editor draft without one so dragging a color stays live.
export function changesColorScheme(
  previous: RootState | null,
  next: RootState,
): boolean {
  if (previous === null) return false;
  if (previous.dark !== next.dark) return true;
  const id = previous.attributes["data-theme-id"];
  if (id !== next.attributes["data-theme-id"]) return true;
  if (id === THEME_PREVIEW_ID) return false;
  return Object.values(APP_THEME_VARIABLES).some(
    (name) => previous.style[name] !== next.style[name],
  );
}

// The subset of HTMLElement that applyRootState touches.
export type RootTarget = {
  classList: { toggle(token: string, force: boolean): boolean };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): string;
  };
};

// Writes only what differs from `previous` and removes what `next` no longer declares.
export function applyRootState(
  root: RootTarget,
  previous: RootState | null,
  next: RootState,
): void {
  if (previous?.dark !== next.dark) root.classList.toggle("dark", next.dark);
  for (const name of Object.keys(previous?.attributes ?? {}))
    if (!(name in next.attributes)) root.removeAttribute(name);
  for (const [name, value] of Object.entries(next.attributes))
    if (previous?.attributes[name] !== value) root.setAttribute(name, value);
  for (const name of Object.keys(previous?.style ?? {}))
    if (!(name in next.style)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(next.style))
    if (previous?.style[name] !== value) root.style.setProperty(name, value);
}
