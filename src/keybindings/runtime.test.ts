import assert from "node:assert/strict";
import { it } from "node:test";
import {
  commandShortcutLabel,
  registerScriptCommands,
  resolveCommand,
} from "../lib/actions";
import { keybindings } from "./store";
import { terminalShortcutCommand } from "../terminal/terminalKeys";

const event = {
  key: "b",
  code: "KeyB",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};
async function withFile(text: string, test: () => void) {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const previous = keybindings.getSnapshot().text;
  let file: string | null = text;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => file,
      setItem: (_key: string, value: string) => {
        file = value;
      },
    },
  });
  try {
    await keybindings.reload();
    test();
  } finally {
    file = previous;
    await keybindings.reload();
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}
it("keeps default input working with a full copied file of unavailable T3 rules", async () => {
  await withFile(
    JSON.stringify(
      Array.from({ length: 256 }, () => ({
        key: "mod+b",
        command: "preview.toggle",
      })),
    ),
    () => {
      assert.equal(keybindings.getSnapshot().issues.length, 0);
      assert.equal(resolveCommand(event, "MacIntel"), "sidebar.toggle");
      assert.equal(commandShortcutLabel("sidebar.toggle", "MacIntel"), "⌘B");
    },
  );
});
it("excludes palette-selection-only actions and absent script IDs before conflicts resolve", async () => {
  await withFile(
    JSON.stringify([
      { key: "mod+b", command: "archive.restore" },
      { key: "mod+b", command: "script.verify.run" },
    ]),
    () => {
      assert.equal(resolveCommand(event, "MacIntel"), "sidebar.toggle");
      const previous = keybindings.getSnapshot();
      const unregister = registerScriptCommands(new Set(["script.verify.run"]));
      try {
        assert.ok(keybindings.getSnapshot() !== previous);
        assert.equal(resolveCommand(event, "MacIntel"), "script.verify.run");
        assert.equal(
          commandShortcutLabel("sidebar.toggle", "MacIntel"),
          undefined,
        );
      } finally {
        unregister();
      }
      assert.equal(resolveCommand(event, "MacIntel"), "sidebar.toggle");
      assert.equal(commandShortcutLabel("sidebar.toggle", "MacIntel"), "⌘B");
    },
  );
});
it("resolves terminal toggle conditions using the actual focus supplied by its owner", async () => {
  await withFile(
    '[{"key":"mod+b","command":"terminal.toggle","when":"!terminalFocus"}]',
    () => {
      assert.equal(
        terminalShortcutCommand(event, "MacIntel", false),
        "terminal.toggle",
      );
      assert.equal(terminalShortcutCommand(event, "MacIntel", true), null);
    },
  );
});
