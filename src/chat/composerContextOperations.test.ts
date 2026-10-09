import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendContext,
  contextReference,
  contextReferences,
  referencedRecords,
  removeContext,
  replaceContext,
  upsertContext,
  type ComposerContent,
  type ComposerContextRecord,
} from "./composerContext";

type ReviewRecord = Extract<ComposerContextRecord, { kind: "review-comment" }>;
const comment = (overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
  version: 1,
  contextId: "file-comment-1",
  kind: "review-comment",
  label: "src/app.ts:L3 to L5",
  sectionId: "file:src/app.ts",
  sectionTitle: "File comment",
  filePath: "src/app.ts",
  startIndex: 2,
  endIndex: 4,
  rangeLabel: "L3 to L5",
  text: "Guard this.",
  diff: "three\nfour\nfive",
  fenceLanguage: "ts",
  ...overrides,
});
const chips = (content: ComposerContent, id: string) =>
  contextReferences(content.text).filter((r) => r.contextId === id).length;
const empty: ComposerContent = { text: "", records: [] };

describe("upsertContext", () => {
  it("inserts a new record with one chip, and a second upsert of the same id replaces it without a second chip", () => {
    const first = upsertContext({ text: "Look at", records: [] }, comment());
    assert.equal(first.text, `Look at ${contextReference(comment())} `);
    const second = upsertContext(first, comment({ text: "Guard it twice." }));
    assert.equal(chips(second, "file-comment-1"), 1);
    assert.equal(second.records.length, 1);
    assert.equal(
      second.records[0]?.kind === "review-comment" && second.records[0].text,
      "Guard it twice.",
    );
  });

  it("returns the same object for an identical record", () => {
    const content = upsertContext(empty, comment());
    assert.equal(upsertContext(content, comment()), content);
    assert.equal(
      upsertContext(content, { ...comment(), fenceLanguage: "ts" }),
      content,
    );
  });

  it("restores a record the text still references without adding a chip", () => {
    const reference = contextReference(comment());
    const content = upsertContext({ text: reference, records: [] }, comment());
    assert.equal(content.text, reference);
    assert.deepEqual(content.records, [comment()]);
  });

  it("refuses a 201st chip but still replaces an existing one at the limit", () => {
    let content = empty;
    for (let index = 0; index < 200; index += 1)
      content = appendContext(
        content,
        comment({ contextId: `c${index}`, label: `c${index}` }),
      );
    assert.throws(
      () => upsertContext(content, comment({ contextId: "c200" })),
      /up to 200 context chips/,
    );
    const replaced = upsertContext(
      content,
      comment({ contextId: "c7", label: "c7", text: "New" }),
    );
    assert.equal(replaced.records.length, 200);
  });
});

describe("replaceContext", () => {
  it("never inserts: an absent id returns the same object", () => {
    const content = upsertContext({ text: "hi", records: [] }, comment());
    const sent = { text: "", records: [] };
    assert.equal(replaceContext(sent, comment({ startIndex: 4 })), sent);
    assert.equal(
      replaceContext(content, comment({ contextId: "other" })),
      content,
    );
  });

  it("moves a record and relabels its chip in place", () => {
    const content = upsertContext({ text: "see", records: [] }, comment());
    const moved = comment({
      label: "src/app.ts:L5 to L7",
      rangeLabel: "L5 to L7",
      startIndex: 4,
      endIndex: 6,
    });
    const next = replaceContext(content, moved);
    assert.equal(next.text, `see ${contextReference(moved)} `);
    assert.deepEqual(next.records, [moved]);
    assert.equal(replaceContext(next, moved), next);
  });
});

describe("removeContext", () => {
  it("drops the record and its chip with T3's spacing", () => {
    const reference = contextReference(comment());
    const middle = removeContext(
      { text: `before ${reference} after`, records: [comment()] },
      "file-comment-1",
    );
    assert.deepEqual(middle, { text: "before after", records: [] });
    const end = removeContext(
      { text: `before ${reference} `, records: [comment()] },
      "file-comment-1",
    );
    assert.equal(end.text, "before");
    const glued = removeContext(
      { text: `before ${reference}`, records: [comment()] },
      "file-comment-1",
    );
    assert.equal(glued.text, "before");
  });

  it("returns the same object for an unknown id", () => {
    const content = upsertContext({ text: "a", records: [] }, comment());
    assert.equal(removeContext(content, "missing"), content);
  });
});

describe("referencedRecords", () => {
  it("excludes records whose chip was deleted from the text", () => {
    const content = upsertContext(empty, comment());
    assert.deepEqual(referencedRecords(content), [comment()]);
    assert.deepEqual(
      referencedRecords({ text: "", records: content.records }),
      [],
    );
  });
});
