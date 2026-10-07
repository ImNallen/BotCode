// Ported from T3 Code v0.0.45 apps/web/src/lib/terminalContext.ts selection behavior (MIT).
import assert from "node:assert/strict";
import { it } from "node:test";
import { composerContextRecord } from "../chat/composerContext";
import { buildTerminalContext } from "./terminalContext";

const selection = {
  contextId: "terminal-context",
  terminalId: "term-2",
  terminalLabel: "Terminal 2",
  position: { start: { x: 3, y: 41 }, end: { x: 0, y: 44 } },
};

it("captures screen line coordinates and preserves spaces within terminal output", () => {
  const context = buildTerminalContext({
    ...selection,
    text: "\r\n  cargo test\r\npassed  \r\n",
  });
  assert.deepEqual(context, {
    version: 1,
    kind: "terminal",
    contextId: "terminal-context",
    label: "Terminal 2 lines 42-45",
    terminalId: "term-2",
    terminalLabel: "Terminal 2",
    lineStart: 42,
    lineEnd: 45,
    text: "  cargo test\npassed  ",
  });
  assert.deepEqual(composerContextRecord.parse(context), context);
});

it("copies the selected payload before later terminal output can move the selection", () => {
  const position = { start: { x: 0, y: 0 }, end: { x: 2, y: 0 } };
  const context = buildTerminalContext({ ...selection, position, text: "OK" });
  position.start.y = 99;
  position.end.y = 103;
  assert.equal(context?.lineStart, 1);
  assert.equal(context?.lineEnd, 1);
  assert.equal(context?.label, "Terminal 2 line 1");
});

it("rejects an empty excerpt and bounds retained output to the context contract", () => {
  assert.equal(buildTerminalContext({ ...selection, text: "\r\n\n" }), null);
  const context = buildTerminalContext({
    ...selection,
    text: "x".repeat(64_001),
  });
  assert.equal(context?.text.length, 64_000);
  assert.deepEqual(composerContextRecord.parse(context), context);
});

it("does not split an emoji at the terminal excerpt limit", () => {
  const context = buildTerminalContext({
    ...selection,
    text: "x".repeat(63_999) + "😀",
  });
  assert.equal(context?.text, "x".repeat(63_999));
});
