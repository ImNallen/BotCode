import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PreferencesProvider,
  readPreferences,
  usePreferences,
} from "../settings/preferences";
import {
  appearanceSchema,
  defaultAppearance,
  readAppearance,
  type AppearanceSettings,
} from "./settings";

function withStoredSettings(
  initial: unknown,
  run: (file: { read: () => Record<string, unknown> }) => void,
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let text = JSON.stringify(initial);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => text,
      setItem: (_key: string, next: string) => {
        text = next;
      },
    },
  });
  try {
    run({ read: () => JSON.parse(text) as Record<string, unknown> });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

function saveUnrelatedChange() {
  let api: ReturnType<typeof usePreferences> | undefined;
  function Inspect() {
    api = usePreferences();
    return null;
  }
  renderToStaticMarkup(
    createElement(PreferencesProvider, { children: createElement(Inspect) }),
  );
  assert.ok(api);
  api.update({ followUpBehavior: "steer" });
}

it("migrates the legacy appearance string and font sizes once, and drops the legacy keys on the next save", () => {
  withStoredSettings(
    { appearance: "dark", promptFontSize: 18, codeFontSize: 20 },
    (file) => {
      const migrated: AppearanceSettings = {
        ...defaultAppearance,
        theme: "dark",
        themeAppearanceMode: "dark",
        fontSizePrompt: 18,
        fontSizeCode: 18,
      };
      assert.deepEqual(readPreferences().preferences.appearance, migrated);
      saveUnrelatedChange();
      const saved = file.read();
      assert.deepEqual(saved.appearance, migrated);
      assert.equal("promptFontSize" in saved, false);
      assert.equal("codeFontSize" in saved, false);
      assert.deepEqual(readPreferences().preferences.appearance, migrated);
    },
  );
});

it("ignores legacy keys once appearance is an object", () => {
  const stored = { ...defaultAppearance, fontSizeCode: 16 };
  assert.deepEqual(
    readAppearance(stored, { promptFontSize: 12, codeFontSize: 11 }),
    stored,
  );
});

it("maps each legacy mode and clamps the legacy code size into 10-18", () => {
  assert.deepEqual(readAppearance("light", { codeFontSize: 11 }), {
    ...defaultAppearance,
    theme: "light",
    themeAppearanceMode: "light",
    fontSizeCode: 11,
  });
  assert.deepEqual(
    readAppearance("system", { promptFontSize: 30, codeFontSize: 19 }),
    { ...defaultAppearance, fontSizeCode: 18 },
  );
  assert.deepEqual(readAppearance(undefined, {}), defaultAppearance);
});

it("falls back to the default for each invalid field without touching its neighbours", () => {
  assert.deepEqual(
    readAppearance(
      {
        theme: "Not An Id",
        appearanceContrast: 150,
        glassOpacity: 30,
        diffColorScheme: "blue-orange",
        chatWidth: "huge",
        panelAnimationDurationMs: 12.5,
        fontSizeCode: 9,
      },
      {},
    ),
    {
      ...defaultAppearance,
      appearanceContrast: 150,
      diffColorScheme: "blue-orange",
    },
  );
});

it("keeps every appearance key through a save and a fresh read", () => {
  const changed: AppearanceSettings = {
    theme: "light",
    themeAppearanceMode: "dark",
    themeHalves: { light: "ocean", dark: "my-dusk" },
    appearanceContrast: 135,
    glassOpacity: 100,
    diffColorScheme: "blue-orange",
    chatWidth: "full",
    panelAnimationDurationMs: 225,
    fontFamilySans: "Inter",
    fontFamilyComposer: "Iosevka",
    fontFamilyCode: "JetBrains Mono",
    fontFamilyTerminal: "Menlo",
    fontSizeInterface: 18,
    fontSizePrompt: 17,
    fontSizeCode: 10,
    fontSizeTerminal: 9,
    fontSmoothing: false,
    wordWrap: false,
    typographyAdvanced: true,
  };
  for (const key of appearanceSchema.keyof().options)
    assert.notEqual(changed[key], defaultAppearance[key], key);
  withStoredSettings({ appearance: changed }, (file) => {
    assert.deepEqual(readPreferences().preferences.appearance, changed);
    saveUnrelatedChange();
    assert.deepEqual(file.read().appearance, changed);
  });
});

it("seeds wordWrap from the ui_state flag only while settings lack it", () => {
  const stored = { ...defaultAppearance } as Record<string, unknown>;
  delete stored.wordWrap;
  assert.equal(readAppearance(stored, { wordWrap: "false" }).wordWrap, false);
  assert.equal(readAppearance("dark", { wordWrap: "false" }).wordWrap, false);
  assert.equal(readAppearance(stored, { wordWrap: null }).wordWrap, true);
  assert.equal(
    readAppearance({ ...stored, wordWrap: true }, { wordWrap: "false" })
      .wordWrap,
    true,
  );
});

it("reads the legacy word wrap flag from ui_state and saves it into settings", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>([
    ["l1code:preferences:v1", JSON.stringify({ appearance: "system" })],
    ["l1code:wordWrap", "false"],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    assert.equal(readPreferences().preferences.appearance.wordWrap, false);
    saveUnrelatedChange();
    const saved = JSON.parse(values.get("l1code:preferences:v1") ?? "{}") as {
      appearance: AppearanceSettings;
    };
    assert.equal(saved.appearance.wordWrap, false);
    values.set("l1code:wordWrap", "true");
    assert.equal(readPreferences().preferences.appearance.wordWrap, false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
