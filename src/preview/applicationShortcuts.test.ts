import assert from "node:assert/strict";
import { it } from "node:test";
import {
  previewApplicationAction,
  previewApplicationShortcuts,
} from "./applicationShortcuts";
import { compileResolvedKeybindingsConfig } from "../keybindings/rules";
import type { ActionContext } from "../lib/actions";

const noop = () => {};
const context: ActionContext = {
  pageOpen: false,
  thread: undefined,
  workspace: {
    id: "workspace",
    label: "Fixture",
    root: "/tmp/fixture",
    kind: "repository",
  },
  branch: "main",
  scratchAvailable: true,
  terminalAvailable: true,
  projectSearchAvailable: true,
  renamePending: false,
  queued: false,
  archiveTarget: undefined,
  checkoutTarget: null,
  editorLabel: null,
  newThread: noop,
  newThreadDirect: noop,
  startScratch: noop,
  openSettings: noop,
  closePage: noop,
  toggleSidebar: noop,
  openPalette: noop,
  openSubmenu: noop,
  arrange: noop,
  requestSidebar: noop,
  requestChat: noop,
  restoreArchived: noop,
  deleteArchived: noop,
  openInEditor: noop,
  revealInFinder: noop,
};
const event = (key: string, metaKey = true) => ({
  key,
  metaKey,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});

it("routes custom preview bindings through the shared registry and honors conflicts", () => {
  const bindings = compileResolvedKeybindingsConfig([
    { key: "mod+y", command: "commandPalette.toggle", when: "previewFocus" },
    { key: "mod+b", command: "sidebar.toggle" },
    { key: "mod+b", command: "composer.stash" },
    { key: "mod+j", command: "terminal.toggle" },
  ]);
  const registered = previewApplicationShortcuts(bindings, context, "MacIntel");
  assert.deepEqual(
    registered.map((item) => item.key),
    ["y", "j"],
  );
  assert.equal(
    previewApplicationAction(event("y"), bindings, context, "MacIntel"),
    "commandPalette.toggle",
  );
  assert.equal(
    previewApplicationAction(event("k"), bindings, context, "MacIntel"),
    null,
  );
  assert.equal(
    previewApplicationAction(event("b"), bindings, context, "MacIntel"),
    null,
  );
});

it("keeps bare input, composer commands and unavailable actions inside the preview", () => {
  const bindings = compileResolvedKeybindingsConfig([
    { key: "enter", command: "commandPalette.toggle" },
    { key: "1", command: "sidebar.toggle" },
    { key: "mod+enter", command: "composer.mode" },
    { key: "mod+p", command: "filePicker.toggle" },
    { key: "mod+k", command: "commandPalette.toggle", when: "!editableFocus" },
  ]);
  assert.deepEqual(
    previewApplicationShortcuts(
      bindings,
      { ...context, projectSearchAvailable: false },
      "MacIntel",
    ),
    [],
  );
  assert.equal(
    previewApplicationAction(
      event("Enter", false),
      bindings,
      context,
      "MacIntel",
    ),
    null,
  );
});

it("preserves application navigation chords available in the preview", () => {
  const bindings = compileResolvedKeybindingsConfig([
    { key: "mod+k", command: "commandPalette.toggle" },
    { key: "mod+b", command: "sidebar.toggle" },
    { key: "mod+j", command: "terminal.toggle" },
    { key: "mod+,", command: "settings.open" },
    { key: "mod+p", command: "filePicker.toggle" },
    { key: "mod+shift+f", command: "projectSearch.toggle" },
  ]);
  assert.equal(
    previewApplicationShortcuts(bindings, context, "MacIntel").length,
    6,
  );
});

it("routes Option-modified non-Latin text by physical key without selecting the layout letter's action", () => {
  const bindings = compileResolvedKeybindingsConfig([
    { key: "mod+alt+s", command: "sidebar.toggle" },
    { key: "mod+alt+o", command: "settings.open" },
  ]);
  const chord = { ...event("ø"), code: "KeyS", altKey: true };
  assert.equal(
    previewApplicationAction(chord, bindings, context, "MacIntel"),
    "sidebar.toggle",
  );
  assert.equal(
    previewApplicationAction(
      { ...chord, key: "o" },
      bindings,
      context,
      "MacIntel",
    ),
    "settings.open",
  );
});
