// Adapted from pingdotgg/t3code v0.0.45 commandPaletteBus.ts (MIT).
const OPEN = "bot-code:command-palette-open";
export type PaletteIntent = "root" | "new-thread-in" | "add-project";
export function openCommandPalette(intent: PaletteIntent = "root") {
  window.dispatchEvent(
    new CustomEvent<PaletteIntent>(OPEN, { detail: intent }),
  );
}
export function subscribeCommandPaletteOpen(
  open: (intent: PaletteIntent) => void,
) {
  const listener = (event: Event) => {
    const intent: unknown =
      event instanceof CustomEvent ? event.detail : "root";
    open(
      intent === "new-thread-in" || intent === "add-project" ? intent : "root",
    );
  };
  window.addEventListener(OPEN, listener);
  return () => window.removeEventListener(OPEN, listener);
}
export function isCommandPaletteOpen() {
  return document.querySelector("[data-command-palette]") !== null;
}
export function focusComposer() {
  document
    .querySelector<HTMLElement>(
      '[role="textbox"][contenteditable="true"][aria-label="Message"]:not([aria-readonly="true"])',
    )
    ?.focus({ preventScroll: true });
}
