import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findTaskListMarkerOffset,
  setMarkdownTaskChecked,
} from "./markdownTasks";

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    assert.equal(
      setMarkdownTaskChecked(markdown, 2, true),
      "- [x] First\n- [x] Second\n",
    );
    assert.equal(
      setMarkdownTaskChecked(markdown, 14, false),
      "- [ ] First\n- [ ] Second\n",
    );
    assert.equal(
      setMarkdownTaskChecked("1. [X] Ordered\n", 3, false),
      "1. [ ] Ordered\n",
    );
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    assert.equal(setMarkdownTaskChecked(markdown, 0, true), markdown);
    assert.equal(setMarkdownTaskChecked(markdown, 200, true), markdown);
    assert.equal(setMarkdownTaskChecked(markdown, -1, true), markdown);
  });
});

describe("findTaskListMarkerOffset", () => {
  it("finds the marker on the list item's first line for every list syntax", () => {
    const markdown =
      "- [ ] dash\n* [x] star\n+ [X] plus\n1. [ ] dot\n2) [ ] paren\n  - [ ] nested\n";
    const starts = [0, 11, 22, 33, 44, 57];
    const markers = starts.map((start) =>
      findTaskListMarkerOffset(markdown, start),
    );
    assert.deepEqual(markers, [2, 13, 24, 36, 47, 61]);
    for (const marker of markers)
      assert.ok(
        /^\[[ xX]\]$/.test(markdown.slice(marker ?? -1, (marker ?? -1) + 3)),
        `offset ${marker} points at a marker`,
      );
  });

  it("returns null for an item that is not a task", () => {
    assert.equal(findTaskListMarkerOffset("- plain [ ] text\n", 0), null);
    assert.equal(findTaskListMarkerOffset("- item\n  [ ] later\n", 0), null);
  });

  it("feeds setMarkdownTaskChecked to rewrite only the nested item", () => {
    const markdown = "- [ ] parent\n  - [ ] child\n";
    const marker = findTaskListMarkerOffset(markdown, 13);
    assert.equal(
      setMarkdownTaskChecked(markdown, marker ?? -1, true),
      "- [ ] parent\n  - [x] child\n",
    );
  });
});
