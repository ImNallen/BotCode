import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { useAppearance } from "../appearance/AppearanceRoot";
import {
  findAll,
  fireEvent,
  withFakeDom,
  type FakeNode,
} from "../test/fakeDom";
import {
  AppearanceSettingsRow,
  FontFamilySettingsRow,
  fontDraftInvalid,
  fontFamilyCommit,
  fontSizeOptions,
} from "./AppearanceSettings";
import { PreferencesProvider } from "./preferences";
import { categories } from "./settingsCatalog";

const contrastRow = categories.appearance.groups
  .flatMap((group) => group.rows)
  .find((row) => row.id === "setting-appearance-contrast");

it("previews a contrast drag everywhere and saves settings once on release", async () => {
  assert.ok(contrastRow);
  const saves: Record<string, unknown>[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: (_key: string, text: string) => {
        saves.push(JSON.parse(text) as Record<string, unknown>);
      },
    },
  });
  let shownElsewhere: number | undefined;
  function Elsewhere() {
    shownElsewhere = useAppearance().appearance.appearanceContrast;
    return null;
  }
  try {
    await withFakeDom(async ({ subtree, root }) => {
      await act(async () =>
        root.render(
          createElement(PreferencesProvider, {
            children: [
              createElement(AppearanceSettingsRow, {
                key: "row",
                info: contrastRow,
              }),
              createElement(Elsewhere, { key: "elsewhere" }),
            ],
          }),
        ),
      );
      const [slider] = findAll(subtree, "INPUT") as (FakeNode & {
        value: string;
      })[];
      assert.ok(slider);
      const [readout] = findAll(subtree, "OUTPUT");
      for (const value of ["105", "120", "150"]) {
        slider.value = value;
        await fireEvent(subtree, slider, "input");
      }
      assert.equal(readout?.textContent, "150%");
      assert.equal(shownElsewhere, 150);
      assert.equal(saves.length, 0);

      await act(async () => {
        for (const entry of slider.listeners)
          if (entry.type === "change")
            entry.listener({ type: "change", target: slider });
      });
      assert.equal(saves.length, 1);
      assert.deepEqual(
        (saves[0]?.appearance as Record<string, unknown>).appearanceContrast,
        150,
      );
      assert.equal(readout?.textContent, "150%");
      assert.equal(shownElsewhere, 150);
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

it("offers T3's size range for each font row", () => {
  const range = (options: number[]) => [options[0], options.at(-1)];
  assert.deepEqual(range(fontSizeOptions("fontSizeInterface")), [12, 20]);
  assert.deepEqual(range(fontSizeOptions("fontSizePrompt")), [12, 20]);
  assert.deepEqual(range(fontSizeOptions("fontSizeCode")), [10, 18]);
  assert.deepEqual(range(fontSizeOptions("fontSizeTerminal")), [8, 20]);
  assert.equal(fontSizeOptions("fontSizeTerminal").length, 13);
});

function fakeCanvasContext() {
  const context = {
    font: "",
    measureText(text: string) {
      const perGlyph = (glyph: string) =>
        context.font.includes("Menlo")
          ? 10
          : context.font.includes("Arial")
            ? glyph === "i"
              ? 4
              : glyph === "M"
                ? 12
                : 8
            : context.font.includes("sans-serif")
              ? 8.5
              : context.font.includes("serif")
                ? 7
                : 9;
      return { width: [...text].reduce((sum, g) => sum + perGlyph(g), 0) };
    },
  };
  return context;
}

it("commits a settled family only when it is installed, and monospace for code rows", async () => {
  await withFakeDom(async ({ document }) => {
    const createElementNode = document.createElement.bind(document);
    const canvas = fakeCanvasContext();
    document.createElement = (tag: string) =>
      tag === "canvas"
        ? Object.assign(createElementNode(tag), { getContext: () => canvas })
        : createElementNode(tag);
    assert.deepEqual(fontFamilyCommit("Menlo", true), {
      kind: "commit",
      family: "Menlo",
    });
    assert.deepEqual(fontFamilyCommit("Arial", true), { kind: "reject" });
    assert.deepEqual(fontFamilyCommit("Arial", false), {
      kind: "commit",
      family: "Arial",
    });
    assert.deepEqual(fontFamilyCommit("Not Installed", false), {
      kind: "reject",
    });
    assert.deepEqual(fontFamilyCommit("", true), {
      kind: "commit",
      family: "",
    });
  });
});

it("flags a settled draft that differs from the committed family", () => {
  assert.equal(fontDraftInvalid("Arial", true, ""), true);
  assert.equal(fontDraftInvalid("Arial", false, ""), false);
  assert.equal(fontDraftInvalid(" Menlo ", true, "Menlo"), false);
  assert.equal(fontDraftInvalid("  ", true, "Menlo"), false);
});

it("keeps the settings page open when Escape discards a family draft", async () => {
  await withFakeDom(async ({ subtree, root }) => {
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await act(async () =>
      root.render(
        createElement(RouterContextProvider, {
          router,
          children: createElement(FontFamilySettingsRow, {
            id: "code-font",
            title: "Code font",
            description: "Code blocks, diffs, and file previews.",
            defaultFamily: "SF Mono",
            defaultValue: "",
            value: "Menlo",
            onValueChange: () => assert.fail("Escape must not commit"),
            onReset: () => {},
            requireMonospace: true,
            size: {
              label: "Code font size",
              options: fontSizeOptions("fontSizeCode"),
              value: 13,
              defaultValue: 13,
              onChange: () => {},
            },
          }),
        }),
      ),
    );
    const [input] = findAll(subtree, "INPUT") as (FakeNode & {
      value: string;
    })[];
    assert.ok(input);
    assert.equal(input.attributes.get("aria-label"), "Code font family");
    let stopped = false;
    const event = await fireEvent(subtree, input, "keydown", {
      key: "Escape",
      stopPropagation: () => {
        stopped = true;
      },
    });
    assert.equal(stopped, true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(input.value, "Menlo");
  });
});
