// Ported from T3 Code v0.0.45 apps/web/src/components/chat/SkillInlineText.tsx and apps/server/src/provider/Layers/CodexSessionRuntime.ts (MIT).
export const SKILL_TOKEN_REGEX =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

export function normalizeSkillMentions(text: string): string {
  return text.replace(SKILL_TOKEN_REGEX, "$1$$$2");
}

export function isSkillMentionName(name: string): boolean {
  const match = Array.from(`$${name} `.matchAll(SKILL_TOKEN_REGEX))[0];
  return match?.index === 0 && match[2] === name;
}
