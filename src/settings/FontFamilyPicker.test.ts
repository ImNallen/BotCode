import assert from "node:assert/strict";
import { it } from "node:test";
import {
  DEFAULT_FONT_VALUE,
  fontPickerItems,
  fontPickerWindow,
} from "./FontFamilyPicker";

const families = ["Avenir", "Fira Code", "JetBrains Mono", "Menlo"];

it("leads with the default entry until a query filters the families", () => {
  assert.deepEqual(fontPickerItems(families, ""), [
    DEFAULT_FONT_VALUE,
    ...families,
  ]);
  assert.deepEqual(fontPickerItems(families, "  MON "), ["JetBrains Mono"]);
  assert.deepEqual(fontPickerItems(families, "co"), ["Fira Code"]);
  assert.deepEqual(fontPickerItems(families, "zz"), []);
});

it("renders only the scrolled viewport plus overscan of a long list", () => {
  assert.deepEqual(fontPickerWindow(0, 5), { start: 0, end: 5 });
  assert.deepEqual(fontPickerWindow(0, 900), { start: 0, end: 22 });
  assert.deepEqual(fontPickerWindow(3000, 900), { start: 88, end: 122 });
  assert.deepEqual(fontPickerWindow(26_700, 900), { start: 878, end: 900 });
});
