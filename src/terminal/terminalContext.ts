// Ported from T3 Code v0.0.45 apps/web/src/lib/terminalContext.ts and components/ThreadTerminalDrawer.tsx (MIT).
import type { ComposerContextRecord } from "../chat/composerContext";
import { truncateContextText } from "../chat/composerContext";
import type { GhosttySelectionPosition } from "./ghostty/surface";

export function buildTerminalContext(input: {
  contextId: string;
  terminalId: string;
  terminalLabel: string;
  position: GhosttySelectionPosition;
  text: string;
}): Extract<ComposerContextRecord, { kind: "terminal" }> | null {
  const text = input.text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  if (text.length === 0) return null;
  const lineStart = Math.max(1, input.position.start.y + 1);
  const lineEnd = Math.max(lineStart, input.position.end.y + 1);
  const range =
    lineStart === lineEnd
      ? `line ${lineStart}`
      : `lines ${lineStart}-${lineEnd}`;
  return {
    version: 1,
    kind: "terminal",
    contextId: input.contextId,
    label: truncateContextText(`${input.terminalLabel} ${range}`, 200),
    terminalId: input.terminalId,
    terminalLabel: input.terminalLabel,
    lineStart,
    lineEnd,
    text: truncateContextText(text, 64_000),
  };
}
