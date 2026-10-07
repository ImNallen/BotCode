// Shell geometry follows pingdotgg/t3code v0.0.45 components/AppSidebarLayout.tsx and
// components/ui/sidebar.tsx, and components/NoProjectsHero.tsx at 6b286ae8a (MIT).
import { ThreadNotificationCoordinator } from "./notifications/ThreadNotificationCoordinator";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useSyncExternalStore,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  Outlet,
  useLocation,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import {
  MessageSquareDashedIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PlusIcon,
} from "lucide-react";
import {
  checkoutKey,
  ipc,
  native,
  setThreadSnapshot,
  type Arrange,
} from "./ipc";
import { Sidebar, SidebarBrand } from "./Sidebar";
import { SidebarFooter } from "./SidebarFooter";
import { SettingsSidebar } from "./settings/SettingsPage";
import type { SettingsSection } from "./settings/settingsCatalog";
import { ChatView } from "./chat/ChatView";
import type { Surface } from "./panel/RightPanel";
import { Button } from "./ui/controls";
import { storage } from "./lib/storage";
import {
  actions,
  runAction,
  type ActionContext,
  type SidebarRequest,
  type ChatRequest,
} from "./lib/actions";
import { matchAction, matchesAction, shortcutLabel } from "./lib/shortcuts";
import {
  focusComposer,
  isCommandPaletteOpen,
  subscribeCommandPaletteOpen,
} from "./lib/commandPaletteBus";
import { CommandPalette } from "./command/CommandPalette";
import { followUps } from "./chat/followUps";
import { confirmAndDeleteThread, restoreThread } from "./threadActions";
import { isTerminalFocused } from "./terminal/terminalKeys";

const SIDEBAR_DEFAULT = 256;
const SIDEBAR_MIN = 208;
const MAIN_MIN = 640;
const SIDEBAR_KEY = "z1:sidebar-width";

function clampSidebar(width: number) {
  const max = Math.max(SIDEBAR_MIN, Math.floor(window.innerWidth) - MAIN_MIN);
  return Math.min(Math.max(width, SIDEBAR_MIN), max);
}

export function Workbench() {
  const selection = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const page = useLocation({
    select: (location): "settings" | "usage" | null =>
      location.pathname.startsWith("/settings")
        ? "settings"
        : location.pathname === "/usage"
          ? "usage"
          : null,
  });
  const pageOpen = page !== null;
  const settingsOpen = page === "settings";
  const previousFocus = useRef<HTMLElement | null>(null);
  const wasPageOpen = useRef(false);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const rememberFocus = useCallback(() => {
    if (pageOpen) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, [pageOpen]);
  const openSettingsAt = useCallback(
    (section: SettingsSection, project?: string) => {
      if (settingsOpen) return;
      rememberFocus();
      void navigate({
        to: "/settings/$section",
        params: { section },
        search: { ...selection, project },
        hash: "",
        resetScroll: false,
      });
    },
    [navigate, selection, settingsOpen, rememberFocus],
  );
  const openSettings = useCallback(
    () => openSettingsAt("general"),
    [openSettingsAt],
  );
  const openUsage = useCallback(() => {
    if (page === "usage") return;
    rememberFocus();
    void navigate({
      to: "/usage",
      search: { ...selection, project: undefined },
      hash: "",
      resetScroll: false,
    });
  }, [navigate, selection, page, rememberFocus]);
  const closePage = useCallback(() => {
    void navigate({
      to: "/",
      search: { ...selection, project: undefined },
      hash: "",
      resetScroll: false,
    });
  }, [navigate, selection]);
  const client = useQueryClient();
  const [error, setError] = useState<string>();
  const [actionStatus, setActionStatus] = useState<string>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteBlocked, setPaletteBlocked] = useState(false);
  const paletteFocus = useRef<HTMLElement | null>(null);
  const restorePaletteFocus = useRef(false);
  useLayoutEffect(() => {
    if (paletteOpen || !restorePaletteFocus.current) return;
    restorePaletteFocus.current = false;
    const previous = paletteFocus.current;
    paletteFocus.current = null;
    if (
      previous?.isConnected &&
      previous !== document.body &&
      previous !== document.documentElement &&
      previous.getBoundingClientRect().width > 0 &&
      previous.getBoundingClientRect().right > 0 &&
      getComputedStyle(previous).visibility !== "hidden" &&
      !previous.matches(":disabled") &&
      !previous.closest("[inert]")
    )
      previous.focus({ preventScroll: true });
    else if (!pageOpen) focusComposer();
  }, [paletteOpen, pageOpen]);
  const openPalette = useCallback(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialogs = Array.from(
      document.querySelectorAll<HTMLDialogElement>(
        "dialog[open]:not([data-command-palette])",
      ),
    );
    flushSync(() => {
      for (const dialog of dialogs)
        dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    paletteFocus.current = previous?.isConnected
      ? previous
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setPaletteBlocked(
      dialogs.some((dialog) => dialog.isConnected && dialog.open),
    );
    setPaletteOpen(true);
  }, []);
  const [sidebarRequest, setSidebarRequest] = useState<SidebarRequest>();
  const [chatRequest, setChatRequest] = useState<ChatRequest>();
  const [renamePending, setRenamePending] = useState(false);
  const requestSequence = useRef(0);
  useSyncExternalStore(
    followUps.subscribe,
    followUps.snapshot,
    followUps.snapshot,
  );
  useEffect(() => subscribeCommandPaletteOpen(openPalette), [openPalette]);
  const [prPanelRequest, setPrPanelRequest] = useState<{
    threadId: string;
    surface: Surface;
    nonce: number;
  }>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampSidebar(Number(storage.getItem(SIDEBAR_KEY)) || SIDEBAR_DEFAULT),
  );
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: ipc.workspaces,
    enabled: native,
  });
  const list = workspaces.data ?? [];
  const availability = useQuery({
    queryKey: ["scratch-available"],
    queryFn: ipc.scratchAvailable,
    enabled: native,
  });
  const scratchAvailable = availability.data ?? false;
  const views = useQueries({
    queries: list.map((workspace) => ({
      queryKey: checkoutKey("workspace", { workspaceId: workspace.id }),
      queryFn: () => ipc.workspace({ workspaceId: workspace.id }),
    })),
  });
  const openSummary = views
    .flatMap((query) => query.data?.threads ?? [])
    .find(
      (thread) =>
        thread.id === selection.thread && thread.archivedAtMs === null,
    );
  const arrange = useCallback(async (threadId: string, action: Arrange) => {
    try {
      await ipc.arrange(threadId, action);
      setError(undefined);
      return true;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);
  const repositories = list.filter((w) => w.kind === "repository");
  const scratch = list.find((w) => w.kind === "scratch");
  const workspaceId = selection.workspace ?? repositories[0]?.id ?? scratch?.id;
  useEffect(() => {
    setChatRequest(undefined);
  }, [workspaceId, selection.thread]);
  const startScratch = useCallback(async () => {
    try {
      const workspace = await ipc.ensureScratch();
      await client.invalidateQueries({ queryKey: ["workspaces"] });
      void navigate({ to: "/", search: { workspace: workspace.id } });
      setError(undefined);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, navigate]);
  const autoStartScratch =
    !workspaces.isPending &&
    !availability.isPending &&
    !workspaces.error &&
    !workspaceId &&
    scratchAvailable &&
    !error;
  useEffect(() => {
    if (autoStartScratch) void startScratch();
  }, [autoStartScratch, startScratch]);
  useLayoutEffect(() => {
    if (pageOpen && !wasPageOpen.current && !previousFocus.current)
      previousFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    const leaving = !pageOpen && wasPageOpen.current;
    wasPageOpen.current = pageOpen;
    if (!leaving) return;
    const frame = requestAnimationFrame(() => {
      const previous = previousFocus.current;
      const visible =
        previous?.isConnected &&
        previous.getBoundingClientRect().width > 0 &&
        getComputedStyle(previous).visibility !== "hidden" &&
        !previous.closest("[inert]") &&
        previous.getBoundingClientRect().right > 0;
      const fallback = document.querySelector<HTMLElement>(
        "[data-settings-trigger]",
      );
      (visible
        ? previous
        : sidebarOpen && window.matchMedia("(min-width: 768px)").matches
          ? fallback
          : sidebarToggle.current
      )?.focus({ preventScroll: true });
      previousFocus.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [pageOpen, sidebarOpen]);
  const openRepository = async () => {
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "Open a Git repository",
      });
      if (typeof path !== "string") return;
      const workspace = await ipc.openWorkspace(path);
      await client.invalidateQueries({ queryKey: ["workspaces"] });
      void navigate({ to: "/", search: { workspace: workspace.id } });
      setError(undefined);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const selectThread = useCallback(
    (workspace: string, thread: string, panel?: Surface) => {
      setPrPanelRequest(
        panel
          ? { threadId: thread, surface: panel, nonce: Date.now() }
          : undefined,
      );
      void navigate({
        to: "/",
        search: (previous) => ({
          ...previous,
          workspace,
          thread,
          project: undefined,
        }),
      });
      void ipc
        .resume(thread)
        .then((snapshot) => setThreadSnapshot(client, snapshot))
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    },
    [client, navigate],
  );
  const selectWorkspace = (workspace: string) =>
    void navigate({ to: "/", search: { workspace } });
  const newThread = (workspace = workspaceId) =>
    void navigate({ to: "/", search: { workspace } });
  const currentView = views.find(
    (view) => view.data?.workspace.id === workspaceId,
  )?.data;
  const actionContext: ActionContext = {
    pageOpen,
    thread: openSummary,
    workspace: list.find((workspace) => workspace.id === workspaceId),
    branch:
      openSummary?.checkout.kind === "worktree"
        ? openSummary.checkout.branch
        : (currentView?.branch ?? ""),
    scratchAvailable,
    terminalAvailable:
      !!workspaceId && !(scratch?.id === workspaceId && !selection.thread),
    renamePending,
    queued: !!selection.thread && followUps.rows(selection.thread).length > 0,
    archiveTarget: undefined,
    newThread: () => newThread(),
    startScratch: () => void startScratch(),
    openSettings,
    closePage,
    toggleSidebar: () => setSidebarOpen((value) => !value),
    openPalette,
    openSubmenu: openPalette,
    arrange: (id, action) => void arrange(id, action),
    requestSidebar: (threadId, operation) => {
      if (operation.kind === "rename") setSidebarOpen(true);
      setSidebarRequest({
        sequence: ++requestSequence.current,
        threadId,
        operation,
      });
    },
    requestChat: (kind) => {
      if (workspaceId)
        setChatRequest({
          sequence: ++requestSequence.current,
          workspaceId,
          threadId: selection.thread,
          kind,
        });
    },
    restoreArchived: (thread) => {
      void restoreThread(thread.id, client)
        .then(() => {
          setError(undefined);
          setActionStatus("Thread restored.");
        })
        .catch((failure: unknown) =>
          setError(
            failure instanceof Error ? failure.message : String(failure),
          ),
        );
    },
    deleteArchived: (thread) => {
      void confirmAndDeleteThread(thread, client)
        .then((outcome) => {
          if (!outcome) return;
          setError(undefined);
          setActionStatus(
            outcome.kind === "retained"
              ? `Thread deleted. Worktree kept. ${outcome.reason}`
              : "Thread deleted.",
          );
        })
        .catch((failure: unknown) =>
          setError(
            failure instanceof Error ? failure.message : String(failure),
          ),
        );
    },
  };
  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (isCommandPaletteOpen()) {
      if (!event.repeat && matchesAction(event, "palette.open")) {
        event.preventDefault();
        closePalette(true);
      }
      return;
    }
    const id = matchAction(event, actionContext, isTerminalFocused());
    if (!id) return;
    event.preventDefault();
    runAction(id, actionContext);
  });
  const onPageEscape = useEffectEvent((event: KeyboardEvent) => {
    if (
      isCommandPaletteOpen() ||
      event.defaultPrevented ||
      !matchesAction(event, "page.close") ||
      !actions["page.close"].available(actionContext)
    )
      return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        '[role="dialog"], [aria-modal="true"], dialog, [data-slot$="popup"]',
      )
    )
      return;
    event.preventDefault();
    runAction("page.close", actionContext);
  });
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => onShortcut(event);
    const escape = (event: KeyboardEvent) => onPageEscape(event);
    window.addEventListener("keydown", shortcut, true);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", shortcut, true);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  const closePalette = (restoreFocus: boolean) => {
    restorePaletteFocus.current = restoreFocus;
    if (!restoreFocus) paletteFocus.current = null;
    setPaletteOpen(false);
  };
  if (!native)
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm text-muted-foreground">
        <div className="font-semibold text-2xl text-foreground">Bot Code</div>
        <p>This workbench runs in its native macOS window.</p>
        <code className="rounded-md border border-border bg-muted px-3 py-2 font-mono text-foreground">
          pnpm tauri dev
        </code>
      </div>
    );
  return (
    <>
      <div
        inert={paletteOpen}
        data-slot="sidebar-wrapper"
        data-sidebar-state={sidebarOpen ? "expanded" : "collapsed"}
        className="group/sidebar-wrapper flex w-full h-dvh min-h-0"
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--workspace-titlebar-content-left":
              "calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap))",
          } as React.CSSProperties
        }
      >
        <ThreadNotificationCoordinator
          workspaces={views.flatMap((view) => (view.data ? [view.data] : []))}
          workspaceIds={list.map((workspace) => workspace.id)}
          visibleThread={
            !pageOpen && selection.thread && workspaceId
              ? { workspaceId, threadId: selection.thread }
              : null
          }
          openThread={selectThread}
        />
        <div
          className="group peer hidden text-sidebar-foreground md:block"
          data-collapsible={sidebarOpen ? "" : "offcanvas"}
          data-side="left"
          data-slot="sidebar"
          data-state={sidebarOpen ? "expanded" : "collapsed"}
          data-variant="sidebar"
        >
          <div
            data-slot="sidebar-gap"
            className="relative w-(--sidebar-width) bg-transparent group-data-[collapsible=offcanvas]:w-0"
          />
          <div
            data-slot="sidebar-container"
            data-app-sidebar=""
            role="navigation"
            aria-label={settingsOpen ? "Settings" : "Threads"}
            className="fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) md:flex left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] border-r"
          >
            <div
              data-sidebar="sidebar"
              data-slot="sidebar-inner"
              className="flex h-full w-full flex-col bg-sidebar"
            >
              <SidebarBrand onNewThread={() => newThread()} />
              <div className="relative min-h-0 flex-1">
                <div
                  className="absolute inset-0 flex min-h-0 flex-col"
                  inert={settingsOpen}
                  aria-hidden={settingsOpen || undefined}
                  style={{
                    visibility: settingsOpen ? "hidden" : "visible",
                    opacity: settingsOpen ? 0 : 1,
                  }}
                >
                  <Sidebar
                    workspaces={
                      scratch ? [scratch, ...repositories] : repositories
                    }
                    views={views.map((query) => query.data)}
                    workspaceId={workspaceId}
                    threadId={selection.thread}
                    onSelectThread={selectThread}
                    onNewThread={newThread}
                    onOpenRepository={() => void openRepository()}
                    onOpenProjectSettings={(id) =>
                      openSettingsAt("projects", id)
                    }
                    onArrange={arrange}
                    commandRequest={sidebarRequest}
                    onRenamePendingChange={setRenamePending}
                  />
                </div>
                {settingsOpen ? (
                  <div className="absolute inset-0 flex min-h-0 flex-col">
                    <SettingsSidebar />
                  </div>
                ) : null}
              </div>
              <SidebarFooter
                pageOpen={pageOpen}
                onOpenSettings={openSettings}
                onOpenUsage={openUsage}
                onBack={closePage}
              />
            </div>
            <SidebarRail
              width={sidebarWidth}
              onResize={setSidebarWidth}
              onReset={() => {
                void storage.removeItem(SIDEBAR_KEY);
                setSidebarWidth(clampSidebar(SIDEBAR_DEFAULT));
              }}
            />
          </div>
        </div>
        <main
          data-slot="sidebar-inset"
          className="relative flex min-w-0 w-full flex-1 flex-col bg-background h-dvh min-h-0 overflow-hidden overscroll-y-none"
        >
          <div
            className="absolute inset-0 flex min-h-0 min-w-0 flex-col"
            inert={pageOpen}
            aria-hidden={pageOpen || undefined}
            style={{
              visibility: pageOpen ? "hidden" : "visible",
              opacity: pageOpen ? 0 : 1,
            }}
          >
            {workspaces.isPending ||
            availability.isPending ||
            autoStartScratch ? null : workspaceId ? (
              <ChatView
                key={workspaceId}
                workspaceId={workspaceId}
                threadId={selection.thread}
                prPanelRequest={prPanelRequest}
                commandRequest={chatRequest}
                onSelectWorkspace={selectWorkspace}
                workspaces={repositories}
                scratch={scratch}
                scratchAvailable={scratchAvailable}
                onStartScratch={() => void startScratch()}
                onOpenRepository={() => void openRepository()}
              />
            ) : (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
                <header
                  data-tauri-drag-region="deep"
                  className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) drag-region [[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]"
                />
                <div
                  data-slot="empty"
                  className="flex min-w-0 flex-1 flex-col items-center justify-center text-balance text-center gap-6 p-6 md:p-12 [&_[data-slot=empty-title]]:text-2xl sm:[&_[data-slot=empty-title]]:text-3xl"
                >
                  <div className="w-full max-w-lg px-8 py-12">
                    <div className="flex flex-col items-center text-center max-w-none">
                      <div
                        data-slot="empty-title"
                        className="font-semibold text-xl"
                      >
                        What should we work on?
                      </div>
                      <div
                        data-slot="empty-description"
                        className="text-muted-foreground text-sm [[data-slot=empty-title]+&]:mt-1"
                      >
                        {scratchAvailable
                          ? "Add a project, or start without one."
                          : "Add a project to start your first thread."}
                      </div>
                      <div className="mt-6 flex justify-center gap-2">
                        <Button size="sm" onClick={() => void openRepository()}>
                          <PlusIcon className="size-4" />
                          Add project
                        </Button>
                        {scratchAvailable ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void startScratch()}
                          >
                            <MessageSquareDashedIcon className="size-4" />
                            Start without a project
                          </Button>
                        ) : null}
                      </div>
                      {(error || workspaces.error) && (
                        <p
                          role="alert"
                          className="mt-4 text-sm text-destructive-foreground"
                        >
                          {error ?? workspaces.error?.message}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
          {pageOpen ? (
            <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col">
              <Outlet />
            </div>
          ) : null}{" "}
          {error ? (
            <div
              role="alert"
              className="pointer-events-auto absolute top-14 left-1/2 z-40 flex w-fit max-w-[min(48rem,calc(100%-2rem))] -translate-x-1/2 items-start gap-2 rounded-xl border border-error/32 alert-glass px-3.5 py-3 text-sm text-error-foreground"
              data-variant="error"
            >
              <div className="line-clamp-3">{error}</div>
              <button
                type="button"
                className="shrink-0 text-xs underline"
                onClick={() => setError(undefined)}
              >
                Dismiss
              </button>
            </div>
          ) : null}
        </main>
        <div
          data-sidebar-control=""
          className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center"
        >
          <Button
            ref={sidebarToggle}
            variant="ghost"
            size="icon"
            aria-label="Toggle main sidebar"
            title={`Toggle main sidebar (${shortcutLabel("sidebar.toggle")})`}
            aria-pressed={sidebarOpen}
            className="size-[var(--workspace-titlebar-control-size)]! [-webkit-app-region:no-drag] pointer-events-auto"
            onClick={() => setSidebarOpen((value) => !value)}
          >
            {sidebarOpen ? (
              <PanelLeftCloseIcon className="size-4" />
            ) : (
              <PanelLeftIcon className="size-4" />
            )}
            <span className="sr-only">Toggle Sidebar</span>
          </Button>
        </div>
      </div>
      {actionStatus ? (
        <p
          role="status"
          className="fixed bottom-3 right-3 z-40 rounded-md border bg-popover px-3 py-2 text-sm"
        >
          {actionStatus}{" "}
          <button type="button" onClick={() => setActionStatus(undefined)}>
            Dismiss
          </button>
        </p>
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          context={actionContext}
          blocked={paletteBlocked}
          workspaces={list}
          threads={views.flatMap((view) =>
            view.data
              ? view.data.threads.map((thread) => ({
                  thread,
                  workspaceId: view.data.workspace.id,
                  workspaceLabel: view.data.workspace.label,
                }))
              : [],
          )}
          onClose={closePalette}
          onSelectThread={(workspace, thread) => {
            selectThread(workspace, thread);
            requestAnimationFrame(() => requestAnimationFrame(focusComposer));
          }}
        />
      ) : null}
    </>
  );
}

function SidebarRail({
  width,
  onResize,
  onReset,
}: {
  width: number;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label="Resize Sidebar"
      title="Drag to resize sidebar"
      data-sidebar="rail"
      className="-translate-x-1/2 -right-4 absolute inset-y-0 z-20 hidden w-4 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex cursor-w-resize"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        onResize(
          clampSidebar(drag.current.width + event.clientX - drag.current.x),
        );
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        const next = clampSidebar(
          drag.current.width + event.clientX - drag.current.x,
        );
        drag.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        void storage.setItem(SIDEBAR_KEY, String(next));
        onResize(next);
      }}
      onDoubleClick={onReset}
    />
  );
}
