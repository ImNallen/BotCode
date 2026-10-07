// Adapted from pingdotgg/t3code v0.0.45 commandPaletteBus.ts (MIT).
const OPEN = "bot-code:command-palette-open";
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN));
}
export function subscribeCommandPaletteOpen(open: () => void) {
  window.addEventListener(OPEN, open);
  return () => window.removeEventListener(OPEN, open);
}
export function isCommandPaletteOpen() {
  return document.querySelector("[data-command-palette]") !== null;
}
export function focusComposer() {
  document
    .querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message"]:not([disabled])',
    )
    ?.focus({ preventScroll: true });
}
