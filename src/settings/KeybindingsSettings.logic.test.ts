import assert from "node:assert/strict";
import { it } from "node:test";
import {
  buildKeybindingRows,
  buildWhenVariableOptions,
  filterKeybindingRows,
  keybindingConflictLabels,
  validateWhenDraft,
} from "./KeybindingsSettings.logic";

const commands = [
  { command: "sidebar.toggle", label: "Toggle sidebar" },
  { command: "chat.new", label: "New thread" },
  { command: "terminal.toggle", label: "Toggle terminal" },
];

it("keeps unrelated row identities stable when another rule is edited or removed", () => {
  const sidebar = { command: "sidebar.toggle", key: "mod+b" };
  const chat = { command: "chat.new", key: "mod+n" };
  const initial = buildKeybindingRows([sidebar, chat, chat], [], commands);
  const changed = buildKeybindingRows(
    [chat, chat, { ...sidebar, key: "mod+h" }],
    [],
    commands,
  );
  const removed = buildKeybindingRows([chat, chat], [], commands);
  const chatIds = (rows: typeof initial) =>
    rows.filter((row) => row.rule.command === "chat.new").map((row) => row.id);
  assert.deepEqual(chatIds(changed), chatIds(initial));
  assert.deepEqual(chatIds(removed), chatIds(initial));
  assert.equal(new Set(chatIds(initial)).size, 2);
});

it("settings rows preserve exact rules and hide unsupported commands", () => {
  const defaultRule = { command: "sidebar.toggle", key: "mod+b" };
  const custom = {
    command: "sidebar.toggle",
    key: "cmd+SHIFT+B",
    when: "!terminalFocus",
  };
  const script = { command: "script.dev-server.run", key: "mod+r" };
  const rows = buildKeybindingRows(
    [custom, script, { command: "themeEditor.toggle", key: "mod+t" }],
    [defaultRule],
    commands,
  );
  assert.equal(rows.length, 2);
  const customRow = rows.find((row) => row.rule.command === "sidebar.toggle");
  assert.ok(customRow);
  assert.equal(customRow.rule, custom);
  assert.equal(customRow.defaultRule, defaultRule);
  assert.equal(customRow.source, "Custom");
  const scriptRow = rows.find((row) => row.rule.command === script.command);
  assert.ok(scriptRow);
  assert.equal(scriptRow.rule, script);
  assert.equal(scriptRow.label, "Run Script: Dev Server");
  assert.equal(scriptRow.source, "Project");
  assert.equal(scriptRow.defaultRule, null);
});

it("default aliases and equivalent condition syntax retain Default source", () => {
  const rows = buildKeybindingRows(
    [{ command: "sidebar.toggle", key: "mod+b", when: "!terminalFocus" }],
    [{ command: "sidebar.toggle", key: "meta+b", when: "!(terminalFocus)" }],
    commands,
  );
  assert.equal(rows[0]?.source, "Custom");
  const aliasRows = buildKeybindingRows(
    [{ command: "sidebar.toggle", key: "cmd+b", when: "!terminalFocus" }],
    [{ command: "sidebar.toggle", key: "meta+b", when: "!(terminalFocus)" }],
    commands,
  );
  assert.equal(aliasRows[0]?.source, "Default");
});

it("conflicts compare platform modifiers and all rows before search filtering", () => {
  const rows = buildKeybindingRows(
    [
      { command: "sidebar.toggle", key: "mod+b", when: "!terminalFocus" },
      { command: "chat.new", key: "meta+b", when: " !terminalFocus " },
      { command: "terminal.toggle", key: "mod+b", when: "terminalFocus" },
    ],
    [],
    commands,
  );
  const sidebar = rows.find((row) => row.rule.command === "sidebar.toggle");
  assert.ok(sidebar);
  assert.deepEqual(
    keybindingConflictLabels(
      rows,
      { rowId: sidebar.id, rule: sidebar.rule },
      "MacIntel",
    ),
    ["New thread"],
  );
  assert.deepEqual(
    keybindingConflictLabels(
      rows,
      { rowId: sidebar.id, rule: sidebar.rule },
      "Win32",
    ),
    [],
  );
  assert.equal(filterKeybindingRows(rows, "Toggle sidebar").length, 1);
  assert.deepEqual(
    keybindingConflictLabels(
      rows,
      { rowId: "new", rule: { command: "chat.new", key: "cmd+b" } },
      "MacIntel",
    ),
    ["New thread", "Toggle sidebar", "Toggle terminal"],
  );
});

it("search covers command IDs, shortcuts, conditions and sources", () => {
  const rows = buildKeybindingRows(
    [{ command: "script.check.run", key: "mod+shift+f9", when: "isDesktop" }],
    [],
    commands,
  );
  for (const query of [
    " SCRIPT.CHECK ",
    "F9",
    "isdesktop",
    "project",
    "Run Script",
  ]) {
    assert.equal(filterKeybindingRows(rows, query).length, 1);
  }
  assert.equal(filterKeybindingRows(rows, "terminal").length, 0);
});

it("when editor accepts the runtime syntax and flags unknown variables", () => {
  const variables = buildWhenVariableOptions([
    {
      command: "chat.new",
      key: "mod+n",
      when: "!terminalFocus && !editableFocus",
    },
  ]);
  assert.deepEqual(validateWhenDraft("  ", variables), {
    kind: "valid",
    expression: "",
    unknownVariables: [],
  });
  assert.deepEqual(
    validateWhenDraft(
      " !terminalFocus && (isDesktop || custom.flag) ",
      variables,
    ),
    {
      kind: "valid",
      expression: "!terminalFocus && (isDesktop || custom.flag)",
      unknownVariables: ["custom.flag"],
    },
  );
  for (const expression of [
    "terminalFocus == true",
    "terminalFocus &&",
    "(isDesktop",
    "x".repeat(257),
  ]) {
    assert.equal(validateWhenDraft(expression, variables).kind, "invalid");
  }
  assert.equal(validateWhenDraft("false", variables).kind, "valid");
});
