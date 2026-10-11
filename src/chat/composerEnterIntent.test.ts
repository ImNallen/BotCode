import assert from "node:assert/strict";
import { it } from "node:test";
import { composerEnterIntent } from "./composer-logic";
import type { SendShortcut } from "../settings/preferences";

const table: [
  SendShortcut,
  "single" | "multi",
  "mod" | "none",
  "idle" | "running",
  ReturnType<typeof composerEnterIntent>,
][] = [
  ["enter", "single", "none", "idle", "send"],
  ["enter", "single", "none", "running", "send"],
  ["enter", "single", "mod", "idle", "send"],
  ["enter", "single", "mod", "running", "alternate"],
  ["enter", "multi", "none", "idle", "send"],
  ["enter", "multi", "none", "running", "send"],
  ["enter", "multi", "mod", "idle", "send"],
  ["enter", "multi", "mod", "running", "alternate"],
  ["mod-enter-multiline", "single", "none", "idle", "send"],
  ["mod-enter-multiline", "single", "none", "running", "send"],
  ["mod-enter-multiline", "single", "mod", "idle", "send"],
  ["mod-enter-multiline", "single", "mod", "running", "alternate"],
  ["mod-enter-multiline", "multi", "none", "idle", "newline"],
  ["mod-enter-multiline", "multi", "none", "running", "newline"],
  ["mod-enter-multiline", "multi", "mod", "idle", "send"],
  ["mod-enter-multiline", "multi", "mod", "running", "send"],
  ["mod-enter", "single", "none", "idle", "newline"],
  ["mod-enter", "single", "none", "running", "newline"],
  ["mod-enter", "single", "mod", "idle", "send"],
  ["mod-enter", "single", "mod", "running", "send"],
  ["mod-enter", "multi", "none", "idle", "newline"],
  ["mod-enter", "multi", "none", "running", "newline"],
  ["mod-enter", "multi", "mod", "idle", "send"],
  ["mod-enter", "multi", "mod", "running", "send"],
];

it("Enter resolves to T3's intent for every shortcut, prompt shape, modifier and run state", () => {
  for (const [sendShortcut, lines, modifier, state, expected] of table)
    assert.equal(
      composerEnterIntent({
        sendShortcut,
        prompt: lines === "multi" ? "first\nsecond" : "first",
        modifierKey: modifier === "mod",
        shiftKey: false,
        running: state === "running",
      }),
      expected,
      `${sendShortcut} ${lines} ${modifier} ${state}`,
    );
});

it("Shift inserts a new line unless it is the modifier mode's opposite-action chord while running", () => {
  const shifted = (
    sendShortcut: SendShortcut,
    prompt: string,
    modifierKey: boolean,
    running: boolean,
  ) =>
    composerEnterIntent({
      sendShortcut,
      prompt,
      modifierKey,
      shiftKey: true,
      running,
    });
  assert.equal(shifted("enter", "a", false, false), "newline");
  assert.equal(shifted("enter", "a", true, true), "newline");
  assert.equal(shifted("mod-enter", "a", true, false), "newline");
  assert.equal(shifted("mod-enter", "a", true, true), "alternate");
  assert.equal(shifted("mod-enter-multiline", "a\nb", true, true), "alternate");
  assert.equal(shifted("mod-enter-multiline", "a", true, true), "newline");
});
