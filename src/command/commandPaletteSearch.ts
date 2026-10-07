// Adapted from pingdotgg/t3code v0.0.45 components/CommandPalette.logic.ts (MIT).
import type { Thread, ThreadSummary } from "../ipc";
import {
  actionIds,
  actionLabel,
  actions,
  type ActionContext,
  type PalettePage,
} from "../lib/actions";
export function searchActions(
  context: ActionContext,
  page: PalettePage,
  query: string,
) {
  return actionIds.filter(
    (id) =>
      actions[id].palette === page &&
      actions[id].available(context) &&
      matchesSearch(
        `${actionLabel(id, context)} ${actions[id].keywords ?? ""}`,
        query,
      ),
  );
}
export type SearchThread = {
  thread: ThreadSummary;
  workspaceId: string;
  workspaceLabel: string;
};
export function normalizeSearch(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
export function matchesSearch(value: string, query: string) {
  const haystack = normalizeSearch(value);
  return normalizeSearch(query)
    .split(" ")
    .every((word) => haystack.includes(word));
}
export type MessageMatch = {
  source: "user" | "assistant";
  snippet: string;
  query: string;
};
type SearchMessage = { source: MessageMatch["source"]; text: string };
export function snapshotMessages(thread: Thread): SearchMessage[] {
  if (thread.placement?.kind === "archived") return [];
  return thread.turns.flatMap((turn) => [
    { source: "user", text: turn.prompt },
    ...turn.items.flatMap((item): SearchMessage[] =>
      item.kind === "user_input" || item.kind === "assistant"
        ? [
            {
              source: item.kind === "user_input" ? "user" : "assistant",
              text: item.text,
            },
          ]
        : [],
    ),
  ]);
}
export function searchThreads(
  rows: SearchThread[],
  snapshots: Thread[],
  query: string,
) {
  const needle = normalizeSearch(query);
  const messages = new Map(
    snapshots.map((thread) => [thread.id, snapshotMessages(thread)]),
  );
  return rows
    .flatMap((row) => {
      if (row.thread.archivedAtMs !== null) return [];
      const title = normalizeSearch(row.thread.title);
      const titleMatch = matchesSearch(title, needle);
      const message = titleMatch
        ? undefined
        : messages
            .get(row.thread.id)
            ?.find((message) => matchesSearch(message.text, needle));
      if (!titleMatch && message === undefined) return [];
      const rank =
        title === needle
          ? 0
          : title.startsWith(needle)
            ? 1
            : titleMatch
              ? 2
              : 3;
      let excerpt: MessageMatch | undefined;
      if (message) {
        const text = message.text.replace(/\s+/g, " ");
        const position = normalizeSearch(text).indexOf(
          needle.split(" ")[0] ?? "",
        );
        const start = Math.max(0, position - 45);
        excerpt = {
          source: message.source,
          query: query.trim(),
          snippet: `${start ? "…" : ""}${text.slice(start, start + 180)}${text.length > start + 180 ? "…" : ""}`,
        };
      }
      return [{ ...row, rank, excerpt }];
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (b.thread.updatedAtMs ?? 0) - (a.thread.updatedAtMs ?? 0) ||
        a.thread.id.localeCompare(b.thread.id),
    );
}
