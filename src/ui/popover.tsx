// Popup classes copied from pingdotgg/t3code v0.0.45 components/ui/popover.tsx (MIT).
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

const VIEWPORT_MARGIN = 8;

export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  align = "center",
  sideOffset = 4,
  className,
  padding = "default",
  "aria-label": ariaLabel,
  "data-theme-editor-panel": themeEditorPanel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: (props: {
    ref: (node: HTMLElement | null) => void;
    onClick: () => void;
    "aria-haspopup": "dialog";
    "aria-expanded": boolean;
    "data-popup-open"?: "";
  }) => ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  padding?: "default" | "none";
  "aria-label"?: string;
  "data-theme-editor-panel"?: string;
}) {
  const anchor = useRef<HTMLElement | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const setOpen = useRef(onOpenChange);
  setOpen.current = onOpenChange;

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      return;
    }
    const place = () => {
      const target = anchor.current;
      if (!target || !popup.current) return;
      const rect = target.getBoundingClientRect();
      const { width, height } = popup.current.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - sideOffset;
      const above = rect.top - sideOffset;
      const flip = below < height + VIEWPORT_MARGIN && above > below;
      const desiredLeft =
        align === "start"
          ? rect.left
          : align === "end"
            ? rect.right - width
            : rect.left + (rect.width - width) / 2;
      setPosition({
        position: "fixed",
        left: Math.max(
          VIEWPORT_MARGIN,
          Math.min(desiredLeft, window.innerWidth - width - VIEWPORT_MARGIN),
        ),
        top: Math.max(
          VIEWPORT_MARGIN,
          flip ? rect.top - sideOffset - height : rect.bottom + sideOffset,
        ),
        "--available-width": `${window.innerWidth - 2 * VIEWPORT_MARGIN}px`,
        "--available-height": `${Math.max(flip ? above : below, 0) - VIEWPORT_MARGIN}px`,
      } as CSSProperties);
    };
    place();
    const observer = new ResizeObserver(place);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open, align, sideOffset]);

  useEffect(() => {
    if (!open) return;
    popup.current
      ?.querySelector<HTMLElement>(
        'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      )
      ?.focus();
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !popup.current?.contains(target) &&
        !anchor.current?.contains(target)
      )
        setOpen.current(false);
    };
    // Capture and cancel Escape so an enclosing modal dialog does not close too.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen.current(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
      const focused = document.activeElement;
      if (!focused || focused === document.body || focused.tagName === "DIALOG")
        anchor.current?.focus();
    };
  }, [open]);

  return (
    <>
      {trigger({
        ref: (node) => {
          anchor.current = node;
        },
        onClick: () => onOpenChange(!open),
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        ...(open ? { "data-popup-open": "" } : {}),
      })}
      {open
        ? createPortal(
            <div
              className="z-[130] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-transform data-instant:transition-none"
              data-slot="popover-positioner"
              style={
                position ?? { position: "fixed", left: 0, top: 0, opacity: 0 }
              }
            >
              <div
                ref={popup}
                role="dialog"
                aria-label={ariaLabel}
                data-theme-editor-panel={themeEditorPanel}
                className={cn(
                  "dropdown-glass relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg text-popover-foreground outline-none transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] has-data-[slot=calendar]:rounded-xl has-data-[slot=calendar]:before:rounded-[calc(var(--radius-xl)-1px)] data-starting-style:scale-98 data-starting-style:opacity-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
                  "shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
                  className,
                )}
                data-slot="popover-popup"
              >
                <div
                  className={cn(
                    "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) has-data-[slot=calendar]:p-2 data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
                    padding === "none"
                      ? "rounded-[calc(var(--radius-lg)-1px)] py-0 [--viewport-inline-padding:0px]"
                      : "py-4 [--viewport-inline-padding:--spacing(4)]",
                    "not-data-transitioning:overflow-y-auto",
                  )}
                  data-slot="popover-viewport"
                >
                  {children}
                </div>
              </div>
            </div>,
            anchor.current?.closest("dialog[open]") ?? document.body,
          )
        : null}
    </>
  );
}
