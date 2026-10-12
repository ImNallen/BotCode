import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import { useAppearance } from "../appearance/AppearanceRoot";
import {
  findAll,
  fireEvent,
  withFakeDom,
  type FakeNode,
} from "../test/fakeDom";
import { AppearanceSettingsRow } from "./AppearanceSettings";
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
