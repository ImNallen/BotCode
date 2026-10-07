// Ported from T3 Code v0.0.45 apps/web/src/reviewCommentContext.test.ts (MIT).
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseDiffFromFile } from "@pierre/diffs";
import { composerContextRecord } from "../chat/composerContext";
import { buildDiffReviewContext } from "./composerReviewContext";

const fileDiff = parseDiffFromFile(
  { name: "src/app.ts", contents: "one\ntwo\nthree\nfour\n" },
  { name: "src/app.ts", contents: "one\nTWO\nthree\nfour\n" },
);
const source = {
  contextId: "review-context",
  sectionId: "turn:2",
  sectionTitle: "Turn 2",
  filePath: "src/app.ts",
  fileDiff,
};

it("sends a mixed-side selection as T3 row coordinates and a unified diff excerpt", () => {
  const record = buildDiffReviewContext({
    ...source,
    range: { start: 2, side: "deletions", end: 2, endSide: "additions" },
    text: "  Keep both sides.  ",
  });
  assert.deepEqual(record, {
    version: 1,
    kind: "review-comment",
    contextId: "review-context",
    label: "src/app.ts:2",
    sectionId: "turn:2",
    sectionTitle: "Turn 2",
    filePath: "src/app.ts",
    startIndex: 1,
    endIndex: 2,
    rangeLabel: "2",
    text: "Keep both sides.",
    diff: "@@ -2,1 +2,1 @@\n-two\n+TWO",
    fenceLanguage: "diff",
  });
  assert.deepEqual(composerContextRecord.parse(record), record);
});

it("normalizes backwards selections and distinguishes old and new lines in split view", () => {
  const backwards = buildDiffReviewContext({
    ...source,
    range: { start: 2, side: "additions", end: 2, endSide: "deletions" },
    text: "Both",
  });
  assert.equal(backwards?.startIndex, 1);
  assert.equal(backwards?.endIndex, 2);
  assert.equal(backwards?.diff, "@@ -2,1 +2,1 @@\n-two\n+TWO");
  const deleted = buildDiffReviewContext({
    ...source,
    range: { start: 2, end: 2, side: "deletions" },
    text: "Old",
  });
  const added = buildDiffReviewContext({
    ...source,
    range: { start: 2, end: 2, side: "additions" },
    text: "New",
  });
  assert.equal(deleted?.rangeLabel, "-2");
  assert.equal(deleted?.diff, "@@ -2,1 +0,0 @@\n-two");
  assert.equal(added?.rangeLabel, "+2");
  assert.equal(added?.diff, "@@ -0,0 +2,1 @@\n+TWO");
});

it("includes expanded context outside compact hunks and refuses an absent line", () => {
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  const next = lines.map((line, index) => (index === 14 ? "changed 15" : line));
  const full = parseDiffFromFile(
    { name: "src/app.ts", contents: lines.join("\n") },
    { name: "src/app.ts", contents: next.join("\n") },
  );
  const record = buildDiffReviewContext({
    ...source,
    fileDiff: full,
    range: { start: 1, end: 2, side: "additions" },
    text: "Beginning",
  });
  assert.equal(record?.startIndex, 0);
  assert.equal(record?.endIndex, 1);
  assert.equal(record?.diff, "@@ -1,2 +1,2 @@\n line 1\n line 2");
  assert.equal(
    buildDiffReviewContext({
      ...source,
      range: { start: 999, end: 999, side: "additions" },
      text: "Absent",
    }),
    null,
  );
});

it("bounds comment and excerpt payloads before they enter the shared chip model", () => {
  const huge = parseDiffFromFile(
    { name: "large.txt", contents: "old" },
    { name: "large.txt", contents: "x".repeat(40_000) },
  );
  const record = buildDiffReviewContext({
    ...source,
    fileDiff: huge,
    range: { start: 1, end: 1, side: "additions" },
    text: "x".repeat(20_000),
  });
  assert.equal(record?.text.length, 16_000);
  assert.equal(record?.diff.length, 32_000);
  assert.deepEqual(composerContextRecord.parse(record), record);
});
