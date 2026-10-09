import assert from "node:assert/strict";
import { it } from "node:test";
import { hydratePartialDiff } from "@pierre/diffs";
import { createPullRequestDiffFileContentsLoader } from "./diffFileContents";
import { pullRequestCodeFile, lineKey } from "./pullRequestDiff";
import type { PrReviewDetail } from "./prReview";

type PrFile = PrReviewDetail["files"][number];
const oldOid = "b".repeat(40);
const newOid = "a".repeat(40);
function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    path: "new name.ts",
    previousPath: "old name.ts",
    status: "renamed",
    additions: 1,
    deletions: 1,
    patch: "@@ -20 +20 @@\n-line 20\n+changed 20",
    unavailable: null,
    anchors: [
      { side: "LEFT", line: 20, text: "-line 20" },
      { side: "RIGHT", line: 20, text: "+changed 20" },
    ],
    contentsSource: {
      id: "00000000-0000-4000-8000-000000000001",
      oldOid,
      newOid,
    },
    ...overrides,
  };
}
function code(input: PrFile) {
  const result = pullRequestCodeFile(input);
  assert.equal(result.kind, "diff");
  if (result.kind !== "diff") throw new Error(result.reason);
  return result;
}
it("hydrates unchanged context from the captured versions and keeps original comment anchors", async () => {
  const input = file();
  const oldContents = Array.from(
    { length: 50 },
    (_, i) => `line ${i + 1}\n`,
  ).join("");
  const newContents = oldContents.replace("line 20\n", "changed 20\n");
  const entry = code(input);
  assert.equal(entry.fileDiff.type, "rename-changed");
  assert.equal(entry.fileDiff.prevName, "old name.ts");
  const requests: string[] = [];
  const loader = createPullRequestDiffFileContentsLoader(
    async (sourceId) => {
      requests.push(sourceId);
      return { oldContents, newContents };
    },
    [input],
    "PR:all",
  );
  assert.deepEqual(requests, []);
  const files = await loader(entry.fileDiff);
  assert.deepEqual(requests, [input.contentsSource?.id]);
  assert.equal(files.oldFile?.name, "old name.ts");
  assert.equal(files.newFile?.name, "new name.ts");
  assert.match(files.oldFile?.cacheKey ?? "", new RegExp(oldOid));
  const hydrated = hydratePartialDiff("merge", entry.fileDiff, files);
  assert.equal(hydrated.isPartial, false);
  assert.equal(hydrated.deletionLines.length, 50);
  assert.equal(hydrated.additionLines[0], "line 1\n");
  assert.equal(hydrated.additionLines[49], "line 50\n");
  assert.equal(entry.targets.has(lineKey("additions", 1)), false);
  assert.deepEqual(entry.targets.get(lineKey("additions", 20)), {
    side: "RIGHT",
    line: 20,
  });
});
it("ports pure rename hydration and cache identity for commit scopes", async () => {
  const input = file({ additions: 0, deletions: 0, patch: "", anchors: [] });
  const entry = code(input);
  assert.equal(entry.fileDiff.type, "rename-pure");
  const load = async () => ({ oldContents: "same\n", newContents: "same\n" });
  const all = await createPullRequestDiffFileContentsLoader(
    load,
    [input],
    "PR:all",
  )(entry.fileDiff);
  const commit = await createPullRequestDiffFileContentsLoader(
    load,
    [input],
    "PR:commitSHA",
  )(entry.fileDiff);
  assert.equal(all.oldFile, null);
  assert.notEqual(all.newFile?.cacheKey, commit.newFile?.cacheKey);
  assert.equal(
    hydratePartialDiff("merge", entry.fileDiff, all).isPartial,
    false,
  );
});
it("fails closed without a captured source and propagates host errors", async () => {
  const entry = code(file());
  const missing = createPullRequestDiffFileContentsLoader(
    async () => {
      throw new Error("must not run");
    },
    [file({ contentsSource: null })],
    "PR:all",
  );
  await assert.rejects(
    missing(entry.fileDiff),
    /Exact file revisions are unavailable/,
  );
  const failed = createPullRequestDiffFileContentsLoader(
    async () => {
      throw new Error("File contents are not valid UTF-8.");
    },
    [file()],
    "PR:all",
  );
  await assert.rejects(failed(entry.fileDiff), /not valid UTF-8/);
});

it("keeps hydrated whitespace modes distinct when context is first expanded with the filter enabled", async () => {
  const input = file({ patch: "@@ -20 +20 @@\n-line 20\n+  line 20" });
  const source = code(input).fileDiff;
  const { hideWhitespaceChanges } = await import("./hideWhitespace");
  const filtered = hideWhitespaceChanges(source);
  const oldContents = Array.from(
    { length: 50 },
    (_, i) => `line ${i + 1}\n`,
  ).join("");
  const loader = createPullRequestDiffFileContentsLoader(
    async () => ({
      oldContents,
      newContents: oldContents.replace("line 20\n", "  line 20\n"),
    }),
    [input],
    "PR:all",
  );
  const expandedFiltered = hydratePartialDiff(
    "merge",
    filtered,
    await loader(filtered),
  );
  const expandedUnfiltered = hydratePartialDiff(
    "merge",
    source,
    await loader(source),
  );
  assert.notEqual(expandedFiltered.cacheKey, expandedUnfiltered.cacheKey);
  assert.equal(expandedFiltered.hunks[0]?.additionLines, 0);
  assert.equal(expandedUnfiltered.hunks[0]?.additionLines, 1);
  assert.equal(expandedFiltered.hunks[0]?.hunkContent[0]?.type, "context");
  assert.equal(expandedUnfiltered.hunks[0]?.hunkContent[0]?.type, "change");
  assert.equal(expandedFiltered.additionLines.length, 50);
  assert.equal(expandedUnfiltered.additionLines.length, 50);
  const dark = pullRequestCodeFile(input, "dark");
  const light = pullRequestCodeFile(input, "light");
  assert.equal(dark.kind, "diff");
  assert.equal(light.kind, "diff");
  if (dark.kind !== "diff" || light.kind !== "diff")
    throw new Error("Expected diff");
  assert.notEqual(dark.fileDiff.cacheKey, light.fileDiff.cacheKey);
  assert.notEqual(source.cacheKey, code(file()).fileDiff.cacheKey);
  assert.notEqual(
    source.cacheKey,
    code({
      ...input,
      contentsSource: {
        id: "00000000-0000-4000-8000-000000000001",
        oldOid,
        newOid: "c".repeat(40),
      },
    }).fileDiff.cacheKey,
  );
});

for (const name of [
  "tab\tname.ts",
  "line\nname.ts",
  'quoted"name.ts',
  "back\\slash.ts",
]) {
  it(`loads renamed literal paths containing ${JSON.stringify(name)}`, async () => {
    const input = file({ path: `new/${name}`, previousPath: `old/${name}` });
    const entry = code(input);
    assert.equal(entry.fileDiff.name, input.path);
    assert.equal(entry.fileDiff.prevName, input.previousPath);
    const loaded = await createPullRequestDiffFileContentsLoader(
      async (id) => {
        assert.equal(id, input.contentsSource?.id);
        return { oldContents: "line 20\n", newContents: "changed 20\n" };
      },
      [input],
      "PR:all",
    )(entry.fileDiff);
    assert.equal(loaded.oldFile?.name, input.previousPath);
    assert.equal(loaded.newFile?.name, input.path);
  });
}
