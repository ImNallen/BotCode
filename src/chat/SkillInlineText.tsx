// Ported from T3 Code v0.0.45 apps/web/src/components/chat/SkillInlineText.tsx and components/composerInlineChip.ts (MIT).
import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import type { Skill } from "../ipc";
import { formatProviderSkillDisplayName } from "./providerSkills";

import { ContextChip, ContextChipLabel } from "./ContextChip";

import { SKILL_TOKEN_REGEX } from "./composerSkillTokens";

type InlineSkill = Pick<Skill, "name" | "displayName">;

export function SkillInlineText(props: {
  text: string;
  skills: ReadonlyArray<InlineSkill>;
}) {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of Array.from(props.text.matchAll(SKILL_TOKEN_REGEX))) {
    const prefix = match[1] ?? "";
    const name = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const rawText = `$${name}`;
    const skill = props.skills.find((candidate) => candidate.name === name);
    if (!skill) {
      continue;
    }

    if (start > cursor) {
      nodes.push(props.text.slice(cursor, start));
    }
    nodes.push(
      <SkillChip key={`${start}:${name}`} skill={skill} rawText={rawText} />,
    );
    cursor = (match.index ?? 0) + match[0].length;
  }

  if (cursor === 0) {
    return <>{props.text}</>;
  }
  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<InlineSkill>,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} skills={skills} />;
    }
    if (
      !isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(
        child,
      )
    ) {
      return child;
    }
    const markdownTagName =
      typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (markdownTagName === "code" || markdownTagName === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSkillInlineMarkdownChildren(child.props.children, skills),
    );
  });
}

function SkillChip(props: { skill: InlineSkill; rawText: string }) {
  return (
    <ContextChip kind="skill" data-markdown-copy={props.rawText}>
      <SkillChipIcon />
      <ContextChipLabel>
        {formatProviderSkillDisplayName(props.skill)}
      </ContextChipLabel>
    </ContextChip>
  );
}

export function SkillChipIcon() {
  return (
    <span
      aria-hidden="true"
      className="contents"
      dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
    />
  );
}

export const SKILL_CHIP_ICON_SVG = `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;
