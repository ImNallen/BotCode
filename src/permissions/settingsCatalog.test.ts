import assert from "node:assert/strict";
import { it } from "node:test";

it("offers one permission search result with a distinct control anchor in the native macOS catalog", async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const previousTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "MacIntel" },
  });
  Object.defineProperty(globalThis, "isTauri", {
    configurable: true,
    value: true,
  });
  try {
    const { categories } = await import("../settings/settingsCatalog");
    const group = categories.general.groups.find(
      (entry) => entry.id === "mac-permissions",
    );
    assert.ok(group);
    assert.equal(group.hideTitle, true);
    assert.equal(group.rows.length, 1);
    assert.equal(group.rows[0]?.id, "mac-permissions-controls");
    assert.match(
      group.rows[0]?.description ?? "",
      /Screen Recording and Accessibility/,
    );
    assert.notEqual(group.id, group.rows[0]?.id);
  } finally {
    if (previousNavigator)
      Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (previousTauri)
      Object.defineProperty(globalThis, "isTauri", previousTauri);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});
