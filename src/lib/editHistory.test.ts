import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

const source = readFileSync(
  new URL("../../src-tauri/src/edit_history.js", import.meta.url),
  "utf8",
);

class FakeElement extends EventTarget {
  shadowRoot: { activeElement: FakeElement | null } | null = null;
}

class FakeKeyboardEvent extends Event {
  readonly key: string | undefined;
  readonly code: string | undefined;
  readonly keyCode: number | undefined;
  readonly metaKey: boolean | undefined;
  readonly shiftKey: boolean | undefined;
  constructor(type: string, init: KeyboardEventInit) {
    super(type, init);
    this.key = init.key;
    this.code = init.code;
    this.keyCode = init.keyCode;
    this.metaKey = init.metaKey;
    this.shiftKey = init.shiftKey;
  }
}

function fakePage(activeElement: FakeElement | null, focused = true) {
  const executed: string[] = [];
  const body = new FakeElement();
  const document = {
    hasFocus: () => focused,
    activeElement,
    body,
    execCommand: (command: string) => {
      executed.push(command);
      return true;
    },
  };
  const run = new Function(
    "document",
    "KeyboardEvent",
    `"use strict"; return (${source});`,
  )(document, FakeKeyboardEvent) as (command: string) => void;
  return { run, body, executed };
}

function record(
  element: FakeElement,
  handle?: (event: FakeKeyboardEvent) => void,
) {
  const received: FakeKeyboardEvent[] = [];
  element.addEventListener("keydown", (event) => {
    received.push(event as FakeKeyboardEvent);
    handle?.(event as FakeKeyboardEvent);
  });
  return received;
}

it("skips the native fallback when a keydown listener handled the command", () => {
  const editor = new FakeElement();
  const { run, executed } = fakePage(editor);
  const received = record(editor, (event) => event.preventDefault());
  run("undo");
  assert.equal(received.length, 1);
  assert.deepEqual(executed, []);
});

it("falls back to execCommand with the same command when nothing handled the keydown", () => {
  const input = new FakeElement();
  const { run, executed } = fakePage(input);
  record(input);
  run("undo");
  run("redo");
  assert.deepEqual(executed, ["undo", "redo"]);
});

it("dispatches to the body when nothing is focused", () => {
  const { run, body, executed } = fakePage(null);
  const received = record(body);
  run("undo");
  assert.equal(received.length, 1);
  assert.deepEqual(executed, ["undo"]);
});

it("targets the deepest focused element through open shadow roots", () => {
  const outerHost = new FakeElement();
  const innerHost = new FakeElement();
  const editor = new FakeElement();
  outerHost.shadowRoot = { activeElement: innerHost };
  innerHost.shadowRoot = { activeElement: editor };
  const { run, executed } = fakePage(outerHost);
  const atHost = record(outerHost);
  const atEditor = record(editor, (event) => event.preventDefault());
  run("undo");
  assert.equal(atEditor.length, 1);
  assert.equal(atHost.length, 0);
  assert.deepEqual(executed, []);
});

it("synthesizes the keydown a real Cmd+Z or Shift+Cmd+Z would carry", () => {
  const editor = new FakeElement();
  const { run } = fakePage(editor);
  const received = record(editor);
  run("undo");
  run("redo");
  const [undo, redo] = received;
  assert.ok(undo && redo);
  assert.deepEqual(
    [undo, redo].map((event) => ({
      key: event.key,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      code: event.code,
      keyCode: event.keyCode,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      composed: event.composed,
    })),
    [
      {
        key: "z",
        shiftKey: false,
        metaKey: true,
        code: "KeyZ",
        keyCode: 90,
        bubbles: true,
        cancelable: true,
        composed: true,
      },
      {
        key: "Z",
        shiftKey: true,
        metaKey: true,
        code: "KeyZ",
        keyCode: 90,
        bubbles: true,
        cancelable: true,
        composed: true,
      },
    ],
  );
});

it("does nothing in a webview whose document is not focused", () => {
  const editor = new FakeElement();
  const { run, body, executed } = fakePage(editor, false);
  const atEditor = record(editor);
  const atBody = record(body);
  run("undo");
  run("redo");
  assert.equal(atEditor.length, 0);
  assert.equal(atBody.length, 0);
  assert.deepEqual(executed, []);
});
