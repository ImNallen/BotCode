import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreferencesProvider, usePreferences } from "./preferences";
import { categories } from "./settingsCatalog";

function storedMeter(stored: unknown) {
  let observed: boolean | undefined;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => JSON.stringify(stored) },
  });
  function Inspect() {
    observed = usePreferences().preferences.contextWindowMeter;
    return null;
  }
  try {
    renderToStaticMarkup(
      createElement(PreferencesProvider, { children: createElement(Inspect) }),
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  return observed;
}

it("shows the context window indicator unless it was turned off", () => {
  assert.equal(storedMeter({ appearance: "dark" }), true);
  assert.equal(storedMeter({ contextWindowMeter: "invalid" }), true);
  assert.equal(storedMeter({ contextWindowMeter: false }), false);
  const application = categories.general.groups.find(
    (group) => group.id === "application",
  );
  assert.ok(
    application?.rows.some(
      (row) =>
        row.id === "context-window-indicator" &&
        row.title === "Context window indicator",
    ),
  );
});
