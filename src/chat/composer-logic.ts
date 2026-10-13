// Ported from T3 Code v0.0.45 apps/web/src/composer-logic.ts and packages/shared/src/composerTrigger.ts (MIT).
import type { SendShortcut } from "../settings/preferences";
export type ComposerTriggerKind =
  | "path"
  | "pull-request"
  | "slash-command"
  | "skill";
export type ComposerSlashCommand =
  | "model"
  | "plan"
  | "default"
  | "usage-limits"
  | "compact";
export type ComposerTrigger = {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
};

const triggerRules: {
  kind: ComposerTriggerKind;
  scope: "line" | "token";
  pattern: RegExp;
}[] = [
  { kind: "slash-command", scope: "line", pattern: /^\/(\S*)$/ },
  {
    kind: "skill",
    scope: "token",
    pattern:
      /^\p{Sc}((?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?$)[a-zA-Z0-9:_-]*)$/u,
  },
  {
    kind: "pull-request",
    scope: "token",
    pattern: /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u,
  },
  { kind: "path", scope: "token", pattern: /^@(.*)$/ },
];

export function detectComposerTrigger(
  text: string,
  cursorInput: number,
): ComposerTrigger | null {
  const cursor = Number.isFinite(cursorInput)
    ? Math.max(0, Math.min(text.length, Math.floor(cursorInput)))
    : text.length;
  const starts = {
    line: cursor === 0 ? 0 : text.lastIndexOf("\n", cursor - 1) + 1,
    token: text.slice(0, cursor).search(/\S*$/),
  };
  for (const rule of triggerRules) {
    const start = starts[rule.scope];
    const match = rule.pattern.exec(text.slice(start, cursor));
    if (match)
      return {
        kind: rule.kind,
        query: match[1] ?? "",
        rangeStart: start,
        rangeEnd: cursor,
      };
  }
  return null;
}

export function replaceTextRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
) {
  const safeStart = Math.max(0, Math.min(text.length, start));
  const safeEnd = Math.max(safeStart, Math.min(text.length, end));
  return {
    text: `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`,
    cursor: safeStart + replacement.length,
  };
}

export function pathBasename(path: string): string {
  return path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1,
  );
}

export function serializeComposerFileLink(path: string): string {
  const label = pathBasename(path)
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  const destination = encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
  return `[${label}](${destination})`;
}

// T3's "background" intent sends a draft without leaving it; L1 Code has no
// background draft submission, so that case sends normally.
export type ComposerEnterIntent = "send" | "alternate" | "newline";

export function composerEnterIntent(input: {
  shiftKey: boolean;
  modifierKey: boolean;
  running: boolean;
  sendShortcut: SendShortcut;
  prompt: string;
}): ComposerEnterIntent {
  const requiresModifier =
    input.sendShortcut === "mod-enter" ||
    (input.sendShortcut === "mod-enter-multiline" &&
      /[\r\n]/.test(input.prompt));
  if (requiresModifier && !input.modifierKey) return "newline";
  if (
    input.shiftKey &&
    !(requiresModifier && input.modifierKey && input.running)
  )
    return "newline";
  if (
    input.running &&
    input.modifierKey &&
    (!requiresModifier || input.shiftKey)
  )
    return "alternate";
  return "send";
}
