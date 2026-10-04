// Popup and item classes copied from pingdotgg/t3code v0.0.45 components/ui/menu.tsx (MIT).
import {
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CheckIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { useLocation } from "@tanstack/react-router";

export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 4,
  className,
  contentClassName,
  popupKind = { kind: "menu" },
  onKeyDownCapture,
  open: controlledOpen,
  onOpenChange,
  anchor: positionAnchor,
}: {
  trigger: (props: {
    ref: (node: HTMLElement | null) => void;
    onClick: () => void;
    "aria-haspopup": "menu" | "dialog";
    "aria-expanded": boolean;
    "data-popup-open"?: "";
  }) => ReactNode;
  children: ReactNode;
  side?: "bottom" | "top";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  contentClassName?: string;
  popupKind?: { kind: "menu" } | { kind: "dialog"; label: string };
  onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchor?: RefObject<HTMLElement | null>;
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
    if (!open) return;
    const positionPopup = () => {
      const target = positionAnchor?.current ?? anchor.current;
      if (!target || !popup.current) return;
      const rect = target.getBoundingClientRect();
      const width = popup.current.getBoundingClientRect().width;
      const desiredLeft =
        align === "start"
          ? rect.left
          : align === "end"
            ? rect.right - width
            : rect.left + (rect.width - width) / 2;
      const edge =
        side === "bottom"
          ? Math.min(
              window.innerHeight - 8,
              Math.max(8, rect.bottom + sideOffset),
            )
          : Math.min(
              window.innerHeight - 8,
              Math.max(8, rect.top - sideOffset),
            );
      setPosition({
        ...(positionAnchor ? { minWidth: rect.width } : {}),
        maxWidth: "calc(100vw - 16px)",
        left: Math.max(8, Math.min(desiredLeft, window.innerWidth - width - 8)),
        maxHeight: Math.max(
          0,
          side === "bottom" ? window.innerHeight - edge - 8 : edge - 8,
        ),
        ...(side === "bottom"
          ? { top: edge }
          : { bottom: window.innerHeight - edge }),
      });
    };
    positionPopup();
    const observer = new ResizeObserver(positionPopup);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", positionPopup);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", positionPopup);
    };
  }, [open, side, align, sideOffset, positionAnchor]);
  useEffect(() => {
    if (!open) return;
    const first = popup.current?.querySelector<HTMLElement>(
      popupKind.kind === "dialog"
        ? '[role="combobox"]:not([disabled])'
        : '[role="menuitem"]:not([disabled]),[role="menuitemradio"]:not([disabled])',
    );
    (first ?? popup.current)?.focus();
  }, [open, popupKind.kind]);
  const focusReturn = useRef<"open" | "pending" | "idle">(
    open ? "open" : "idle",
  );
  useLayoutEffect(() => {
    if (open) focusReturn.current = "open";
    else if (focusReturn.current === "open") focusReturn.current = "pending";
    if (focusReturn.current !== "pending") return;
    if (document.activeElement !== document.body) {
      focusReturn.current = "idle";
      return;
    }
    if (anchor.current?.matches(":disabled")) return;
    anchor.current?.focus();
    focusReturn.current = "idle";
  });
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
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
        "aria-haspopup": popupKind.kind,
        "aria-expanded": open,
        ...(open ? { "data-popup-open": "" } : {}),
      })}
      {open
        ? createPortal(
            <div
              ref={popup}
              role={popupKind.kind}
              aria-label={
                popupKind.kind === "dialog" ? popupKind.label : undefined
              }
              tabIndex={-1}
              data-slot="menu-popup"
              style={position}
              onKeyDownCapture={(event) => {
                onKeyDownCapture?.(event);
                if (event.defaultPrevented || popupKind.kind === "dialog")
                  return;
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
                if (!(event.target instanceof Element)) return;
                const item = event.target.closest(
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
              <div
                className={cn(
                  "min-h-0 max-h-80 w-full overflow-y-auto p-1",
                  contentClassName,
                )}
              >
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

export function MenuRadioItem({
  checked,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { checked: boolean }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-checked={checked ? "" : undefined}
      data-slot="menu-radio-item"
      className={cn(
        "[&_svg]:-mx-0.5 flex min-h-8 w-full in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-left text-base text-foreground outline-none data-checked:bg-foreground/[0.08] disabled:pointer-events-none disabled:cursor-not-allowed hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

export function MenuRadioItemIndicator({ checked }: { checked: boolean }) {
  return checked ? (
    <span aria-hidden className="flex shrink-0">
      <CheckIcon className="size-3.5" />
    </span>
  ) : null;
}
