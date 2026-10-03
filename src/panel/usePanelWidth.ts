// Width clamping and drag lifecycle follow pingdotgg/t3code v0.0.45
// components/preview/PreviewPanelShell.tsx, hooks/useResizableWidth.ts and hooks/useResizeDrag.ts (MIT).
import {
  type PointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const STORAGE_KEY = "z1:right-panel-width";
const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 540;
const MAX_WIDTH_FRACTION = 0.7;
const SIBLING_COLUMN_MIN_WIDTH = 360;

function readStoredWidth(): number {
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  return localStorage.getItem(STORAGE_KEY) !== null && Number.isFinite(stored)
    ? stored
    : DEFAULT_WIDTH;
}

function useMaxWidth(
  host: RefObject<HTMLElement | null>,
  enabled: boolean,
): number {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [row, setRow] = useState<number>();
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setViewport(window.innerWidth);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(frame);
    };
  }, []);
  useLayoutEffect(() => {
    const parent = host.current?.parentElement;
    if (!enabled || !parent) return;
    const measure = () => setRow(parent.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [host, enabled]);
  const rowCap =
    row === undefined ? Infinity : Math.floor(row) - SIBLING_COLUMN_MIN_WIDTH;
  return Math.max(
    MIN_WIDTH,
    Math.min(Math.floor(viewport * MAX_WIDTH_FRACTION), rowCap),
  );
}

export function usePanelWidth(
  host: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const maxWidth = useMaxWidth(host, enabled);
  const [stored, setStored] = useState(readStoredWidth);
  const width = Math.max(MIN_WIDTH, Math.min(maxWidth, stored));
  const clampRef = useRef((value: number) => value);
  clampRef.current = (value) => Math.max(MIN_WIDTH, Math.min(maxWidth, value));
  const drag = useRef<{
    target: HTMLElement;
    pointerId: number;
    startX: number;
    startWidth: number;
    pendingX: number;
    width: number;
    frame: number | null;
  } | null>(null);

  const flush = () => {
    const active = drag.current;
    if (!active) return;
    active.width = clampRef.current(
      active.startWidth - (active.pendingX - active.startX),
    );
    setStored(active.width);
  };
  const finish = (commit: boolean) => {
    const active = drag.current;
    if (!active) return;
    if (active.frame !== null) cancelAnimationFrame(active.frame);
    if (commit) flush();
    drag.current = null;
    if (active.target.hasPointerCapture(active.pointerId))
      active.target.releasePointerCapture(active.pointerId);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    if (commit) localStorage.setItem(STORAGE_KEY, String(active.width));
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const onBlur = () => finishRef.current(true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      finishRef.current(false);
    };
  }, []);

  const end = (event: PointerEvent<HTMLElement>, usePosition: boolean) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (usePosition) active.pendingX = event.clientX;
    finish(true);
  };

  const handlers = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (event.button !== 0 || drag.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      drag.current = {
        target: event.currentTarget,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: width,
        pendingX: event.clientX,
        width,
        frame: null,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const active = drag.current;
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      active.pendingX = event.clientX;
      if (active.frame !== null) return;
      active.frame = requestAnimationFrame(() => {
        active.frame = null;
        flush();
      });
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => end(event, true),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => end(event, false),
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) =>
      end(event, false),
  };
  return { width, handlers };
}
