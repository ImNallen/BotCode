import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import { AppearanceRoot } from "../appearance/AppearanceRoot";
import { EditorToasts } from "../lib/editorActions";
import {
  FakeNode,
  findAll,
  fireEvent,
  withFakeDom,
  type FakeDocument,
} from "../test/fakeDom";
import {
  APP_THEME_VARIABLES,
  createVividThemeColors,
  getCustomThemes,
  getThemeDefinition,
  GROVE_THEME,
  parseThemeFile,
  removeCustomTheme,
  setThemeLibraryStore,
  THEME_FILE_VERSION,
  themeColorToHex,
  updateCustomTheme,
  type ThemeDefinition,
} from "../themePalette";
import { PreferencesProvider } from "./preferences";
import { ThemeEditorHost } from "./ThemeEditorHost";
import {
  useThemeEditorStore,
  type ThemeEditorSessionInput,
} from "./themeEditorStore";

const EDITED_SURFACE = "#00ffff";

const dusk = parseThemeFile({
  version: THEME_FILE_VERSION,
  id: "dusk",
  name: "Dusk",
  appearance: "dark",
  colors: { canvas: "#101827", surface: "#ff00ff" },
});
const aurora = parseThemeFile({
  version: THEME_FILE_VERSION,
  id: "aurora",
  name: "Aurora",
  appearance: "light",
  colors: { canvas: "#f4f1ea", surface: "#00ff00" },
});
const guided = parseThemeFile({
  version: THEME_FILE_VERSION,
  id: "guided",
  name: "Guided",
  appearance: "dark",
  colors: {
    ...createVividThemeColors("dark", "#101827", "#7c3aed"),
    surface: EDITED_SURFACE,
  },
  managed: true,
});

const PREFERENCES_KEY = "l1code:preferences:v1";

type Harness = {
  document: FakeDocument;
  subtree: FakeNode;
  open: (session: Partial<ThemeEditorSessionInput>) => Promise<void>;
  button: (text: string) => FakeNode;
  labelled: (label: string) => FakeNode;
  type: (node: FakeNode, value: string) => Promise<void>;
  click: (node: FakeNode) => Promise<void>;
  settle: () => Promise<void>;
  heading: () => string | undefined;
  hex: (label: string) => string;
  savedAppearance: () => Record<string, unknown>;
  library: () => ReadonlyArray<ThemeDefinition>;
  occurrences: (text: string) => number;
  root: { attributes: Map<string, string>; style: Map<string, string> };
  failSettings: { value: boolean };
  failLibrary: { when: (json: string) => boolean };
};

async function withEditor(
  installed: ReadonlyArray<ThemeDefinition>,
  run: (harness: Harness) => Promise<void>,
  appearance: Record<string, unknown> = {},
) {
  const values = new Map<string, string>([
    [PREFERENCES_KEY, JSON.stringify({ appearance })],
  ]);
  const failSettings = { value: false };
  const failLibrary = { when: (_json: string) => false };
  const previousStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const previousFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === PREFERENCES_KEY && failSettings.value)
          throw new Error("settings.json is read-only");
        values.set(key, value);
      },
    },
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 0,
  });
  values.set("l1code:themes:v1", JSON.stringify(installed));
  setThemeLibraryStore({
    getItem: (key) => values.get(key) ?? null,
    setItemDurable: async (key, value) => {
      if (failLibrary.when(value)) throw new Error("ui_state is read-only");
      values.set(key, value);
    },
  });
  Object.assign(FakeNode.prototype, { showPopover() {}, hidePopover() {} });
  try {
    await withFakeDom(async ({ document, subtree, root }) => {
      Object.assign(window, {
        addEventListener() {},
        removeEventListener() {},
        setTimeout,
        clearTimeout,
        innerWidth: 1100,
        innerHeight: 780,
      });
      Object.assign(document, {
        visibilityState: "hidden",
        hasFocus: () => false,
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener() {},
        removeEventListener() {},
      });
      const html = document.documentElement;
      const rootState = {
        attributes: html.attributes,
        style: new Map<string, string>(),
      };
      Object.assign(html, {
        classList: { toggle() {}, add() {}, remove() {} },
        style: {
          setProperty: (name: string, value: string) =>
            rootState.style.set(name, value),
          removeProperty: (name: string) => {
            rootState.style.delete(name);
            return "";
          },
        },
      });
      await act(async () =>
        root.render(
          createElement(PreferencesProvider, {
            children: [
              createElement(AppearanceRoot, { key: "root" }),
              createElement(ThemeEditorHost, { key: "host" }),
              createElement(EditorToasts, { key: "toasts" }),
            ],
          }),
        ),
      );
      const settle = () =>
        act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      const all = (tag: string) => findAll(document.body, tag);
      const harness: Harness = {
        document,
        subtree,
        open: async (session) => {
          await act(async () =>
            useThemeEditorStore.getState().openThemeEditor({
              editingThemeId: null,
              seedThemeId: null,
              seedName: null,
              initialAppearance: "dark",
              ...session,
            }),
          );
          await act(async () => {
            await import("./ThemeEditorPanel");
          });
          await settle();
        },
        button: (text) => {
          const match = all("BUTTON").find(
            (button) => button.textContent === text,
          );
          assert.ok(
            match,
            `button ${text} in ${all("BUTTON").map((button) => button.textContent)}`,
          );
          return match;
        },
        labelled: (label) => {
          const match = [...all("BUTTON"), ...all("INPUT")].find(
            (node) =>
              node.attributes.get("aria-label") === label ||
              node.attributes.get("placeholder") === label,
          );
          assert.ok(match, `control ${label}`);
          return match;
        },
        // react-dom loads before the fake DOM exists and falls back to IE's
        // change polyfill for text inputs, so typing calls onChange directly.
        type: async (node, value) => {
          Object.assign(node, { value });
          const key = Object.keys(node).find((name) =>
            name.startsWith("__reactProps$"),
          );
          const props = Reflect.get(node, key ?? "") as {
            onChange: (event: { currentTarget: FakeNode }) => void;
          };
          await act(async () => props.onChange({ currentTarget: node }));
        },
        click: async (node) => {
          await fireEvent(subtree, node, "click");
          await settle();
        },
        settle,
        heading: () => all("H2")[0]?.textContent,
        hex: (label) =>
          String(
            (
              harness.labelled(`${label} hex value`) as FakeNode & {
                value: string;
              }
            ).value,
          ),
        savedAppearance: () =>
          (
            JSON.parse(values.get(PREFERENCES_KEY) ?? "{}") as {
              appearance: Record<string, unknown>;
            }
          ).appearance,
        library: () =>
          JSON.parse(
            values.get("l1code:themes:v1") ?? "[]",
          ) as ThemeDefinition[],
        occurrences: (text) => document.body.textContent.split(text).length - 1,
        root: rootState,
        failSettings,
        failLibrary,
      };
      await run(harness);
      await act(async () => useThemeEditorStore.getState().closeThemeEditor());
    });
  } finally {
    for (const [name, descriptor] of [
      ["localStorage", previousStorage],
      ["requestAnimationFrame", previousFrame],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

const libraryIds = (library: ReadonlyArray<ThemeDefinition>) =>
  library.map((theme) => theme.id).sort();

it("paints the draft over the stored theme while open and repaints the stored theme on close", async () => {
  await withEditor(
    [],
    async ({ open, labelled, type, button, click, root }) => {
      const groveCanvas = GROVE_THEME.colors.canvas;
      assert.equal(root.attributes.get("data-theme-id"), GROVE_THEME.id);
      assert.equal(root.style.get(APP_THEME_VARIABLES.canvas), groveCanvas);

      await open({ seedThemeId: GROVE_THEME.id, initialAppearance: "light" });
      assert.equal(root.attributes.get("data-theme-id"), "__preview");
      assert.equal(root.style.get(APP_THEME_VARIABLES.canvas), groveCanvas);

      await type(labelled("Background hex value"), "#203040");
      assert.equal(root.attributes.get("data-theme-id"), "__preview");
      assert.equal(
        themeColorToHex(root.style.get(APP_THEME_VARIABLES.canvas) ?? ""),
        "#203040",
      );

      await click(button("Cancel"));
      assert.equal(useThemeEditorStore.getState().session, null);
      assert.equal(root.attributes.get("data-theme-id"), GROVE_THEME.id);
      assert.equal(root.style.get(APP_THEME_VARIABLES.canvas), groveCanvas);
    },
    { theme: GROVE_THEME.id, themeAppearanceMode: "light" },
  );
});

it("keeps editing the live definition and stops editing a removed theme", async () => {
  await withEditor([dusk], async ({ open, labelled, heading, button }) => {
    await open({ editingThemeId: "dusk" });
    assert.equal(heading(), "Edit theme");
    assert.equal(Reflect.get(labelled("Theme name"), "value"), "Dusk");
    assert.equal(
      button("Light").attributes.get("aria-disabled")?.toString(),
      "true",
    );

    await act(async () => {
      await updateCustomTheme({
        ...dusk,
        variants: { light: { ...aurora.colors } },
      });
    });
    assert.equal(
      button("Light").attributes.get("aria-disabled")?.toString(),
      "false",
    );

    await act(async () => {
      await removeCustomTheme("dusk");
    });
    assert.equal(heading(), "Create theme");
    assert.ok(button("Create theme"));
  });
});

it("labels the submit for create, add palette, save changes and merge", async () => {
  await withEditor([dusk, aurora], async ({ open, labelled, type, button }) => {
    await open({});
    const create = button("Create theme");
    assert.equal(create.attributes.get("disabled"), "");
    await type(labelled("e.g. Aurora"), "Nimbus");
    assert.equal(button("Create theme").attributes.get("disabled"), undefined);

    await type(labelled("e.g. Aurora"), "dusk");
    assert.ok(button("Add light palette"));
    assert.equal(
      button("Light").attributes.get("aria-pressed")?.toString(),
      "true",
    );
    assert.equal(
      button("Dark").attributes.get("aria-disabled")?.toString(),
      "true",
    );

    await open({ editingThemeId: "aurora", initialAppearance: "light" });
    assert.ok(button("Save changes"));
    await type(labelled("Theme name"), "Dusk");
    assert.ok(button("Merge into “Dusk”"));
  });
});

it("creates a theme, makes it active, and closes with T3's toast", async () => {
  await withEditor(
    [],
    async ({
      open,
      labelled,
      type,
      button,
      click,
      savedAppearance,
      occurrences,
    }) => {
      const created = occurrences("Nimbus createdIt’s now active.");
      await open({});
      await type(labelled("e.g. Aurora"), "Nimbus");
      await click(button("Create theme"));
      const nimbus = getThemeDefinition("nimbus");
      assert.equal(nimbus?.managed, true);
      assert.equal(nimbus?.appearance, "dark");
      assert.equal(savedAppearance().theme, "nimbus");
      assert.equal(useThemeEditorStore.getState().session, null);
      assert.equal(occurrences("Nimbus createdIt’s now active."), created + 1);
    },
  );
});

it("merges a renamed theme into the theme with that name", async () => {
  await withEditor(
    [dusk, aurora],
    async ({
      open,
      labelled,
      type,
      button,
      click,
      library,
      savedAppearance,
      occurrences,
    }) => {
      const updated = occurrences("Dusk updatedIts light palette was added.");
      await open({ editingThemeId: "aurora", initialAppearance: "light" });
      await type(labelled("Theme name"), "Dusk");
      await click(button("Merge into “Dusk”"));
      assert.deepEqual(libraryIds(library()), ["dusk"]);
      assert.ok(getThemeDefinition("dusk")?.variants?.light);
      assert.equal(savedAppearance().theme, "dusk");
      assert.equal(
        occurrences("Dusk updatedIts light palette was added."),
        updated + 1,
      );
    },
  );
});

it("rolls back a create or merge that could not be made active", async () => {
  await withEditor([dusk, aurora], async (harness) => {
    const { open, labelled, type, button, click, library, failSettings } =
      harness;
    const failure = "Theme saved, but it could not be made active. Try again.";
    const shown = () =>
      harness.occurrences(
        "Could not save your themeTheme storage is unavailable, so the change was not kept.",
      );
    const baseline = shown();
    const toasts = () => shown() - baseline;
    failSettings.value = true;
    const before = library();

    await open({});
    await type(labelled("e.g. Aurora"), "Nimbus");
    await click(button("Create theme"));
    assert.deepEqual(library(), before);
    assert.equal(getThemeDefinition("nimbus"), null);
    assert.ok(harness.document.body.textContent.includes(failure));
    assert.equal(toasts(), 1);
    assert.ok(useThemeEditorStore.getState().session);

    await type(labelled("e.g. Aurora"), "Dusk");
    await click(button("Add light palette"));
    assert.deepEqual(library(), before);
    assert.equal(getThemeDefinition("dusk")?.variants, undefined);
    assert.equal(toasts(), 2);

    await open({ editingThemeId: "aurora", initialAppearance: "light" });
    await type(labelled("Theme name"), "Dusk");
    await click(button("Merge into “Dusk”"));
    assert.deepEqual(libraryIds(library()), ["aurora", "dusk"]);
    assert.equal(getThemeDefinition("dusk")?.variants, undefined);
    assert.ok(getThemeDefinition("aurora"));
    assert.ok(harness.document.body.textContent.includes(failure));
    assert.equal(toasts(), 3);
  });
});

it("keeps the library unchanged when a durable write fails and says so", async () => {
  await withEditor([dusk, aurora], async (harness) => {
    const { open, labelled, type, button, click, library, failLibrary } =
      harness;
    const baseline = harness.occurrences("Could not save your theme");
    const toasts = () =>
      harness.occurrences("Could not save your theme") - baseline;
    const before = library();

    failLibrary.when = () => true;
    await open({});
    await type(labelled("e.g. Aurora"), "Nimbus");
    await click(button("Create theme"));
    assert.deepEqual(library(), before);
    assert.ok(
      harness.document.body.textContent.includes("Could not create the theme."),
    );
    assert.equal(toasts(), 1);

    await open({ editingThemeId: "aurora", initialAppearance: "light" });
    await type(labelled("Theme name"), "Aurora Two");
    await click(button("Save changes"));
    assert.deepEqual(library(), before);
    assert.ok(
      harness.document.body.textContent.includes("Could not save the theme."),
    );
    assert.equal(toasts(), 2);

    failLibrary.when = (json) => !json.includes('"aurora"');
    await type(labelled("Theme name"), "Dusk");
    await click(button("Merge into “Dusk”"));
    assert.deepEqual(libraryIds(library()), ["aurora", "dusk"]);
    assert.equal(getThemeDefinition("dusk")?.variants, undefined);
    assert.equal(toasts(), 3);
    assert.ok(useThemeEditorStore.getState().session);
  });
});

it("regenerates a palette from Background and Accent only when the guided editor owns it", async () => {
  await withEditor(
    [dusk, guided],
    async ({ open, labelled, click, hex, type }) => {
      const advanced = () => labelled("Use advanced theme colors");
      const checked = () =>
        advanced().attributes.get("aria-checked")?.toString();

      await open({ editingThemeId: "dusk" });
      assert.equal(checked(), "true");
      assert.equal(hex("Surface"), "#ff00ff");
      await click(advanced());
      assert.equal(checked(), "false");
      await click(advanced());
      assert.notEqual(hex("Surface"), "#ff00ff");

      await open({ editingThemeId: "guided" });
      assert.equal(checked(), "false");
      await click(advanced());
      assert.equal(hex("Surface"), EDITED_SURFACE);
      await click(advanced());
      await click(advanced());
      assert.equal(hex("Surface"), EDITED_SURFACE);
      await click(advanced());
      await type(labelled("Background hex value"), "#203040");
      await click(advanced());
      assert.notEqual(hex("Surface"), EDITED_SURFACE);
    },
  );
});
