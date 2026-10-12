import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import { EditorToasts } from "../lib/editorActions";
import { storage } from "../lib/storage";
import { FakeNode, findAll, fireEvent, withFakeDom } from "../test/fakeDom";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  GROVE_THEME,
  invalidateCustomThemes,
  parseThemeFile,
  setThemeLibraryStore,
  THEME_FILE_VERSION,
  type ThemeDefinition,
} from "../themePalette";
import type { AppearanceSettings } from "../appearance/settings";
import { PreferencesProvider } from "./preferences";
import { ThemeLibrary } from "./ThemeSettings";
import { useThemeEditorStore } from "./themeEditorStore";

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
      assert.ok(texts.includes("Add theme"));
      assert.ok(labels.includes("Edit Dusk"));
      assert.ok(!labels.includes("Edit Grove"));

      await fireEvent(subtree, labelled("Use Dusk theme"), "click");
      assert.deepEqual(saved().themeHalves, { dark: "dusk" });
      assert.equal(saved().theme, "system");

      const opened = async (target: FakeNode) => {
        await fireEvent(subtree, target, "click");
        const { id: _, ...session } =
          useThemeEditorStore.getState().session ?? {};
        useThemeEditorStore.getState().closeThemeEditor();
        return session;
      };
      await fireEvent(subtree, labelled("Use dark mode"), "click");
      const create = buttons().find(
        (button) => button.textContent === "Create theme",
      );
      assert.ok(create);
      assert.deepEqual(await opened(create), {
        editingThemeId: null,
        seedThemeId: "dusk",
        seedName: null,
        initialAppearance: "dark",
      });
      assert.deepEqual(await opened(labelled("Duplicate Grove")), {
        editingThemeId: null,
        seedThemeId: GROVE_THEME.id,
        seedName: "Grove copy",
        initialAppearance: "dark",
      });
      assert.deepEqual(await opened(labelled("Edit Dusk")), {
        editingThemeId: "dusk",
        seedThemeId: null,
        seedName: null,
        initialAppearance: "dark",
      });

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

type PickedThemeFile = { name: string; size: number; text: string };

type ImportHarness = {
  openDialog: () => Promise<void>;
  paste: (json: string) => Promise<void>;
  click: (text: string) => Promise<void>;
  text: () => string;
  preferences: () => string | undefined;
  selection: () => Pick<AppearanceSettings, "theme" | "themeHalves">;
  library: () => ThemeDefinition[];
};

async function withImportDialog(
  installed: ReadonlyArray<ThemeDefinition>,
  run: (harness: ImportHarness) => Promise<void>,
  picked: ReadonlyArray<PickedThemeFile> = [],
) {
  const values = new Map<string, string>([
    ["z1:preferences:v1", JSON.stringify({})],
    [CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(installed)],
  ]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  setThemeLibraryStore({
    getItem: (key) => values.get(key) ?? null,
    setItemDurable: async (key, value) => {
      values.set(key, value);
    },
  });
  invalidateCustomThemes();
  try {
    await withFakeDom(async ({ document, subtree, root }) => {
      const popover = FakeNode.prototype as unknown as Record<string, unknown>;
      popover.showPopover = () => {};
      popover.hidePopover = () => {};
      Object.assign(window, {
        addEventListener() {},
        removeEventListener() {},
        setTimeout,
        clearTimeout,
        __TAURI_INTERNALS__: {
          invoke: async (command: string) => {
            assert.equal(command, "pick_theme_files");
            return picked;
          },
        },
      });
      await act(async () =>
        root.render(
          createElement(PreferencesProvider, {
            children: [
              createElement(ThemeLibrary, { key: "library" }),
              createElement(EditorToasts, { key: "toasts" }),
            ],
          }),
        ),
      );
      const settle = async () => {
        for (let round = 0; round < 5; round += 1)
          await act(
            () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
          );
      };
      const press = async (node: FakeNode) => {
        await fireEvent(
          subtree.contains(node) ? subtree : document.body,
          node,
          "click",
        );
        await settle();
      };
      const dialogButton = (text: string) => {
        const match = findAll(document.body, "BUTTON").find(
          (button) => !subtree.contains(button) && button.textContent === text,
        );
        assert.ok(match, `dialog button ${text}`);
        return match;
      };
      const saved = () =>
        (
          JSON.parse(values.get("z1:preferences:v1") ?? "{}") as {
            appearance?: AppearanceSettings;
          }
        ).appearance;
      await run({
        openDialog: async () => {
          const add = findAll(subtree, "BUTTON").find(
            (button) => button.textContent === "Add theme",
          );
          assert.ok(add, "library Add theme button");
          await press(add);
          assert.match(document.body.textContent, /Add a theme/);
        },
        paste: async (json) => {
          const editor = findAll(document.body, "TEXTAREA").find(
            (node) => node.attributes.get("aria-label") === "Theme JSON",
          );
          assert.ok(editor, "Theme JSON editor");
          Object.assign(editor, { value: json });
          const key = Object.keys(editor).find((name) =>
            name.startsWith("__reactProps$"),
          );
          const props = Reflect.get(editor, key ?? "") as {
            onChange: (event: { currentTarget: FakeNode }) => void;
          };
          await act(async () => props.onChange({ currentTarget: editor }));
        },
        click: async (text) => press(dialogButton(text)),
        text: () => document.body.textContent,
        preferences: () => values.get("z1:preferences:v1"),
        selection: () => ({
          theme: saved()?.theme ?? "system",
          themeHalves: saved()?.themeHalves ?? {},
        }),
        library: () =>
          JSON.parse(
            values.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]",
          ) as ThemeDefinition[],
      });
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
    invalidateCustomThemes();
  }
}

const vsCodeTheme = (name: string, type: "light" | "dark", canvas: string) =>
  JSON.stringify({
    name,
    type,
    colors: { "editor.background": canvas, focusBorder: "#89b4fa" },
  });

it("activates a pasted one-appearance theme as its half and a dual-mode theme as the base", async () => {
  await withImportDialog([], async (dialog) => {
    await dialog.openDialog();
    await dialog.paste(vsCodeTheme("Nova Dark", "dark", "#1e1e2e"));
    await dialog.click("Add theme");
    assert.deepEqual(
      dialog.library().map((theme) => theme.id),
      ["nova-dark"],
    );
    assert.deepEqual(dialog.selection(), {
      theme: "system",
      themeHalves: { dark: "nova-dark" },
    });
    assert.match(dialog.text(), /Nova Dark added/);
    assert.match(dialog.text(), /It’s now your dark theme\./);
    assert.ok(!dialog.text().includes("Add a theme"), "dialog closed");

    await dialog.openDialog();
    await dialog.paste(
      JSON.stringify({
        version: THEME_FILE_VERSION,
        name: "Aurora Pair",
        appearance: "light",
        colors: { canvas: "#f4f1ea" },
        variants: { dark: { canvas: "#101827" } },
      }),
    );
    await dialog.click("Add theme");
    assert.deepEqual(dialog.selection(), {
      theme: "aurora-pair",
      themeHalves: {},
    });
    assert.match(dialog.text(), /It’s now active\./);
  });
});

it("refuses pasted text over the theme file limit without installing it", async () => {
  await withImportDialog([], async (dialog) => {
    await dialog.openDialog();
    await dialog.paste("x".repeat(256 * 1024 + 1));
    await dialog.click("Add theme");
    assert.match(dialog.text(), /That file is 256 KB\./);
    assert.deepEqual(dialog.library(), []);
  });
});

it("updates an installed theme or keeps both from the Already installed step", async () => {
  const pasteDusk = (canvas: string) =>
    JSON.stringify({
      version: THEME_FILE_VERSION,
      id: "dusk",
      name: "Dusk",
      appearance: "dark",
      colors: { canvas },
    });
  await withImportDialog([dusk], async (dialog) => {
    const before = dialog.preferences();
    await dialog.openDialog();
    await dialog.paste(pasteDusk("#203040"));
    await dialog.click("Add theme");
    assert.match(dialog.text(), /Already installed/);
    await dialog.click("Update existing");
    const [updated, ...rest] = dialog.library();
    assert.equal(rest.length, 0);
    assert.equal(updated?.id, "dusk");
    assert.notEqual(updated?.colors.canvas, dusk.colors.canvas);
    assert.match(dialog.text(), /Dusk updated/);

    await dialog.openDialog();
    await dialog.paste(pasteDusk("#405060"));
    await dialog.click("Add theme");
    await dialog.click("Keep both");
    assert.deepEqual(
      dialog.library().map((theme) => [theme.id, theme.label]),
      [
        ["dusk", "Dusk"],
        ["dusk-1", "Dusk (1)"],
      ],
    );
    assert.equal(dialog.library()[0]?.colors.canvas, updated?.colors.canvas);
    assert.equal(dialog.preferences(), before);
  });
});

it("installs a batch of picked files as a paired theme without activating it", async () => {
  const files = [
    vsCodeTheme("Nova Light", "light", "#f5f5f5"),
    vsCodeTheme("Nova Dark", "dark", "#1e1e2e"),
  ].map((text, index) => ({
    name: index === 0 ? "nova-light.json" : "nova-dark.json",
    size: text.length,
    text,
  }));
  await withImportDialog(
    [],
    async (dialog) => {
      const before = dialog.preferences();
      await dialog.openDialog();
      await dialog.click("Choose files");
      assert.deepEqual(
        dialog.library().map((theme) => [theme.id, theme.label]),
        [["nova", "Nova"]],
      );
      assert.deepEqual(Object.keys(dialog.library()[0]?.variants ?? {}), [
        "dark",
      ]);
      assert.equal(dialog.preferences(), before);
      assert.match(dialog.text(), /Nova added/);
      assert.ok(!dialog.text().includes("Add a theme"), "dialog closed");
    },
    files,
  );
});
