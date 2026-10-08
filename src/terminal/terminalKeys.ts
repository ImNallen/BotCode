// Ported from pingdotgg/t3code v0.0.45 apps/web/src/keybindings.ts, lib/terminalFocus.ts and the terminal rows of packages/shared/src/keybindings.ts DEFAULT_KEYBINDINGS (MIT).
import { actionIds, matchesAction } from "../lib/actions";
import { currentShortcutContext } from "../lib/shortcutContext";
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

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

export function terminalShortcutCommand(
  event: KeyEventLike,
  platform = navigator.platform,
  terminalFocus = true,
): TerminalCommand | null {
  for (const id of actionIds) {
    if (
      (id === "terminal.toggle" ||
        id === "terminal.split" ||
        id === "terminal.splitVertical" ||
        id === "terminal.new" ||
        id === "terminal.close") &&
      matchesAction(event, id, platform, {
        ...currentShortcutContext(platform),
        terminalFocus,
      })
    )
      return id;
  }
  return null;
}

export function isTerminalClearShortcut(
  event: KeyEventLike,
  platform = navigator.platform,
): boolean {
  return (
    matchesAction(event, "terminal.clear", platform, {
      ...currentShortcutContext(platform),
      terminalFocus: true,
    }) ||
    matchesAction(event, "terminal.clearControl", platform, {
      ...currentShortcutContext(platform),
      terminalFocus: true,
    })
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

/**
 * Option composes characters on macOS, such as $ and @ on Swedish layouts, as
 * Ghostty's default macos-option-as-alt = false does. The surface encodes these
 * as Alt chords, so they must instead reach its textarea, which forwards the
 * composed text, the same path it gives AltGraph text.
 */
export function isMacOptionText(
  event: KeyEventLike,
  platform = navigator.platform,
): boolean {
  return (
    isMacPlatform(platform) &&
    event.altKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    (event.key === "Dead" || [...event.key].length === 1)
  );
}

/**
 * Command chords are app shortcuts on macOS, but the surface encodes an
 * unhandled one as its bare letter, so Command+R would type "r" into the shell.
 */
export function isMacCommandChord(
  event: KeyEventLike,
  platform = navigator.platform,
): boolean {
  return isMacPlatform(platform) && event.metaKey && !event.ctrlKey;
}

export type TerminalFocusOwner = "drawer" | "right-panel";

export function getTerminalFocusOwner(): TerminalFocusOwner | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  const owner = activeElement.closest<HTMLElement>("[data-terminal-owner]")
    ?.dataset.terminalOwner;
  if (owner === "drawer" || owner === "right-panel") return owner;
  return null;
}

export function isTerminalFocused(): boolean {
  return getTerminalFocusOwner() !== null;
}
