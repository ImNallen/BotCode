import assert from "node:assert/strict";
import { it } from "node:test";
import {
  editorId,
  openInEditorMenuLabel,
  resolvePreferredEditor,
} from "./editors";

it("keeps the stored editor only while it is installed, else the first installed in T3 order", () => {
  assert.equal(
    resolvePreferredEditor("zed", ["cursor", "zed", "file-manager"]),
    "zed",
  );
  assert.equal(
    resolvePreferredEditor("zed", ["file-manager", "webstorm", "vscode"]),
    "vscode",
  );
  assert.equal(
    resolvePreferredEditor(null, ["file-manager", "idea", "antigravity"]),
    "antigravity",
  );
  assert.equal(resolvePreferredEditor(null, ["file-manager"]), "file-manager");
  assert.equal(resolvePreferredEditor("cursor", []), null);
});

it("parses T3 editor ids and labels the chat link menu", () => {
  assert.equal(editorId.safeParse("vscode-insiders").success, true);
  assert.equal(editorId.safeParse("sublime").success, false);
  assert.equal(openInEditorMenuLabel("vscode"), "Open in VS Code");
  assert.equal(openInEditorMenuLabel("file-manager"), "Open in editor");
  assert.equal(openInEditorMenuLabel(null), "Open in editor");
});
