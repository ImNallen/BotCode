import assert from "node:assert/strict";
import { it } from "node:test";
import type { ThreadMessageMatch, ThreadSummary } from "../ipc";
import {
  matchesSearch,
  searchThreads,
  highlightSearchText,
  normalizeSearch,
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
function snapshot(id: string): ThreadMessageMatch {
  return {
    threadId: id,
    workspaceId: "workspace",
    workspaceLabel: "Project",
    title: "Loaded conversation",
    updatedAtMs: 100,
    revision: 1,
    source: "assistant",
    snippet: "Fixed café login redirect",
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
it("keeps unopened native rows but drops known deleted, archived and revised rows", () => {
  const content = snapshot("live");
  assert.equal(
    searchThreads([], [content], "cafe login")[0]?.thread.id,
    "live",
  );
  assert.deepEqual(
    searchThreads([], [content], "login", new Set(["workspace"])),
    [],
  );
  assert.deepEqual(
    searchThreads([row("live", "Title", 1, 5)], [content], "login"),
    [],
  );
  const current = row("live", "Title");
  current.thread.revision = 2;
  assert.deepEqual(searchThreads([current], [content], "login"), []);
});
it("highlights every folded query word in original Unicode text", () => {
  for (const [text, expected] of [
    ["Ｃａｆé Login", "cafe login"],
    ["ΟΣ", "ος"],
    ["a\u0903b\u20dd", "ab"],
  ])
    assert.equal(normalizeSearch(text ?? ""), expected);
  const parts = highlightSearchText("Fixed café and ＬＯＧＩＮ", "login cafe");
  assert.deepEqual(
    parts.filter((part) => part.highlighted).map((part) => part.text),
    ["café", "ＬＯＧＩＮ"],
  );
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

it("highlights the original match after compatibility and repeated whitespace", () => {
  for (const text of [
    "¨".repeat(300) + "needle",
    "  needle",
    "a  needle",
    "a\u00a0\u3000needle",
  ]) {
    assert.equal(
      highlightSearchText(text, "needle")
        .filter((part) => part.highlighted)
        .map((part) => part.text)
        .join(""),
      "needle",
    );
  }
});
it("preserves contextual lowercase and original Unicode spans", () => {
  const cases: [string, string, string][] = [
    ["¨¨ ΟΣ  needle", "ος needle", "ΟΣneedle"],
    [
      "\ufeff  Ｃａｆe\u0301\u0903\u20dd \u3000needle",
      "cafe needle",
      "Ｃａｆe\u0301\u0903\u20ddneedle",
    ],
    ["👨‍👩‍👧‍👦  needle", "👨‍👩‍👧‍👦 needle", "👨‍👩‍👧‍👦needle"],
    ["\u0085needle", "\u0085needle", "\u0085needle"],
  ];
  for (const [text, query, expected] of cases) {
    assert.equal(
      highlightSearchText(text, query)
        .filter((part) => part.highlighted)
        .map((part) => part.text)
        .join(""),
      expected,
    );
  }
});
