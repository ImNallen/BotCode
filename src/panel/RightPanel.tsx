// Ported from T3 Code v0.0.45 apps/web/src/components/RightPanelTabs.tsx, preview/PreviewPanelShell.tsx and preview/RightPanelResizeHandle.tsx (MIT).
import { isCommandPaletteOpen } from "../lib/commandPaletteBus";
import {
  FileDiffIcon,
  GitPullRequestIcon,
  FilesIcon,
  GlobeIcon,
  PlusIcon,
  TerminalSquareIcon,
  type LucideIcon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { FileLinks } from "../chat/ChatMarkdown";
import type { CheckoutRef, WorkspaceView, Thread } from "../ipc";
import type { TurnDiffSelection } from "./turnDiffSelection";
import { cn } from "../lib/cn";
import { usePreferences } from "../settings/preferences";
import {
  PersistentThreadTerminalPanel,
  requestClosePanelSurface,
} from "../terminal/ThreadTerminalDrawer";
import {
  terminalScopeKey,
  type TerminalSurfaceId,
} from "../terminal/terminalState";
import {
  createPanelTerminal,
  useTerminalState,
} from "../terminal/terminalStore";
import { Button } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import { Kbd, MenuShortcut, PanelTabCloseButton, ScrollRow } from "./chrome";
import { DiffSurface } from "./DiffSurface";
import { usePendingFiles } from "./fileDrafts";
import { FileEntryIcon } from "./FileEntryIcon";
import { FilesSurface } from "./FilesSurface";
import { PullRequestDetail } from "./PullRequestDetail";
import { PullRequestsSurface } from "./PullRequestsSurface";
import { pullRequestState } from "./pullRequestPresentation";
import { stackLayerAccess } from "./pullRequestStack";
import type { PullRequestKey, ThreadPrSummary } from "./pullRequests";
import type { ReviewDraftRequest } from "./reviews";
import type { PrObservation } from "./prReview";
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
import { ErrorView } from "../errors/ErrorView";
import { RenderErrorBoundary } from "../errors/RenderErrorBoundary";
import { PreviewSurface } from "../preview/PreviewSurface";
import { previewScopeKey, scopeForPreview } from "../preview/model";

export type Surface =
  | { kind: "files" }
  | { kind: "diff" }
  | { kind: "preview" }
  | { kind: "pull_requests" }
  | { kind: "pull_request"; key: PullRequestKey }
  | { kind: "file"; path: string; line: number | null; revealSequence: number }
  | { kind: "terminal"; id: TerminalSurfaceId };

export type PanelState = { surfaces: Surface[]; active: number | null };

export const emptyPanel: PanelState = { surfaces: [], active: null };

type SurfaceAction = {
  label: string;
  icon: LucideIcon;
  shortcut: string;
  onSelect: () => void;
  unavailable?: { hint: string; reason: string };
};

type SurfaceTarget = {
  label: string;
  icon: LucideIcon;
  shortcut: string;
  surface: Surface;
};

const SURFACE_TARGETS: readonly SurfaceTarget[] = [
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

const FOLDER_TARGETS = SURFACE_TARGETS.filter(
  (target) => target.surface.kind === "files",
);

const TERMINAL_UNAVAILABLE = {
  hint: "Available when a project is open.",
  reason: "Terminal surfaces are only available from a project thread.",
};

const LAUNCHER_SHORTCUT_BLOCKING_LAYERS =
  '[data-slot="menu-popup"],[role="dialog"],[aria-modal="true"],dialog[open]';

function actionForKey(
  event: KeyboardEvent,
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
  onCheckoutPullRequest,
  terminalAvailable,
  fileLinks,
  thread,
  turnSelection,
  onSelectTurn,
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
  onCheckoutPullRequest: (target: PrObservation) => void;
  terminalAvailable: boolean;
  fileLinks: FileLinks;
  thread: Thread | undefined;
  turnSelection: TurnDiffSelection | null;
  onSelectTurn: (turnId: string | null, filePath?: string) => void;
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
  const { preferences } = usePreferences();
  const pendingFiles = usePendingFiles(checkout);
  const threadId = conversationId ?? null;
  const terminalScope = terminalScopeKey(checkout.workspaceId, threadId);
  const terminals = useTerminalState(terminalScope).panelSurfaces;
  const localAvailable = view !== undefined && view.unavailable === null;
  const open = (surface: Surface) => onChange(openSurface(state, surface));
  const openTerminal = () => {
    if (!terminalAvailable) return;
    open({ kind: "terminal", id: createPanelTerminal(terminalScope) });
  };
  const close = (index: number) => {
    const surface = state.surfaces[index];
    const terminal =
      surface?.kind === "terminal"
        ? terminals.find((entry) => entry.id === surface.id)
        : undefined;
    if (terminal) {
      requestClosePanelSurface(checkout.workspaceId, threadId, terminal);
      return;
    }
    onChange(closeSurface(state, index));
  };
  const surfaceAction = ({ surface, ...target }: SurfaceTarget) => ({
    ...target,
    onSelect: () => open(surface),
  });
  const actions: SurfaceAction[] = [
    surfaceAction({
      label: "Preview",
      icon: GlobeIcon,
      shortcut: "B",
      surface: { kind: "preview" },
    }),
    ...(conversationId && pullRequests.length > 0
      ? [
          surfaceAction({
            label: "Pull requests",
            icon: GitPullRequestIcon,
            shortcut: "P",
            surface: pullRequestSurface(pullRequests),
          }),
        ]
      : []),
    {
      label: "Terminal",
      icon: TerminalSquareIcon,
      shortcut: "T",
      onSelect: openTerminal,
      ...(terminalAvailable ? {} : { unavailable: TERMINAL_UNAVAILABLE }),
    },
    ...(!localAvailable
      ? thread?.turns.some((turn) => turn.checkpoint.kind === "complete")
        ? SURFACE_TARGETS.filter((target) => target.surface.kind === "diff")
        : []
      : git
        ? SURFACE_TARGETS
        : FOLDER_TARGETS
    ).map(surfaceAction),
  ];
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
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    setAddMenuOpen(false);
    action.onSelect();
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
                  const title = surfaceTitle(surface, terminals);
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
                        close(index);
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
                        onClick={() => close(index)}
                      >
                        <SurfaceIcon
                          surface={surface}
                          pullRequests={pullRequests}
                        />
                        {surface.kind === "file" &&
                        pendingFiles.has(surface.path) ? (
                          <span
                            className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
                            aria-hidden
                          />
                        ) : null}
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
                        className={
                          action.unavailable
                            ? "disabled:pointer-events-auto"
                            : undefined
                        }
                        disabled={Boolean(action.unavailable)}
                        title={action.unavailable?.reason}
                        aria-keyshortcuts={action.shortcut}
                        onClick={action.onSelect}
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
            <RenderErrorBoundary
              resetKeys={[
                checkout.workspaceId,
                checkout.threadId,
                conversationId,
                active ? surfaceKey(active) : null,
              ]}
              fallback={({ error, reset }) => (
                <ErrorView
                  error={error}
                  onRetry={reset}
                  area="Panel content"
                  contained
                />
              )}
            >
              {active?.kind === "preview" ? (
                <PreviewSurface
                  key={previewScopeKey(
                    scopeForPreview(checkout.workspaceId, conversationId),
                  )}
                  scope={scopeForPreview(checkout.workspaceId, conversationId)}
                />
              ) : active?.kind === "pull_requests" && conversationId ? (
                <PullRequestsSurface
                  key={conversationId}
                  threadId={conversationId}
                  onOpen={(key) => open({ kind: "pull_request", key })}
                />
              ) : active?.kind === "pull_request" && conversationId ? (
                <PullRequestDetail
                  key={`${conversationId}/${active.key}`}
                  prKey={active.key}
                  onSelectPullRequest={(key) =>
                    open({ kind: "pull_request", key })
                  }
                  access={stackLayerAccess({
                    key: active.key,
                    linkedKeys: pullRequests.map((link) => link.pr.key),
                    threadId: conversationId,
                    workspaceId: checkout.workspaceId,
                  })}
                  threadId={conversationId}
                  workspaceId={checkout.workspaceId}
                  canAskCodex={canAskCodex}
                  onAskCodex={onAskCodex}
                  onCheckout={onCheckoutPullRequest}
                  onBack={() => open({ kind: "pull_requests" })}
                />
              ) : active?.kind === "terminal" ? (
                <PersistentThreadTerminalPanel
                  key={`${terminalScope}/${active.id}`}
                  workspaceId={checkout.workspaceId}
                  threadId={threadId}
                  surfaceId={active.id}
                  fontSize={preferences.codeFontSize}
                  fileLinks={fileLinks}
                  onNewTerminal={openTerminal}
                />
              ) : view?.unavailable && active && active.kind !== "diff" ? (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p className="text-center">{view.unavailable}</p>
                </div>
              ) : !active ? (
                <Launcher actions={actions} />
              ) : active.kind === "diff" ? (
                <DiffSurface
                  checkout={checkout}
                  view={view}
                  onOpenFile={handleOpenFile}
                  thread={thread}
                  turnSelection={turnSelection}
                  onSelectTurn={onSelectTurn}
                />
              ) : (
                <FilesSurface
                  key="files"
                  checkout={checkout}
                  view={view}
                  path={active.kind === "file" ? active.path : null}
                  line={active.kind === "file" ? active.line : null}
                  revealSequence={
                    active.kind === "file" ? active.revealSequence : 0
                  }
                  onOpenFile={handleOpenFile}
                  fileLinks={fileLinks}
                />
              )}
            </RenderErrorBoundary>
          </div>
        </div>
      </div>
    </div>
  );
}

function SurfaceIcon({
  surface,
  pullRequests,
}: {
  surface: Surface;
  pullRequests: ThreadPrSummary["links"];
}) {
  switch (surface.kind) {
    case "diff":
      return <FileDiffIcon className="size-3 shrink-0" />;
    case "preview":
      return <GlobeIcon className="size-3 shrink-0" />;
    case "pull_requests":
      return <GitPullRequestIcon className="size-3 shrink-0" />;
    case "pull_request": {
      const lifecycle = pullRequests.find((link) => link.pr.key === surface.key)
        ?.pr.snapshot?.lifecycle;
      if (!lifecycle) return <GitPullRequestIcon className="size-3 shrink-0" />;
      const state = pullRequestState(lifecycle);
      return (
        <state.Icon className={cn("size-3 shrink-0", state.toneClassName)} />
      );
    }
    case "files":
      return <FilesIcon className="size-3 shrink-0" />;
    case "file":
      return <FileEntryIcon path={surface.path} className="size-3" />;
    case "terminal":
      return <TerminalSquareIcon className="size-3 shrink-0" />;
  }
}

function Launcher({ actions }: { actions: readonly SurfaceAction[] }) {
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
                <span className="relative inline-flex shrink-0">
                  <action.icon className="size-4" />
                </span>
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
                  <span className="relative inline-flex shrink-0">
                    <action.icon className="size-4" />
                  </span>
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
