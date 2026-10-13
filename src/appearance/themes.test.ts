import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { persistentStorage, storage } from "../lib/storage";
import { PreferencesProvider, usePreferences } from "../settings/preferences";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  installCustomTheme,
  parseThemeFile,
  removeCustomThemes,
  setThemeLibraryStore,
  subscribeToCustomThemes,
  THEME_FILE_VERSION,
  ThemeLibraryStorageError,
} from "../themePalette";
import { useThemeSelection } from "./AppearanceRoot";
import type { AppearanceSettings } from "./settings";

const theme = (id: string, appearance: "light" | "dark" = "dark") =>
  parseThemeFile({
    version: THEME_FILE_VERSION,
    id,
    name: id,
    appearance,
    colors: { canvas: appearance === "dark" ? "#101827" : "#f8fbff" },
  });

it("keeps the library and ui_state unchanged when the durable write fails, then saves the next change", async () => {
  let failing = true;
  const writes: string[] = [];
  const store = persistentStorage(async (key, value) => {
    if (failing) throw new Error("disk full");
    writes.push(`${key}=${value}`);
  });
  const seeded = JSON.stringify([theme("dusk")]);
  store.load({ [CUSTOM_THEMES_STORAGE_KEY]: seeded });
  setThemeLibraryStore(store);
  let notified = 0;
  const unsubscribe = subscribeToCustomThemes(() => notified++);
  try {
    const failure = await installCustomTheme(theme("dawn", "light")).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof ThemeLibraryStorageError);
    assert.equal(failure.operation, "write");
    assert.match(String(failure.cause), /disk full/);
    assert.deepEqual(
      getCustomThemes().map((installed) => installed.id),
      ["dusk"],
    );
    assert.equal(store.getItem(CUSTOM_THEMES_STORAGE_KEY), seeded);
    assert.equal(notified, 0);

    failing = false;
    await installCustomTheme(theme("dawn", "light"));
    assert.deepEqual(
      getCustomThemes().map((installed) => installed.id),
      ["dusk", "dawn"],
    );
    assert.equal(notified, 1);
    assert.equal(writes.length, 1);
  } finally {
    unsubscribe();
    setThemeLibraryStore(storage);
  }
});

it("serializes overlapping library changes so neither overwrites the other", async () => {
  let release: (() => void) | undefined;
  const firstWrite = new Promise<void>((resolve) => (release = resolve));
  let writes = 0;
  const store = persistentStorage(async () => {
    if (writes++ === 0) await firstWrite;
  });
  store.load({ [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([theme("dusk")]) });
  setThemeLibraryStore(store);
  try {
    const install = installCustomTheme(theme("dawn", "light"));
    const remove = removeCustomThemes(["dusk"]);
    release?.();
    await Promise.all([install, remove]);
    assert.deepEqual(
      getCustomThemes().map((installed) => installed.id),
      ["dawn"],
    );
    assert.deepEqual(
      (
        JSON.parse(store.getItem(CUSTOM_THEMES_STORAGE_KEY) ?? "[]") as {
          id: string;
        }[]
      ).map((stored) => stored.id),
      ["dawn"],
    );
  } finally {
    setThemeLibraryStore(storage);
  }
});

function withLocalStorage(
  entries: Record<string, unknown>,
  run: (values: Map<string, string>) => void,
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map(
    Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]),
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    run(values);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

function render<T>(read: () => T): T {
  let value: T | undefined;
  function Inspect() {
    value = read();
    return null;
  }
  renderToStaticMarkup(
    createElement(PreferencesProvider, { children: createElement(Inspect) }),
  );
  assert.ok(value);
  return value;
}

const savedAppearance = (values: Map<string, string>) =>
  (
    JSON.parse(values.get("l1code:preferences:v1") ?? "{}") as {
      appearance: AppearanceSettings;
    }
  ).appearance;

it("chooses a whole theme without changing the mode and lets two changes in one handler both land", () => {
  withLocalStorage(
    {
      "l1code:preferences:v1": {
        appearance: {
          theme: "light",
          themeAppearanceMode: "dark",
          themeHalves: { light: "ocean", dark: "grove" },
        },
      },
    },
    (values) => {
      const selection = render(useThemeSelection);
      selection.setTheme("iris");
      assert.deepEqual(savedAppearance(values).themeHalves, {});
      assert.equal(savedAppearance(values).theme, "iris");
      assert.equal(savedAppearance(values).themeAppearanceMode, "dark");

      selection.setTheme("dark");
      selection.setThemeHalf("light", "ember");
      assert.equal(savedAppearance(values).theme, "dark");
      assert.deepEqual(savedAppearance(values).themeHalves, {
        light: "ember",
      });

      selection.setThemeHalf("dark", "grove");
      selection.setThemeHalf("light", null);
      assert.deepEqual(savedAppearance(values).themeHalves, { dark: "grove" });
    },
  );
});

it("restores the theme selection with the rest of appearance and keeps the theme library", () => {
  const library = [theme("dusk")];
  withLocalStorage(
    {
      "l1code:preferences:v1": {
        appearance: {
          theme: "dusk",
          themeAppearanceMode: "dark",
          themeHalves: { light: "ocean" },
          appearanceContrast: 150,
        },
      },
      [CUSTOM_THEMES_STORAGE_KEY]: library,
    },
    (values) => {
      setThemeLibraryStore(storage);
      render(usePreferences).reset();
      const appearance = savedAppearance(values);
      assert.equal(appearance.theme, "system");
      assert.equal(appearance.themeAppearanceMode, "system");
      assert.deepEqual(appearance.themeHalves, {});
      assert.equal(appearance.appearanceContrast, 100);
      assert.equal(
        values.get(CUSTOM_THEMES_STORAGE_KEY),
        JSON.stringify(library),
      );
      assert.deepEqual(
        getCustomThemes().map((installed) => installed.id),
        ["dusk"],
      );
    },
  );
});
