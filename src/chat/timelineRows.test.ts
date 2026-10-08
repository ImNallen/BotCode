import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Approval, Item, Thread } from "../ipc";
import { Timeline } from "./Timeline";
import {
  deriveRows,
  liveWorkEntryLabel,
  workEntryExpandedBody,
  type TimelineRow,
} from "./timelineRows";

const turnId = "018ba719-19f4-4fdb-bd79-aa4a676ea056";

const webSearch: Item = {
  kind: "web_search",
  id: "exec-af1cec6b-7b06-458e-8d44-f38131318601",
  query: "latest Rust release site:blog.rust-lang.org",
  status: "completed",
};

const mcpCall: Item = {
  kind: "mcp_tool_call",
  id: "exec-0e668882-3b63-455d-8185-6ddafa10e7cd",
  server: "node_repl",
  tool: "js",
  title: "Evaluate 6 × 7",
  status: "completed",
  arguments: { code: "nodeRepl.write(6*7)", title: "Evaluate 6 × 7" },
  result: "42",
  error: null,
  durationMs: 56,
};

const answer: Item = {
  kind: "assistant",
  id: "answer",
  text: "Rust 1.98.0, and 42.",
  complete: true,
};

function thread(items: Item[], running = false): Thread {
  return {
    worktreeSetup: null,
    id: "018ba719-19f4-4fdb-bd79-aa4a676ea054",
    workspaceId: "018ba719-19f4-4fdb-bd79-aa4a676ea055",
    title: "Timeline items",
    nativeThreadId: "native",
    revision: 1,
    session: { kind: running ? "running" : "ready" },
    checkout: { kind: "local" },
    settings: {
      model: null,
      effort: null,
      permissionMode: "approval-required",
      interactionMode: "default",
    },
    context: null,
    approvals: [],
    userQuestions: [],
    diagnostic: null,
    pendingRevert: null,
    lastRevert: null,
    turns: [
      {
        id: turnId,
        prompt: "Check the latest Rust release and compute 6 × 7",
        attachments: [],
        tasks: null,
        nativeTurnId: "native-turn",
        delivery: { kind: "accepted" },
        execution: { kind: running ? "running" : "completed" },
        items,
        settings: null,
        startedAtMs: 0,
        completedAtMs: running ? null : 12_000,
        checkpoint: { kind: "pending" },
      },
    ],
  };
}

const kinds = (rows: TimelineRow[]) => rows.map((row) => row.kind);

function only<K extends TimelineRow["kind"]>(rows: TimelineRow[], kind: K) {
  const matches = rows.filter(
    (row): row is Extract<TimelineRow, { kind: K }> => row.kind === kind,
  );
  assert.equal(matches.length, 1, `one ${kind} row`);
  const [row] = matches;
  assert.ok(row);
  return row;
}

it("labels pending approvals by their typed kind in the timeline", () => {
  const cases: Array<[Approval["action"], string]> = [
    [
      { kind: "command", command: "echo reviewed", cwd: "/tmp", reason: "" },
      "echo reviewed",
    ],
    [
      { kind: "file_change", text: "+change", reason: "" },
      "File change approval",
    ],
    [
      { kind: "permission", detail: "Network access", reason: "" },
      "App permission approval",
    ],
    [
      {
        kind: "mcp_elicitation",
        detail: "Allow the app?",
        reason: "",
        appName: "Fixture App",
      },
      "App access approval",
    ],
  ];
  for (const [action, expected] of cases) {
    const pending = thread([], true);
    pending.approvals = [
      { id: "approval", turnId, action, options: [], state: "pending" },
    ];
    const rows = deriveRows(pending, new Set(), new Set());
    assert.equal(only(rows, "live").entry.label, expected);
  }
});

it("folds a settled web search and MCP call behind Worked for and labels the unfolded group as T3", () => {
  const settled = thread([webSearch, mcpCall, answer]);
  const folded = deriveRows(settled, new Set(), new Set());
  assert.deepEqual(kinds(folded), ["user", "fold", "assistant"]);
  assert.equal(only(folded, "fold").label, "Worked for 12s");

  const unfolded = deriveRows(settled, new Set([turnId]), new Set());
  assert.deepEqual(kinds(unfolded), [
    "user",
    "fold",
    "work-group",
    "assistant",
  ]);
  const group = only(unfolded, "work-group");
  assert.equal(group.label, "Searched the web 1 time and used 1 tool");
  assert.equal(group.icon, "hammer");
  assert.deepEqual(
    group.entries.map((entry) => entry.label),
    ["latest Rust release site:blog.rust-lang.org", "Evaluate 6 × 7"],
  );

  const withThought = thread([
    {
      kind: "reasoning",
      id: "thought",
      text: "Search, then evaluate.",
      complete: true,
    },
    webSearch,
    mcpCall,
    answer,
  ]);
  const activity = deriveRows(withThought, new Set([turnId]), new Set());
  assert.deepEqual(kinds(activity), [
    "user",
    "fold",
    "activity-group",
    "assistant",
  ]);
  assert.deepEqual(
    { ...only(activity, "activity-group"), entries: undefined },
    {
      kind: "activity-group",
      id: "activity-group:thought",
      groupId: "activity-group:thought",
      label: "Searched the web 1 time and used 1 tool",
      icon: "wrench",
      failed: false,
      active: false,
      shimmer: false,
      entries: undefined,
      expanded: false,
    },
  );
});

it("titles a single MCP row and expands it to T3's projected MCP call", () => {
  const rows = deriveRows(
    thread([mcpCall, answer]),
    new Set([turnId]),
    new Set(),
  );
  const { entry } = only(rows, "work");
  assert.equal(entry.heading, "Evaluate 6 × 7");
  assert.equal(entry.icon, "wrench");
  assert.equal(
    workEntryExpandedBody(entry, entry.heading),
    `MCP call
{
  "type": "mcpToolCall",
  "id": "exec-0e668882-3b63-455d-8185-6ddafa10e7cd",
  "tool": "js",
  "server": "node_repl",
  "status": "completed",
  "arguments": {
    "code": "nodeRepl.write(6*7)",
    "title": "Evaluate 6 × 7"
  },
  "appContext": null,
  "error": null,
  "durationMs": 56,
  "result": {
    "content": "42"
  }
}`,
  );
});

it("heads a single web search row Web search and expands it to the query", () => {
  const rows = deriveRows(
    thread([webSearch, answer]),
    new Set([turnId]),
    new Set(),
  );
  const { entry } = only(rows, "work");
  assert.equal(entry.heading, "Web search");
  assert.equal(entry.icon, "globe");
  assert.equal(
    workEntryExpandedBody(entry, entry.heading),
    "latest Rust release site:blog.rust-lang.org",
  );
});

it("shows a running turn's incomplete reasoning as the live Thinking activity row", () => {
  const rows = deriveRows(
    thread(
      [{ kind: "reasoning", id: "thought", text: "Planning", complete: false }],
      true,
    ),
    new Set(),
    new Set(),
  );
  assert.deepEqual(kinds(rows), ["user", "working", "activity-group"]);
  const group = only(rows, "activity-group");
  assert.equal(group.label, "Thinking");
  assert.equal(group.icon, "brain");
  assert.equal(group.active, true);
  assert.equal(group.shimmer, true);
  const markup = renderToStaticMarkup(
    createElement(Timeline, {
      skills: [],
      thread: thread(
        [
          {
            kind: "reasoning",
            id: "thought",
            text: "Planning",
            complete: false,
          },
        ],
        true,
      ),
      clearance: 0,
      reverting: false,
      busy: false,
      onEdit() {},
      onRemoveQueued() {},
      onOpenTurnDiff() {},
    }),
  );
  assert.ok(markup.includes("live-activity-focus"));
  assert.ok(markup.includes(">Thinking<"));
});

it("labels a settled reasoning-only turn Thought without a fold", () => {
  const rows = deriveRows(
    thread([
      { kind: "reasoning", id: "thought", text: "Easy one.", complete: true },
      answer,
    ]),
    new Set(),
    new Set(),
  );
  assert.deepEqual(kinds(rows), ["user", "activity-group", "assistant"]);
  assert.equal(only(rows, "activity-group").label, "Thought");
});

it("renders a finished compaction as its own separator row and an unfinished one as Compacting", () => {
  const settled = deriveRows(
    thread([
      { kind: "context_compaction", id: "compact", complete: true },
      answer,
    ]),
    new Set(),
    new Set(),
  );
  assert.deepEqual(kinds(settled), ["user", "context-compaction", "assistant"]);
  assert.equal(only(settled, "context-compaction").label, "Context compacted");

  const running = deriveRows(
    thread(
      [{ kind: "context_compaction", id: "compact", complete: false }],
      true,
    ),
    new Set(),
    new Set(),
  );
  assert.deepEqual(kinds(running), ["user", "working", "thinking"]);
  assert.equal(only(running, "working").compacting, true);
  assert.equal(only(running, "thinking").compacting, true);
});

it("renders nothing for item kinds T3 drops", () => {
  const rows = deriveRows(
    thread([
      { kind: "hook_prompt", id: "hook", text: "Remember the rules" },
      { kind: "sleep", id: "sleep", durationMs: 1000 },
      { kind: "review_mode", id: "review", entered: true, review: "diff" },
      { kind: "function_call_output", id: "output", name: "shell" },
      {
        kind: "sub_agent_activity",
        id: "root",
        activity: "started",
        agentPath: "/root",
        agentThreadId: "root-thread",
      },
      answer,
    ]),
    new Set(),
    new Set(),
  );
  assert.deepEqual(kinds(rows), ["user", "assistant"]);
});

it("names the program a Windows shell runs, not the shell", () => {
  const ran = (command: string) =>
    liveWorkEntryLabel(
      {
        id: "command",
        action: "command",
        icon: "terminal",
        heading: "Ran command",
        label: "Ran command",
        command,
        detail: "",
        mcpCall: null,
        running: false,
        failed: false,
      },
      false,
    );
  assert.equal(
    ran('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "cargo test"'),
    "Ran cargo",
  );
  assert.equal(ran("powershell.exe -NoProfile -Command git status"), "Ran git");
  assert.equal(
    ran("C:\\Windows\\System32\\cmd.exe /c pnpm install"),
    "Ran pnpm",
  );
  assert.equal(ran("/bin/zsh -lc 'rg TODO'"), "Ran rg");
  assert.equal(ran("C:\\tools\\rg.exe TODO"), "Ran rg");
});
