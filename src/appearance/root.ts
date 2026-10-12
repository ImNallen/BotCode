// Token policy follows pingdotgg/t3code v0.0.45 apps/web/src/routes/__root.tsx appearance sync effects and appearanceContrast.ts (MIT).
import { appearanceFontStyle } from "../appearanceFonts";
import type { AppearanceSettings } from "./settings";

export type RootState = Readonly<{
  dark: boolean;
  attributes: Readonly<Record<string, string>>;
  style: Readonly<Record<string, string>>;
}>;

export type RootInputs = Readonly<{
  appearance: AppearanceSettings;
  systemDark: boolean;
}>;

export function resolveRootState({
  appearance,
  systemDark,
}: RootInputs): RootState {
  const mode = appearance.themeAppearanceMode;
  const contrast = appearance.appearanceContrast;
  const boost = Math.max(contrast - 100, 0);
  return {
    dark: mode === "dark" || (mode === "system" && systemDark),
    attributes: {
      "data-chat-width": appearance.chatWidth,
      "data-diff-color-scheme": appearance.diffColorScheme,
    },
    style: {
      "--appearance-contrast-base": `${Math.min(contrast, 100)}%`,
      "--appearance-contrast-boost": `${boost}%`,
      "--appearance-contrast-border-boost": `${boost / 4}%`,
      "--glass-opacity": `${appearance.glassOpacity}%`,
      ...(appearance.glassOpacity === 100 ? { "--glass-blur": "0px" } : {}),
      ...appearanceFontStyle(appearance),
    },
  };
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
