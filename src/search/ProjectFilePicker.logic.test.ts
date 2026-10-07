import assert from "node:assert/strict";
import { it } from "node:test";
import {
  findMatchIndices,
  getProjectFilePickerMatches,
} from "./ProjectFilePicker.logic";

it("keeps backend ranking and computes only capped-row fuzzy highlights", () => {
  const rows = getProjectFilePickerMatches(
    ["z/Composer.tsx", "a/composer.test.ts"],
    " @./cmps ",
  );
  assert.deepEqual(
    rows.map((row) => row.path),
    ["z/Composer.tsx", "a/composer.test.ts"],
  );
  assert.deepEqual(rows[0]?.nameMatchIndices, [0, 2, 3, 5]);
  assert.deepEqual(findMatchIndices("unrelated.txt", "query"), []);
  assert.deepEqual(findMatchIndices("anything", ""), []);
  assert.equal(
    getProjectFilePickerMatches(
      Array.from({ length: 250 }, (_, index) => `${index}.txt`),
      "",
    ).length,
    200,
  );
});
