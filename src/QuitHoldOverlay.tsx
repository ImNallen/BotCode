// Ported from T3 Code v0.0.45 apps/web/src/components/QuitHoldOverlay.tsx (MIT).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { native } from "./ipc";
import {
  quitHintMessage,
  quitHintReceiver,
  quitShortcutHint,
  type QuitHintMode,
} from "./quitHold";

export function QuitHoldOverlay() {
  const [visibleMode, setVisibleMode] = useState<QuitHintMode | null>(null);

  useEffect(() => {
    if (!native) return;
    const receiver = quitHintReceiver(setVisibleMode, {
      set: (run, ms) => window.setTimeout(run, ms),
      clear: (id) => window.clearTimeout(id),
    });
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<unknown>("bot:quit-shortcut", ({ payload }) => {
      const hint = quitShortcutHint.safeParse(payload);
      if (hint.success) receiver.receive(hint.data);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
      receiver.dispose();
    };
  }, []);

  if (!visibleMode) return null;
  return (
    <QuitHint message={quitHintMessage(visibleMode, navigator.platform)} />
  );
}

// A manual popover sits in the top layer, above a modal <dialog>, which T3's z-100 cannot rise over.
function QuitHint({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const hint = ref.current;
    hint?.showPopover();
    return () => hint?.hidePopover();
  }, []);
  return (
    <div
      ref={ref}
      popover="manual"
      role="status"
      className="pointer-events-none fixed inset-x-0 top-[22%] z-100 flex justify-center bottom-auto m-0 w-auto overflow-visible border-0 bg-transparent p-0"
    >
      <div className="rounded-full bg-foreground/95 px-8 py-4 text-2xl font-bold text-background shadow-xl">
        {message}
      </div>
    </div>
  );
}
