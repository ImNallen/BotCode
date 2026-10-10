import assert from "node:assert/strict";
import { it } from "node:test";
import { newProjectFolderName } from "./newProject";

it("new project preview matches portable T3 folder names", () => {
  assert.equal(newProjectFolderName(" Pinball Stats "), "pinball-stats");
  assert.equal(newProjectFolderName("Crème café"), "creme-cafe");
  assert.equal(newProjectFolderName("ＡＢＣ"), "abc");
  assert.equal(newProjectFolderName("CON"), "con-project");
  assert.equal(newProjectFolderName("✨"), "project");
  assert.equal(
    newProjectFolderName("a".repeat(63) + " and more"),
    "a".repeat(63),
  );
});
