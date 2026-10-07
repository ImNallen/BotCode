// Ported from T3 Code v0.0.45 packages/shared/src/composerInlineTokens.ts and apps/web/src/composer-rich-text-doc.ts (MIT).
import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { pathBasename } from "./composer-logic";
import { SKILL_TOKEN_REGEX } from "./composerSkillTokens";

export function composerSkills(text: string) {
  return Array.from(text.matchAll(SKILL_TOKEN_REGEX), (match) => {
    const start = match.index + (match[1]?.length ?? 0);
    const end = match.index + match[0].length;
    return { start, end, name: match[2] ?? "", source: text.slice(start, end) };
  });
}

const fileLink = /(^|\s)\[((?:\\.|[^\]\\]){0,512})\]\(([^)\s]+)\)(?=\s|$)/g;
const quotedMention = /(^|\s)@"((?:\\.|[^"\\])*)"(?=\s|$)/g;
type Mention = { start: number; end: number; path: string; source: string };

export function composerMentions(text: string): Mention[] {
  const mentions: Mention[] = [];
  for (const match of text.matchAll(fileLink)) {
    const label = (match[2] ?? "").replace(/\\(.)/g, "$1");
    let path = match[3] ?? "";
    try {
      path = decodeURIComponent(path);
    } catch {
      continue;
    }
    if (
      !path ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
      label !== pathBasename(path)
    )
      continue;
    const start = match.index + (match[1]?.length ?? 0);
    const end = match.index + match[0].length;
    mentions.push({ start, end, path, source: text.slice(start, end) });
  }
  for (const match of text.matchAll(quotedMention)) {
    const path = (match[2] ?? "").replace(/\\(.)/g, "$1");
    if (!path) continue;
    const start = match.index + (match[1]?.length ?? 0);
    const end = match.index + match[0].length;
    mentions.push({ start, end, path, source: text.slice(start, end) });
  }
  return mentions.sort((a, b) => a.start - b.start);
}

export function buildComposerDocument(value: string): JSONContent {
  return {
    type: "doc",
    content: value.split("\n").map((line) => {
      const content: JSONContent[] = [];
      let cursor = 0;
      const mentions = [
        ...composerMentions(line).map((mention) => ({
          ...mention,
          type: "composer-mention",
        })),
        ...composerSkills(line)
          .filter((mention) => mention.end < line.length)
          .map((mention) => ({ ...mention, type: "composer-skill" })),
      ].sort((a, b) => a.start - b.start);
      for (const mention of mentions) {
        if (mention.start < cursor) continue;
        if (mention.start > cursor)
          content.push({
            type: "text",
            text: line.slice(cursor, mention.start),
          });
        content.push({
          type: mention.type,
          attrs: mention,
        });
        cursor = mention.end;
      }
      if (cursor < line.length)
        content.push({ type: "text", text: line.slice(cursor) });
      return { type: "paragraph", content };
    }),
  };
}

type PromptSpan = {
  from: number;
  to: number;
  start: number;
  end: number;
  atom: boolean;
};

export function composerDocumentMap(doc: ProseMirrorNode) {
  let text = "";
  const spans: PromptSpan[] = [];
  doc.forEach((paragraph, position, index) => {
    if (index) {
      spans.push({
        from: position - 1,
        to: position + 1,
        start: text.length,
        end: text.length + 1,
        atom: true,
      });
      text += "\n";
    }
    paragraph.forEach((node, offset) => {
      const source = node.isText
        ? (node.text ?? "")
        : node.type.name === "hardBreak"
          ? "\n"
          : typeof node.attrs.source === "string"
            ? node.attrs.source
            : "";
      const from = position + offset + 1;
      spans.push({
        from,
        to: from + node.nodeSize,
        start: text.length,
        end: text.length + source.length,
        atom: !node.isText,
      });
      text += source;
    });
  });
  return { text, spans, end: Math.max(1, doc.content.size - 1) };
}

export function promptCursor(doc: ProseMirrorNode, position: number): number {
  const map = composerDocumentMap(doc);
  for (const span of map.spans) {
    if (position <= span.from) return span.start;
    if (position < span.to)
      return span.atom ? span.start : span.start + position - span.from;
  }
  return map.text.length;
}

export function editorCursor(doc: ProseMirrorNode, offset: number): number {
  const map = composerDocumentMap(doc);
  for (const span of map.spans) {
    if (offset <= span.start) return span.from;
    if (offset <= span.end)
      return span.atom ? span.to : span.from + offset - span.start;
  }
  return map.end;
}
