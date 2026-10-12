// Keys, ranges and defaults follow pingdotgg/t3code v0.0.45 packages/contracts/src/settings.ts ClientSettingsSchema (MIT).
import { z } from "zod";

export const appearanceRanges = {
  appearanceContrast: { min: 50, max: 200, step: 5 },
  glassOpacity: { min: 40, max: 100, step: 5 },
  panelAnimationDurationMs: { min: 0, max: 400, step: 25 },
  fontSizePrompt: { min: 12, max: 20, step: 1 },
  fontSizeCode: { min: 10, max: 18, step: 1 },
} as const;
export type AppearanceRangeKey = keyof typeof appearanceRanges;

const ranged = (key: AppearanceRangeKey) =>
  z
    .number()
    .int()
    .min(appearanceRanges[key].min)
    .max(appearanceRanges[key].max);

export const themeModeSchema = z.enum(["system", "light", "dark"]);
export type ThemeMode = z.infer<typeof themeModeSchema>;

export const appearanceSchema = z.object({
  // T3's ThemePreference: "system", "light", "dark" or a theme id.
  theme: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,47})$/),
  themeAppearanceMode: themeModeSchema,
  appearanceContrast: ranged("appearanceContrast"),
  glassOpacity: ranged("glassOpacity"),
  diffColorScheme: z.enum(["red-green", "blue-orange"]),
  chatWidth: z.enum(["comfortable", "wide", "full"]),
  panelAnimationDurationMs: ranged("panelAnimationDurationMs"),
  fontSizePrompt: ranged("fontSizePrompt"),
  fontSizeCode: ranged("fontSizeCode"),
});
export type AppearanceSettings = Readonly<z.infer<typeof appearanceSchema>>;
export type ChatWidth = AppearanceSettings["chatWidth"];
export type DiffColorScheme = AppearanceSettings["diffColorScheme"];

export const defaultAppearance = {
  theme: "system",
  themeAppearanceMode: "system",
  appearanceContrast: 100,
  glassOpacity: 80,
  diffColorScheme: "red-green",
  chatWidth: "comfortable",
  panelAnimationDurationMs: 0,
  fontSizePrompt: 14,
  fontSizeCode: 13,
} as const satisfies AppearanceSettings;

// Top-level settings.json values written before appearance became one object.
export type LegacyAppearance = Readonly<{
  promptFontSize?: unknown;
  codeFontSize?: unknown;
}>;

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
// Each field falls back to its own default.
export function readAppearance(
  stored: unknown,
  legacy: LegacyAppearance,
): AppearanceSettings {
  const source = isRecord(stored) ? stored : migrate(stored, legacy);
  return Object.fromEntries(
    appearanceSchema.keyof().options.map((key) => {
      const parsed = appearanceSchema.shape[key].safeParse(source[key]);
      return [key, parsed.success ? parsed.data : defaultAppearance[key]];
    }),
  ) as AppearanceSettings;
}
