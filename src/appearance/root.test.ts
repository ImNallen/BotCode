import assert from "node:assert/strict";
import { it } from "node:test";
import {
  applyRootState,
  needsNoTransitionsFrame,
  resolveRootState,
  type RootState,
  type RootTarget,
} from "./root";
import { defaultAppearance, type AppearanceSettings } from "./settings";
import {
  APP_THEME_VARIABLES,
  GROVE_THEME,
  OCEAN_THEME,
  parseThemeFile,
  THEME_FILE_VERSION,
  type ThemeDefinition,
} from "../themePalette";

function resolve(
  patch: Partial<AppearanceSettings>,
  systemDark = false,
  customThemes: ReadonlyArray<ThemeDefinition> = [],
) {
  return resolveRootState({
    appearance: { ...defaultAppearance, ...patch },
    systemDark,
    customThemes,
  });
}

function recordingRoot() {
  const writes: string[] = [];
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const style = new Map<string, string>();
  const root: RootTarget = {
    classList: {
      toggle(token, force) {
        writes.push(`class ${token} ${force}`);
        if (force) classes.add(token);
        else classes.delete(token);
        return force;
      },
    },
    setAttribute(name, value) {
      writes.push(`set ${name}=${value}`);
      attributes.set(name, value);
    },
    removeAttribute(name) {
      writes.push(`remove ${name}`);
      attributes.delete(name);
    },
    style: {
      setProperty(name, value) {
        writes.push(`set ${name}=${value}`);
        style.set(name, value);
      },
      removeProperty(name) {
        writes.push(`remove ${name}`);
        const previous = style.get(name) ?? "";
        style.delete(name);
        return previous;
      },
    },
  };
  return { root, writes, classes, attributes, style };
}

it("writes T3's contrast mix for low, default and high contrast", () => {
  const contrast = (appearanceContrast: number) => {
    const { style } = resolve({ appearanceContrast });
    return [
      style["--appearance-contrast-base"],
      style["--appearance-contrast-boost"],
      style["--appearance-contrast-border-boost"],
    ];
  };
  assert.deepEqual(contrast(50), ["50%", "0%", "0%"]);
  assert.deepEqual(contrast(100), ["100%", "0%", "0%"]);
  assert.deepEqual(contrast(150), ["100%", "50%", "12.5%"]);
  assert.deepEqual(contrast(200), ["100%", "100%", "25%"]);
});

it("zeroes the glass blur only at full glass opacity", () => {
  assert.equal(resolve({ glassOpacity: 80 }).style["--glass-opacity"], "80%");
  assert.equal("--glass-blur" in resolve({ glassOpacity: 95 }).style, false);
  assert.equal(resolve({ glassOpacity: 100 }).style["--glass-blur"], "0px");
});

it("sets the chat width, diff colors and font sizes on the root", () => {
  const state = resolve({
    chatWidth: "wide",
    diffColorScheme: "blue-orange",
    fontSizePrompt: 17,
    fontSizeCode: 11,
  });
  assert.deepEqual(state.attributes, {
    "data-chat-width": "wide",
    "data-diff-color-scheme": "blue-orange",
  });
  assert.equal(state.style["--font-size-prompt"], "17px");
  assert.equal(state.style["--font-size-code"], "11px");
  assert.equal(state.style["--diffs-font-size"], "11px");
});

it("follows the system scheme only in system mode", () => {
  assert.equal(resolve({ themeAppearanceMode: "system" }, true).dark, true);
  assert.equal(resolve({ themeAppearanceMode: "system" }, false).dark, false);
  assert.equal(resolve({ themeAppearanceMode: "light" }, true).dark, false);
  assert.equal(resolve({ themeAppearanceMode: "dark" }, false).dark, true);
});

it("removes stale properties, writes only changes, and writes nothing when reapplied", () => {
  const { root, writes, classes, attributes, style } = recordingRoot();
  const solid = resolve({ glassOpacity: 100, themeAppearanceMode: "dark" });
  applyRootState(root, null, solid);
  assert.deepEqual(Object.fromEntries(style), solid.style);
  assert.deepEqual(Object.fromEntries(attributes), solid.attributes);
  assert.equal(classes.has("dark"), true);

  writes.length = 0;
  const translucent: RootState = resolve({ glassOpacity: 85 });
  applyRootState(root, solid, translucent);
  assert.deepEqual(writes.toSorted(), [
    "class dark false",
    "remove --glass-blur",
    "set --glass-opacity=85%",
  ]);
  assert.deepEqual(Object.fromEntries(style), translucent.style);
  assert.equal(classes.has("dark"), false);

  writes.length = 0;
  applyRootState(root, translucent, translucent);
  assert.deepEqual(writes, []);

  applyRootState(root, translucent, { ...translucent, attributes: {} });
  assert.deepEqual(writes.toSorted(), [
    "remove data-chat-width",
    "remove data-diff-color-scheme",
  ]);
});

it("prepends a custom family to T3's default stack and removes the variable when cleared", () => {
  const { root, style } = recordingRoot();
  const custom = resolve({
    fontFamilySans: "Inter Display",
    fontFamilyCode: "JetBrains Mono",
    fontFamilyComposer: "Iosevka",
  });
  applyRootState(root, null, custom);
  assert.equal(
    style.get("--font-sans"),
    '"Inter Display", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  );
  assert.equal(
    style.get("--font-mono"),
    '"JetBrains Mono", "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
  );
  assert.equal(style.get("--font-composer"), "Iosevka, var(--font-sans)");

  applyRootState(root, custom, resolve({ fontFamilyCode: "  " }));
  assert.equal(style.has("--font-sans"), false);
  assert.equal(style.has("--font-mono"), false);
  assert.equal(style.has("--font-composer"), false);
});

it("sizes the root from the interface size and toggles font smoothing", () => {
  const { root, style } = recordingRoot();
  const large = resolve({ fontSizeInterface: 20, fontSmoothing: true });
  applyRootState(root, null, large);
  assert.equal(style.get("font-size"), "20px");
  assert.equal(style.get("-webkit-font-smoothing"), "antialiased");

  applyRootState(root, large, resolve({ fontSmoothing: false }));
  assert.equal(style.get("font-size"), "16px");
  assert.equal(style.has("-webkit-font-smoothing"), false);
});

const dusk = parseThemeFile({
  version: THEME_FILE_VERSION,
  id: "dusk",
  name: "Dusk",
  appearance: "dark",
  colors: { canvas: "#101827", accent: "#67c2ff" },
});

function painted(
  patch: Partial<AppearanceSettings>,
  systemDark: boolean,
): [scheme: "light" | "dark", themeId: string | null] {
  const state = resolve(patch, systemDark, [dusk]);
  return [
    state.dark ? "dark" : "light",
    state.attributes["data-theme-id"] ?? null,
  ];
}

function themeVariables(entries: Iterable<[string, string]>) {
  return Object.fromEntries(
    [...entries].filter(([name]) => name.startsWith("--app-theme-")),
  );
}

it("resolves the scheme and theme the way T3's useTheme does", () => {
  const cases: [
    Partial<AppearanceSettings>,
    boolean,
    ReturnType<typeof painted>,
  ][] = [
    [
      { theme: "system", themeAppearanceMode: "system" },
      false,
      ["light", null],
    ],
    [{ theme: "system", themeAppearanceMode: "system" }, true, ["dark", null]],
    [{ theme: "light", themeAppearanceMode: "dark" }, false, ["dark", null]],
    [{ theme: "dark", themeAppearanceMode: "light" }, true, ["light", null]],
    [
      { theme: "ocean", themeAppearanceMode: "system" },
      true,
      ["dark", "ocean"],
    ],
    [
      { theme: "ocean", themeAppearanceMode: "light" },
      true,
      ["light", "ocean"],
    ],
    [{ theme: "dusk", themeAppearanceMode: "light" }, false, ["dark", "dusk"]],
    [{ theme: "dusk", themeAppearanceMode: "system" }, false, ["dark", "dusk"]],
    [
      {
        theme: "dusk",
        themeAppearanceMode: "light",
        themeHalves: { light: "grove" },
      },
      false,
      ["light", "grove"],
    ],
    [
      {
        theme: "system",
        themeAppearanceMode: "system",
        themeHalves: { dark: "dusk" },
      },
      true,
      ["dark", "dusk"],
    ],
    [
      {
        theme: "system",
        themeAppearanceMode: "system",
        themeHalves: { dark: "dusk" },
      },
      false,
      ["light", null],
    ],
    [
      {
        theme: "ocean",
        themeAppearanceMode: "system",
        themeHalves: { dark: "dusk" },
      },
      false,
      ["light", "ocean"],
    ],
    [
      {
        theme: "ocean",
        themeAppearanceMode: "dark",
        themeHalves: { dark: "dusk" },
      },
      false,
      ["dark", "dusk"],
    ],
    [
      {
        theme: "system",
        themeAppearanceMode: "light",
        themeHalves: { light: "dusk" },
      },
      false,
      ["light", null],
    ],
    [
      {
        theme: "removed",
        themeAppearanceMode: "system",
        themeHalves: { dark: "gone" },
      },
      true,
      ["dark", null],
    ],
  ];
  for (const [patch, systemDark, expected] of cases)
    assert.deepEqual(
      painted(patch, systemDark),
      expected,
      `${JSON.stringify(patch)} systemDark=${systemDark}`,
    );
});

it("writes every theme variable for the resolved palette and removes them all for the stock look", () => {
  const { root, attributes, style, classes } = recordingRoot();
  const oceanDark = resolve({ theme: "ocean", themeAppearanceMode: "dark" });
  applyRootState(root, null, oceanDark);
  assert.equal(attributes.get("data-theme-id"), "ocean");
  assert.equal(classes.has("dark"), true);
  const oceanColors = OCEAN_THEME.variants?.dark;
  assert.ok(oceanColors);
  for (const [role, name] of Object.entries(APP_THEME_VARIABLES))
    assert.equal(
      style.get(name),
      oceanColors[role as keyof typeof oceanColors],
      name,
    );

  const groveLight = resolve({ theme: "grove", themeAppearanceMode: "light" });
  applyRootState(root, oceanDark, groveLight);
  assert.equal(attributes.get("data-theme-id"), "grove");
  assert.equal(classes.has("dark"), false);
  assert.deepEqual(
    themeVariables(style),
    themeVariables(Object.entries(groveLight.style)),
  );
  assert.equal(style.get("--app-theme-canvas"), GROVE_THEME.colors.canvas);

  const stock = resolve({ theme: "system", themeAppearanceMode: "light" });
  applyRootState(root, groveLight, stock);
  assert.equal(attributes.has("data-theme-id"), false);
  assert.deepEqual(themeVariables(style), {});
  assert.equal(style.get("--glass-opacity"), "80%");
  assert.equal(attributes.get("data-chat-width"), "comfortable");
});

it("paints an editor preview over the selection and skips colors that do not parse", () => {
  const groveDark = GROVE_THEME.variants?.dark;
  assert.ok(groveDark);
  const preview = resolveRootState({
    appearance: {
      ...defaultAppearance,
      theme: "ocean",
      themeAppearanceMode: "light",
    },
    systemDark: false,
    customThemes: [],
    preview: { appearance: "dark", colors: { ...groveDark, accent: "#12" } },
  });
  assert.equal(preview.dark, true);
  assert.equal(preview.attributes["data-theme-id"], "__preview");
  assert.equal(preview.style["--app-theme-canvas"], groveDark.canvas);
  assert.equal("--app-theme-accent" in preview.style, false);
});

it("suppresses transitions when the palette changes but not while an editor draft moves", () => {
  const light = resolve({ theme: "ocean", themeAppearanceMode: "light" });
  const original = resolve({ theme: "dusk" }, false, [dusk]);
  const edited = resolve({ theme: "dusk" }, false, [
    { ...dusk, colors: { ...dusk.colors, canvas: "oklch(0.2 0 0)" } },
  ]);
  const draft = (canvas: string): RootState => ({
    ...light,
    attributes: { ...light.attributes, "data-theme-id": "__preview" },
    style: { ...light.style, "--app-theme-canvas": canvas },
  });
  assert.equal(needsNoTransitionsFrame(null, light), false);
  assert.equal(needsNoTransitionsFrame(light, light), false);
  assert.equal(
    needsNoTransitionsFrame(
      light,
      resolve({ theme: "ocean", themeAppearanceMode: "dark" }),
    ),
    true,
  );
  assert.equal(
    needsNoTransitionsFrame(
      light,
      resolve({ theme: "grove", themeAppearanceMode: "light" }),
    ),
    true,
  );
  assert.equal(needsNoTransitionsFrame(original, edited), true);
  assert.equal(
    needsNoTransitionsFrame(
      light,
      resolve({
        theme: "ocean",
        themeAppearanceMode: "light",
        glassOpacity: 90,
      }),
    ),
    false,
  );
  assert.equal(
    needsNoTransitionsFrame(draft("oklch(0.3 0 0)"), draft("oklch(0.4 0 0)")),
    false,
  );
});
