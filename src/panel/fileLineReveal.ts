// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/files/FilePreviewPanel.tsx and fileLineReveal.ts (MIT).
import { VirtualizedFile, type FileOptions } from "@pierre/diffs";
import { useCallback, useRef } from "react";

export function clampFileLine(contents: string, line: number): number {
  const count =
    contents === ""
      ? 1
      : contents.split("\n").length - Number(contents.endsWith("\n"));
  return Math.max(1, Math.min(Math.floor(line), count));
}
export function centeredFileLineScrollTop({
  scrollHeight,
  viewportHeight,
  fileTop,
  top,
  height,
}: {
  scrollHeight: number;
  viewportHeight: number;
  fileTop: number;
  top: number;
  height: number;
}) {
  return Math.max(
    0,
    Math.min(
      fileTop + top - Math.max(0, (viewportHeight - height) / 2),
      scrollHeight - viewportHeight,
    ),
  );
}
type PostRender = NonNullable<
  FileOptions<undefined, undefined>["onPostRender"]
>;
export function useFileLineReveal(
  path: string,
  line: number | null,
  sequence: number,
): PostRender {
  const state = useRef<{
    frame: number | null;
    cancelGuard: (() => void) | null;
    request: number | null;
    handled: number | null;
  }>({ frame: null, cancelGuard: null, request: null, handled: null });
  return useCallback<PostRender>(
    (container, instance, phase) => {
      const reveal = state.current;
      const cancel = () => {
        if (reveal.frame !== null) cancelAnimationFrame(reveal.frame);
        reveal.frame = null;
        reveal.cancelGuard?.();
      };
      if (phase === "unmount") {
        cancel();
        reveal.handled = null;
        return;
      }
      if (reveal.request !== sequence) {
        cancel();
        reveal.request = sequence;
        reveal.handled = null;
      }
      if (line === null) {
        cancel();
        reveal.handled = null;
        container.style.minHeight = "";
        return;
      }
      if (
        !(instance instanceof VirtualizedFile) ||
        reveal.handled === sequence ||
        reveal.frame !== null
      )
        return;
      const viewport = container.closest<HTMLElement>(
        ".file-preview-virtualizer",
      );
      if (!viewport) return;
      container.style.minHeight = `${Math.ceil(Math.max(instance.height, viewport.clientHeight))}px`;
      const resolveTarget = (target: number) => {
        const position = instance.getLinePosition(target);
        if (!position) return null;
        const viewportRect = viewport.getBoundingClientRect();
        const fileTop =
          viewport.scrollTop +
          container.getBoundingClientRect().top -
          viewportRect.top;
        const root = container.shadowRoot ?? container;
        const rendered = root
          .querySelector<HTMLElement>(`[data-line="${target}"]`)
          ?.getBoundingClientRect();
        return centeredFileLineScrollTop({
          scrollHeight: viewport.scrollHeight,
          viewportHeight: viewport.clientHeight,
          fileTop,
          top:
            rendered && rendered.height > 0
              ? viewport.scrollTop + rendered.top - viewportRect.top - fileTop
              : position.top,
          height:
            rendered && rendered.height > 0 ? rendered.height : position.height,
        });
      };
      const guard = (target: number) => {
        let frames = 20;
        let frame: number | null = null;
        const stop = () => {
          if (frame !== null) cancelAnimationFrame(frame);
          frame = null;
          viewport.removeEventListener("wheel", stop);
          viewport.removeEventListener("touchstart", stop);
          viewport.removeEventListener("pointerdown", stop, true);
          window.removeEventListener("keydown", stop, true);
          if (reveal.cancelGuard === stop) reveal.cancelGuard = null;
        };
        viewport.addEventListener("wheel", stop, { passive: true });
        viewport.addEventListener("touchstart", stop, { passive: true });
        viewport.addEventListener("pointerdown", stop, {
          passive: true,
          capture: true,
        });
        window.addEventListener("keydown", stop, true);
        const hold = () => {
          frame = null;
          if (--frames <= 0 || !viewport.isConnected) {
            stop();
            return;
          }
          const top = resolveTarget(target);
          if (top !== null && Math.abs(viewport.scrollTop - top) > 2)
            viewport.scrollTop = top;
          frame = requestAnimationFrame(hold);
        };
        frame = requestAnimationFrame(hold);
        reveal.cancelGuard = stop;
      };
      const schedule = (attempt: number) => {
        reveal.frame = requestAnimationFrame(() => {
          reveal.frame = null;
          if (!container.isConnected || reveal.request !== sequence) return;
          const contents = instance.file?.contents;
          const target =
            contents === undefined ? null : clampFileLine(contents, line);
          const top = target === null ? null : resolveTarget(target);
          if (target === null || top === null) {
            if (attempt < 30) schedule(attempt + 1);
            return;
          }
          viewport.scrollTop = top;
          container.dataset.revealedLine = String(target);
          reveal.handled = sequence;
          guard(target);
        });
      };
      schedule(0);
    },
    [path, line, sequence],
  );
}
