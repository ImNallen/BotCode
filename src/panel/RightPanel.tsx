// Shell, tab strip and launcher copied from pingdotgg/t3code v0.0.45 components/RightPanelTabs.tsx,
// preview/PreviewPanelShell.tsx and preview/RightPanelResizeHandle.tsx (MIT).
import {
  FileDiffIcon,
  GitPullRequestIcon,
  FilesIcon,
  PlusIcon,
  type LucideIcon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { CheckoutRef, WorkspaceView } from "../ipc";
import { cn } from "../lib/cn";
import { Button } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import { Kbd, MenuShortcut, PanelTabCloseButton, ScrollRow } from "./chrome";
import { DiffSurface } from "./DiffSurface";
import { FileEntryIcon } from "./FileEntryIcon";
import { FilesSurface } from "./FilesSurface";
import { PullRequestDetail } from "./PullRequestDetail";
import { PullRequestsSurface } from "./PullRequestsSurface";
import type { PullRequestKey, ThreadPrSummary } from "./pullRequests";
import type { ReviewDraftRequest } from "./reviews";
import {
  closeSurface,
  openFile,
  openSurface,
  pullRequestSurface,
  surfaceKey,
  surfaceTitle,
  eligibleSurfaces,
} from "./panelState";
import { usePanelWidth } from "./usePanelWidth";

export type Surface =
  | { kind: "files" }
  | { kind: "diff" }
  | { kind: "pull_requests" }
  | { kind: "pull_request"; key: PullRequestKey }
  | { kind: "file"; path: string };

export type PanelState = { surfaces: Surface[]; active: number | null };

export const emptyPanel: PanelState = { surfaces: [], active: null };

type SurfaceAction = {
  label: string;
  icon: LucideIcon;
  shortcut: string;
  surface: Surface;
};

const SURFACE_ACTIONS: readonly SurfaceAction[] = [
  {
    label: "Files",
    icon: FilesIcon,
    shortcut: "F",
    surface: { kind: "files" },
  },
  {
    label: "Diff",
    icon: FileDiffIcon,
    shortcut: "D",
    surface: { kind: "diff" },
  },
];

const LAUNCHER_SHORTCUT_BLOCKING_LAYERS =
  '[data-slot="menu-popup"],[role="dialog"]';

const FOLDER_ACTIONS = SURFACE_ACTIONS.filter(
  (action) => action.surface.kind === "files",
);

function actionForKey(
  event: KeyboardEvent,
  actions: readonly SurfaceAction[],
): SurfaceAction | undefined {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  return actions.find(
    (action) => action.shortcut.toLowerCase() === event.key.toLowerCase(),
  );
}

const targetsTypingContext = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  ) !== null;

export function RightPanel({
  checkout,
  git,
  view,
  state: savedState,
  onChange,
  maximized,
  conversationId,
  pullRequests,
  canAskCodex,
  onAskCodex,
}: {
  checkout: CheckoutRef;
  git: boolean;
  view: WorkspaceView | undefined;
  state: PanelState;
  onChange: (state: PanelState) => void;
  maximized: boolean;
  conversationId: string | undefined;
  pullRequests: ThreadPrSummary["links"];
  canAskCodex: boolean;
  onAskCodex: (request: ReviewDraftRequest) => void;
}) {
  const state = eligibleSurfaces(
    savedState,
    git,
    conversationId ? pullRequests : undefined,
  );
  const host = useRef<HTMLDivElement>(null);
  const { width, handlers } = usePanelWidth(host, !maximized);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const tabList = useRef<HTMLDivElement>(null);
  const active =
    state.active === null ? undefined : state.surfaces[state.active];
  const available =
    Boolean(conversationId) ||
    (view !== undefined && view.unavailable === null);
  const localAvailable = view !== undefined && view.unavailable === null;
  const prSurface = pullRequestSurface(pullRequests);
  const actions: SurfaceAction[] = [
    ...(conversationId
      ? [
          {
            label: surfaceTitle(prSurface),
            icon: GitPullRequestIcon,
            shortcut: "P",
            surface: prSurface,
          },
        ]
      : []),
    ...(!localAvailable ? [] : git ? SURFACE_ACTIONS : FOLDER_ACTIONS),
  ];
  const open = (surface: Surface) => onChange(openSurface(state, surface));
  const handleOpenFile = (path: string) => onChange(openFile(state, path));

  useEffect(() => {
    tabList.current
      ?.querySelector<HTMLElement>("[data-active-tab='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.active]);

  useEffect(() => {
    const viewport = tabList.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (viewport.scrollWidth <= viewport.clientWidth) return;
      event.preventDefault();
      viewport.scrollLeft += event.deltaY;
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  const handleAddMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = actionForKey(event.nativeEvent, actions);
    if (!action || !available) return;
    event.preventDefault();
    event.stopPropagation();
    setAddMenuOpen(false);
    open(action.surface);
  };

  return (
    <div
      ref={host}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        maximized
          ? "flex-1 border-l border-border"
          : "shrink-0 border-l border-border",
      )}
      style={{ width: maximized ? "100%" : `${width}px` }}
      data-preview-panel-mode="inline"
      data-preview-panel-maximized={maximized ? "true" : "false"}
    >
      {maximized ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none"
          {...handlers}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
          />
        </div>
      )}
      <div className="h-full min-h-0 w-full">
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <div
            className={cn(
              "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2 pr-28 drag-region",
              maximized &&
                "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]",
            )}
            data-right-panel-tabbar
            data-tauri-drag-region="deep"
          >
            <ScrollRow
              viewportRef={tabList}
              className="min-w-0 flex-1"
              data-right-panel-tab-list
            >
              <div className="flex h-full w-max min-w-full items-center gap-1">
                {state.surfaces.map((surface, index) => {
                  const isActive = index === state.active;
                  const title = surfaceTitle(surface);
                  return (
                    <div
                      key={surfaceKey(surface)}
                      data-active-tab={isActive}
                      onMouseDown={(event) => {
                        if (event.button === 1) event.preventDefault();
                      }}
                      onAuxClick={(event) => {
                        if (event.button !== 1) return;
                        event.preventDefault();
                        onChange(closeSurface(state, index));
                      }}
                      className={cn(
                        "cursor-pointer group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs [-webkit-app-region:no-drag]",
                        isActive
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      <PanelTabCloseButton
                        label={`Close ${title}`}
                        onClick={() => onChange(closeSurface(state, index))}
                      >
                        <SurfaceIcon surface={surface} />
                      </PanelTabCloseButton>
                      <button
                        type="button"
                        title={surface.kind === "file" ? surface.path : title}
                        className="cursor-pointer flex min-w-0 items-center"
                        onClick={() => onChange({ ...state, active: index })}
                      >
                        <span className="truncate">{title}</span>
                      </button>
                    </div>
                  );
                })}
                {state.surfaces.length > 0 ? (
                  <Menu
                    open={addMenuOpen}
                    onOpenChange={setAddMenuOpen}
                    sideOffset={6}
                    onKeyDownCapture={handleAddMenuKeyDown}
                    trigger={({ ref, ...props }) => (
                      <Button
                        ref={ref}
                        aria-label="Add panel surface"
                        className="shrink-0 [-webkit-app-region:no-drag]"
                        size="icon-xs"
                        variant="ghost-muted"
                        {...props}
                      >
                        <PlusIcon className="size-3.5" />
                      </Button>
                    )}
                  >
                    {actions.map((action) => (
                      <MenuItem
                        key={action.label}
                        disabled={!available}
                        aria-keyshortcuts={action.shortcut}
                        onClick={() => open(action.surface)}
                      >
                        <action.icon />
                        {action.label}
                        <MenuShortcut>{action.shortcut}</MenuShortcut>
                      </MenuItem>
                    ))}
                  </Menu>
                ) : null}
              </div>
            </ScrollRow>
            <span
              aria-hidden
              className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
            />
          </div>
          <div
            className="flex min-h-0 flex-1 flex-col"
            data-right-panel-surface-content
          >
            {active?.kind === "pull_requests" && conversationId ? (
              <PullRequestsSurface
                key={conversationId}
                threadId={conversationId}
                onOpen={(key) => open({ kind: "pull_request", key })}
              />
            ) : active?.kind === "pull_request" && conversationId ? (
              <PullRequestDetail
                key={`${conversationId}/${active.key}`}
                prKey={active.key}
                threadId={conversationId}
                workspaceId={checkout.workspaceId}
                canAskCodex={canAskCodex}
                onAskCodex={onAskCodex}
                onBack={() => open({ kind: "pull_requests" })}
              />
            ) : view?.unavailable && active ? (
              <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                <p className="text-center">{view.unavailable}</p>
              </div>
            ) : !active ? (
              <Launcher actions={actions} available={available} onOpen={open} />
            ) : active.kind === "diff" ? (
              <DiffSurface
                checkout={checkout}
                view={view}
                onOpenFile={handleOpenFile}
              />
            ) : (
              <FilesSurface
                key="files"
                checkout={checkout}
                view={view}
                path={active.kind === "file" ? active.path : null}
                onOpenFile={handleOpenFile}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SurfaceIcon({ surface }: { surface: Surface }) {
  switch (surface.kind) {
    case "diff":
      return <FileDiffIcon className="size-3 shrink-0" />;
    case "pull_requests":
    case "pull_request":
      return <GitPullRequestIcon className="size-3 shrink-0" />;
    case "files":
      return <FilesIcon className="size-3 shrink-0" />;
    case "file":
      return <FileEntryIcon path={surface.path} className="size-3" />;
  }
}

function Launcher({
  actions,
  available,
  onOpen,
}: {
  actions: readonly SurfaceAction[];
  available: boolean;
  onOpen: (surface: Surface) => void;
}) {
  const [highlight, setHighlight] = useState(-1);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    if (!available) return;
    const handler = (event: KeyboardEvent) => {
      const action = actionForKey(event, actions);
      if (!action) return;
      if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
      if (targetsTypingContext(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenRef.current(action.surface);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [actions, available]);
  const focusOnMount = useCallback(
    (node: HTMLDivElement | null) => node?.focus(),
    [],
  );
  const count = available ? actions.length : 0;
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
      setHighlight((highlight + 1) % count);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(
        highlight === -1 ? count - 1 : (highlight - 1 + count) % count,
      );
    } else if (event.key === "Enter" && event.target === event.currentTarget) {
      const action = actions[highlight];
      if (!action) return;
      event.preventDefault();
      onOpen(action.surface);
    }
  };
  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Open a surface"
      data-surface-launcher-keys={
        available ? actions.map((a) => a.shortcut).join("") : ""
      }
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 outline-none pb-(--workspace-topbar-height)"
    >
      <div className="w-full max-w-xs py-6">
        <h3 className="mb-3 text-center font-medium text-foreground text-sm">
          Open a surface
        </h3>
        <div className="flex flex-col gap-0.5">
          {actions.map((action, index) =>
            available ? (
              <div
                key={action.label}
                className="group relative"
                onMouseEnter={() => setHighlight(index)}
                onMouseLeave={() =>
                  setHighlight((current) => (current === index ? -1 : current))
                }
              >
                <button
                  type="button"
                  onClick={() => onOpen(action.surface)}
                  className={cn(
                    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors group-hover:bg-accent/60",
                    highlight === index && "bg-accent/60",
                  )}
                >
                  <span className="relative inline-flex shrink-0">
                    <action.icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {action.label}
                  </span>
                  <Kbd>{action.shortcut}</Kbd>
                </button>
              </div>
            ) : (
              <div
                key={action.label}
                tabIndex={0}
                aria-disabled="true"
                title="Available when a project is open."
                className="flex h-8 w-full cursor-default items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm opacity-50"
              >
                <span className="relative inline-flex shrink-0">
                  <action.icon className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                <Kbd>{action.shortcut}</Kbd>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
