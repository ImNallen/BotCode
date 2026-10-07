// Ported from T3 Code v0.0.45 apps/web/src/components/chat/composerSlashCommandSearch.ts and ChatComposer.tsx (MIT).
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "../lib/searchRanking";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { pathBasename } from "./composer-logic";
import type { Skill } from "../ipc";
import {
  scoreProviderSkill,
  searchProviderSkills,
} from "./providerSkillSearch";
import { formatProviderSkillDisplayName } from "./providerSkills";

type SlashItem = Extract<ComposerCommandItem, { type: "slash-command" }>;
type SlashSearchItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "skill" }
>;
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
  skills: readonly Skill[] = [],
): SlashSearchItem[] {
  const items: SlashSearchItem[] = commands.filter(
    (item) =>
      planSupported || (item.command !== "plan" && item.command !== "default"),
  );
  items.push(...skillCommandItems(skills, "", true));
  const normalized = normalizeSearchQuery(query, {
    trimLeadingPattern: /^\/+/,
  });
  if (!normalized) return items;
  const ranked: { item: SlashSearchItem; score: number; tieBreaker: string }[] =
    [];
  for (const item of items) {
    if (item.type === "skill") {
      const skillQuery = normalized.startsWith("skill:")
        ? normalized.slice(6)
        : normalized;
      const score =
        normalized === "skill" || !skillQuery
          ? 0
          : (scoreProviderSkill(item.skill, skillQuery) ??
            ("skill".startsWith(normalized) ? Number.MAX_SAFE_INTEGER : null));
      if (score !== null)
        insertRankedSearchResult(
          ranked,
          { item, score, tieBreaker: `2\u0000${item.skill.name}\u0000codex` },
          Infinity,
        );
      continue;
    }
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
        {
          item,
          score: Math.min(...scores),
          tieBreaker: `0\u0000${item.command}`,
        },
        Infinity,
      );
  }
  return ranked.map((result) => result.item);
}

export function skillCommandItems(
  skills: readonly Skill[],
  query: string,
  slash = false,
): Extract<ComposerCommandItem, { type: "skill" }>[] {
  return searchProviderSkills(skills, query).map((skill) => ({
    id: `skill:codex:${skill.name}`,
    type: "skill",
    skill,
    label: slash
      ? `/skill:${skill.name}`
      : formatProviderSkillDisplayName(skill),
    description:
      skill.shortDescription ??
      skill.description ??
      (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
  }));
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
