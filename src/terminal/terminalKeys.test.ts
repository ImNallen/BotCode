import assert from "node:assert/strict";
import { it } from "node:test";
import {
  isTerminalClearShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
  terminalShortcutCommand,
} from "./terminalKeys.ts";

const MAC = "MacIntel";
const LINUX = "Linux x86_64";

function key(
  value: string,
  modifiers: Partial<
    Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>
  > = {},
  code = `Key${value.toUpperCase()}`,
) {
  return {
    key: value,
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

it("matches T3's terminal bindings with Command on macOS", () => {
  assert.equal(
    terminalShortcutCommand(key("j", { metaKey: true }), MAC),
    "terminal.toggle",
  );
  assert.equal(
    terminalShortcutCommand(key("d", { metaKey: true }), MAC),
    "terminal.split",
  );
  assert.equal(
    terminalShortcutCommand(key("D", { metaKey: true, shiftKey: true }), MAC),
    "terminal.splitVertical",
  );
  assert.equal(
    terminalShortcutCommand(key("n", { metaKey: true }), MAC),
    "terminal.new",
  );
  assert.equal(
    terminalShortcutCommand(key("w", { metaKey: true }), MAC),
    "terminal.close",
  );
});

it("leaves Control chords to the shell on macOS", () => {
  assert.equal(terminalShortcutCommand(key("d", { ctrlKey: true }), MAC), null);
  assert.equal(terminalShortcutCommand(key("j", { ctrlKey: true }), MAC), null);
  assert.equal(
    terminalShortcutCommand(key("j", { metaKey: true, altKey: true }), MAC),
    null,
  );
  assert.equal(
    terminalShortcutCommand(key("w", { metaKey: true, shiftKey: true }), MAC),
    null,
  );
});

it("uses Control as mod elsewhere and matches the physical key", () => {
  assert.equal(
    terminalShortcutCommand(key("j", { ctrlKey: true }), LINUX),
    "terminal.toggle",
  );
  assert.equal(
    terminalShortcutCommand(key("j", { metaKey: true }), LINUX),
    null,
  );
  assert.equal(
    terminalShortcutCommand(key("о", { metaKey: true }, "KeyJ"), MAC),
    "terminal.toggle",
  );
});

it("translates T3's in-terminal editing keys", () => {
  assert.equal(isTerminalClearShortcut(key("l", { ctrlKey: true }), MAC), true);
  assert.equal(isTerminalClearShortcut(key("k", { metaKey: true }), MAC), true);
  assert.equal(
    isTerminalClearShortcut(key("k", { metaKey: true }), LINUX),
    false,
  );
  assert.equal(
    terminalNavigationShortcutData(
      key("ArrowLeft", { altKey: true }, "ArrowLeft"),
      MAC,
    ),
    "\u001bb",
  );
  assert.equal(
    terminalNavigationShortcutData(
      key("ArrowRight", { metaKey: true }, "ArrowRight"),
      MAC,
    ),
    "\u0005",
  );
  assert.equal(
    terminalNavigationShortcutData(
      key("ArrowRight", { ctrlKey: true }, "ArrowRight"),
      LINUX,
    ),
    "\u001bf",
  );
  assert.equal(
    terminalDeleteShortcutData(
      key("Backspace", { metaKey: true }, "Backspace"),
      MAC,
    ),
    "\u0015",
  );
  assert.equal(
    terminalDeleteShortcutData(
      key("Backspace", { metaKey: true }, "Backspace"),
      LINUX,
    ),
    null,
  );
});
