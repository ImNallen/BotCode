// Ported from pingdotgg/t3code v0.0.45 apps/web/src/keybindings.ts and lib/terminalFocus.ts (MIT).
import { isMacPlatform } from "./utils";
import type { ShortcutMatchContext } from "../keybindings/keyboard";
export function currentShortcutContext(
  platform = navigator.platform,
): ShortcutMatchContext {
  const active =
    typeof document === "undefined" ? null : document.activeElement;
  const has = (selector: string) =>
    typeof document !== "undefined" &&
    [...document.querySelectorAll(selector)].some(
      (element) => !element.closest("[inert], [hidden]"),
    );
  return {
    terminalFocus:
      active?.closest(
        ".xterm, .thread-terminal-drawer, [data-terminal-owner]",
      ) !== null && active !== null,
    terminalOpen: has("[data-terminal-owner]"),
    previewFocus: false,
    previewOpen: false,
    isDesktop: true,
    isWeb: false,
    isMac: isMacPlatform(platform),
    editableFocus:
      active !== null &&
      typeof HTMLElement !== "undefined" &&
      active instanceof HTMLElement &&
      (active.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)),
    modelPickerOpen: has('[data-model-picker-open="true"]'),
    usagePageOpen:
      typeof location !== "undefined" && location.pathname === "/usage",
    settingsPageOpen:
      typeof location !== "undefined" &&
      location.pathname.startsWith("/settings"),
  };
}
