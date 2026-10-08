// Ported from pingdotgg/t3code v0.0.45 components/Sidebar.tsx and threadActionMenu.logic.ts (MIT).
import { useRouter } from "@tanstack/react-router";
import { sidebarPendingFileDrops } from "./chat/sidebarPendingFileDrops";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { followUps } from "./chat/followUps";
import { pullRequestSurface } from "./panel/panelState";
import { prLabel } from "./panel/pullRequests";
import type { Surface } from "./panel/RightPanel";
// Layout and classes follow pingdotgg/t3code v0.0.45 components/Sidebar.tsx,
// sidebar/SidebarChrome.tsx, sidebar/SidebarThreadHeader.tsx and ThreadStatusIndicators.tsx (MIT).
// The Pinned section, Snoozed shelf and Settled shelf follow Sidebar.tsx classification,
// SidebarSectionHeader, SnoozeMenuButton, slim rows, settled paging, the snooze wake timer and
// planForwardNavigation, and Sidebar.logic.ts shouldNavigateAfterThreadPark.
import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  CopyIcon,
  Trash2Icon,
  GitBranchIcon,
  HashIcon,
  AlarmClockOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleCheckIcon,
  ClockIcon,
  PinIcon,
  PinOffIcon,
  ShieldQuestionIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { ipc, type Arrange, type Workspace, type WorkspaceView } from "./ipc";
import { cn } from "./lib/cn";
import { usePreferences } from "./settings/preferences";
import {
  compareInboxReturns,
  formatWorkingDurationLabel,
  isSidebarThreadWorking,
  observeInboxReturns,
} from "./sidebarWorking";
import { workingSessions } from "./lib/sessions";
import { formatSidebarTime } from "./lib/time";
import { pathBasename } from "./chat/composer-logic";
import { WorkspaceBadge } from "./ProjectBadge";
import { OpenAI } from "./ui/icons";
import { Button } from "./ui/controls";
import { ProjectScopeMenu } from "./ProjectScopeMenu";
import { storage } from "./lib/storage";
import {
  Menu,
  MenuItem,
  MenuShortcut,
  MenuSub,
  MenuSeparator,
} from "./ui/menu";
import {
  canParkThread,
  shortcutLabel,
  type SidebarRequest,
} from "./lib/actions";
import { confirmAndDeleteThread } from "./threadActions";
import { resolveSnoozePresets, snoozeWakeLabel } from "./lib/snooze";

type Row = {
  workspace: Workspace;
  branch: string;
  thread: WorkspaceView["threads"][number];
};

const SCOPE_KEY = "z1:sidebar-project-scope";
const WORKING_EXPANDED_KEY = "z1:sidebar:working-expanded";
const SNOOZED_EXPANDED_KEY = "z1:sidebar:snoozed-expanded";
const SETTLED_EXPANDED_KEY = "z1:sidebar:settled-expanded";
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;

type SidebarSections = {
  pinned: Row[];
  active: Row[];
  working: Row[];
  workingTotal: number;
  snoozed: Row[];
  snoozedTotal: number;
  settled: Row[];
  settledTotal: number;
  hiddenCount: number;
};

export function partitionSidebarRows({
  rows,
  query,
  scopeId,
  openThreadId,
  now,
  snoozedExpanded,
  settledExpanded,
  settledVisibleCount,
  workingEnabled = false,
  workingExpanded = false,
  observedReturns = new Map(),
}: {
  rows: Row[];
  query: string;
  scopeId: string | undefined;
  openThreadId: string | undefined;
  now: number;
  snoozedExpanded: boolean;
  settledExpanded: boolean;
  settledVisibleCount: number;
  workingEnabled?: boolean;
  workingExpanded?: boolean;
  observedReturns?: ReadonlyMap<string, number>;
}): SidebarSections {
  const needle = query.trim().toLowerCase();
  const pinned: Row[] = [];
  const active: Row[] = [];
  const working: Row[] = [];
  const snoozed: Row[] = [];
  const settled: Row[] = [];
  for (const row of rows) {
    if (row.thread.archivedAtMs != null) continue;
    if (scopeId && row.workspace.id !== scopeId) continue;
    if (needle && !row.thread.title.toLowerCase().includes(needle)) continue;
    const { snoozedUntilMs, settledAtMs, pinnedAtMs } = row.thread;
    (snoozedUntilMs !== null && snoozedUntilMs > now
      ? snoozed
      : settledAtMs !== null
        ? settled
        : pinnedAtMs !== null
          ? pinned
          : workingEnabled && isSidebarThreadWorking(row.thread)
            ? working
            : active
    ).push(row);
  }
  pinned.sort(
    (a, b) => (b.thread.pinnedAtMs ?? 0) - (a.thread.pinnedAtMs ?? 0),
  );
  const byReturn = (a: Row, b: Row) =>
    compareInboxReturns(a.thread, b.thread, observedReturns) ||
    a.workspace.id.localeCompare(b.workspace.id);
  active.sort(
    workingEnabled
      ? byReturn
      : (a, b) => (b.thread.updatedAtMs ?? 0) - (a.thread.updatedAtMs ?? 0),
  );
  working.sort(byReturn);
  snoozed.sort(
    (a, b) => (a.thread.snoozedUntilMs ?? 0) - (b.thread.snoozedUntilMs ?? 0),
  );
  settled.sort(
    (a, b) => (b.thread.settledAtMs ?? 0) - (a.thread.settledAtMs ?? 0),
  );
  const totals = {
    workingTotal: working.length,
    snoozedTotal: snoozed.length,
    settledTotal: settled.length,
  };
  if (needle)
    return {
      pinned,
      active,
      working,
      snoozed,
      settled,
      ...totals,
      hiddenCount: 0,
    };
  // The open thread never hides under Show more or a collapsed shelf.
  const isOpen = (row: Row) => row.thread.id === openThreadId;
  const page = settled.slice(0, settledVisibleCount);
  const open = settled.slice(settledVisibleCount).find(isOpen);
  if (open) page.push(open);
  return {
    pinned,
    active,
    working: workingExpanded ? working : working.filter(isOpen),
    snoozed: snoozedExpanded ? snoozed : snoozed.filter(isOpen),
    settled: settledExpanded ? page : page.filter(isOpen),
    ...totals,
    hiddenCount: settled.length - page.length,
  };
}

const menuButton =
  "peer/menu-button flex w-full cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden text-left outline-hidden ring-ring transition-[width,height,padding] hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 active:bg-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground active:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-sidebar-foreground";

function HeaderIconButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        menuButton,
        "justify-center rounded-[var(--control-radius)] p-0 font-medium text-sidebar-muted-foreground/80 relative size-7 shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function Sidebar({
  workspaces,
  views,
  workspaceId,
  threadId,
  onSelectThread,
  onNewThread,
  onOpenRepository,
  onOpenProjectSettings,
  onArrange,
  commandRequest,
  onRenamePendingChange,
}: {
  commandRequest?: SidebarRequest;
  onRenamePendingChange?: (pending: boolean) => void;
  workspaces: Workspace[];
  views: (WorkspaceView | undefined)[];
  workspaceId: string | undefined;
  threadId: string | undefined;
  onSelectThread: (
    workspaceId: string,
    threadId: string,
    panel?: Surface,
  ) => void | Promise<void>;
  onNewThread: (workspaceId?: string, shiftKey?: boolean) => void;
  onOpenRepository: () => void;
  onOpenProjectSettings: (workspaceId: string) => void;
  onArrange: (threadId: string, action: Arrange) => Promise<boolean>;
}) {
  const { preferences } = usePreferences();
  const client = useQueryClient();
  const router = useRouter();
  const dropFiles = (row: Row, files: File[]) => {
    const id = sidebarPendingFileDrops.queue(row.thread.id, files);
    try {
      void Promise.resolve(onSelectThread(row.workspace.id, row.thread.id))
        .then(() => {
          if (router.state.location.search.thread !== row.thread.id)
            sidebarPendingFileDrops.remove(id);
        })
        .catch((cause) => {
          sidebarPendingFileDrops.remove(id);
          setActionError(
            cause instanceof Error ? cause.message : String(cause),
          );
        });
    } catch (cause) {
      sidebarPendingFileDrops.remove(id);
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const [actionError, setActionError] = useState<string>();
  const [actionStatus, setActionStatus] = useState<string>();
  const [renaming, setRenaming] = useState<{ id: string; title: string }>();
  const [savingRename, setSavingRename] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    onRenamePendingChange?.(savingRename);
  }, [savingRename, onRenamePendingChange]);
  const editRename = (value: { id: string; title: string } | undefined) => {
    if (!saving.current) setRenaming(value);
  };
  const saveRename = async () => {
    if (!renaming || !renaming.title.trim() || saving.current) return;
    saving.current = true;
    setSavingRename(true);
    try {
      await ipc.renameThread(renaming.id, renaming.title.trim());
      setRenaming(undefined);
      setActionError(undefined);
      await client.invalidateQueries({ queryKey: ["workspace"] });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      setSavingRename(false);
    }
  };
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] = useState(() => storage.getItem(SCOPE_KEY));
  const scope = workspaces.find((workspace) => workspace.id === scopeId);
  const searchField = useRef<HTMLLabelElement>(null);
  const scopeTrigger = useRef<HTMLElement | null>(null);
  const [workingExpanded, setWorkingExpanded] = useState(
    () => storage.getItem(WORKING_EXPANDED_KEY) === "true",
  );
  const [snoozedExpanded, setSnoozedExpanded] = useState(
    () => storage.getItem(SNOOZED_EXPANDED_KEY) === "true",
  );
  const [settledExpanded, setSettledExpanded] = useState(
    () => storage.getItem(SETTLED_EXPANDED_KEY) === "true",
  );
  // Keyed by scope so changing the project filter starts again at the first page.
  const [settledPage, setSettledPage] = useState({
    scopeId: scope?.id,
    count: SETTLED_TAIL_INITIAL_COUNT,
  });
  const settledVisibleCount =
    settledPage.scopeId === scope?.id
      ? settledPage.count
      : SETTLED_TAIL_INITIAL_COUNT;
  const openThread = useRef(threadId);
  useEffect(() => {
    openThread.current = threadId;
  }, [threadId]);
  const rows: Row[] = views.flatMap((view) =>
    view
      ? view.threads.map((thread) => ({
          workspace: view.workspace,
          branch:
            thread.checkout.kind === "worktree"
              ? thread.checkout.branch
              : view.branch,
          thread,
        }))
      : [],
  );
  const searching = query.trim() !== "";
  // Wake times are compared with the real clock on every render. The tick
  // re-renders at the next wake and once a minute for the wake labels.
  const [tick, setTick] = useState(0);
  const now = Date.now();
  const observedReturns = observeInboxReturns(
    rows.map((row) => row.thread),
    preferences.sidebarWorkingShelfEnabled,
    now,
  );
  const {
    pinned,
    active,
    working,
    workingTotal,
    snoozed,
    snoozedTotal,
    settled,
    settledTotal,
    hiddenCount,
  } = partitionSidebarRows({
    rows,
    query,
    scopeId: scope?.id,
    openThreadId: threadId,
    now,
    snoozedExpanded,
    settledExpanded,
    settledVisibleCount,
    workingEnabled: preferences.sidebarWorkingShelfEnabled,
    workingExpanded,
    observedReturns,
  });
  const nextWakeMs = Math.min(
    ...rows.flatMap(({ thread }) =>
      thread.snoozedUntilMs !== null && thread.snoozedUntilMs > now
        ? [thread.snoozedUntilMs]
        : [],
    ),
  );
  useEffect(() => {
    if (nextWakeMs === Infinity) return;
    // setTimeout delays are signed 32-bit, so a far wake waits in clamped
    // steps. Each tick re-arms the timer.
    const delay = Math.min(nextWakeMs - Date.now() + 50, 2_147_483_647);
    const id = window.setTimeout(() => {
      setTick((tick) => tick + 1);
      // The core decides auto-settling, so a woken idle thread needs a fresh summary.
      void client.invalidateQueries({ queryKey: ["workspace"] });
    }, delay);
    return () => window.clearTimeout(id);
  }, [nextWakeMs, client, tick]);
  const wakeLabelsShown = snoozed.length > 0;
  useEffect(() => {
    if (!wakeLabelsShown) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(id);
  }, [wakeLabelsShown]);
  const workingShelfExpanded = workingExpanded || searching;
  const toggleWorking = () => {
    const next = !workingExpanded;
    setWorkingExpanded(next);
    void storage.setItem(WORKING_EXPANDED_KEY, String(next));
  };
  const snoozedShelfExpanded = snoozedExpanded || searching;
  const settledShelfExpanded = settledExpanded || searching;
  const toggleSnoozed = () => {
    const next = !snoozedExpanded;
    setSnoozedExpanded(next);
    void storage.setItem(SNOOZED_EXPANDED_KEY, String(next));
  };
  const toggleSettled = () => {
    const next = !settledExpanded;
    setSettledExpanded(next);
    void storage.setItem(SETTLED_EXPANDED_KEY, String(next));
  };
  const inboxCards = [...pinned, ...active];
  const cards = [...inboxCards, ...working];
  const [menu, setMenu] = useState<{
    threadId: string;
    point: { x: number; y: number };
    row: HTMLElement;
  }>();
  const menuRow = menu && rows.find((row) => row.thread.id === menu.threadId);
  const openMenu = (row: Row) => (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    // A keyboard-opened context menu reports no pointer position.
    const rect = element.getBoundingClientRect();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    setMenu({
      threadId: row.thread.id,
      point: keyboard
        ? { x: rect.left, y: rect.bottom }
        : { x: event.clientX, y: event.clientY },
      row: element,
    });
  };
  const park = async (row: Row, action: Arrange | "delete") => {
    if (
      (action === "delete" || action.kind === "archive") &&
      followUps.rows(row.thread.id).length
    ) {
      setActionError(
        "Remove queued messages from this thread before archiving or deleting it.",
      );
      return;
    }
    const index = cards.findIndex((card) => card.thread.id === row.thread.id);
    const next =
      index !== -1 && cards.length > 1
        ? cards[(index + 1) % cards.length]
        : undefined;
    const forward =
      row.thread.id !== threadId
        ? undefined
        : next
          ? () => onSelectThread(next.workspace.id, next.thread.id)
          : () => onNewThread(row.workspace.id);
    if (action === "delete") {
      try {
        const outcome = await confirmAndDeleteThread(row.thread, client);
        if (!outcome) return;
        setActionError(undefined);
        setActionStatus(
          outcome.kind === "retained"
            ? `Thread deleted. Worktree kept. ${outcome.reason}`
            : undefined,
        );
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return;
      }
    } else {
      if (!(await onArrange(row.thread.id, action))) return;
      setActionError(undefined);
      setActionStatus(undefined);
    }
    if (openThread.current === row.thread.id) forward?.();
  };
  const copy = (value: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setActionError(undefined);
        setActionStatus(undefined);
      })
      .catch((error: unknown) =>
        setActionError(error instanceof Error ? error.message : String(error)),
      );
  };
  const consumedCommand = useRef<number | undefined>(undefined);
  const handleCommand = useEffectEvent((request: SidebarRequest) => {
    if (consumedCommand.current === request.sequence) return;
    consumedCommand.current = request.sequence;
    const row = rows.find(
      (row) =>
        row.thread.id === request.threadId && row.thread.archivedAtMs === null,
    );
    if (!row || threadId !== request.threadId) return;
    const operation = request.operation;
    if (
      (operation.kind === "archive" || operation.kind === "delete") &&
      !canParkThread(row.thread, followUps.rows(row.thread.id).length > 0)
    ) {
      setActionError(
        "This thread has running work, an approval, or queued messages. Finish them before archiving or deleting it.",
      );
      return;
    }
    switch (operation.kind) {
      case "rename":
        if (saving.current) return;
        setQuery("");
        setScopeId(null);
        void storage.removeItem(SCOPE_KEY);
        setSnoozedExpanded(true);
        setSettledExpanded(true);
        setSettledPage({ scopeId: undefined, count: rows.length });
        editRename({ id: row.thread.id, title: row.thread.title });
        return;
      case "snooze": {
        if (row.thread.awaitingApproval) return;
        const preset = resolveSnoozePresets(new Date()).find(
          (preset) => preset.id === operation.preset,
        );
        if (preset) void park(row, { kind: "snooze", untilMs: preset.untilMs });
        return;
      }
      case "wake":
        void onArrange(row.thread.id, { kind: "wake" });
        return;
      case "archive":
        void park(row, { kind: "archive" });
        return;
      case "delete":
        void park(row, "delete");
        return;
      case "copyPath":
        copy(
          row.thread.checkout.kind === "local"
            ? row.workspace.root
            : row.thread.checkout.path,
        );
        return;
      case "copyBranch":
        if (row.workspace.kind === "repository" && row.branch) copy(row.branch);
        return;
      case "copyId":
        copy(row.thread.id);
        return;
    }
  });
  useEffect(() => {
    if (commandRequest) handleCommand(commandRequest);
  }, [commandRequest]);
  return (
    <RenameContext.Provider
      value={{ renaming, setRenaming: editRename, saveRename, savingRename }}
    >
      {actionStatus ? (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {actionStatus}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="px-3 py-2 text-xs text-error-foreground">
          {actionError}
        </p>
      ) : null}
      <div className="w-full shrink-0">
        <div className="relative flex w-full min-w-0 flex-col p-[var(--sidebar-content-inset)] z-[1]">
          <div className="flex items-center gap-1">
            <label
              ref={searchField}
              className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            >
              <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
              <input
                type="search"
                placeholder="Search"
                aria-label="Search threads"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent p-0 font-medium text-sidebar-foreground text-sm leading-normal outline-none placeholder:text-sidebar-muted-foreground [&::-webkit-search-cancel-button]:hidden"
              />
              {query ? (
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label="Clear thread search"
                  onClick={() => setQuery("")}
                >
                  <XIcon className="size-3" />
                </Button>
              ) : null}
            </label>
            <div className="flex shrink-0 items-center">
              {workspaces.length > 0 ? (
                <>
                  <ProjectScopeMenu
                    workspaces={workspaces}
                    scope={scope}
                    anchor={searchField}
                    onScope={(id) => {
                      setScopeId(id);
                      if (id) void storage.setItem(SCOPE_KEY, id);
                      else void storage.removeItem(SCOPE_KEY);
                    }}
                    onOpenSettings={(id) => {
                      // Settings records the focused element so Back can restore it.
                      scopeTrigger.current?.focus();
                      onOpenProjectSettings(id);
                    }}
                    trigger={({ ref, ...props }) => {
                      const label = scope
                        ? `Filter threads by project: ${scope.label}`
                        : "Filter threads by project";
                      return (
                        <HeaderIconButton
                          aria-label={label}
                          title={label}
                          ref={(node) => {
                            ref(node);
                            scopeTrigger.current = node;
                          }}
                          {...props}
                        >
                          {scope ? (
                            <span className="flex shrink-0">
                              <WorkspaceBadge
                                workspace={scope}
                                className="size-4"
                              />
                            </span>
                          ) : (
                            <FolderIcon className="size-4" />
                          )}
                        </HeaderIconButton>
                      );
                    }}
                  />
                  <HeaderIconButton
                    aria-label="Add project"
                    title="Add project"
                    onClick={onOpenRepository}
                  >
                    <FolderPlusIcon />
                  </HeaderIconButton>
                </>
              ) : null}
              <HeaderIconButton
                aria-label="New thread"
                title={`New thread${shortcutLabel("chat.new") ? ` (${shortcutLabel("chat.new")})` : ""}\nNew thread in current project: Shift+click`}
                disabled={!scope && !workspaceId}
                onClick={(event) => onNewThread(scope?.id, event.shiftKey)}
              >
                <SquarePenIcon />
              </HeaderIconButton>
            </div>
          </div>
        </div>
      </div>
      <div className="h-auto min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex w-full min-w-0 flex-col [overflow-anchor:none] min-h-full">
          <div className="relative flex w-full min-w-0 flex-col p-[var(--sidebar-content-inset)] pt-0 flex-1">
            {inboxCards.length + workingTotal + snoozedTotal + settledTotal >
            0 ? (
              <ul className="relative flex flex-col gap-px flex-1">
                {inboxCards.map((row) => (
                  <ThreadRow
                    key={row.thread.id}
                    row={row}
                    active={row.thread.id === threadId}
                    onDropFiles={(files) => dropFiles(row, files)}
                    onSelect={() =>
                      onSelectThread(row.workspace.id, row.thread.id)
                    }
                    onPullRequests={() =>
                      onSelectThread(
                        row.workspace.id,
                        row.thread.id,
                        pullRequestSurface(row.thread.pullRequests.links),
                      )
                    }
                    onContextMenu={openMenu(row)}
                    onSettle={() => void park(row, { kind: "settle" })}
                    onSnooze={(untilMs) =>
                      void park(row, { kind: "snooze", untilMs })
                    }
                    onUnpin={() =>
                      void onArrange(row.thread.id, { kind: "unpin" })
                    }
                  />
                ))}
                {workingTotal > 0 ? (
                  <SectionHeader
                    className="mt-auto"
                    label={
                      workingShelfExpanded
                        ? "Working"
                        : `Working (${workingTotal})`
                    }
                    expanded={workingShelfExpanded}
                    disabled={searching}
                    onToggle={toggleWorking}
                  />
                ) : null}
                {working.map((row) => (
                  <ThreadRow
                    key={row.thread.id}
                    row={row}
                    active={row.thread.id === threadId}
                    onDropFiles={(files) => dropFiles(row, files)}
                    onSelect={() =>
                      onSelectThread(row.workspace.id, row.thread.id)
                    }
                    onPullRequests={() =>
                      onSelectThread(
                        row.workspace.id,
                        row.thread.id,
                        pullRequestSurface(row.thread.pullRequests.links),
                      )
                    }
                    onContextMenu={openMenu(row)}
                    onSettle={() => void park(row, { kind: "settle" })}
                    onSnooze={(untilMs) =>
                      void park(row, { kind: "snooze", untilMs })
                    }
                    onUnpin={() =>
                      void onArrange(row.thread.id, { kind: "unpin" })
                    }
                  />
                ))}
                {snoozedTotal > 0 ? (
                  <SectionHeader
                    snoozed
                    className={cn(workingTotal === 0 && "mt-auto")}
                    label={
                      snoozedShelfExpanded
                        ? "Snoozed"
                        : `Snoozed (${snoozedTotal})`
                    }
                    expanded={snoozedShelfExpanded}
                    disabled={searching}
                    onToggle={toggleSnoozed}
                  />
                ) : null}
                {snoozed.map((row) => (
                  <SlimRow
                    key={row.thread.id}
                    row={row}
                    action="unsnooze"
                    label={snoozeWakeLabel(
                      row.thread.snoozedUntilMs ?? now,
                      now,
                    )}
                    active={row.thread.id === threadId}
                    onDropFiles={(files) => dropFiles(row, files)}
                    onSelect={() =>
                      onSelectThread(row.workspace.id, row.thread.id)
                    }
                    onPullRequests={() =>
                      onSelectThread(
                        row.workspace.id,
                        row.thread.id,
                        pullRequestSurface(row.thread.pullRequests.links),
                      )
                    }
                    onContextMenu={openMenu(row)}
                    onAction={() =>
                      void onArrange(row.thread.id, { kind: "wake" })
                    }
                    onUnpin={() =>
                      void onArrange(row.thread.id, { kind: "unpin" })
                    }
                  />
                ))}
                <SectionHeader
                  className={cn(
                    workingTotal === 0 && snoozedTotal === 0 && "mt-auto",
                  )}
                  label={
                    settledShelfExpanded
                      ? "Settled"
                      : `Settled (${settledTotal})`
                  }
                  expanded={settledShelfExpanded}
                  disabled={searching}
                  onToggle={toggleSettled}
                />
                {settled.map((row) => (
                  <SlimRow
                    key={row.thread.id}
                    row={row}
                    action="unsettle"
                    label={
                      row.thread.settledAtMs === null
                        ? ""
                        : formatSidebarTime(row.thread.settledAtMs)
                    }
                    active={row.thread.id === threadId}
                    onDropFiles={(files) => dropFiles(row, files)}
                    onSelect={() =>
                      onSelectThread(row.workspace.id, row.thread.id)
                    }
                    onPullRequests={() =>
                      onSelectThread(
                        row.workspace.id,
                        row.thread.id,
                        pullRequestSurface(row.thread.pullRequests.links),
                      )
                    }
                    onContextMenu={openMenu(row)}
                    onAction={() =>
                      void onArrange(row.thread.id, { kind: "unsettle" })
                    }
                    onUnpin={() =>
                      void onArrange(row.thread.id, { kind: "unpin" })
                    }
                  />
                ))}
                {settledExpanded && hiddenCount > 0 ? (
                  <li className="list-none">
                    <button
                      type="button"
                      onClick={() =>
                        setSettledPage({
                          scopeId: scope?.id,
                          count: settledVisibleCount + SETTLED_TAIL_PAGE_COUNT,
                        })
                      }
                      className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                    >
                      <PlusIcon aria-hidden className="size-4 shrink-0" />
                      Show {Math.min(hiddenCount, SETTLED_TAIL_PAGE_COUNT)} more
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : (
              <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
                {searching ? (
                  "No matching threads"
                ) : workspaces.length === 0 ? (
                  <>
                    No projects yet
                    <button
                      type="button"
                      onClick={onOpenRepository}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                    >
                      <PlusIcon className="-mx-0.5 size-3" />
                      Add project
                    </button>
                  </>
                ) : scope ? (
                  `No threads in ${scope.label} yet`
                ) : (
                  "No threads yet"
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {menu && menuRow ? (
        <ThreadContextMenu
          key={`${menu.threadId}:${menu.point.x}:${menu.point.y}`}
          row={menuRow}
          point={menu.point}
          returnFocus={menu.row}
          now={now}
          onClose={() => setMenu(undefined)}
          onArrange={(action) => void onArrange(menuRow.thread.id, action)}
          onPark={(action) => void park(menuRow, action)}
          onRename={() =>
            editRename({ id: menuRow.thread.id, title: menuRow.thread.title })
          }
          savingRename={savingRename}
          onDelete={() => void park(menuRow, "delete")}
          onCopy={copy}
        />
      ) : null}
    </RenameContext.Provider>
  );
}

function ThreadContextMenu({
  row: { thread, workspace, branch },
  point,
  returnFocus,
  now,
  onClose,
  onArrange,
  onPark,
  onRename,
  savingRename,
  onDelete,
  onCopy,
}: {
  row: Row;
  point: { x: number; y: number };
  returnFocus: HTMLElement;
  now: number;
  onClose: () => void;
  onArrange: (action: Arrange) => void;
  onPark: (action: Arrange) => void;
  onRename: () => void;
  savingRename: boolean;
  onDelete: () => void;
  onCopy: (value: string) => void;
}) {
  const pinned = thread.pinnedAtMs !== null;
  const settled = thread.settledAtMs !== null;
  const snoozed = thread.snoozedUntilMs !== null && thread.snoozedUntilMs > now;
  const [presets] = useState(() => resolveSnoozePresets(new Date()));
  return (
    <Menu
      open
      point={point}
      returnFocus={returnFocus}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      trigger={() => null}
    >
      <MenuItem onClick={() => onArrange({ kind: pinned ? "unpin" : "pin" })}>
        {pinned ? <PinOffIcon /> : <PinIcon />}
        {pinned ? "Unpin thread" : "Pin thread"}
      </MenuItem>
      <MenuItem
        onClick={() =>
          settled ? onArrange({ kind: "unsettle" }) : onPark({ kind: "settle" })
        }
      >
        <CircleCheckIcon />
        {settled ? "Un-settle thread" : "Settle thread"}
      </MenuItem>
      {snoozed ? (
        <MenuItem onClick={() => onArrange({ kind: "wake" })}>
          <ClockIcon />
          Wake thread
        </MenuItem>
      ) : (
        <MenuSub
          label="Snooze"
          icon={<ClockIcon />}
          disabled={thread.awaitingApproval}
        >
          {presets.map((preset) => (
            <MenuItem
              key={preset.id}
              onClick={() =>
                onPark({ kind: "snooze", untilMs: preset.untilMs })
              }
            >
              {`${preset.label} (${preset.whenLabel})`}
            </MenuItem>
          ))}
        </MenuSub>
      )}
      <MenuSeparator />
      <MenuItem onClick={onRename} disabled={savingRename}>
        <SquarePenIcon />
        Rename thread
      </MenuItem>
      <MenuSeparator />
      <MenuSub label="Copy" icon={<CopyIcon />}>
        <MenuItem
          onClick={() =>
            onCopy(
              thread.checkout.kind === "local"
                ? workspace.root
                : thread.checkout.path,
            )
          }
        >
          <FolderIcon />
          Path
        </MenuItem>
        {workspace.kind === "repository" && branch ? (
          <MenuItem onClick={() => onCopy(branch)}>
            <GitBranchIcon />
            Branch
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => onCopy(thread.id)}>
          <HashIcon />
          Thread ID
        </MenuItem>
      </MenuSub>
      <MenuSeparator />
      <MenuItem
        disabled={
          workingSessions.has(thread.session.kind) || thread.awaitingApproval
        }
        onClick={() => onPark({ kind: "archive" })}
      >
        <ArchiveIcon />
        Archive thread
      </MenuItem>
      <MenuItem
        variant="destructive"
        disabled={
          workingSessions.has(thread.session.kind) || thread.awaitingApproval
        }
        onClick={onDelete}
      >
        <Trash2Icon />
        Delete
      </MenuItem>
    </Menu>
  );
}

// Enter on a nested button must reach that button, not select the row.
function rowKeyDown(onSelect: () => void) {
  return (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };
}

function rowAction(action: () => void) {
  return (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  };
}

function SectionHeader({
  label,
  snoozed = false,
  className,
  expanded,
  disabled,
  onToggle,
}: {
  label: string;
  snoozed?: boolean;
  className?: string;
  expanded: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={cn("list-none mx-0.5 h-8", className)}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        disabled={disabled}
        className={cn(
          "flex h-full w-full items-center gap-2 px-2 text-left text-xs font-medium",
          snoozed ? "text-info-foreground" : "text-sidebar-muted-foreground/60",
          "cursor-pointer disabled:cursor-default",
        )}
      >
        <span className="shrink-0">{label}</span>
        <span
          aria-hidden
          className={cn(
            "h-px min-w-2 flex-1",
            snoozed ? "bg-info/20" : "bg-sidebar-border/60",
          )}
        />
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
    </li>
  );
}

function PinIndicator({ onUnpin }: { onUnpin: () => void }) {
  return (
    <button
      type="button"
      aria-label="Unpin thread"
      title="Unpin thread"
      onClick={rowAction(onUnpin)}
      className="inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PinIcon aria-hidden className="size-3 shrink-0" />
    </button>
  );
}

// Clicks and right-clicks inside the portaled popup still bubble to the row
// through React, so the wrapper keeps them from reaching it.
function SnoozeMenuButton({
  open,
  onOpenChange,
  onSnooze,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (untilMs: number) => void;
}) {
  // Presets resolve when the menu opens, so "In 1 hour" counts from the click.
  const presets = useMemo(
    () => (open ? resolveSnoozePresets(new Date()) : []),
    [open],
  );
  return (
    <span
      className="flex"
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <Menu
        side="bottom"
        align="end"
        open={open}
        onOpenChange={onOpenChange}
        trigger={(props) => (
          <button
            type="button"
            aria-label="Snooze thread"
            title="Snooze thread"
            className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
            {...props}
          >
            <ClockIcon className="size-3" />
          </button>
        )}
      >
        {presets.map((preset) => (
          <MenuItem key={preset.id} onClick={() => onSnooze(preset.untilMs)}>
            {preset.label}
            <MenuShortcut>{preset.whenLabel}</MenuShortcut>
          </MenuItem>
        ))}
      </Menu>
    </span>
  );
}

function WorkingDuration({ startedAt }: { startedAt: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? null : (
    <span className="tabular-nums">
      {formatWorkingDurationLabel(Date.now() - startedAt)}
    </span>
  );
}

function ThreadRow({
  row,
  onDropFiles,
  active,
  onSelect,
  onPullRequests,
  onSettle,
  onSnooze,
  onUnpin,
  onContextMenu,
}: {
  row: Row;
  onDropFiles: (files: File[]) => void;
  active: boolean;
  onSelect: () => void;
  onPullRequests: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onSettle: () => void;
  onSnooze: (untilMs: number) => void;
  onUnpin: () => void;
}) {
  const isWorking = isSidebarThreadWorking(row.thread);
  const recede = !active;
  const { fileDrop, isDragOver } = useThreadFileDrop(onDropFiles);
  // Settling and snoozing are refused while an approval waits, so the buttons stay hidden.
  const canSettle = !row.thread.awaitingApproval;
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  // The button unmounts while an approval waits, so it must not reopen after.
  useEffect(() => {
    if (!canSettle) setSnoozeOpen(false);
  }, [canSettle]);
  return (
    <li
      data-thread-item
      {...fileDrop}
      className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]"
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        onKeyDown={rowKeyDown(onSelect)}
        onContextMenu={onContextMenu}
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isDragOver && "ring-1 ring-inset ring-primary/70",
          isDragOver && !active && "bg-sidebar-row-hover",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : recede
              ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
          recede &&
            isWorking &&
            "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
        )}
      >
        <span className="sr-only">{row.thread.title}</span>
        <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <WorkspaceBadge
              workspace={row.workspace}
              className="size-4 shrink-0"
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-secondary-label text-xs",
                recede ? "font-normal" : "font-medium",
              )}
            >
              {row.workspace.label}
            </span>
            {row.thread.pinnedAtMs !== null ? (
              <PinIndicator onUnpin={onUnpin} />
            ) : null}
            <span className="group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
              <span
                className={cn(
                  "pointer-events-none",
                  canSettle &&
                    "group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-hover/sidebar-row:absolute group-hover/sidebar-row:right-0 group-hover/sidebar-row:opacity-0",
                  "flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity",
                  snoozeOpen &&
                    "pointer-events-none absolute right-0 opacity-0",
                )}
              >
                {row.thread.awaitingApproval ? (
                  <span className="inline-flex items-center gap-1 font-medium text-warning-foreground">
                    <ShieldQuestionIcon
                      aria-hidden
                      className="size-4 shrink-0"
                    />
                    <span role="status">Approval</span>
                  </span>
                ) : isWorking ? (
                  <span className="inline-flex items-center gap-1 font-medium text-info">
                    <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                    <span role="status">Working</span>
                    <span aria-hidden>
                      <WorkingDuration
                        startedAt={
                          row.thread.latestTurn?.startedAtMs ??
                          row.thread.updatedAtMs
                        }
                      />
                    </span>
                  </span>
                ) : row.thread.updatedAtMs !== null ? (
                  formatSidebarTime(row.thread.updatedAtMs)
                ) : null}
              </span>
              {canSettle ? (
                <span
                  className={cn(
                    "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:static group-hover/sidebar-row:opacity-100",
                    snoozeOpen && "pointer-events-auto static opacity-100",
                  )}
                >
                  <SnoozeMenuButton
                    open={snoozeOpen}
                    onOpenChange={setSnoozeOpen}
                    onSnooze={onSnooze}
                  />
                  <button
                    type="button"
                    aria-label="Settle thread"
                    title="Settle thread"
                    onClick={rowAction(onSettle)}
                    className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <CheckIcon className="size-3.5" />
                    Settle
                  </button>
                </span>
              ) : null}
            </span>
          </div>
          <div className="mt-1 flex min-w-0">
            <ThreadTitle
              thread={row.thread}
              className={cn(
                "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none truncate",
                recede
                  ? "font-normal text-secondary-label"
                  : "font-medium text-foreground/90",
              )}
            />
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
            <PrBadge row={row} onOpen={onPullRequests} />
            {row.branch ? (
              <>
                {row.thread.checkout.kind === "worktree" ? (
                  <WorktreeIndicator {...row.thread.checkout} />
                ) : null}
                <span className="flex min-w-0 flex-1 text-muted-foreground/40">
                  <span className="inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap">
                    <span className="min-w-0 truncate">{row.branch}</span>
                  </span>
                </span>
              </>
            ) : (
              <span className="flex-1" />
            )}
            <span
              aria-hidden
              className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
            >
              <span className="inline-flex shrink-0 items-center">
                <OpenAI className="size-3.5 opacity-60" />
              </span>
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}

function SlimRow({
  row,
  onDropFiles,
  action,
  label,
  active,
  onSelect,
  onPullRequests,
  onAction,
  onUnpin,
  onContextMenu,
}: {
  row: Row;
  onDropFiles: (files: File[]) => void;
  action: "unsettle" | "unsnooze";
  label: string;
  active: boolean;
  onSelect: () => void;
  onPullRequests: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onAction: () => void;
  onUnpin: () => void;
}) {
  const recede = !active;
  const { fileDrop, isDragOver } = useThreadFileDrop(onDropFiles);
  const unsettle = action === "unsettle";
  return (
    <li
      data-thread-item
      {...fileDrop}
      className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]"
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        onKeyDown={rowKeyDown(onSelect)}
        onContextMenu={onContextMenu}
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          unsettle &&
            "[&:not(:hover):not(:focus-within)_*]:text-secondary-label/70",
          isDragOver && "ring-1 ring-inset ring-primary/70",
          isDragOver && !active && "bg-sidebar-row-hover",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          "flex h-9 items-center gap-2.5 px-2.5",
        )}
      >
        <span className="sr-only">{row.thread.title}</span>
        <span
          className={cn(
            "shrink-0 transition-opacity",
            (recede || unsettle) &&
              "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
          )}
        >
          <WorkspaceBadge workspace={row.workspace} className="size-4" />
        </span>
        <ThreadTitle
          thread={row.thread}
          className={cn(
            "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none",
            recede ? "font-normal" : "font-medium",
            "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
            recede ? "text-secondary-label/70" : "text-foreground",
          )}
        />
        <PrBadge row={row} onOpen={onPullRequests} />
        {row.thread.pinnedAtMs !== null ? (
          <PinIndicator onUnpin={onUnpin} />
        ) : null}
        <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
          <span className="inline-flex justify-end tabular-nums text-secondary-label transition-opacity group-hover/sidebar-row:opacity-0">
            <span
              className={cn(
                "text-xs",
                !unsettle && "text-info-foreground tabular-nums",
              )}
            >
              {label}
            </span>
          </span>
          <button
            type="button"
            aria-label={unsettle ? "Un-settle thread" : "Wake thread now"}
            title={unsettle ? "Un-settle thread" : "Wake thread now"}
            onClick={rowAction(onAction)}
            className="pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
          >
            {unsettle ? (
              <Undo2Icon className="mb-px size-3.5" />
            ) : (
              <AlarmClockOffIcon className="mb-px size-3" />
            )}
          </button>
        </span>
      </div>
    </li>
  );
}

function WorktreeIndicator({ path, branch }: { path: string; branch: string }) {
  const label = `Worktree: ${pathBasename(path)} (${branch})`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex items-center justify-center"
    >
      <FolderGit2Icon className="size-3 text-muted-foreground/40" />
    </span>
  );
}

export function SidebarBrand({ onNewThread }: { onNewThread: () => void }) {
  return (
    <div
      data-tauri-drag-region="deep"
      className="@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:px-0 drag-region"
    >
      <button
        type="button"
        aria-label="New thread"
        onClick={onNewThread}
        className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 cursor-pointer items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex text-foreground"
      >
        <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
          <span className="shrink-0 font-bold">Bot</span>
          <span className="truncate [text-box:trim-both_cap_alphabetic] text-muted-foreground">
            Code
          </span>
        </span>
      </button>
    </div>
  );
}

function PrBadge({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const links = row.thread.pullRequests.links;
  const first = links[0]?.pr;
  if (!first) return null;
  const label =
    links.length === 1
      ? `#${first.key.split("/").at(-1)} ${prLabel(first)}`
      : `${links.length} PRs`;
  const stale = links.some((link) => link.pr.freshness.kind !== "current");
  return (
    <button
      type="button"
      title={stale ? `${label}. Status may be out of date` : label}
      aria-label={`Open pull requests: ${label}`}
      onClick={rowAction(onOpen)}
      onKeyDown={(event) => event.stopPropagation()}
      className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground hover:text-foreground"
    >
      {label}
      {stale ? " ·" : ""}
    </button>
  );
}

const RenameContext = createContext<
  | {
      renaming: { id: string; title: string } | undefined;
      setRenaming: (value: { id: string; title: string } | undefined) => void;
      saveRename: () => Promise<void>;
      savingRename: boolean;
    }
  | undefined
>(undefined);

function ThreadTitle({
  thread,
  className,
}: {
  thread: Row["thread"];
  className: string;
}) {
  const editor = useContext(RenameContext);
  if (!editor || editor.renaming?.id !== thread.id)
    return (
      <span aria-hidden className={className}>
        {thread.title}
      </span>
    );
  return (
    <input
      autoFocus
      disabled={editor.savingRename}
      value={editor.renaming.title}
      aria-label="Thread title"
      onFocus={(event) => {
        event.currentTarget.select();
        event.currentTarget.scrollIntoView({ block: "nearest" });
      }}
      onChange={(event) =>
        editor.setRenaming({ id: thread.id, title: event.target.value })
      }
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          void editor.saveRename();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          editor.setRenaming(undefined);
        }
      }}
      onBlur={() => void editor.saveRename()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  );
}

function useThreadFileDrop(addFiles: (files: File[]) => void) {
  const [isDragOver, setDragOver] = useState(false);
  useEffect(() => {
    const clear = () => setDragOver(false);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);
  return {
    isDragOver,
    fileDrop: makeWorkspaceFileDropHandlers({
      setDragActive: setDragOver,
      addFiles,
    }),
  };
}
