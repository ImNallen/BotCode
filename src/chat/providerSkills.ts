// Ported from T3 Code v0.0.45 packages/client-runtime/src/providerSkills.ts (MIT).
import type { Skill } from "../ipc";
import { isSkillMentionName } from "./composerSkillTokens";

export type ProviderSkillSourceKind =
  | "app"
  | "repo"
  | "project"
  | "personal"
  | "system"
  | "other";

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<Skill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<Skill>,
): Skill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const normalizedName = skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

export function isProviderSkillUserInvocable(
  skill: Pick<Skill, "name" | "enabled">,
): boolean {
  return skill.enabled && isSkillMentionName(skill.name);
}

export function resolveProviderSkillSourceKind(
  skill: Pick<Skill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (
    normalizedPath.includes("/.codex/plugins/") ||
    normalizedPath.includes("/.agents/plugins/")
  ) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}
