// Keys, ranges and defaults follow pingdotgg/t3code v0.0.45 packages/contracts/src/settings.ts ClientSettingsSchema (MIT).
import { z } from "zod";

export const appearanceRanges = {
  appearanceContrast: { min: 50, max: 200, step: 5 },
  glassOpacity: { min: 40, max: 100, step: 5 },
  panelAnimationDurationMs: { min: 0, max: 400, step: 25 },
  fontSizeInterface: { min: 12, max: 20, step: 1 },
  fontSizePrompt: { min: 12, max: 20, step: 1 },
  fontSizeCode: { min: 10, max: 18, step: 1 },
  fontSizeTerminal: { min: 8, max: 20, step: 1 },
} as const;
export type AppearanceRangeKey = keyof typeof appearanceRanges;

const ranged = (key: AppearanceRangeKey) =>
  z
    .number()
    .int()
    .min(appearanceRanges[key].min)
    .max(appearanceRanges[key].max);

// An empty family means the app default.
const fontFamily = z.string().max(200);

export const themeModeSchema = z.enum(["system", "light", "dark"]);
export type ThemeMode = z.infer<typeof themeModeSchema>;

// T3 themePalette.ts isThemeId. Built-in ids and the mode keywords match too.
const themeId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,47})$/);

export const appearanceSchema = z.object({
  // T3's ThemePreference: "system", "light", "dark" or a theme id.
  theme: themeId,
  themeAppearanceMode: themeModeSchema,
  // T3's appearance mix: the theme that renders light or dark, whatever the base theme.
  themeHalves: z.object({
    light: themeId.optional(),
    dark: themeId.optional(),
  }),
  appearanceContrast: ranged("appearanceContrast"),
  glassOpacity: ranged("glassOpacity"),
  diffColorScheme: z.enum(["red-green", "blue-orange"]),
  chatWidth: z.enum(["comfortable", "wide", "full"]),
  panelAnimationDurationMs: ranged("panelAnimationDurationMs"),
  fontFamilySans: fontFamily,
  fontFamilyComposer: fontFamily,
  fontFamilyCode: fontFamily,
  fontFamilyTerminal: fontFamily,
  fontSizeInterface: ranged("fontSizeInterface"),
  fontSizePrompt: ranged("fontSizePrompt"),
  fontSizeCode: ranged("fontSizeCode"),
  fontSizeTerminal: ranged("fontSizeTerminal"),
  fontSmoothing: z.boolean(),
  wordWrap: z.boolean(),
  // Lives here, not in UI state as in T3, because the terminal font follows it too.
  typographyAdvanced: z.boolean(),
});
export type AppearanceSettings = Readonly<z.infer<typeof appearanceSchema>>;
export type ChatWidth = AppearanceSettings["chatWidth"];
export type DiffColorScheme = AppearanceSettings["diffColorScheme"];

export const defaultAppearance = {
  theme: "system",
  themeAppearanceMode: "system",
  themeHalves: {},
  appearanceContrast: 100,
  glassOpacity: 80,
  diffColorScheme: "red-green",
  chatWidth: "comfortable",
  panelAnimationDurationMs: 0,
  fontFamilySans: "",
  fontFamilyComposer: "",
  fontFamilyCode: "",
  fontFamilyTerminal: "",
  fontSizeInterface: 16,
  fontSizePrompt: 14,
  fontSizeCode: 13,
  fontSizeTerminal: 12,
  fontSmoothing: true,
  wordWrap: true,
  typographyAdvanced: false,
} as const satisfies AppearanceSettings;

// Values written before appearance became one object: top-level settings.json
// keys, and the ui_state "z1.wordWrap" flag.
export type LegacyAppearance = Readonly<{
  promptFontSize?: unknown;
  codeFontSize?: unknown;
  wordWrap?: string | null;
}>;

export const LEGACY_WORD_WRAP_KEY = "z1.wordWrap";

const legacyCodeFontSize = z.number().int().min(11).max(20);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrate(
  mode: unknown,
  legacy: LegacyAppearance,
): Record<string, unknown> {
  const codeFontSize = legacyCodeFontSize.safeParse(legacy.codeFontSize);
  const { min, max } = appearanceRanges.fontSizeCode;
  return {
    theme: mode,
    themeAppearanceMode: mode,
    fontSizePrompt: legacy.promptFontSize,
    fontSizeCode: codeFontSize.success
      ? Math.min(max, Math.max(min, codeFontSize.data))
      : undefined,
  };
}

// A stored object is already migrated, so the legacy keys are ignored and a second read changes nothing.
// wordWrap arrived later than the object, so the ui_state flag seeds it while the object lacks it.
// Each field falls back to its own default.
export function readAppearance(
  stored: unknown,
  legacy: LegacyAppearance,
): AppearanceSettings {
  const migrated = isRecord(stored) ? stored : migrate(stored, legacy);
  const source =
    migrated.wordWrap === undefined &&
    (legacy.wordWrap === "true" || legacy.wordWrap === "false")
      ? { ...migrated, wordWrap: legacy.wordWrap === "true" }
      : migrated;
  return Object.fromEntries(
    appearanceSchema.keyof().options.map((key) => {
      const parsed = appearanceSchema.shape[key].safeParse(source[key]);
      return [key, parsed.success ? parsed.data : defaultAppearance[key]];
    }),
  ) as AppearanceSettings;
}
