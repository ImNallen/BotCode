// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/chat/ChatHeader.tsx (MIT).
import { EllipsisIcon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { Button } from "../ui/controls";
import { Menu } from "../ui/menu";

export type HeaderActionsPresentation = "toolbar" | "menu";

export function headerActionsCollapsed(width: number, mobile: boolean) {
  return mobile || width < 512;
}

const MOBILE_QUERY = "(max-width: 767px)";
const subscribeMobile = (callback: () => void) => {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
};
const mobileSnapshot = () => window.matchMedia(MOBILE_QUERY).matches;

export function ChatHeaderActions({
  className,
  hasActions,
  children,
}: {
  className: string;
  hasActions: boolean;
  children: (
    presentation: HeaderActionsPresentation,
    closeMenu: () => void,
  ) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mobile = useSyncExternalStore(subscribeMobile, mobileSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  useLayoutEffect(() => {
    const container = ref.current?.parentElement;
    if (!container) return;
    const update = () =>
      setCollapsed(headerActionsCollapsed(container.clientWidth, mobile));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [mobile]);
  const [open, setOpen] = useState(false);
  const [actionsContainer] = useState(() => {
    const container = document.createElement("div");
    container.className = "contents";
    return container;
  });
  const mountInlineActions = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && !collapsed) node.appendChild(actionsContainer);
    },
    [actionsContainer, collapsed],
  );
  const mountMenuActions = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && collapsed) node.appendChild(actionsContainer);
    },
    [actionsContainer, collapsed],
  );
  if (!collapsed && open) setOpen(false);
  return (
    <div
      ref={ref}
      data-chat-header-actions
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
        className,
        "[[data-panel-animations=true]_&]:motion-safe:transition-[padding-right] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
      )}
    >
      <Menu
        keepMounted
        open={collapsed && open}
        onOpenChange={setOpen}
        align="end"
        label="Header actions"
        trigger={(props) => (
          <Button
            {...props}
            size="icon-sm"
            variant="ghost"
            aria-label="More header actions"
            className={collapsed && hasActions ? undefined : "hidden"}
          >
            <EllipsisIcon className="size-4" />
          </Button>
        )}
      >
        <div ref={mountMenuActions} className="contents" />
        {createPortal(
          children(collapsed ? "menu" : "toolbar", () => setOpen(false)),
          actionsContainer,
        )}
      </Menu>
      <div ref={mountInlineActions} className="contents" />
    </div>
  );
}
