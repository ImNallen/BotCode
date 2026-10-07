// Ported from T3 Code v0.0.45 apps/web/src/providerSkillSearch.ts (MIT).
import type { Skill } from "../ipc";
import {
  dedupeProviderSkillsByName,
  formatProviderSkillDisplayName,
  isProviderSkillUserInvocable,
} from "./providerSkills";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "../lib/searchRanking";

export function scoreProviderSkill(skill: Skill, query: string): number | null {
  const normalizedName = skill.name.toLowerCase();
  const normalizedLabel = formatProviderSkillDisplayName(skill).toLowerCase();
  const normalizedShortDescription =
    skill.shortDescription?.toLowerCase() ?? "";
  const normalizedDescription = skill.description?.toLowerCase() ?? "";
  const normalizedScope = skill.scope?.toLowerCase() ?? "";

  const scores = [
    scoreQueryMatch({
      value: normalizedName,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: normalizedLabel,
      query,
      exactBase: 1,
      prefixBase: 3,
      boundaryBase: 5,
      includesBase: 7,
      fuzzyBase: 110,
    }),
    scoreQueryMatch({
      value: normalizedShortDescription,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
    scoreQueryMatch({
      value: normalizedDescription,
      query,
      exactBase: 30,
      prefixBase: 32,
      boundaryBase: 34,
      includesBase: 36,
    }),
    scoreQueryMatch({
      value: normalizedScope,
      query,
      exactBase: 40,
      prefixBase: 42,
      includesBase: 44,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

export function searchProviderSkills(
  skills: ReadonlyArray<Skill>,
  query: string,
  limit = Number.POSITIVE_INFINITY,
): Skill[] {
  const enabledSkills = dedupeProviderSkillsByName(
    skills.filter(isProviderSkillUserInvocable),
  );
  const normalizedQuery = normalizeSearchQuery(query, {
    trimLeadingPattern: /^\p{Sc}+/u,
  });

  if (!normalizedQuery) {
    return enabledSkills;
  }

  const ranked: Array<{
    item: Skill;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const skill of enabledSkills) {
    const score = scoreProviderSkill(skill, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item: skill,
        score,
        tieBreaker: `${formatProviderSkillDisplayName(skill).toLowerCase()}\u0000${skill.name}`,
      },
      limit,
    );
  }

  return ranked.map((entry) => entry.item);
}
