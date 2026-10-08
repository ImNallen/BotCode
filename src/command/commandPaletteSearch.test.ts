import assert from "node:assert/strict";
import { it } from "node:test";
import type { Thread, ThreadSummary } from "../ipc";
import {
  matchesSearch,
  searchThreads,
  snapshotMessages,
  type SearchThread,
} from "./commandPaletteSearch";
function row(
  id: string,
  title: string,
  updatedAtMs = 0,
  archivedAtMs: number | null = null,
): SearchThread {
  const thread: ThreadSummary = {
    id,
    title,
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
    archivedAtMs,
    updatedAtMs,
    awaitingApproval: false,
    pinnedAtMs: null,
    snoozedUntilMs: null,
    settledAtMs: null,
  };
  return { thread, workspaceId: "workspace", workspaceLabel: "Project" };
}
function snapshot(id: string): Thread {
  return {
    id,
    workspaceId: "workspace",
    title: "Loaded conversation",
    worktreeSetup: null,
    nativeThreadId: null,
    revision: 1,
    session: { kind: "ready" },
    settings: {
      model: null,
      effort: null,
      permissionMode: "full-access",
      interactionMode: "default",
    },
    checkout: { kind: "local" },
    approvals: [],
    userQuestions: [],
    diagnostic: null,
    pendingRevert: null,
    lastRevert: null,
    context: null,
    turns: [
      {
        id: "turn",
        prompt: "Please inspect login behavior",
        tasks: null,
        nativeTurnId: null,
        delivery: { kind: "accepted" },
        execution: { kind: "completed" },
        items: [
          {
            id: "answer",
            kind: "assistant",
            text: "Fixed café login redirect",
            complete: true,
          },
        ],
        settings: null,
        startedAtMs: 1,
        completedAtMs: 2,
        attachments: [],
        checkpoint: { kind: "unavailable", before: null, reason: "No Git" },
      },
    ],
  };
}
it("finds unloaded titles, folds accents/compatibility characters and requires every token", () => {
  assert.equal(matchesSearch("Ｃａｆé  Login", "CAFE login"), true);
  assert.equal(matchesSearch("Cafe only", "cafe login"), false);
  assert.deepEqual(
    searchThreads([row("unloaded", "Café login")], [], "login cafe").map(
      (match) => match.thread.id,
    ),
    ["unloaded"],
  );
});
it("ranks exact titles, title prefixes, other title matches, then cached messages", () => {
  const rows = [
    row("body", "Conversation", 100),
    row("title", "Fix café login", 50),
    row("prefix", "Café login now", 10),
    row("exact", "café login", 1),
  ];
  const matches = searchThreads(rows, [snapshot("body")], "cafe login");
  assert.deepEqual(
    matches.map((match) => match.thread.id),
    ["exact", "prefix", "title", "body"],
  );
  assert.equal(matches[3]?.excerpt?.source, "assistant");
  assert.ok(matches[3]?.excerpt?.snippet.includes("café login"));
});
it("searches cached prompts but excludes archived and orphaned snapshots", () => {
  const loaded = snapshot("live");
  assert.equal(
    searchThreads([row("live", "Title")], [loaded], "inspect behavior")[0]
      ?.excerpt?.source,
    "user",
  );
  assert.deepEqual(
    searchThreads([row("live", "Title", 1, 5)], [loaded], "login"),
    [],
  );
  assert.deepEqual(searchThreads([], [loaded], "login"), []);
  loaded.placement = { kind: "archived" };
  assert.deepEqual(snapshotMessages(loaded), []);
});
it("uses recency within equal ranks and returns all live titles for empty query", () => {
  assert.deepEqual(
    searchThreads(
      [
        row("old", "Old", 1),
        row("new", "New", 2),
        row("gone", "Archived", 3, 4),
      ],
      [],
      "",
    ).map((match) => match.thread.id),
    ["new", "old"],
  );
});
