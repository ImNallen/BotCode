import assert from "node:assert/strict";
import { it } from "node:test";
import { FolderClosedIcon } from "lucide-react";
import { FileExplorerIcon, FinderIcon } from "../ui/editorIcons";
import {
  editorById,
  editorId,
  editorLabelForPlatform,
  installedEditors,
  openInEditorMenuLabel,
  resolvePreferredEditor,
  revealInFileExplorerLabel,
} from "./editors";
import { getLocalFileManagerName, isWindowsPlatform } from "./utils";

const platforms = [
  ["MacIntel", "Finder", FinderIcon, "brand", "Reveal in Finder"],
  [
    "Win32",
    "File Explorer",
    FileExplorerIcon,
    "brand",
    "Reveal in File Explorer",
  ],
  ["Linux x86_64", "Files", FolderClosedIcon, "generic", "Reveal in Files"],
] as const;

for (const [platform, name, Icon, kind, reveal] of platforms) {
  it(`names the ${platform} file manager ${name}`, () => {
    assert.equal(getLocalFileManagerName(platform), name);
    assert.equal(editorLabelForPlatform("file-manager", platform), name);
    assert.equal(editorLabelForPlatform("zed", platform), "Zed");
    assert.equal(revealInFileExplorerLabel(platform), reveal);
  });

  it(`lists the ${platform} file manager with its icon`, () => {
    assert.deepEqual(
      installedEditors(["cursor", "vscode", "file-manager"], platform).map(
        (editor) => [editor.id, editor.label, editor.Icon, editor.kind],
      ),
      [
        ["cursor", "Cursor", editorById("cursor").Icon, "brand"],
        ["vscode", "VS Code", editorById("vscode").Icon, "brand"],
        ["file-manager", name, Icon, kind],
      ],
    );
    assert.deepEqual(
      installedEditors(["vscode"], platform).map((e) => e.id),
      ["vscode"],
    );
  });
}

it("recognizes Windows platform strings only", () => {
  assert.equal(isWindowsPlatform("Win32"), true);
  assert.equal(isWindowsPlatform("Windows"), true);
  assert.equal(isWindowsPlatform("darwin"), false);
  assert.equal(isWindowsPlatform("MacIntel"), false);
});

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
