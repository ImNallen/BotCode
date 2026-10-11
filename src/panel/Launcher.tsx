// Ported from T3 Code v0.0.45 apps/web/src/components/RightPanelTabs.tsx (MIT).
import { BotIcon, type LucideIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { isCommandPaletteOpen } from "../lib/commandPaletteBus";
import { cn } from "../lib/cn";
import { Kbd } from "./chrome";
import type { Surface } from "./RightPanel";

export type SurfaceAction = {
  label: string;
  icon: LucideIcon;
  shortcut: string;
  onSelect: () => void;
  unavailable?: { hint: string; reason: string };
  badgeCount?: number;
};

export function agentsAction(
  liveCount: number,
  open: (surface: Surface) => void,
): SurfaceAction {
  return {
    label: "Agents",
    icon: BotIcon,
    shortcut: "A",
    onSelect: () => open({ kind: "agents" }),
    badgeCount: liveCount,
  };
}

const LAUNCHER_SHORTCUT_BLOCKING_LAYERS =
  '[data-slot="menu-popup"],[role="dialog"],[aria-modal="true"],dialog[open]';

export function actionForKey(
  event: Pick<
    KeyboardEvent,
    | "altKey"
    | "ctrlKey"
    | "defaultPrevented"
    | "isComposing"
    | "key"
    | "metaKey"
  >,
  actions: readonly SurfaceAction[],
): SurfaceAction | undefined {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  return actions.find(
    (action) =>
      !action.unavailable &&
      action.shortcut.toLowerCase() === event.key.toLowerCase(),
  );
}

const targetsTypingContext = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  ) !== null;

function ActionIcon({ action }: { action: SurfaceAction }) {
  return (
    <span className="relative inline-flex shrink-0">
      <action.icon className="size-4" />
      {action.badgeCount ? (
        <span
          aria-hidden
          className="absolute -top-1.5 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold tabular-nums text-white"
        >
          {action.badgeCount}
        </span>
      ) : null}
    </span>
  );
}

export function Launcher({ actions }: { actions: readonly SurfaceAction[] }) {
  const [highlight, setHighlight] = useState(-1);
  const availableActions = actions.filter((action) => !action.unavailable);
  const highlightIndex =
    availableActions.length === 0
      ? -1
      : Math.min(highlight, availableActions.length - 1);
  const shortcutActionsRef = useRef(availableActions);
  shortcutActionsRef.current = availableActions;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isCommandPaletteOpen()) return;
      const action = actionForKey(event, shortcutActionsRef.current);
      if (!action) return;
      if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
      if (targetsTypingContext(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      action.onSelect();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
  const focusOnMount = useCallback(
    (node: HTMLDivElement | null) => node?.focus(),
    [],
  );
  const count = availableActions.length;
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    if (count === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlight((highlightIndex + 1) % count);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(
        highlightIndex === -1
          ? count - 1
          : (highlightIndex - 1 + count) % count,
      );
    } else if (event.key === "Enter" && event.target === event.currentTarget) {
      const action = availableActions[highlightIndex];
      if (!action) return;
      event.preventDefault();
      action.onSelect();
    }
  };
  const isHighlighted = (action: SurfaceAction) =>
    highlightIndex !== -1 && availableActions[highlightIndex] === action;
  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Open a surface"
      data-surface-launcher-keys={availableActions
        .map((action) => action.shortcut)
        .join("")}
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 outline-none pb-(--workspace-topbar-height)"
    >
      <div className="w-full max-w-xs py-6">
        <h3 className="mb-3 text-center font-medium text-foreground text-sm">
          Open a surface
        </h3>
        <div className="flex flex-col gap-0.5">
          {actions.map((action) =>
            action.unavailable ? (
              <div
                key={action.label}
                tabIndex={0}
                aria-disabled="true"
                title={action.unavailable.hint}
                className="flex h-8 w-full cursor-default items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm opacity-50"
              >
                <ActionIcon action={action} />
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                <Kbd>{action.shortcut}</Kbd>
              </div>
            ) : (
              <div
                key={action.label}
                className="group relative"
                onMouseEnter={() =>
                  setHighlight(availableActions.indexOf(action))
                }
                onMouseLeave={() =>
                  setHighlight((current) =>
                    current === availableActions.indexOf(action) ? -1 : current,
                  )
                }
              >
                <button
                  type="button"
                  onClick={action.onSelect}
                  className={cn(
                    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors group-hover:bg-accent/60",
                    isHighlighted(action) && "bg-accent/60",
                  )}
                >
                  <ActionIcon action={action} />
                  <span className="min-w-0 flex-1 truncate">
                    {action.label}
                  </span>
                  <Kbd>{action.shortcut}</Kbd>
                </button>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
