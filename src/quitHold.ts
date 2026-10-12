// Ported from T3 Code v0.0.45 apps/web/src/components/QuitHoldOverlay.tsx (MIT): hint timing and text.
import { z } from "zod";
import { isMacPlatform } from "./lib/utils";

export const HOLD_HINT_LINGER_MS = 1200;

export const quitShortcutHint = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("down"),
    mode: z.enum(["hold", "double-click"]),
  }),
  z.object({ state: z.literal("up") }),
]);
export type QuitShortcutHint = z.infer<typeof quitShortcutHint>;
export type QuitHintMode = "hold" | "double-click";

type Timers = {
  set: (run: () => void, ms: number) => number;
  clear: (id: number | undefined) => void;
};

export function quitHintReceiver(
  show: (mode: QuitHintMode | null) => void,
  timers: Timers,
) {
  let hideTimer: number | undefined;
  let pressedMode: QuitHintMode = "hold";
  return {
    receive(hint: QuitShortcutHint) {
      timers.clear(hideTimer);
      if (hint.state === "down") {
        pressedMode = hint.mode;
        show(hint.mode);
        return;
      }
      if (pressedMode === "double-click") {
        show(null);
        return;
      }
      hideTimer = timers.set(() => show(null), HOLD_HINT_LINGER_MS);
    },
    dispose() {
      timers.clear(hideTimer);
    },
  };
}

export function quitHintMessage(mode: QuitHintMode, platform: string): string {
  const shortcut = isMacPlatform(platform) ? "⌘Q" : "Ctrl+Q";
  return mode === "hold"
    ? `Hold ${shortcut} or press twice to quit`
    : `Press ${shortcut} again to quit`;
}
