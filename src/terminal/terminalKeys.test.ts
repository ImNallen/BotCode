import assert from "node:assert/strict";
import { it } from "node:test";
import {
  isMacCommandChord,
  isMacOptionText,
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

it("lets macOS Option-composed text reach the textarea", () => {
  assert.equal(
    isMacOptionText(key("$", { altKey: true }, "Digit4"), MAC),
    true,
  );
  assert.equal(
    isMacOptionText(key("@", { altKey: true }, "Digit2"), MAC),
    true,
  );
  assert.equal(
    isMacOptionText(key("Dead", { altKey: true }, "BracketRight"), MAC),
    true,
  );
  assert.equal(
    isMacOptionText(key("ArrowLeft", { altKey: true }, "ArrowLeft"), MAC),
    false,
  );
  assert.equal(
    isMacOptionText(key("Backspace", { altKey: true }, "Backspace"), MAC),
    false,
  );
  assert.equal(isMacOptionText(key("4", {}, "Digit4"), MAC), false);
  assert.equal(
    isMacOptionText(key("4", { altKey: true, metaKey: true }, "Digit4"), MAC),
    false,
  );
  assert.equal(
    isMacOptionText(key("4", { altKey: true }, "Digit4"), LINUX),
    false,
  );
});

it("treats macOS Command chords as app shortcuts", () => {
  assert.equal(isMacCommandChord(key("r", { metaKey: true }), MAC), true);
  assert.equal(
    isMacCommandChord(key("r", { metaKey: true, shiftKey: true }), MAC),
    true,
  );
  assert.equal(
    isMacCommandChord(key("r", { metaKey: true, ctrlKey: true }), MAC),
    false,
  );
  assert.equal(isMacCommandChord(key("r"), MAC), false);
  assert.equal(isMacCommandChord(key("r", { metaKey: true }), LINUX), false);
});
