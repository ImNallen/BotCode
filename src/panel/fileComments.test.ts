// Partly ported from T3 Code v0.0.45 apps/web/src/components/files/FilePreviewPanel.test.ts (MIT).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TextDocument } from "@pierre/diffs/edit";
// Pierre's own remap, which the editor runs before it reports `lineAnnotations`. Not a public export.
import { applyDocumentChangeToLineAnnotations } from "../../node_modules/@pierre/diffs/dist/editor/lineAnnotations.js";
import {
  referencedRecords,
  type ComposerContextRecord,
} from "../chat/composerContext";
import { buildFileReviewContext } from "./composerReviewContext";
import {
  applyMovedAnnotations,
  fileCommentAnnotations,
  formatFileCommentRange,
  movedFileCommentDraft,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
  savedFileComments,
  type FileCommentLineAnnotation,
} from "./fileComments";

const source = "one\ntwo\nthree\nfour\nfive\nsix\n";
const fileComment = (id: string, startLine: number, endLine: number) =>
  buildFileReviewContext({
    contextId: id,
    filePath: "src/app.ts",
    startLine,
    endLine,
    text: `Comment ${id}`,
    contents: source,
  });

function pierreMoves(
  annotations: FileCommentLineAnnotation[],
  edit: { start: number; end: number; text: string },
  contents = source,
) {
  const document = new TextDocument<"file", undefined>("src/app.ts", contents);
  const change = document.applyResolvedEdits(
    [edit],
    true,
    undefined,
    undefined,
    true,
  );
  assert.ok(change);
  return {
    moved:
      applyDocumentChangeToLineAnnotations(change, annotations) ?? annotations,
    contents: document.getText(),
  };
}

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    assert.deepEqual(normalizeFileCommentRange({ start: 16, end: 7 }), {
      startLine: 7,
      endLine: 16,
    });
    assert.equal(formatFileCommentRange(7, 7), "L7");
    assert.equal(formatFileCommentRange(7, 16), "L7 to L16");
  });

  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    assert.deepEqual(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
      [
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 11,
                endLine: 20,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ],
    );
  });

  it("mints distinct ids the composer accepts", () => {
    const first = nextFileCommentId();
    assert.notEqual(first, nextFileCommentId());
    assert.match(first, /^[a-z0-9_-]+$/i);
  });

  it("groups comments by end line in record order with the draft last in its group", () => {
    const a = fileComment("a", 2, 4);
    const b = fileComment("b", 1, 1);
    const c = fileComment("c", 4, 4);
    assert.deepEqual(
      fileCommentAnnotations([a, b, c], { id: "d", startLine: 3, endLine: 4 }),
      [
        {
          lineNumber: 4,
          metadata: {
            entries: [
              {
                id: "a",
                kind: "comment",
                startLine: 2,
                endLine: 4,
                text: "Comment a",
              },
              {
                id: "c",
                kind: "comment",
                startLine: 4,
                endLine: 4,
                text: "Comment c",
              },
              { id: "d", kind: "draft", startLine: 3, endLine: 4, text: "" },
            ],
          },
        },
        {
          lineNumber: 1,
          metadata: {
            entries: [
              {
                id: "b",
                kind: "comment",
                startLine: 1,
                endLine: 1,
                text: "Comment b",
              },
            ],
          },
        },
      ],
    );
    assert.deepEqual(
      fileCommentAnnotations([], { id: "d", startLine: 6, endLine: 6 }),
      [
        {
          lineNumber: 6,
          metadata: {
            entries: [
              { id: "d", kind: "draft", startLine: 6, endLine: 6, text: "" },
            ],
          },
        },
      ],
    );
  });
});

describe("savedFileComments", () => {
  it("shows only this path's file comments that the composer still references", () => {
    const kept = fileComment("kept", 1, 1);
    const unreferenced = fileComment("dropped", 2, 2);
    const otherFile = buildFileReviewContext({
      contextId: "other",
      filePath: "src/other.ts",
      startLine: 1,
      endLine: 1,
      text: "Elsewhere",
      contents: source,
    });
    const diffComment: ComposerContextRecord = {
      ...fileComment("diff", 1, 1),
      sectionId: "working:unstaged",
    };
    const records = [kept, unreferenced, otherFile, diffComment];
    const text = [kept, otherFile, diffComment]
      .map((r) => `[${r.label}](t3-context://v1/review-comment/${r.contextId})`)
      .join(" ");
    assert.deepEqual(
      savedFileComments(referencedRecords({ text, records }), "src/app.ts"),
      [kept],
    );
    assert.deepEqual(savedFileComments(records, "src/app.t"), []);
  });
});

describe("applyMovedAnnotations", () => {
  it("rebuilds a comment that lines inserted above moved, with its new lines and excerpt", () => {
    const saved = [fileComment("a", 3, 4), fileComment("b", 1, 1)];
    const { moved, contents } = pierreMoves(
      fileCommentAnnotations(saved, null),
      {
        start: "one\n".length,
        end: "one\n".length,
        text: "new\nlines\n",
      },
    );
    assert.deepEqual(applyMovedAnnotations(saved, moved, contents), [
      {
        ...fileComment("a", 5, 6),
        diff: "three\nfour",
      },
    ]);
  });

  it("returns nothing for an edit that moves no line", () => {
    const saved = [fileComment("a", 3, 4)];
    const { moved, contents } = pierreMoves(
      fileCommentAnnotations(saved, null),
      {
        start: 0,
        end: 3,
        text: "ONE",
      },
    );
    assert.deepEqual(applyMovedAnnotations(saved, moved, contents), []);
  });

  it("leaves a comment whose anchor line was deleted as saved", () => {
    const saved = [fileComment("a", 3, 4)];
    const start = "one\ntwo\nthree\n".length;
    const { moved, contents } = pierreMoves(
      fileCommentAnnotations(saved, null),
      {
        start,
        end: start + "four\n".length,
        text: "",
      },
    );
    assert.deepEqual(moved, []);
    assert.deepEqual(applyMovedAnnotations(saved, moved, contents), []);
  });

  it("ignores annotations of comments the composer no longer holds, so undo cannot resurrect them", () => {
    const sent = fileComment("sent", 2, 2);
    const restored = remapFileCommentAnnotations(
      fileCommentAnnotations([sent], null),
    ).map((annotation) => ({ ...annotation, lineNumber: 4 }));
    assert.deepEqual(applyMovedAnnotations([], restored, source), []);
  });

  it("ignores the open draft", () => {
    const { moved, contents } = pierreMoves(
      fileCommentAnnotations([], { id: "d", startLine: 2, endLine: 2 }),
      { start: 0, end: 0, text: "x\n" },
    );
    assert.deepEqual(applyMovedAnnotations([], moved, contents), []);
  });
});

describe("movedFileCommentDraft", () => {
  const draft = { id: "d", startLine: 2, endLine: 3 };

  it("follows its anchor and keeps its span", () => {
    const { moved } = pierreMoves(fileCommentAnnotations([], draft), {
      start: 0,
      end: 0,
      text: "x\n",
    });
    assert.deepEqual(movedFileCommentDraft(draft, moved), {
      id: "d",
      startLine: 3,
      endLine: 4,
    });
  });

  it("returns the same draft when nothing moved and closes it when its anchor line is gone", () => {
    const annotations = fileCommentAnnotations([], draft);
    assert.equal(movedFileCommentDraft(draft, annotations), draft);
    const start = "one\ntwo\n".length;
    const { moved } = pierreMoves(annotations, {
      start,
      end: start + "three\n".length,
      text: "",
    });
    assert.equal(movedFileCommentDraft(draft, moved), null);
    assert.equal(movedFileCommentDraft(null, annotations), null);
  });
});
