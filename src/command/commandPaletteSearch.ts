// Adapted from pingdotgg/t3code v0.0.45 components/CommandPalette.logic.ts (MIT).
import type { ThreadMessageMatch, ThreadSummary } from "../ipc";
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
export type ThreadSearchRow = {
  thread: { id: string; title: string; updatedAtMs: number | null };
  workspaceId: string;
  workspaceLabel: string;
  rank: number;
  excerpt?: MessageMatch;
};
export function searchThreads(
  rows: SearchThread[],
  content: ThreadMessageMatch[],
  query: string,
  loadedWorkspaceIds: ReadonlySet<string> = new Set(),
): ThreadSearchRow[] {
  const needle = normalizeSearch(query);
  const current = new Map(rows.map((row) => [row.thread.id, row]));
  const results: ThreadSearchRow[] = rows.flatMap((row) => {
    if (
      row.thread.archivedAtMs !== null ||
      !matchesSearch(row.thread.title, needle)
    )
      return [];
    const title = normalizeSearch(row.thread.title);
    return [
      { ...row, rank: title === needle ? 0 : title.startsWith(needle) ? 1 : 2 },
    ];
  });
  const titles = new Set(results.map((row) => row.thread.id));
  for (const match of content) {
    const row = current.get(match.threadId);
    if (
      titles.has(match.threadId) ||
      (row &&
        (row.thread.archivedAtMs !== null ||
          row.thread.revision > match.revision)) ||
      (!row && loadedWorkspaceIds.has(match.workspaceId))
    )
      continue;
    results.push({
      thread: row?.thread ?? {
        id: match.threadId,
        title: match.title,
        updatedAtMs: match.updatedAtMs,
      },
      workspaceId: match.workspaceId,
      workspaceLabel: row?.workspaceLabel ?? match.workspaceLabel,
      rank: 3,
      excerpt: { source: match.source, snippet: match.snippet, query },
    });
  }
  return results.sort(
    (a, b) =>
      a.rank - b.rank ||
      (b.thread.updatedAtMs ?? 0) - (a.thread.updatedAtMs ?? 0) ||
      a.thread.id.localeCompare(b.thread.id),
  );
}
export function highlightSearchText(text: string, query: string) {
  const characters = Array.from(text);
  const decomposed = characters.map((char) =>
    char.normalize("NFKD").replace(/\p{M}/gu, ""),
  );
  const originalOffsets = decomposed.flatMap((part, index) =>
    Array.from({ length: part.toLowerCase().length }, () => index),
  );
  const lower = decomposed.join("").toLowerCase();
  let folded = "";
  const offsets: number[] = [];
  let whitespaceOffset: number | undefined;
  for (const [index, offset] of originalOffsets.entries()) {
    const char = lower.charAt(index);
    if (/\s/u.test(char)) {
      if (folded && whitespaceOffset === undefined) whitespaceOffset = offset;
    } else {
      if (whitespaceOffset !== undefined) {
        folded += " ";
        offsets.push(whitespaceOffset);
        whitespaceOffset = undefined;
      }
      folded += char;
      offsets.push(offset);
    }
  }
  const highlighted = new Set<number>();
  for (const word of normalizeSearch(query).split(" ").filter(Boolean)) {
    let start = folded.indexOf(word);
    while (start !== -1) {
      const first = offsets[start],
        last = offsets[start + word.length - 1];
      if (first !== undefined && last !== undefined)
        for (let i = first; i <= last; i++) highlighted.add(i);
      start = folded.indexOf(word, start + word.length);
    }
  }
  const parts: { text: string; highlighted: boolean; start: number }[] = [];
  for (const [index, char] of characters.entries()) {
    const previous = parts.at(-1);
    const active =
      highlighted.has(index) ||
      (/^\p{M}$/u.test(char) && previous?.highlighted === true);
    if (previous && previous.highlighted === active) previous.text += char;
    else parts.push({ text: char, highlighted: active, start: index });
  }
  return parts;
}
