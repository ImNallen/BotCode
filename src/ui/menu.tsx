// Popup and item classes copied from pingdotgg/t3code v0.0.45 components/ui/menu.tsx (MIT).
import {
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { useLocation } from "@tanstack/react-router";

export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 4,
  className,
  onKeyDownCapture,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger: (props: {
    ref: (node: HTMLElement | null) => void;
    onClick: () => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "data-popup-open"?: "";
  }) => ReactNode;
  children: ReactNode;
  side?: "bottom" | "top";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const pathname = useLocation({ select: (location) => location.pathname });
  const previousPathname = useRef(pathname);
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  useEffect(() => {
    if (previousPathname.current !== pathname) setOpenRef.current(false);
    previousPathname.current = pathname;
  }, [pathname]);
  const anchor = useRef<HTMLElement | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const horizontal = Math.min(
      Math.max(8, rect.left),
      Math.max(8, window.innerWidth - 280),
    );
    setPosition({
      maxWidth: "calc(100vw - 16px)",
      ...(side === "bottom"
        ? { top: rect.bottom + sideOffset }
        : { bottom: window.innerHeight - rect.top + sideOffset }),
      ...(align === "start"
        ? { left: horizontal }
        : align === "end"
          ? { right: Math.max(8, window.innerWidth - rect.right) }
          : {
              left: rect.left + rect.width / 2,
              transform: "translateX(-50%)",
            }),
    });
  }, [open, side, align, sideOffset]);
  useEffect(() => {
    if (open && position) {
      const first = popup.current?.querySelector<HTMLElement>(
        '[role="menuitem"]:not([disabled]),[role="menuitemradio"]:not([disabled])',
      );
      (first ?? popup.current)?.focus();
    }
  }, [open, position]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popup.current?.contains(target) && !anchor.current?.contains(target))
        setOpenRef.current(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpenRef.current(false);
        anchor.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <>
      {trigger({
        ref: (node) => {
          anchor.current = node;
        },
        onClick: () => setOpen(!open),
        "aria-haspopup": "menu",
        "aria-expanded": open,
        ...(open ? { "data-popup-open": "" } : {}),
      })}
      {open && position
        ? createPortal(
            <div
              ref={popup}
              role="menu"
              tabIndex={-1}
              data-slot="menu-popup"
              style={position}
              onKeyDownCapture={(event) => {
                onKeyDownCapture?.(event);
                if (event.defaultPrevented) return;
                const items = Array.from(
                  popup.current?.querySelectorAll<HTMLElement>(
                    '[role="menuitem"]:not([disabled]),[role="menuitemradio"]:not([disabled])',
                  ) ?? [],
                );
                if (!items.length) return;
                const index = items.findIndex(
                  (item) => item === document.activeElement,
                );
                let next: number;
                switch (event.key) {
                  case "ArrowDown":
                    next = (index + 1) % items.length;
                    break;
                  case "ArrowUp":
                    next = (index - 1 + items.length) % items.length;
                    break;
                  case "Home":
                    next = 0;
                    break;
                  case "End":
                    next = items.length - 1;
                    break;
                  default:
                    return;
                }
                event.preventDefault();
                items[next]?.focus();
              }}
              onClick={(event) => {
                const item = (event.target as Element).closest(
                  "[role=menuitem],[role=menuitemradio]",
                );
                if (item && !item.hasAttribute("data-keep-open")) {
                  setOpen(false);
                  anchor.current?.focus();
                }
              }}
              className={cn(
                "dropdown-glass fixed z-[130] flex rounded-lg shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none focus:outline-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
                "[-webkit-app-region:no-drag]",
                "min-w-[min(10rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]",
                className,
              )}
            >
              <div className="max-h-80 w-full overflow-y-auto p-1">
                {children}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function MenuItem({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      role="menuitem"
      data-slot="menu-item"
      className={cn(
        "[&>svg]:-mx-0.5 flex min-h-8 w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-left text-base text-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-64 sm:min-h-7 sm:text-sm [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg:not([class*='size-'])]:size-4.5 sm:[&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground [&>svg]:pointer-events-none [&>svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function MenuSeparator() {
  return <div role="separator" className="mx-2 my-1 h-px bg-border" />;
}
