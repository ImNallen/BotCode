// Ported from T3 Code v0.0.45 apps/web/src/components/diffs/commentSubmitShortcut.test.ts (MIT).
import assert from "node:assert/strict";
import { it } from "node:test";
import { isCommentSubmitShortcut } from "./commentSubmitShortcut";

it("accepts Command or Ctrl+Enter only while an eligible comment is idle", () => {
  assert.equal(
    isCommentSubmitShortcut(
      { key: "Enter", metaKey: true, ctrlKey: false },
      "Looks good",
      false,
    ),
    true,
  );
  assert.equal(
    isCommentSubmitShortcut(
      { key: "Enter", metaKey: false, ctrlKey: true },
      "Looks good",
      false,
    ),
    true,
  );
  assert.equal(
    isCommentSubmitShortcut(
      { key: "Enter", metaKey: true, ctrlKey: false },
      "Looks good",
      true,
    ),
    false,
  );
});

it("rejects empty comments and unrelated key presses", () => {
  assert.equal(
    isCommentSubmitShortcut(
      { key: "Enter", metaKey: true, ctrlKey: false },
      "   ",
      false,
    ),
    false,
  );
  assert.equal(
    isCommentSubmitShortcut(
      { key: "K", metaKey: true, ctrlKey: false },
      "Looks good",
      false,
    ),
    false,
  );
  assert.equal(
    isCommentSubmitShortcut(
      { key: "Enter", metaKey: false, ctrlKey: false },
      "Looks good",
      false,
    ),
    false,
  );
});
