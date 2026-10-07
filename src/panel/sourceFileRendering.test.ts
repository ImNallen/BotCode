import assert from "node:assert/strict";
import { it } from "node:test";
import { FileRenderer, type FileContents } from "@pierre/diffs";

it("keeps Pierre's prepared layout and rendered file aligned across line-reveal redraws", async () => {
  const renderer = new FileRenderer({ theme: "pierre-dark", overflow: "wrap" });
  try {
    await renderer.initializeHighlighter();
    const file: FileContents = {
      name: "shard-499/file-099.txt",
      cacheKey: "editor:search-fixture:initial",
      contents: Array.from(
        { length: 400 },
        (_, index) => `line ${index + 1}\n`,
      ).join(""),
    };
    assert.equal(renderer.renderFile(file)?.file, file);

    for (const overflow of ["scroll", "wrap"] as const) {
      renderer.setOptions({ theme: "pierre-dark", overflow });
      const prepared = renderer.getFileForNextRender(file);
      assert.equal(renderer.renderFile(file)?.file, prepared);
    }

    const changed = {
      ...file,
      contents: file.contents.replace("line 321", "test 321"),
      cacheKey: "editor:search-fixture:changed",
    };
    assert.equal(changed.contents.length, file.contents.length);
    const prepared = renderer.getFileForNextRender(changed);
    assert.equal(renderer.renderFile(changed)?.file, prepared);
    assert.equal(renderer.fileCache?.contents, changed.contents);
  } finally {
    renderer.cleanUp();
  }
});
