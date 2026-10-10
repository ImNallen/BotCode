import assert from "node:assert/strict";
import { it } from "node:test";
import { firstEmoji, filterProjectIconNames } from "./projectIconOptions";
import { isMonogramText } from "./projectIcon";

it("pasted emoji chooses one complete grapheme, including joined, flag and keycap sequences", () => {
  for (const emoji of ["👩‍💻", "🇸🇪", "1️⃣", "🛠️"])
    assert.equal(firstEmoji(`  ${emoji} followed by text`), emoji);
  assert.equal(firstEmoji("a💻"), null);
  assert.equal(firstEmoji("  "), null);
});

it("icon search normalizes spaces, includes the full catalog, and caps results", () => {
  assert.ok(filterProjectIconNames(" FOLDER CODE ").includes("folder-code"));
  assert.ok(filterProjectIconNames("accessibility").includes("accessibility"));
  assert.equal(filterProjectIconNames("").length, 24);
  assert.ok(filterProjectIconNames("a").length <= 60);
  assert.deepEqual(filterProjectIconNames("no-such-lucide-icon"), []);
});

it("monogram input accepts letter and number sequences with marks, and refuses punctuation and leading marks", () => {
  for (const text of ["A", "T3", "É", "A\u0301", "क्‍ष"])
    assert.equal(isMonogramText(text), true, text);
  for (const text of ["", "!", "A B", "\u0301A", "😀", "A".repeat(33)])
    assert.equal(isMonogramText(text), false, text);
});
