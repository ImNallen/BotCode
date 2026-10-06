// Ported from pingdotgg/t3code v0.0.45 apps/web/src/keybindings.ts, lib/terminalFocus.ts and the
// terminal rows of packages/shared/src/keybindings.ts DEFAULT_KEYBINDINGS (MIT).
import { isMacPlatform } from "../lib/utils";

type KeyEventLike = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
> & { type?: string };

export type TerminalCommand =
  | "terminal.toggle"
  | "terminal.split"
  | "terminal.splitVertical"
  | "terminal.new"
  | "terminal.close";

const TERMINAL_WORD_BACKWARD = "\u001bb";
const TERMINAL_WORD_FORWARD = "\u001bf";
const TERMINAL_LINE_START = "\u0001";
const TERMINAL_LINE_END = "\u0005";
const TERMINAL_DELETE_TO_LINE_START = "\u0015";

// mod is Command on macOS and Control elsewhere. Every command except the
// toggle applies only while a terminal has focus.
const TERMINAL_BINDINGS: ReadonlyArray<{
  key: string;
  shift: boolean;
  command: TerminalCommand;
}> = [
  { key: "j", shift: false, command: "terminal.toggle" },
  { key: "d", shift: false, command: "terminal.split" },
  { key: "d", shift: true, command: "terminal.splitVertical" },
  { key: "n", shift: false, command: "terminal.new" },
  { key: "w", shift: false, command: "terminal.close" },
];

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

function resolveEventKey(event: KeyEventLike): string {
  const layoutKey = normalizeEventKey(event.key);
  if (/^[a-z]$/.test(layoutKey)) return layoutKey;
  // Non-Latin layouts and Option-modified keys fall back to the physical key.
  return event.code.match(/^Key([A-Z])$/)?.[1]?.toLowerCase() ?? layoutKey;
}

export function terminalShortcutCommand(
  event: KeyEventLike,
  platform = navigator.platform,
): TerminalCommand | null {
  if (event.type !== undefined && event.type !== "keydown") return null;
  const mac = isMacPlatform(platform);
  if (event.altKey || event.metaKey !== mac || event.ctrlKey === mac)
    return null;
  const key = resolveEventKey(event);
  return (
    TERMINAL_BINDINGS.find(
      (binding) => binding.key === key && binding.shift === event.shiftKey,
    )?.command ?? null
  );
}

export function isTerminalClearShortcut(
  event: KeyEventLike,
  platform = navigator.platform,
): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }

  const key = event.key.toLowerCase();

  if (
    key === "l" &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    return true;
  }

  return (
    isMacPlatform(platform) &&
    key === "k" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function terminalDeleteShortcutData(
  event: KeyEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (!isMacPlatform(platform)) {
    return null;
  }

  const key = normalizeEventKey(event.key);
  if (key !== "backspace") {
    return null;
  }

  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    ? TERMINAL_DELETE_TO_LINE_START
    : null;
}

export function terminalNavigationShortcutData(
  event: KeyEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (event.shiftKey) return null;

  const key = normalizeEventKey(event.key);
  if (key !== "arrowleft" && key !== "arrowright") {
    return null;
  }

  const moveWord =
    key === "arrowleft" ? TERMINAL_WORD_BACKWARD : TERMINAL_WORD_FORWARD;
  const moveLine =
    key === "arrowleft" ? TERMINAL_LINE_START : TERMINAL_LINE_END;

  if (isMacPlatform(platform)) {
    if (event.altKey && !event.metaKey && !event.ctrlKey) {
      return moveWord;
    }
    if (event.metaKey && !event.altKey && !event.ctrlKey) {
      return moveLine;
    }
    return null;
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    return moveWord;
  }

  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    return moveWord;
  }

  return null;
}

/** Whether keyboard focus is inside the terminal drawer. */
export function isTerminalFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  return activeElement.closest("[data-terminal-owner]") !== null;
}
