import assert from "node:assert/strict";
import { it } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Approval, Item, Subagent, Thread } from "../ipc";
import { AgentSpawnRow, Timeline } from "./Timeline";
import {
  deriveRows,
  liveWorkEntryLabel,
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapNavigationInteractive,
  resolveTimelineMinimapTopPercent,
  workEntryCanExpand,
  workEntryExpandedBody,
  workEntryViewedImagePath,
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
  appContext: null,
  presentation: null,
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
    subagents: [],
    turns: [
      {
        id: turnId,
        kind: "prompt" as const,
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
      toolIcon: null,
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
      onExpandImage() {},
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

it("shows Starting sandbox in place of Thinking while a sandbox agent connects", () => {
  const connecting = (checkout: Thread["checkout"]) =>
    deriveRows(
      { ...thread([], true), session: { kind: "connecting" }, checkout },
      new Set(),
      new Set(),
    );
  const sandbox = connecting({
    kind: "worktree",
    path: "/mirror",
    branch: "l1code/abc",
    sandbox: { kind: "docker", id: "0123456789ab" },
  });
  assert.deepEqual(kinds(sandbox), ["user", "working"]);
  assert.equal(only(sandbox, "working").startingSandbox, true);
  const sandboxThread: Thread = {
    ...thread([], true),
    session: { kind: "connecting" },
    checkout: {
      kind: "worktree",
      path: "/mirror",
      branch: "l1code/abc",
      sandbox: { kind: "docker", id: "0123456789ab" },
    },
  };
  const markup = renderToStaticMarkup(
    createElement(Timeline, {
      skills: [],
      thread: sandboxThread,
      clearance: 0,
      reverting: false,
      busy: false,
      onEdit() {},
      onExpandImage() {},
      onRemoveQueued() {},
      onOpenTurnDiff() {},
    }),
  );
  assert.match(markup, /Starting sandbox…/);

  const mac = connecting({ kind: "worktree", path: "/w", branch: "b" });
  assert.deepEqual(kinds(mac), ["user", "working", "thinking"]);
  assert.equal(only(mac, "working").startingSandbox, false);
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
        status: "completed",
        presentation: null,
        viewedImagePath: null,
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

const computerUse: Item = {
  kind: "mcp_tool_call",
  id: "call_8fe2acb4d20b46c9a6e59dd236c01a8e",
  server: "cua_repl",
  tool: "js",
  title: "Inspect isolated baseline Tauri app",
  status: "completed",
  arguments: { title: "Inspect isolated baseline Tauri app" },
  result: "L1 Code window",
  error: null,
  durationMs: 752,
  appContext: null,
  presentation: {
    surface: "computer",
    source: {
      key: "native-app:dev.l1.code.previewverify",
      name: "Computer Use",
      kind: "computer",
      icon: {
        kind: "native_app",
        app: { kind: "app_id", appId: "dev.l1.code.previewverify" },
      },
    },
    icon: {
      kind: "native_app",
      app: { kind: "app_id", appId: "dev.l1.code.previewverify" },
    },
  },
};

const chromeBrowser: Item = {
  kind: "mcp_tool_call",
  id: "call_68e27098b8664ebc84094ce65f81406d",
  server: "browser",
  tool: "navigate",
  title: "Open shared logo link",
  status: "completed",
  arguments: { title: "Open shared logo link" },
  result: "Opened tab",
  error: null,
  durationMs: 7290,
  appContext: null,
  presentation: {
    surface: "browser",
    source: {
      key: "browser-use:chrome",
      name: "Chrome",
      kind: "integration",
      icon: {
        kind: "native_app",
        app: { kind: "display_name", displayName: "Google Chrome" },
      },
    },
    icon: {
      kind: "website",
      pageUrl: "https://chatgpt.com/",
      faviconUrl: null,
      faviconUrlDark: null,
    },
  },
};

const command = (status: string): Item => ({
  kind: "command",
  id: `command-${status}`,
  command: "/bin/zsh -lc 'rg toolCall'",
  output: "",
  status,
});

function markup(value: Thread) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Timeline, {
        skills: [],
        thread: value,
        clearance: 0,
        reverting: false,
        busy: false,
        onEdit() {},
        onExpandImage() {},
        onRemoveQueued() {},
        onOpenTurnDiff() {},
      }),
    ),
  );
}

it("summarizes a group with T3's integration names and the first source's icon", () => {
  const rows = deriveRows(
    thread([chromeBrowser, command("completed"), computerUse, answer]),
    new Set([turnId]),
    new Set(),
  );
  const group = only(rows, "work-group");
  assert.equal(group.label, "Used Chrome and Computer Use and ran 1 command");
  assert.equal(group.icon, "browser");
  assert.deepEqual(group.toolIcon, {
    kind: "website",
    pageUrl: "https://chatgpt.com/",
    faviconUrl: null,
    faviconUrlDark: null,
  });

  const chromeOnly = deriveRows(
    thread([chromeBrowser, command("completed"), answer]),
    new Set([turnId]),
    new Set(),
  );
  assert.equal(
    only(chromeOnly, "work-group").label,
    "Used Chrome integration and ran 1 command",
  );
});

it("gives browser and Computer Use rows their app icons, favicons and an x when they fail", () => {
  const browser = markup(thread([chromeBrowser], true));
  assert.ok(browser.includes('src="https://chatgpt.com/favicon.ico"'));
  assert.ok(browser.includes('referrerPolicy="no-referrer"'));
  assert.ok(browser.includes("M8.5 19H7.2C4.4 19"), "browser glyph until load");

  const declined = markup(
    thread([{ ...computerUse, status: "declined" }], true),
  );
  assert.ok(declined.includes("computer-use-app-gradient"));
  assert.ok(declined.includes('aria-label="Tool call failed"'));
  assert.ok(declined.includes("lucide-x"), "trailing x for an untintable icon");

  const failedCommand = markup(thread([command("declined")], true));
  assert.ok(failedCommand.includes('aria-label="Tool call failed"'));
  assert.ok(
    !failedCommand.includes("lucide-x"),
    "a terminal glyph takes the tint",
  );
});

it("keeps the live activity row on a just-completed tool in present tense, as T3 does", () => {
  const rowsFor = (status: string) =>
    deriveRows(thread([command(status)], true), new Set(), new Set());

  const running = rowsFor("inProgress");
  assert.deepEqual(kinds(running), ["user", "working", "work-live"]);
  const completed = rowsFor("completed");
  assert.deepEqual(kinds(completed), ["user", "working", "work-live"]);
  const live = only(completed, "work-live");
  assert.equal(live.id, `live-activity:${turnId}`);
  assert.equal(live.active, true);
  assert.equal(liveWorkEntryLabel(live.entry, live.active), "Running rg");

  const failed = rowsFor("failed");
  assert.deepEqual(kinds(failed), ["user", "working", "thinking"]);
  assert.equal(only(failed, "thinking").id, `live-activity:${turnId}`);

  const declined = rowsFor("declined");
  assert.deepEqual(kinds(declined), [
    "user",
    "working",
    "work-live",
    "thinking",
  ]);
  const settledLive = only(declined, "work-live");
  assert.equal(settledLive.active, false);
  assert.equal(settledLive.id, "work-live:command-declined");
  assert.equal(
    liveWorkEntryLabel(settledLive.entry, settledLive.active),
    "Declined rg",
  );
});

it("expands the live tool row to every tool since the latest failure", () => {
  const items = [
    command("completed"),
    { ...command("failed"), id: "command-failed" },
    { ...webSearch, status: "completed" as const },
  ];
  const collapsed = deriveRows(thread(items, true), new Set(), new Set());
  const live = only(collapsed, "work-live");
  assert.equal(live.expanded, false);
  assert.deepEqual(
    live.entries.map((entry) => entry.id),
    ["command-failed", webSearch.id],
  );
  assert.equal(live.entry.id, webSearch.id);
  assert.deepEqual(
    collapsed.filter((row) => row.kind === "work").map((row) => row.id),
    ["command-completed"],
  );

  const expanded = deriveRows(
    thread(items, true),
    new Set(),
    new Set([live.groupId]),
  );
  assert.equal(only(expanded, "work-live").expanded, true);
});

it("previews image views but not image generations, without repeating the path", () => {
  const rows = deriveRows(
    thread(
      [
        { kind: "image_view", id: "view", path: "/tmp/screen.png" },
        { kind: "image_view", id: "notes", path: "/tmp/notes.txt" },
        { kind: "image_generation", id: "gen", status: "completed" },
        answer,
      ],
      false,
    ),
    new Set([turnId]),
    new Set(),
  );
  const [view, notes, generation] = only(rows, "work-group").entries;
  assert.ok(view && notes && generation);
  assert.equal(workEntryViewedImagePath(view), "/tmp/screen.png");
  assert.equal(workEntryCanExpand(view, view.label), true);
  assert.equal(workEntryExpandedBody(view, view.label), null);
  assert.equal(workEntryViewedImagePath(notes), null);
  assert.equal(workEntryViewedImagePath(generation), null);
});

const l1code = (
  id: string,
  tool: string,
  status: "inProgress" | "completed" | "failed",
  args: Record<string, string | number> = {},
): Extract<Item, { kind: "mcp_tool_call" }> => ({
  kind: "mcp_tool_call",
  id,
  server: "l1code",
  tool,
  title: `l1code · ${tool}`,
  status,
  arguments: args,
  result: null,
  error: null,
  durationMs: null,
  appContext: null,
  presentation: null,
});

it("labels L1 Code's own MCP tools with T3's tool labels and icons", () => {
  const single = (item: Item) => {
    const { entry } = only(
      deriveRows(thread([item, answer]), new Set([turnId]), new Set()),
      "work",
    );
    return { heading: entry.heading, icon: entry.icon };
  };
  assert.deepEqual(single(l1code("open", "preview_open", "completed")), {
    heading: "Opened a page in the preview browser",
    icon: "browser",
  });
  assert.deepEqual(single(l1code("snap", "preview_snapshot", "failed")), {
    heading: "Failed to take a snapshot of the preview page",
    icon: "browser",
  });
  assert.deepEqual(
    single(
      l1code("link", "link_pull_request", "completed", {
        url: "https://github.com/pingdotgg/t3code/pull/12",
      }),
    ),
    { heading: "Linked PR #12", icon: "pull-request" },
  );
  assert.deepEqual(
    single(
      l1code("unlink", "unlink_pull_request", "completed", {
        repository: "pingdotgg/t3code",
        number: 7,
      }),
    ),
    { heading: "Unlinked PR #7", icon: "pull-request" },
  );
  assert.deepEqual(
    single({
      ...l1code("other", "preview_open", "completed"),
      server: "x",
      title: "x · preview_open",
    }),
    { heading: "X · preview_open", icon: "wrench" },
  );
});

it("keeps a L1 Code preview tool live in present tense and summarizes groups by T3's kinds", () => {
  const live = only(
    deriveRows(
      thread([l1code("open", "preview_open", "completed")], true),
      new Set(),
      new Set(),
    ),
    "work-live",
  );
  assert.equal(
    liveWorkEntryLabel(live.entry, live.active),
    "Opening a page in the preview browser",
  );

  const groupOf = (items: Item[]) =>
    only(
      deriveRows(thread([...items, answer]), new Set([turnId]), new Set()),
      "work-group",
    );
  const browser = groupOf([
    l1code("open", "preview_open", "completed"),
    l1code("click", "preview_click", "completed"),
  ]);
  assert.equal(browser.label, "Used browser 2 times");
  assert.equal(browser.icon, "browser");
  const prs = groupOf([
    l1code("link", "link_pull_request", "completed", { number: 3 }),
    l1code("list", "list_thread_pull_requests", "completed"),
  ]);
  assert.equal(
    prs.label,
    "Linked 1 pull request and checked linked pull requests",
  );
  assert.equal(prs.icon, "pull-request");
  assert.ok(
    markup(
      thread([l1code("list", "list_thread_pull_requests", "inProgress")], true),
    ).includes(">Checking linked pull requests<"),
  );
});

function subagent(title: string, overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: `child-${title}`,
    spawnTurnId: turnId,
    title,
    role: title,
    model: "gpt-6.1-sol",
    effort: "low",
    status: "idle",
    activationCount: 1,
    totalTokens: 41_720,
    progress: "assistant message",
    startedAtMs: 1_000,
    completedAtMs: null,
    updatedAtMs: 7_000,
    ...overrides,
  };
}

const spawnItems: Item[] = [
  {
    kind: "sub_agent_activity",
    id: "call_ygRl7d0KEX0LgwNCPMjqj2jD",
    activity: "started",
    agentPath: "/root/readme_lines",
    agentThreadId: "child-readme_lines",
  },
  {
    kind: "sub_agent_activity",
    id: "call_CAaYmbjlREhUhGVqcwxMEm70",
    activity: "started",
    agentPath: "/root/git_branch",
    agentThreadId: "child-git_branch",
  },
  {
    kind: "collab_agent_tool_call",
    id: "call_longqlKu5HuObXEYBchDEhqE",
    tool: "wait",
    prompt: null,
    status: "completed",
  },
  {
    kind: "sub_agent_activity",
    id: "subagent-completed-1",
    activity: "completed",
    agentPath: "/root/readme_lines",
    agentThreadId: "child-readme_lines",
  },
];

function spawnRows(
  subagents: Subagent[],
  running = false,
  expanded: ReadonlySet<string> = new Set(),
) {
  return deriveRows(
    { ...thread([...spawnItems, answer], running), subagents },
    new Set(),
    expanded,
  );
}

it("puts one spawn row for the turn's subagents where the first one started", () => {
  const rows = spawnRows([
    subagent("readme_lines"),
    subagent("git_branch", { totalTokens: 41_703 }),
  ]);
  assert.deepEqual(kinds(rows), ["user", "fold", "agents", "assistant"]);
  const row = only(rows, "agents");
  assert.equal(row.id, "agents:call_ygRl7d0KEX0LgwNCPMjqj2jD");
  assert.equal(row.label, "Ran 2 subagents");
  assert.equal(row.live, false);
  assert.equal(row.failed, false);
  assert.equal(row.expanded, false);
  assert.deepEqual(row.members, [
    {
      id: "child-readme_lines",
      title: "readme_lines",
      role: null,
      failed: false,
      statusLabel: "Idle · 41.7k tok",
      firstLine: "assistant message",
      body: "assistant message\n\ngpt-6.1-sol · low",
    },
    {
      id: "child-git_branch",
      title: "git_branch",
      role: null,
      failed: false,
      statusLabel: "Idle · 41.7k tok",
      firstLine: "assistant message",
      body: "assistant message\n\ngpt-6.1-sol · low",
    },
  ]);
});

it("kicks off subagents while one works and labels each member's outcome", () => {
  const live = spawnRows(
    [
      subagent("readme_lines", { status: "running", totalTokens: null }),
      subagent("git_branch", { status: "waiting", progress: null }),
    ],
    true,
  );
  const working = only(live, "agents");
  assert.equal(working.label, "Kicked off 2 subagents");
  assert.equal(working.live, true);
  assert.deepEqual(
    working.members.map((member) => member.statusLabel),
    ["Working", "Working"],
  );
  assert.ok(!kinds(live).includes("thinking"));

  const settled = only(
    spawnRows([
      subagent("readme_lines", {
        status: "failed",
        role: "reviewer",
        progress: "\n  first line\nsecond line",
        completedAtMs: 7_200,
        totalTokens: 20_840,
      }),
      subagent("git_branch", {
        status: "interrupted",
        completedAtMs: 2_000,
        totalTokens: null,
        model: null,
      }),
    ]),
    "agents",
  );
  assert.equal(settled.label, "Ran 2 subagents");
  assert.equal(settled.failed, true);
  assert.deepEqual(
    settled.members.map(({ role, failed, statusLabel, firstLine, body }) => ({
      role,
      failed,
      statusLabel,
      firstLine,
      body,
    })),
    [
      {
        role: "reviewer",
        failed: true,
        statusLabel: "Failed · 6.2s · 20.8k tok",
        firstLine: "  first line",
        body: "first line\nsecond line\n\ngpt-6.1-sol · low",
      },
      {
        role: null,
        failed: false,
        statusLabel: "Stopped · 1.0s",
        firstLine: "assistant message",
        body: "assistant message",
      },
    ],
  );
});

it("expands the spawn row into its member rows", () => {
  const members = [subagent("readme_lines"), subagent("git_branch")];
  const collapsed = only(spawnRows(members), "agents");
  const closed = renderToStaticMarkup(
    createElement(AgentSpawnRow, { row: collapsed, onToggle() {} }),
  );
  assert.ok(closed.includes('aria-expanded="false"'));
  assert.ok(closed.includes(">Ran 2 subagents<"));
  assert.ok(!closed.includes("readme_lines"));

  const row = only(
    spawnRows(members, false, new Set([collapsed.id])),
    "agents",
  );
  assert.equal(row.expanded, true);
  const open = renderToStaticMarkup(
    createElement(AgentSpawnRow, { row, onToggle() {} }),
  );
  assert.ok(open.includes('aria-expanded="true"'));
  assert.ok(open.includes(">readme_lines<"));
  assert.ok(open.includes(">git_branch<"));
  assert.equal(open.split(">Idle · 41.7k tok<").length - 1, 2);
  assert.ok(!open.includes("Open Agents panel"));
  assert.ok(
    renderToStaticMarkup(
      createElement(AgentSpawnRow, { row, onToggle() {}, onOpenAgents() {} }),
    ).includes("Open Agents panel ›"),
  );
});

it("opens the Agents panel from the expanded spawn row's link", () => {
  const collapsed = only(spawnRows([subagent("readme_lines")]), "agents");
  const row = only(
    spawnRows([subagent("readme_lines")], false, new Set([collapsed.id])),
    "agents",
  );
  let opened = 0;
  const link = findElement(
    AgentSpawnRow({ row, onToggle() {}, onOpenAgents: () => (opened += 1) }),
    (props) => props.children === "Open Agents panel ›",
  );
  assert.equal(
    link?.props.className,
    "mt-1 self-start rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground",
  );
  (link?.props.onClick as () => void)();
  assert.equal(opened, 1);
});

type ElementLike = { props: Record<string, unknown> };
function findElement(
  node: unknown,
  match: (props: Record<string, unknown>) => boolean,
): ElementLike | undefined {
  if (Array.isArray(node))
    return node.reduce<ElementLike | undefined>(
      (found, child) => found ?? findElement(child, match),
      undefined,
    );
  if (!node || typeof node !== "object" || !("props" in node)) return;
  const element = node as ElementLike;
  return match(element.props)
    ? element
    : findElement(element.props.children, match);
}

it("shows no spawn row for a turn whose subagents the roster does not hold", () => {
  const rows = spawnRows([subagent("other", { spawnTurnId: "other-turn" })]);
  assert.ok(!kinds(rows).includes("agents"));
});

it("shows the spawn row for a roster rebuilt from a legacy thread's items", () => {
  const legacy = (title: string, overrides: Partial<Subagent>) =>
    subagent(title, {
      model: null,
      effort: null,
      totalTokens: null,
      progress: null,
      startedAtMs: 1_000,
      updatedAtMs: 13_000,
      ...overrides,
    });
  const row = only(
    spawnRows([
      legacy("readme_lines", { status: "idle" }),
      legacy("git_branch", { status: "interrupted", completedAtMs: 13_000 }),
      legacy("lint", { status: "interrupted", completedAtMs: 13_000 }),
    ]),
    "agents",
  );
  assert.equal(row.label, "Ran 3 subagents");
  assert.equal(row.live, false);
  assert.deepEqual(
    row.members.map(({ statusLabel, firstLine, body }) => ({
      statusLabel,
      firstLine,
      body,
    })),
    [
      { statusLabel: "Idle", firstLine: null, body: "" },
      { statusLabel: "Stopped · 12s", firstLine: null, body: "" },
      { statusLabel: "Stopped · 12s", firstLine: null, body: "" },
    ],
  );
});

it("resolves T3's minimap geometry", () => {
  assert.equal(
    resolveTimelineMinimapHeightStyle(5),
    "min(32px, calc(100vh - 18rem))",
  );
  assert.equal(resolveTimelineMinimapTopPercent(2, 5), 50);
  assert.equal(
    resolveTimelineMinimapIndexFromPointer({
      itemCount: 101,
      railTop: 100,
      railHeight: 500,
      pointerY: 350,
    }),
    50,
  );
  assert.equal(
    resolveTimelineMinimapIndexFromPointer({
      itemCount: 101,
      railTop: 100,
      railHeight: 500,
      pointerY: 999,
    }),
    100,
  );
  assert.equal(
    resolveTimelineMinimapCurrentIndex({
      scrollTop: 100,
      scrollBottom: 500,
      itemBounds: [
        { top: 80, height: 20 },
        { top: 120, height: 20 },
        { top: 220, height: 20 },
      ],
    }),
    1,
  );
  assert.equal(
    resolveTimelineMinimapCurrentIndex({
      scrollTop: 150,
      scrollBottom: 200,
      itemBounds: [
        { top: 80, height: 20 },
        { top: 120, height: 20 },
        { top: 220, height: 20 },
      ],
    }),
    1,
  );
  assert.equal(
    resolveTimelineMinimapCurrentIndex({
      scrollTop: 0,
      scrollBottom: 50,
      itemBounds: [{ top: 80, height: 20 }],
    }),
    null,
  );
  assert.equal(resolveTimelineMinimapHasPersistentGutter(832, 768), false);
  assert.equal(resolveTimelineMinimapHasPersistentGutter(863, 768), false);
  assert.equal(resolveTimelineMinimapHasPersistentGutter(864, 768), true);
  assert.equal(resolveTimelineMinimapHasPersistentGutter(1400, 1152), true);
  assert.equal(resolveTimelineMinimapHasPersistentGutter(1200, 1152), false);
  assert.equal(resolveTimelineMinimapHasPersistentGutter(2560, 2560), false);

  assert.equal(resolveTimelineMinimapHitStripWidth(768, 768), 0);
  assert.equal(resolveTimelineMinimapHitStripWidth(792, 768), 0);
  assert.equal(resolveTimelineMinimapHitStripWidth(820, 768), 14);
  assert.equal(resolveTimelineMinimapHitStripWidth(872, 768), 40);
  assert.equal(resolveTimelineMinimapHitStripWidth(1400, 768), 40);
  assert.equal(resolveTimelineMinimapHitStripWidth(2560, 2560), 0);
  assert.equal(resolveTimelineMinimapHitStripWidth(1204, 1152), 14);
  assert.equal(resolveTimelineMinimapHitStripWidth(0, 0), 0);
  assert.equal(resolveTimelineMinimapHitStripWidth(Number.NaN, 768), 0);

  assert.equal(resolveTimelineMinimapNavigationInteractive(40), true);
  assert.equal(resolveTimelineMinimapNavigationInteractive(14), true);
  assert.equal(resolveTimelineMinimapNavigationInteractive(8), false);
  assert.equal(resolveTimelineMinimapNavigationInteractive(0), false);

  assert.equal(resolveTimelineMinimapInteractiveWidth(0, false), 0);
  assert.equal(resolveTimelineMinimapInteractiveWidth(14, false), 14);
  assert.equal(resolveTimelineMinimapInteractiveWidth(40, false), 40);
  assert.equal(resolveTimelineMinimapInteractiveWidth(0, true), "22rem");
  assert.equal(resolveTimelineMinimapInteractiveWidth(14, true), "22rem");
  assert.equal(resolveTimelineMinimapInteractiveWidth(40, true), "22rem");
});

it("renders T3's minimap from the second user turn", () => {
  const single = thread([answer]);
  assert.ok(!markup(single).includes('data-testid="timeline-minimap"'));

  const steered = thread([
    answer,
    {
      kind: "user_input",
      id: "steer",
      text: "Also check the changelog",
      attachments: [],
      delivery: { kind: "accepted" },
    },
  ]);
  const html = markup(steered);
  assert.ok(html.includes('data-testid="timeline-minimap"'));
  assert.ok(html.includes('aria-label="Previous turn"'));
  assert.ok(html.includes('aria-label="Next turn"'));
  assert.ok(html.includes('aria-label="Jump to message: User message"'));
  assert.equal(html.match(/data-minimap-strip/g)?.length, 2);
  assert.ok(html.includes("[@media(pointer:fine)]:block"));
});
