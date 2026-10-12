import assert from "node:assert/strict";
import { it } from "node:test";
import { defaultAppearance } from "./appearance/settings";
import { resolveTerminalFont } from "./appearanceFonts";

const custom = {
  ...defaultAppearance,
  fontFamilyCode: "JetBrains Mono",
  fontSizeCode: 15,
  fontFamilyTerminal: "Menlo",
  fontSizeTerminal: 9,
};

it("gives the terminal the code font while Advanced is off", () => {
  assert.deepEqual(resolveTerminalFont(custom), {
    family: "JetBrains Mono",
    size: 15,
  });
});

it("gives the terminal its own font, even an empty default, while Advanced is on", () => {
  const advanced = { ...custom, typographyAdvanced: true };
  assert.deepEqual(resolveTerminalFont(advanced), { family: "Menlo", size: 9 });
  assert.deepEqual(
    resolveTerminalFont({ ...advanced, fontFamilyTerminal: "" }),
    { family: "", size: 9 },
  );
});
