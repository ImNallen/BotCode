import assert from "node:assert/strict";
import { it } from "node:test";
import type { DraftComment, PrReviewDetail } from "./prReview.ts";
import { draftAnnotations, pullRequestCodeFile } from "./pullRequestDiff.ts";

type PrFile = PrReviewDetail["files"][number];

const PATCH = [
  "@@ -1,3 +1,3 @@",
  " import a",
  "-const b = 1;",
  "+const b = 2;",
  " export {}",
  "@@ -10,2 +10,3 @@ function tail() {",
  " keep",
  "+added",
  " end",
].join("\n");

const ANCHORS: PrFile["anchors"] = [
  { side: "RIGHT", line: 1, text: " import a" },
  { side: "LEFT", line: 2, text: "-const b = 1;" },
  { side: "RIGHT", line: 2, text: "+const b = 2;" },
  { side: "RIGHT", line: 3, text: " export {}" },
  { side: "RIGHT", line: 10, text: " keep" },
  { side: "RIGHT", line: 11, text: "+added" },
  { side: "RIGHT", line: 12, text: " end" },
];

function file(overrides: Partial<PrFile> = {}): PrFile {
  return {
    path: "src/app.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    patch: PATCH,
    unavailable: null,
    anchors: ANCHORS,
    ...overrides,
  };
}

function diff(input: PrFile) {
  const result = pullRequestCodeFile(input);
  if (result.kind !== "diff") throw new Error(result.reason);
  return result;
}

it("builds pierre hunks from GitHub's headerless per-file patch", () => {
  const { fileDiff } = diff(file());
  assert.equal(fileDiff.name, "src/app.ts");
  assert.equal(fileDiff.type, "change");
  assert.deepEqual(
    fileDiff.hunks.map((hunk) => [
      hunk.deletionStart,
      hunk.deletionCount,
      hunk.additionStart,
      hunk.additionCount,
      hunk.deletionLines,
      hunk.additionLines,
    ]),
    [
      [1, 3, 1, 3, 1, 1],
      [10, 2, 10, 3, 0, 1],
    ],
  );
  assert.deepEqual(fileDiff.additionLines, [
    "import a\n",
    "const b = 2;\n",
    "export {}\n",
    "keep\n",
    "added\n",
    "end\n",
  ]);
});

it("marks added and removed files and keeps paths with spaces", () => {
  const added = diff(
    file({
      path: "docs/new page.md",
      status: "added",
      patch: "@@ -0,0 +1 @@\n+hi",
    }),
  );
  assert.equal(added.fileDiff.type, "new");
  assert.equal(added.fileDiff.name, "docs/new page.md");
  const removed = diff(
    file({ status: "removed", patch: "@@ -1 +0,0 @@\n-bye" }),
  );
  assert.equal(removed.fileDiff.type, "deleted");
  assert.equal(removed.fileDiff.name, "src/app.ts");
});

it("keeps the reason for files without a renderable patch", () => {
  assert.deepEqual(
    pullRequestCodeFile(
      file({
        patch: null,
        anchors: [],
        unavailable: "Patch unavailable, binary or oversized.",
      }),
    ),
    {
      kind: "unavailable",
      file: file({
        patch: null,
        anchors: [],
        unavailable: "Patch unavailable, binary or oversized.",
      }),
      reason: "Patch unavailable, binary or oversized.",
    },
  );
  const broken = pullRequestCodeFile(
    file({ patch: "@@ -1,2 +1,2 @@\n only one line" }),
  );
  assert.equal(broken.kind, "unavailable");
  assert.equal(
    broken.kind === "unavailable" && broken.reason,
    "This patch could not be displayed. Line comments are unavailable.",
  );
});

it("maps every rendered row to the GitHub anchor it comments on", () => {
  assert.deepEqual(Object.fromEntries(diff(file()).targets), {
    "additions:1": { side: "RIGHT", line: 1 },
    "deletions:1": { side: "RIGHT", line: 1 },
    "deletions:2": { side: "LEFT", line: 2 },
    "additions:2": { side: "RIGHT", line: 2 },
    "additions:3": { side: "RIGHT", line: 3 },
    "deletions:3": { side: "RIGHT", line: 3 },
    "additions:10": { side: "RIGHT", line: 10 },
    "deletions:10": { side: "RIGHT", line: 10 },
    "additions:11": { side: "RIGHT", line: 11 },
    "additions:12": { side: "RIGHT", line: 12 },
    "deletions:11": { side: "RIGHT", line: 12 },
  });
});

it("offers no comment target outside GitHub's anchors", () => {
  const { targets } = diff(
    file({ anchors: ANCHORS.filter((anchor) => anchor.line !== 2) }),
  );
  assert.equal(targets.get("deletions:2"), undefined);
  assert.equal(targets.get("additions:2"), undefined);
  assert.deepEqual(targets.get("additions:11"), { side: "RIGHT", line: 11 });
  assert.equal(diff(file({ anchors: [] })).targets.size, 0);
});

it("groups drafted comments under their line on the viewer's side", () => {
  const comment = (
    id: string,
    path: string,
    side: DraftComment["side"],
    line: number,
  ): DraftComment => ({ id, revision: 0, path, side, line, body: "" });
  assert.deepEqual(
    draftAnnotations(
      [
        comment("a", "src/app.ts", "RIGHT", 11),
        comment("b", "src/other.ts", "RIGHT", 11),
        comment("c", "src/app.ts", "LEFT", 2),
        comment("d", "src/app.ts", "RIGHT", 11),
      ],
      "src/app.ts",
    ),
    [
      { side: "additions", lineNumber: 11, metadata: { ids: ["a", "d"] } },
      { side: "deletions", lineNumber: 2, metadata: { ids: ["c"] } },
    ],
  );
});
