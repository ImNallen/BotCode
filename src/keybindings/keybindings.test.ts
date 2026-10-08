import assert from "node:assert/strict";
import { it } from "node:test";
import { IpcError } from "../ipc";
import { editKeybindings, parseKeybindings } from "./config";
import { createKeybindings } from "./store";
import {
  DEFAULT_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
  type KeybindingRule,
} from "./rules";
import {
  keybindingFromKeyboardEvent,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "./keyboard";
import { legacyScriptRules } from "./legacyScripts";

const commands = new Set(["settings.open"]);
const defaults: readonly KeybindingRule[] = DEFAULT_KEYBINDINGS;
function memoryFile(initial: string | null = null) {
  let text = initial;
  return {
    read: async () => ({ path: "/isolated/keybindings.json", text }),
    write: async (next: string, expected: string | null) => {
      if (expected !== text)
        throw new IpcError("keybindings_changed", "File changed");
      text = next;
    },
    replace: (next: string) => {
      text = next;
    },
    text: () => text,
  };
}
function event(key: string, extra: Partial<KeyboardEvent> = {}) {
  return {
    key,
    code: "",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  };
}
function winner(
  key: string,
  bindings: ReturnType<typeof createKeybindings>["getSnapshot"],
  terminalFocus = false,
) {
  return resolveShortcutCommand(event(key), bindings().bindings, {
    platform: "MacIntel",
    context: { terminalFocus },
  });
}

it("accepts copied T3 JSONC and replaces every default for the customized command", async () => {
  const file = memoryFile(`[
    // copied directly from T3
    {"key":"mod+g","command":"chat.new","when":"!terminalFocus"},
    {"key":"mod+alt+b","command":"sidebar.toggle"},
  ]`);
  const owner = createKeybindings(file, defaults, commands);
  await owner.reload();
  assert.deepEqual(owner.getSnapshot().issues, []);
  assert.equal(winner("g", owner.getSnapshot), "chat.new");
  assert.equal(winner("n", owner.getSnapshot), null);
  assert.equal(winner("n", owner.getSnapshot, true), "terminal.new");
});
it("ignores malformed entries individually and keeps their command defaults", async () => {
  const file = memoryFile(
    JSON.stringify([
      {
        key: "mod+alt+b",
        command: "sidebar.toggle",
        when: "terminalFocus && (",
      },
      { key: "mod+g", command: "chat.new", when: "!terminalFocus" },
      { key: 3, command: "thread.pin" },
    ]),
  );
  const owner = createKeybindings(file, defaults, commands);
  await owner.reload();
  assert.equal(owner.getSnapshot().issues.length, 2);
  assert.equal(winner("b", owner.getSnapshot), "sidebar.toggle");
  assert.equal(winner("g", owner.getSnapshot), "chat.new");
});
it("keeps a malformed whole document unchanged when settings tries to save", async () => {
  const file = memoryFile("[ malformed");
  const owner = createKeybindings(file, defaults, commands);
  await owner.reload();
  assert.equal(winner("b", owner.getSnapshot), "sidebar.toggle");
  await assert.rejects(
    owner.upsert({ key: "mod+g", command: "sidebar.toggle" }),
    /left unchanged/,
  );
  assert.equal(file.text(), "[ malformed");
  assert.ok(/malformed/.test(owner.getSnapshot().error ?? ""));
});
it("preserves unrelated raw entries and alternate conditions on exact row edits", () => {
  const first = {
    key: "mod+g",
    command: "sidebar.toggle",
    when: "!terminalFocus",
  };
  const alternate = {
    key: "mod+h",
    command: "sidebar.toggle",
    when: "terminalFocus",
  };
  const unsupported = {
    key: "mod+l",
    command: "preview.focusUrl",
    when: "previewFocus",
  };
  const invalid = { key: 5, command: "thread.pin", note: "keep my entry" };
  const document = parseKeybindings(
    JSON.stringify([first, alternate, unsupported, invalid]),
    commands,
  );
  const next = {
    key: "mod+alt+g",
    command: "sidebar.toggle",
    when: "!terminalFocus",
  };
  const updated = editKeybindings(
    document,
    { kind: "upsert", rule: next, replace: first },
    commands,
  );
  assert.deepEqual(JSON.parse(updated), [
    alternate,
    unsupported,
    invalid,
    next,
  ]);
});
it("rebases a save onto a concurrent external edit instead of overwriting it", async () => {
  const file = memoryFile("[]");
  let race = true;
  const owner = createKeybindings(
    {
      ...file,
      write: async (text, expected) => {
        if (race) {
          race = false;
          file.replace('[{"key":"mod+g","command":"chat.new"}]');
        }
        await file.write(text, expected);
      },
    },
    defaults,
    commands,
  );
  await owner.upsert({ key: "mod+h", command: "sidebar.toggle" });
  assert.equal(winner("g", owner.getSnapshot), "chat.new");
  assert.equal(winner("h", owner.getSnapshot), "sidebar.toggle");
});
it("serializes settings edits and publishes only acknowledged saves across restart", async () => {
  const file = memoryFile();
  const owner = createKeybindings(file, defaults, commands);
  await Promise.all([
    owner.upsert({ key: "mod+g", command: "sidebar.toggle" }),
    owner.upsert({ key: "mod+h", command: "chat.new" }),
  ]);
  const restarted = createKeybindings(file, defaults, commands);
  await restarted.reload();
  assert.equal(winner("g", restarted.getSnapshot), "sidebar.toggle");
  assert.equal(winner("h", restarted.getSnapshot), "chat.new");
  const refused = createKeybindings(
    {
      ...file,
      write: async () => {
        throw new Error("Disk full");
      },
    },
    defaults,
    commands,
  );
  await refused.reload();
  await assert.rejects(
    refused.upsert({ key: "mod+l", command: "sidebar.toggle" }),
    /Disk full/,
  );
  assert.equal(winner("g", refused.getSnapshot), "sidebar.toggle");
  assert.equal(winner("l", refused.getSnapshot), null);
});
it("resolves the last matching rule with T3 condition precedence and unknown variables", () => {
  const bindings = compileResolvedKeybindingsConfig([
    { key: "mod+g", command: "sidebar.toggle" },
    {
      key: "mod+g",
      command: "chat.new",
      when: "!terminalFocus && (isDesktop || isWeb)",
    },
    { key: "mod+g", command: "preview.toggle", when: "unknownVariable" },
  ]);
  assert.equal(
    resolveShortcutCommand(event("g"), bindings, { platform: "MacIntel" }),
    "chat.new",
  );
  assert.equal(
    resolveShortcutCommand(event("g"), bindings, {
      platform: "MacIntel",
      context: { terminalFocus: true },
    }),
    "sidebar.toggle",
  );
  assert.equal(
    shortcutLabelForCommand(bindings, "sidebar.toggle", "MacIntel"),
    null,
  );
});
it("retains JSON string literals when removing comments and trailing commas", () => {
  const parsed = parseKeybindings(
    '[{"key":"mod+g","command":"settings.open","note":"https://example.test/*literal*/,]"},]',
    commands,
  );
  assert.equal(parsed.rules.length, 1);
  assert.deepEqual(parsed.issues, []);
});
it("matches layout keys, physical fallback, plus keys and AltGraph as T3 does", () => {
  const bindings = compileResolvedKeybindingsConfig([
    { key: "mod+g", command: "sidebar.toggle" },
    { key: "mod++", command: "preview.zoomIn" },
    { key: "ctrl+alt+q", command: "chat.new" },
  ]);
  const mac = { platform: "MacIntel" };
  assert.equal(
    resolveShortcutCommand(event("g", { code: "KeyH" }), bindings, mac),
    "sidebar.toggle",
  );
  assert.equal(
    resolveShortcutCommand(event("ж", { code: "KeyG" }), bindings, mac),
    "sidebar.toggle",
  );
  assert.equal(
    resolveShortcutCommand(event("h", { code: "KeyG" }), bindings, mac),
    null,
  );
  assert.equal(
    resolveShortcutCommand(event("+"), bindings, mac),
    "preview.zoomIn",
  );
  assert.equal(
    resolveShortcutCommand(
      {
        ...event("@", {
          code: "KeyQ",
          metaKey: false,
          ctrlKey: true,
          altKey: true,
        }),
        getModifierState: () => true,
      },
      bindings,
      { platform: "Linux" },
    ),
    null,
  );
});
it("converts recorded and legacy script keys to T3 rules", () => {
  assert.equal(
    keybindingFromKeyboardEvent(
      event("G", { code: "KeyG", shiftKey: true }),
      "MacIntel",
    ),
    "mod+shift+g",
  );
  assert.deepEqual(
    legacyScriptRules(
      '{"script.dev.run":{"key":"r","meta":true,"ctrl":false,"alt":true,"shift":false}}',
      "MacIntel",
    ),
    [{ key: "mod+alt+r", command: "script.dev.run", when: "!terminalFocus" }],
  );
});
