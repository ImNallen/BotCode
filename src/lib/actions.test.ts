import assert from "node:assert/strict";
import { it } from "node:test";
import {
  actionLabel,
  actions,
  matchAction,
  matchesAction,
  runAction,
  shortcutLabel,
  type ActionContext,
  type KeyEventLike,
} from "./actions";
import type { Arrange, OpenTarget, ThreadSummary } from "../ipc";
import { searchActions, searchThreads } from "../command/commandPaletteSearch";
function summary(): ThreadSummary {
  return {
    id: "thread",
    title: "Test",
    revision: 1,
    latestTurn: null,
    pendingApprovalIds: [],
    pendingUserQuestionIds: [],
    pullRequests: {
      sequence: 0,
      links: [],
      discovering: false,
      discoveryError: null,
    },
    session: { kind: "ready" },
    checkout: { kind: "local" },
    createdAtMs: 1,
    archivedAtMs: null,
    updatedAtMs: 1,
    awaitingApproval: false,
    pinnedAtMs: null,
    settledAtMs: null,
    snoozedUntilMs: null,
  };
}
function context(): ActionContext {
  const noop = () => {};
  return {
    pageOpen: false,
    thread: summary(),
    workspace: {
      id: "workspace",
      label: "Project",
      root: "/tmp/project",
      kind: "repository",
    },
    branch: "main",
    scratchAvailable: true,
    terminalAvailable: true,
    projectSearchAvailable: true,
    renamePending: false,
    queued: false,
    archiveTarget: undefined,
    checkoutTarget: {
      kind: "workspace",
      workspace_id: "workspace",
      thread_id: null,
      path: "",
    },
    editorLabel: "Cursor",
    newThread: noop,
    startScratch: noop,
    openSettings: noop,
    closePage: noop,
    toggleSidebar: noop,
    openPalette: noop,
    openSubmenu: noop,
    arrange: noop,
    requestSidebar: noop,
    requestChat: noop,
    restoreArchived: noop,
    deleteArchived: noop,
    openInEditor: noop,
    revealInFinder: noop,
  };
}
function key(key: string, options: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key,
    code: `Key${key.toUpperCase()}`,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...options,
  };
}
it("the same discovered pin and settle commands execute from palette and shortcuts", () => {
  const ctx = context();
  const calls: Arrange[] = [];
  ctx.arrange = (_, action) => calls.push(action);
  for (const [id, letter] of [
    ["thread.pin", "p"],
    ["thread.settle", "s"],
  ] as const) {
    assert.equal(actions[id].palette, "root");
    assert.equal(runAction(id, ctx), true);
    const matched = matchAction(
      key(letter, { shiftKey: true }),
      ctx,
      false,
      "MacIntel",
    );
    assert.equal(matched, id);
    if (matched) runAction(matched, ctx);
  }
  assert.deepEqual(calls, [
    { kind: "pin" },
    { kind: "pin" },
    { kind: "settle" },
    { kind: "settle" },
  ]);
});
it("rechecks eligibility after discovery and permits pinning running work", () => {
  const ctx = context();
  assert.ok(ctx.thread);
  let changes = 0;
  ctx.arrange = () => changes++;
  assert.equal(actions["thread.settle"].available(ctx), true);
  ctx.thread.awaitingApproval = true;
  assert.equal(runAction("thread.settle", ctx), false);
  assert.equal(
    matchAction(key("s", { shiftKey: true }), ctx, false, "MacIntel"),
    undefined,
  );
  ctx.thread.session = { kind: "running" };
  assert.equal(runAction("thread.pin", ctx), true);
  assert.equal(runAction("thread.archive", ctx), false);
  assert.equal(changes, 1);
});
it("does not advertise queued, archived, hidden-page or pending-rename operations", () => {
  const ctx = context();
  ctx.queued = true;
  assert.equal(actions["thread.delete"].available(ctx), false);
  ctx.renamePending = true;
  assert.equal(actions["thread.rename"].available(ctx), false);
  ctx.pageOpen = true;
  assert.equal(actions["thread.pin"].available(ctx), false);
  assert.equal(actions["rightPanel.toggle"].available(ctx), false);
  ctx.pageOpen = false;
  assert.ok(ctx.thread);
  ctx.thread.archivedAtMs = 12;
  assert.equal(runAction("thread.pin", ctx), false);
});
it("matches exact modifiers, platform primary modifier, physical scratch key and punctuation", () => {
  assert.equal(
    matchesAction(key("k"), "commandPalette.toggle", "MacIntel"),
    true,
  );
  assert.equal(
    matchesAction(
      key("k", { shiftKey: true }),
      "commandPalette.toggle",
      "MacIntel",
    ),
    false,
  );
  assert.equal(
    matchesAction(
      key("k", { ctrlKey: true }),
      "commandPalette.toggle",
      "MacIntel",
    ),
    false,
  );
  assert.equal(
    matchesAction(
      key("k", { metaKey: false, ctrlKey: true }),
      "commandPalette.toggle",
      "Linux",
    ),
    true,
  );
  assert.equal(
    matchesAction(
      key("Dead", { code: "KeyN", altKey: true }),
      "chat.newWithoutProject",
      "MacIntel",
    ),
    true,
  );
  assert.equal(
    matchesAction(key(",", { code: "Comma" }), "settings.open", "MacIntel"),
    true,
  );
  assert.equal(
    matchesAction(
      key("<", { code: "Comma", shiftKey: true }),
      "settings.open",
      "MacIntel",
    ),
    false,
  );
  assert.equal(shortcutLabel("commandPalette.toggle", "MacIntel"), "⌘K");
  assert.equal(shortcutLabel("chat.newWithoutProject", "Linux"), "Ctrl+Alt+N");
});
it("leaves clear and new-terminal keys to the focused terminal and ignores composition/repeats", () => {
  const ctx = context();
  assert.equal(matchAction(key("k"), ctx, true, "MacIntel"), undefined);
  assert.equal(matchAction(key("n"), ctx, false, "MacIntel"), "chat.new");
  assert.equal(matchAction(key("n"), ctx, true, "MacIntel"), undefined);
  assert.equal(
    matchAction(key("k", { isComposing: true }), ctx, false, "MacIntel"),
    undefined,
  );
  assert.equal(
    matchAction(key("k", { repeat: true }), ctx, false, "MacIntel"),
    undefined,
  );
  assert.equal(matchAction(key("b"), ctx, true, "MacIntel"), "sidebar.toggle");
});

it("normal searches find matching actions alongside matching thread titles", () => {
  const ctx = context();
  assert.ok(ctx.thread);
  assert.deepEqual(searchActions(ctx, "root", "settings"), ["settings.open"]);
  assert.equal(
    searchThreads(
      [
        {
          thread: { ...ctx.thread, title: "Settings work" },
          workspaceId: "workspace",
          workspaceLabel: "Project",
        },
      ],
      [],
      "settings",
    ).length,
    1,
  );
});

it("opens the checkout in the preferred editor from the palette and Command+O, even in a terminal", () => {
  const ctx = context();
  const opened: OpenTarget[] = [];
  ctx.openInEditor = (target) => opened.push(target);
  assert.equal(actions["editor.openFavorite"].palette, "root");
  assert.equal(actionLabel("editor.openFavorite", ctx), "Open in Cursor");
  assert.equal(shortcutLabel("editor.openFavorite", "MacIntel"), "⌘O");
  assert.equal(
    matchAction(key("o"), ctx, false, "MacIntel"),
    "editor.openFavorite",
  );
  assert.equal(
    matchAction(key("o"), ctx, true, "MacIntel"),
    "editor.openFavorite",
  );
  assert.equal(
    matchAction(key("o", { shiftKey: true }), ctx, false, "MacIntel"),
    "chat.new",
  );
  assert.equal(runAction("editor.openFavorite", ctx), true);
  assert.deepEqual(opened, [
    { kind: "workspace", workspace_id: "workspace", thread_id: null, path: "" },
  ]);
});
it("offers editor actions only for an open checkout with an installed editor", () => {
  const ctx = context();
  const revealed: OpenTarget[] = [];
  ctx.revealInFinder = (target) => revealed.push(target);
  ctx.editorLabel = null;
  assert.equal(matchAction(key("o"), ctx, false, "MacIntel"), undefined);
  assert.equal(runAction("editor.reveal", ctx), true);
  ctx.editorLabel = "Zed";
  ctx.pageOpen = true;
  assert.equal(actions["editor.openFavorite"].available(ctx), false);
  assert.equal(actions["editor.reveal"].available(ctx), false);
  ctx.pageOpen = false;
  ctx.checkoutTarget = null;
  assert.equal(runAction("editor.openFavorite", ctx), false);
  assert.equal(runAction("editor.reveal", ctx), false);
  assert.deepEqual(revealed, [
    { kind: "workspace", workspace_id: "workspace", thread_id: null, path: "" },
  ]);
});
it("project search has T3 labels, exact platform shortcuts and checkout eligibility", () => {
  const ctx = context();
  const calls: string[] = [];
  ctx.requestChat = (kind) => calls.push(kind);
  assert.equal(actions["filePicker.toggle"].title, "Go to file");
  assert.equal(
    actions["projectSearch.toggle"].title,
    "Search project contents",
  );
  assert.equal(
    matchAction(key("p"), ctx, false, "MacIntel"),
    "filePicker.toggle",
  );
  assert.equal(
    matchAction(key("f", { shiftKey: true }), ctx, false, "MacIntel"),
    "projectSearch.toggle",
  );
  assert.equal(
    matchAction(
      key("p", { metaKey: false, ctrlKey: true }),
      ctx,
      false,
      "Linux",
    ),
    "filePicker.toggle",
  );
  assert.equal(matchAction(key("p"), ctx, true, "MacIntel"), undefined);
  assert.equal(matchAction(key("f"), ctx, false, "MacIntel"), undefined);
  assert.ok(
    searchActions(ctx, "root", "quick open").includes("filePicker.toggle"),
  );
  assert.ok(
    searchActions(ctx, "root", "grep").includes("projectSearch.toggle"),
  );
  runAction("filePicker.toggle", ctx);
  runAction("projectSearch.toggle", ctx);
  assert.deepEqual(calls, ["filePicker.toggle", "projectSearch.toggle"]);
  ctx.thread = undefined;
  assert.equal(actions["filePicker.toggle"].available(ctx), true);
  ctx.projectSearchAvailable = false;
  assert.equal(runAction("filePicker.toggle", ctx), false);
  assert.equal(runAction("projectSearch.toggle", ctx), false);
  ctx.projectSearchAvailable = true;
  ctx.pageOpen = true;
  assert.equal(actions["filePicker.toggle"].available(ctx), false);
});
