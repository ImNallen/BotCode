import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EditStateManager,
  Editor,
  TextDocument,
  type EditorSelection,
} from "@pierre/diffs/edit";
import { claimFileEditState, fileEditStateKey } from "./retainedEditState";

let nextKey = 0;
const uniqueKey = () => `retained-edit-state-test-${nextKey++}`;
const fileEditor = (key: string) => new Editor("file", {}, key);
const caretAt = (line: number, character: number): EditorSelection => ({
  start: { line, character },
  end: { line, character },
  direction: 0,
});

function retain(
  key: string,
  original: string,
  edits: readonly string[],
  document = new TextDocument<"file", undefined>("notes.txt", original),
) {
  const owner = fileEditor(key);
  const session = EditStateManager.activate("file", key, owner);
  session.document = document;
  session.fileInfo = { name: "notes.txt" };
  for (const text of edits)
    document.applyResolvedEdits(
      [{ start: 0, end: document.getText().length, text }],
      true,
      [caretAt(0, 0)],
      undefined,
      true,
    );
  session.editor = { selections: [caretAt(0, document.getText().length)] };
  EditStateManager.releaseFile(key, owner);
  return document;
}

const attach = (key: string, owner: Editor<"file">) =>
  EditStateManager.activate("file", key, owner);

describe("claimFileEditState", () => {
  it("keeps the retained document and its history when the shown contents match", () => {
    const key = uniqueKey();
    retain(key, "draft", ["draft edited"]);
    const owner = fileEditor(key);

    assert.equal(claimFileEditState(owner, key, "draft edited"), "kept");
    const session = attach(key, owner);
    assert.deepEqual(session.editor?.selections, [caretAt(0, 12)]);
    session.document?.undo();
    assert.equal(session.document?.getText(), "draft");
  });

  it("shows contents changed while hidden, and one undo returns the retained text", () => {
    const key = uniqueKey();
    retain(key, "one", ["one two"]);
    const owner = fileEditor(key);

    assert.equal(
      claimFileEditState(owner, key, "written by agent"),
      "replaced",
    );
    const document = attach(key, owner).document;
    assert.equal(document?.getText(), "written by agent");
    document?.undo();
    assert.equal(document?.getText(), "one two");
    document?.undo();
    assert.equal(document?.getText(), "one");
  });

  it("drops retained selections after a replace", () => {
    const key = uniqueKey();
    retain(key, "a long retained line", []);
    const owner = fileEditor(key);

    claimFileEditState(owner, key, "short");
    assert.equal(attach(key, owner).editor?.selections, undefined);
  });

  it("keeps history for CRLF contents equal to the retained document", () => {
    const key = uniqueKey();
    const document = retain(key, "a\r\nb\r\n", ["a\r\nb\r\nc\r\n"]);
    assert.equal(document.getText(), "a\r\nb\r\nc\r\n");
    const owner = fileEditor(key);

    assert.equal(claimFileEditState(owner, key, "a\r\nb\r\nc\r\n"), "kept");
    document.undo();
    assert.equal(document.getText(), "a\r\nb\r\n");
  });

  it("reports busy and leaves an attached editor's document alone", () => {
    const key = uniqueKey();
    const attached = fileEditor(key);
    const session = attach(key, attached);
    session.document = new TextDocument("notes.txt", "on screen");
    session.fileInfo = { name: "notes.txt" };

    assert.equal(claimFileEditState(fileEditor(key), key, "other"), "busy");
    assert.equal(session.document.getText(), "on screen");
    assert.equal(session.document.canUndo, false);
    EditStateManager.releaseFile(key, attached);
  });

  it("converges when StrictMode attaches, releases, and attaches again", () => {
    const key = uniqueKey();
    retain(key, "old", []);
    const first = fileEditor(key);
    claimFileEditState(first, key, "new");
    attach(key, first);
    EditStateManager.releaseFile(key, first);
    const second = fileEditor(key);

    assert.equal(claimFileEditState(second, key, "new"), "kept");
    const document = attach(key, second).document;
    document?.undo();
    assert.equal(document?.getText(), "old");
  });

  it("starts fresh without a retained document and lets the editor attach", () => {
    const key = uniqueKey();
    const owner = fileEditor(key);

    assert.equal(claimFileEditState(owner, key, "anything"), "fresh");
    attach(key, owner);
    assert.equal(claimFileEditState(fileEditor(key), key, "x"), "busy");
  });

  it("discards a session it cannot reconcile and frees the key", () => {
    class BrokenDocument extends TextDocument<"file", undefined> {
      override applyResolvedEdits(): never {
        throw new Error("broken");
      }
    }
    const key = uniqueKey();
    retain(key, "old", [], new BrokenDocument("notes.txt", "old"));

    assert.equal(claimFileEditState(fileEditor(key), key, "new"), "failed");
    assert.equal(claimFileEditState(fileEditor(key), key, "new"), "fresh");
  });
});

describe("fileEditStateKey", () => {
  it("separates checkouts and files, and joins one file in one checkout", () => {
    const thread = { workspaceId: "w", threadId: "t" };
    assert.equal(
      fileEditStateKey(thread, "a.ts"),
      fileEditStateKey({ ...thread }, "a.ts"),
    );
    const keys = new Set([
      fileEditStateKey(thread, "a.ts"),
      fileEditStateKey({ workspaceId: "w" }, "a.ts"),
      fileEditStateKey({ workspaceId: "w", threadId: "u" }, "a.ts"),
      fileEditStateKey({ workspaceId: "v", threadId: "t" }, "a.ts"),
      fileEditStateKey(thread, "b.ts"),
    ]);
    assert.equal(keys.size, 5);
  });
});
