// Popup classes ported from T3 Code v0.0.45 components/ui/tooltip.tsx (MIT).
import {
  cloneElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ButtonHTMLAttributes,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

export function Tooltip({
  children,
  content,
  side = "top",
}: {
  children: ReactElement<
    ButtonHTMLAttributes<HTMLButtonElement> & {
      "data-slot"?: string;
      ref?: Ref<HTMLButtonElement>;
    }
  >;
  content: string;
  side?: "top" | "bottom";
}) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!anchor.current || !popup.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const { width, height } = popup.current.getBoundingClientRect();
      setPosition({
        left: Math.max(
          8,
          Math.min(
            rect.left + (rect.width - width) / 2,
            window.innerWidth - width - 8,
          ),
        ),
        top:
          side === "bottom" &&
          rect.bottom + 4 + height <= window.innerHeight - 8
            ? rect.bottom + 4
            : rect.top - height - 4 >= 8
              ? rect.top - height - 4
              : rect.bottom + 4,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, side]);
  return (
    <>
      {cloneElement(children, {
        // A trigger that is also a popover anchor keeps its own ref.
        ref: (node: HTMLButtonElement | null) => {
          anchor.current = node;
          const ref = children.props.ref;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        },
        "aria-describedby": open ? id : undefined,
        "data-slot": "tooltip-trigger",
        onPointerEnter: (event) => {
          children.props.onPointerEnter?.(event);
          setOpen(true);
        },
        onPointerLeave: (event) => {
          children.props.onPointerLeave?.(event);
          setOpen(false);
        },
        onFocus: (event) => {
          children.props.onFocus?.(event);
          setOpen(true);
        },
        onBlur: (event) => {
          children.props.onBlur?.(event);
          setOpen(false);
        },
        onKeyDownCapture: (event) => {
          children.props.onKeyDownCapture?.(event);
          if (event.key === "Escape") setOpen(false);
        },
        onKeyDown: (event) => {
          children.props.onKeyDown?.(event);
          if (event.key === "Escape") setOpen(false);
        },
      })}
      {open &&
        createPortal(
          <div
            ref={popup}
            style={{ position: "fixed", ...position }}
            data-slot="tooltip-positioner"
            className="pointer-events-none z-[140] max-w-[calc(100vw-16px)]"
          >
            <div
              id={id}
              role="tooltip"
              data-slot="tooltip-popup"
              className="relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md text-popover-foreground text-xs transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)] border bg-popover not-dark:bg-clip-padding shadow-md/5 max-w-80 wrap-anywhere whitespace-normal leading-snug"
            >
              <div
                data-slot="tooltip-viewport"
                className="relative size-full overflow-clip px-2 py-1"
              >
                {content}
              </div>
            </div>
          </div>,
          anchor.current?.closest("dialog") ?? document.body,
        )}
    </>
  );
}
