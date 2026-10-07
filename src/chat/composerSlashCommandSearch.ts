// Ported from T3 Code v0.0.45 apps/web/src/components/chat/composerSlashCommandSearch.ts and ChatComposer.tsx (MIT).
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "../lib/searchRanking";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { pathBasename } from "./composer-logic";

type SlashItem = Extract<ComposerCommandItem, { type: "slash-command" }>;
const commands: SlashItem[] = [
  {
    id: "slash:model",
    type: "slash-command",
    command: "model",
    label: "/model",
    description: "Switch model",
  },
  {
    id: "slash:plan",
    type: "slash-command",
    command: "plan",
    label: "/plan",
    description: "Switch to plan mode",
  },
  {
    id: "slash:default",
    type: "slash-command",
    command: "default",
    label: "/default",
    description: "Switch to normal build mode",
  },
  {
    id: "slash:usage-limits",
    type: "slash-command",
    command: "usage-limits",
    label: "/usage-limits",
    description: "Show Codex usage limits",
  },
];

export function standaloneComposerCommand(text: string) {
  return (
    commands.find((item) => item.label === text.trim().toLowerCase())
      ?.command ?? null
  );
}

export function searchSlashCommandItems(
  query: string,
  planSupported: boolean,
): SlashItem[] {
  const items = commands.filter(
    (item) =>
      planSupported || (item.command !== "plan" && item.command !== "default"),
  );
  const normalized = normalizeSearchQuery(query, {
    trimLeadingPattern: /^\/+/,
  });
  if (!normalized) return items;
  const ranked: { item: SlashItem; score: number; tieBreaker: string }[] = [];
  for (const item of items) {
    const scores = [
      scoreQueryMatch({
        value: item.command,
        query: normalized,
        exactBase: 0,
        prefixBase: 2,
        boundaryBase: 4,
        includesBase: 6,
        fuzzyBase: 100,
        boundaryMarkers: ["-", "_", "/"],
      }),
      scoreQueryMatch({
        value: item.description.toLowerCase(),
        query: normalized,
        exactBase: 20,
        prefixBase: 22,
        boundaryBase: 24,
        includesBase: 26,
      }),
    ].filter((score) => score !== null);
    if (scores.length)
      insertRankedSearchResult(
        ranked,
        { item, score: Math.min(...scores), tieBreaker: item.command },
        Infinity,
      );
  }
  return ranked.map((result) => result.item);
}

export function searchComposerPaths(
  files: readonly string[],
  query: string,
): ComposerCommandItem[] {
  const normalized = normalizeSearchQuery(query);
  const ranked: {
    item: ComposerCommandItem;
    score: number;
    tieBreaker: string;
  }[] = [];
  for (const path of files) {
    const score = normalized
      ? scoreQueryMatch({
          value: path.toLowerCase(),
          query: normalized,
          exactBase: 0,
          prefixBase: 2,
          boundaryBase: 4,
          includesBase: 6,
          fuzzyBase: 100,
        })
      : 0;
    if (score === null) continue;
    insertRankedSearchResult(
      ranked,
      {
        item: {
          id: `path:${path}`,
          type: "path",
          path,
          label: pathBasename(path),
          description: path,
        },
        score,
        tieBreaker: path,
      },
      50,
    );
  }
  return ranked.map((result) => result.item);
}
