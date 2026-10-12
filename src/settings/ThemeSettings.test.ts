import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import { storage } from "../lib/storage";
import {
  findAll,
  fireEvent,
  withFakeDom,
  type FakeNode,
} from "../test/fakeDom";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  parseThemeFile,
  setThemeLibraryStore,
  THEME_FILE_VERSION,
} from "../themePalette";
import type { AppearanceSettings } from "../appearance/settings";
import { PreferencesProvider } from "./preferences";
import { ThemeLibrary } from "./ThemeSettings";

const dusk = parseThemeFile({
  version: THEME_FILE_VERSION,
  id: "dusk",
  name: "Dusk",
  appearance: "dark",
  colors: { canvas: "#101827" },
});

it("assigns a one-appearance theme to its half, switches the scheme, and removes the theme from the library and the mix", async () => {
  const values = new Map<string, string>([
    ["z1:preferences:v1", JSON.stringify({})],
    [CUSTOM_THEMES_STORAGE_KEY, JSON.stringify([dusk])],
  ]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  setThemeLibraryStore(storage);
  const saved = () =>
    (
      JSON.parse(values.get("z1:preferences:v1") ?? "{}") as {
        appearance: AppearanceSettings;
      }
    ).appearance;
  try {
    await withFakeDom(async ({ document, subtree, root }) => {
      await act(async () =>
        root.render(
          createElement(PreferencesProvider, {
            children: createElement(ThemeLibrary),
          }),
        ),
      );
      const buttons = () => findAll(document.body, "BUTTON");
      const labelled = (label: string): FakeNode => {
        const match = buttons().find(
          (button) => button.attributes.get("aria-label") === label,
        );
        assert.ok(match, `button ${label}`);
        return match;
      };
      const texts = buttons().map((button) => button.textContent);
      const labels = buttons().map(
        (button) => button.attributes.get("aria-label") ?? "",
      );
      for (const name of [
        "Bot Code",
        "T3 Chat",
        "Grove",
        "Ocean",
        "Ember",
        "Iris",
        "Dusk",
      ])
        assert.ok(texts.includes(name), name);
      assert.ok(labels.includes("Export Dusk"));
      assert.ok(!texts.some((text) => /Create theme|Add theme/.test(text)));
      assert.ok(!labels.some((label) => /^(Duplicate|Edit) /.test(label)));

      await fireEvent(subtree, labelled("Use Dusk theme"), "click");
      assert.deepEqual(saved().themeHalves, { dark: "dusk" });
      assert.equal(saved().theme, "system");

      await fireEvent(subtree, labelled("Use light mode"), "click");
      assert.equal(saved().themeAppearanceMode, "light");
      assert.equal(
        String(labelled("Use light mode").attributes.get("aria-pressed")),
        "true",
      );

      await fireEvent(subtree, labelled("Remove Dusk"), "click");
      assert.match(document.body.textContent, /Remove “Dusk”\?/);
      const confirm = buttons().find(
        (button) => button.textContent === "Remove theme",
      );
      assert.ok(confirm);
      await fireEvent(document.body, confirm, "click");
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      assert.deepEqual(JSON.parse(values.get(CUSTOM_THEMES_STORAGE_KEY)!), []);
      assert.deepEqual(getCustomThemes(), []);
      assert.deepEqual(saved().themeHalves, {});
      assert.ok(!document.body.textContent.includes("Remove “Dusk”?"));
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
