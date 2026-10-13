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
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  CopyIcon,
  Trash2Icon,
  GitBranchIcon,
  HashIcon,
  AlarmClockIcon,
  AlarmClockOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleCheckIcon,
  ClockIcon,
  PinIcon,
  PinOffIcon,
  ShieldQuestionIcon,
  ContainerIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
  Undo2Icon,
  XIcon,
  FolderTreeIcon,
  MailOpenIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  RefreshCwIcon,
  SettingsIcon,
  TimerIcon,
  type LucideIcon,
} from "lucide-react";
import {
  ipc,
  type Arrange,
  type Checkout,
  type Workspace,
  type WorkspaceView,
} from "./ipc";
import { cn } from "./lib/cn";
import { resolveWorktreeCleanup, usePreferences } from "./settings/preferences";
import {
  compareInboxReturns,
  formatWorkingDurationLabel,
  isSidebarThreadWorking,
  observeInboxReturns,
  resolveSidebarThreadStatus,
  shouldRecedeSidebarThread,
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
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSub,
  MenuSeparator,
} from "./ui/menu";
import {
  canParkThread,
  shortcutLabel,
  type SidebarRequest,
} from "./lib/actions";
import { confirmAndDeleteThread } from "./threadActions";
import { compareActiveThreads, comparePinnedThreads } from "./lib/threadSort";
import {
  DndContext,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import {
  restrictToFirstScrollableAncestor,
  restrictToVerticalAxis,
} from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  animateSidebarLayoutChanges,
  applySidebarThreadDrop,
  orderItemsByPreferredIds,
  planSidebarThreadDrop,
  releasesSidebarDrop,
  sidebarDropCommands,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarDropTarget,
  type SidebarDropVerb,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarOptimisticDrop,
  type SidebarSection,
} from "./sidebarDrop";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel,
} from "./sidebarDrag";
import { SidebarDragLifecycle, SidebarPointerSensor } from "./sidebarPointer";
import {
  resolveSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "./lib/snooze";
import { CustomSnoozeDialog } from "./CustomSnoozeDialog";
import {
  hasUnseenCompletion,
  isThreadWoke,
  threadVisits,
  useThreadLastVisitedAt,
} from "./lib/threadVisits";
import { projectScope, useProjectScopeId } from "./lib/projectScope";
import {
  buildThreadActionMenuItems,
  sidebarThreadMenuSupports,
  type ThreadActionMenuIcon,
  type ThreadActionMenuId,
  type ThreadActionMenuItem,
} from "./threadActionMenu";
import { Tooltip } from "./ui/tooltip";
import { Toast, ToastViewport } from "./ui/toast";

type Row = {
  workspace: Workspace;
  branch: string;
  thread: WorkspaceView["threads"][number];
};

const WORKING_EXPANDED_KEY = "l1code:sidebar:working-expanded";
const SNOOZED_EXPANDED_KEY = "l1code:sidebar:snoozed-expanded";
const SETTLED_EXPANDED_KEY = "l1code:sidebar:settled-expanded";
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;

type SidebarSections = {
  pinned: Row[];
  settledOrder: string[];
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
  drop,
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
  drop?: SidebarOptimisticDrop | null;
}): SidebarSections {
  const needle = query.trim().toLowerCase();
  const pinned: Row[] = [];
  const active: Row[] = [];
  const working: Row[] = [];
  const snoozed: Row[] = [];
  const settled: Row[] = [];
  const inbox = (thread: Row["thread"]) =>
    workingEnabled && isSidebarThreadWorking(thread) ? working : active;
  for (const row of rows) {
    if (row.thread.archivedAtMs != null) continue;
    if (scopeId && row.workspace.id !== scopeId) continue;
    if (needle && !row.thread.title.toLowerCase().includes(needle)) continue;
    if (drop?.key === row.thread.id) {
      const projected = applySidebarThreadDrop(
        row.thread,
        drop.section,
        drop.atMs,
        drop.assignedKeys.get(row.thread.id),
      );
      const thread = drop.clearsSnooze
        ? projected
        : { ...projected, snoozedUntilMs: row.thread.snoozedUntilMs };
      (drop.section === "pinned"
        ? pinned
        : drop.section === "settled"
          ? settled
          : inbox(thread)
      ).push({ ...row, thread });
      continue;
    }
    const { snoozedUntilMs, settledAtMs, pinnedAtMs } = row.thread;
    (snoozedUntilMs !== null && snoozedUntilMs > now
      ? snoozed
      : settledAtMs !== null
        ? settled
        : pinnedAtMs !== null
          ? pinned
          : inbox(row.thread)
    ).push(row);
  }
  pinned.sort((a, b) => comparePinnedThreads(a.thread, b.thread));
  const byReturn = (a: Row, b: Row) =>
    compareInboxReturns(a.thread, b.thread, observedReturns) ||
    a.workspace.id.localeCompare(b.workspace.id);
  active.sort(
    workingEnabled
      ? byReturn
      : (a, b) => compareActiveThreads(a.thread, b.thread),
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
    settledOrder: settled.map((row) => row.thread.id),
  };
  const held = (section: "pinned" | "active", list: Row[]) =>
    drop?.section === section && drop.order !== null
      ? orderItemsByPreferredIds({
          items: list,
          preferredIds: drop.order,
          getId: (row) => row.thread.id,
        })
      : list;
  if (needle)
    return {
      pinned: held("pinned", pinned),
      active: held("active", active),
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
    pinned: held("pinned", pinned),
    active: held("active", active),
    working: workingExpanded ? working : working.filter(isOpen),
    snoozed: snoozedExpanded ? snoozed : snoozed.filter(isOpen),
    settled: settledExpanded ? page : page.filter(isOpen),
    ...totals,
    hiddenCount: settled.length - page.length,
  };
}

export function sidebarListItems(sections: SidebarSections): SidebarListItem[] {
  const rowsOf = (list: Row[], section: SidebarSection): SidebarListItem[] =>
    list.map((row) => ({ kind: "thread", key: row.thread.id, section }));
  if (
    sections.pinned.length +
      sections.active.length +
      sections.workingTotal +
      sections.snoozedTotal +
      sections.settledTotal ===
    0
  ) {
    return [];
  }
  const items: SidebarListItem[] = [
    { kind: "marker", marker: "pinned-header" },
    ...rowsOf(sections.pinned, "pinned"),
    { kind: "marker", marker: "pinned-divider" },
    { kind: "marker", marker: "active-placeholder" },
    ...rowsOf(sections.active, "active"),
  ];
  if (sections.workingTotal > 0) {
    items.push({ kind: "marker", marker: "working-header" });
    items.push(...rowsOf(sections.working, "working"));
  }
  if (sections.snoozedTotal > 0) {
    items.push({ kind: "marker", marker: "snoozed-header" });
    items.push(...rowsOf(sections.snoozed, "snoozed"));
  }
  items.push({ kind: "marker", marker: "settled-header" });
  items.push({ kind: "marker", marker: "settled-placeholder" });
  items.push(...rowsOf(sections.settled, "settled"));
  return items;
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
  const scopeId = useProjectScopeId();
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
  const [optimisticDrop, setOptimisticDrop] =
    useState<SidebarOptimisticDrop | null>(null);
  const partitionInput = {
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
  };
  const sections = partitionSidebarRows({
    ...partitionInput,
    drop: optimisticDrop,
  });
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
  } = sections;
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
    snoozePresets: SnoozePreset[];
  }>();
  const menuRow = menu && rows.find((row) => row.thread.id === menu.threadId);
  const [customSnoozeId, setCustomSnoozeId] = useState<string>();
  const [titleError, setTitleError] = useState<string>();
  const regenerateTitle = (row: Row) => {
    if (row.thread.isRegeneratingTitle) return;
    ipc
      .regenerateThreadTitle(row.thread.id)
      .then(() => setTitleError(undefined))
      .catch((error: unknown) =>
        setTitleError(error instanceof Error ? error.message : String(error)),
      );
  };
  const customSnoozeRow =
    customSnoozeId === undefined
      ? undefined
      : rows.find(
          (row) =>
            row.thread.id === customSnoozeId &&
            row.thread.archivedAtMs === null,
        );
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
      snoozePresets: resolveSnoozePresets(new Date()),
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
      return false;
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
        const outcome = await confirmAndDeleteThread(
          row.thread,
          client,
          resolveWorktreeCleanup(preferences, row.workspace.id)
            .worktreeOnDelete,
        );
        if (!outcome) return false;
        setActionError(undefined);
        setActionStatus(
          outcome.kind === "retained"
            ? `Thread deleted. Worktree kept. ${outcome.reason}`
            : undefined,
        );
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
        return false;
      }
    } else {
      if (!(await onArrange(row.thread.id, action))) return false;
      setActionError(undefined);
      setActionStatus(undefined);
    }
    if (openThread.current === row.thread.id) forward?.();
    return true;
  };
  const threadList = useRef<HTMLUListElement | null>(null);
  const dragLabelOffset = useRef(0);
  const restrictBelowPins = useCallback<Modifier>(
    (args) => restrictBelowSidebarLabel(args, dragLabelOffset.current),
    [],
  );
  const [dragState, setDragState] = useState<{
    readonly activeKey: string;
    readonly activeSection: SidebarSection;
    readonly atMs: number;
    readonly activationY: number | null;
    readonly targetSection: SidebarSection | null;
  } | null>(null);
  const dragTargetSection = dragState?.targetSection ?? null;
  const dragSensor = useRef<SidebarPointerSensor | null>(null);
  const finishThreadDrag = useCallback((started: boolean) => {
    dragSensor.current = null;
    if (started) setDragState(null);
  }, []);
  const attachDragSensor = useCallback((sensor: SidebarPointerSensor) => {
    dragSensor.current = sensor;
  }, []);
  const cancelThreadDrag = useCallback(() => {
    dragSensor.current?.cancel();
  }, []);
  const dndSensors = useSensors(
    useSensor(SidebarPointerSensor, {
      distance: 6,
      onAttach: attachDragSensor,
      onFinish: finishThreadDrag,
    }),
  );
  const rowByKey = new Map(rows.map((row) => [row.thread.id, row]));
  const computedListItems = sidebarListItems(sections);
  const listOrderKey = computedListItems
    .map((item) =>
      item.kind === "thread" ? `${item.key}:${item.section}` : item.marker,
    )
    .join("\0");
  const listItems = useMemo(() => computedListItems, [listOrderKey]);
  const sectionByKey = new Map(
    listItems.flatMap((item) =>
      item.kind === "thread" ? [[item.key, item.section] as const] : [],
    ),
  );
  const keysSignature = rows
    .map(
      ({ thread }) =>
        `${thread.id}:${thread.pinOrderKey ?? ""}:${thread.activeOrderKey ?? ""}`,
    )
    .join("\0");
  const { pinnedKeysById, activeKeysById } = useMemo(
    () => ({
      pinnedKeysById: new Map(
        rows.map(({ thread }) => [thread.id, thread.pinOrderKey]),
      ),
      activeKeysById: new Map(
        rows.map(({ thread }) => [thread.id, thread.activeOrderKey]),
      ),
    }),
    [keysSignature],
  );
  const pinnedIds = pinned.map((row) => row.thread.id);
  const activeIds = active.map((row) => row.thread.id);
  const workingEnabled = preferences.sidebarWorkingShelfEnabled;
  useEffect(() => {
    if (
      optimisticDrop !== null &&
      releasesSidebarDrop({
        drop: optimisticDrop,
        threadsById: new Map(rows.map(({ thread }) => [thread.id, thread])),
        destinationIds:
          optimisticDrop.section === "pinned" ? pinnedIds : activeIds,
        nowMs: Date.now(),
      })
    )
      setOptimisticDrop(null);
  }, [optimisticDrop, views]);
  useEffect(() => {
    if (
      dragState !== null &&
      !listItems.some(
        (item) => item.kind === "thread" && item.key === dragState.activeKey,
      )
    ) {
      cancelThreadDrag();
    }
  }, [cancelThreadDrag, dragState, listItems]);
  const handleThreadDragStart = (event: DragStartEvent) => {
    const activeKey = String(event.active.id);
    const activeSection = sectionByKey.get(activeKey);
    if (activeSection === undefined) return;
    const list = threadList.current;
    const header = list?.querySelector<HTMLElement>(
      '[data-testid="sidebar-pinned-header"]',
    );
    if (list && header) {
      const listRect = list.getBoundingClientRect();
      const scale =
        list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1;
      dragLabelOffset.current =
        header.getBoundingClientRect().top -
        listRect.top +
        SIDEBAR_DRAG_LABEL_HEIGHT * scale;
    } else {
      dragLabelOffset.current = 0;
    }
    setDragState({
      activeKey,
      activeSection,
      targetSection: activeSection,
      atMs: Date.now(),
      activationY:
        event.activatorEvent instanceof PointerEvent
          ? event.activatorEvent.clientY
          : null,
    });
  };
  const handleThreadDragOver = (event: DragOverEvent) => {
    const target = event.over
      ? resolveSidebarDropTarget(
          listItems,
          String(event.active.id),
          String(event.over.id),
        )
      : null;
    setDragState((current) =>
      current === null || current.activeKey !== String(event.active.id)
        ? current
        : { ...current, targetSection: target?.section ?? null },
    );
  };
  const sortableIds = useMemo(
    () => listItems.map(sidebarListItemId),
    [listItems],
  );
  const draggedKey = dragState?.activeKey;
  const draggedFrom = dragState?.activeSection;
  const draggedAtMs = dragState?.atMs;
  const dragActivationY = dragState?.activationY;
  const draggedOrder = (section: "active" | "settled") => {
    if (
      draggedKey === undefined ||
      draggedFrom === undefined ||
      draggedAtMs === undefined
    )
      return undefined;
    const projected = partitionSidebarRows({
      ...partitionInput,
      drop: {
        key: draggedKey,
        sourceSection: draggedFrom,
        section,
        atMs: draggedAtMs,
        clearsSnooze: true,
        order: null,
        keysAtDrop: new Map(),
        assignedKeys: new Map(),
      },
    });
    return section === "settled"
      ? projected.settledOrder
      : projected.active.map((row) => row.thread.id);
  };
  const sidebarSortingStrategy = useMemo(() => {
    const activeOrder = workingEnabled ? draggedOrder("active") : undefined;
    return createSidebarSortingStrategy({
      items: listItems,
      boundaryLabelHeight: SIDEBAR_DRAG_LABEL_HEIGHT,
      settledOrder: draggedOrder("settled") ?? [],
      ...(activeOrder === undefined ? {} : { activeOrder }),
      settledExpanded: settledShelfExpanded,
      settledVisibleCount,
      routeThreadKey: threadId ?? null,
      snoozedThreadCount: snoozedTotal,
    });
  }, [
    draggedKey,
    draggedAtMs,
    listItems,
    settledShelfExpanded,
    settledVisibleCount,
    snoozedTotal,
    threadId,
    workingEnabled,
  ]);
  const planDrop = (
    activeKey: string,
    activeSection: SidebarSection,
    target: SidebarDropTarget,
  ) => {
    const thread = rowByKey.get(activeKey)?.thread;
    return planSidebarThreadDrop({
      activeKey,
      activeSection,
      activePinned: thread?.pinnedAtMs != null,
      activeSettled: thread?.settledAtMs != null,
      target,
      pinnedOrder: pinnedIds,
      pinnedKeysById,
      activeOrder: activeIds,
      activeKeysById,
      activeTimeOrdered: workingEnabled,
    });
  };
  const dndCollisionDetection = useMemo(() => {
    if (draggedKey === undefined || draggedFrom === undefined)
      return createSidebarCollisionDetection(() => true);
    return createSidebarCollisionDetection(
      (id) => {
        const target = resolveSidebarDropTarget(listItems, draggedKey, id);
        if (target === null) return false;
        return planDrop(draggedKey, draggedFrom, target).kind !== "none";
      },
      {
        items: listItems,
        activationY: dragActivationY ?? null,
      },
    );
  }, [
    activeKeysById,
    pinnedKeysById,
    draggedKey,
    draggedFrom,
    dragActivationY,
    listItems,
    workingEnabled,
  ]);
  const handleThreadDragEnd = (event: DragEndEvent) => {
    const activeKey = String(event.active.id);
    const activeSection = sectionByKey.get(activeKey);
    const target =
      event.over === null
        ? null
        : resolveSidebarDropTarget(listItems, activeKey, String(event.over.id));
    const row = rowByKey.get(activeKey);
    if (activeSection === undefined || target === null || row === undefined)
      return;
    const plan = planDrop(activeKey, activeSection, target);
    if (plan.kind === "none") return;
    const assignments =
      plan.kind === "pin"
        ? [
            ...(plan.orderKey === undefined
              ? []
              : [{ id: activeKey, orderKey: plan.orderKey }]),
            ...plan.extraAssignments,
          ]
        : plan.kind === "settle"
          ? []
          : plan.assignments;
    const drop: SidebarOptimisticDrop = {
      key: activeKey,
      sourceSection: activeSection,
      section: target.section,
      atMs: Date.now(),
      clearsSnooze:
        plan.kind === "pin" ||
        plan.kind === "settle" ||
        (plan.kind === "move-active" && plan.unsnooze),
      order: plan.kind === "settle" ? null : plan.order,
      keysAtDrop: new Map(
        [
          ...(target.section === "active" ? activeKeysById : pinnedKeysById),
        ].map(([id, key]) => [id, key ?? null]),
      ),
      assignedKeys: new Map(
        assignments.map(({ id, orderKey }) => [id, orderKey]),
      ),
    };
    setOptimisticDrop(drop);
    const release = () =>
      setOptimisticDrop((current) => (current === drop ? null : current));
    void (async () => {
      if (plan.kind === "settle") {
        if (!(await park(row, { kind: "settle" }))) release();
        return;
      }
      for (const { threadId: id, action } of sidebarDropCommands(
        activeKey,
        plan,
      )) {
        if (!(await onArrange(id, action))) {
          release();
          return;
        }
      }
    })();
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
  const checkoutPath = (row: Row) =>
    row.thread.checkout.kind === "local"
      ? row.workspace.root
      : row.thread.checkout.path;
  const toggleProjectFilter = (row: Row) =>
    projectScope.set(scope?.id === row.workspace.id ? null : row.workspace.id);
  const runThreadMenuAction = (row: Row, id: ThreadActionMenuId) => {
    const preset = menu?.snoozePresets.find(
      (candidate) => `snooze:${candidate.id}` === id,
    );
    if (preset) {
      void park(row, { kind: "snooze", untilMs: preset.untilMs });
      return;
    }
    switch (id) {
      case "pin":
      case "unpin":
      case "unsettle":
        void onArrange(row.thread.id, { kind: id });
        return;
      case "settle":
        void park(row, { kind: "settle" });
        return;
      case "unsnooze":
        void onArrange(row.thread.id, { kind: "wake" });
        return;
      case "snooze:custom":
        setCustomSnoozeId(row.thread.id);
        return;
      case "auto-settle:enabled":
      case "auto-settle:disabled":
        void onArrange(row.thread.id, {
          kind: "set_auto_settle",
          enabled: id === "auto-settle:enabled",
        });
        return;
      case "rename":
        editRename({ id: row.thread.id, title: row.thread.title });
        return;
      case "regenerate-title":
        regenerateTitle(row);
        return;
      case "mark-unread":
        threadVisits.markUnread(
          row.thread.id,
          row.thread.latestTurn?.completedAtMs,
        );
        return;
      case "filter-by-project":
        toggleProjectFilter(row);
        return;
      case "project-settings":
        menu?.row.focus();
        onOpenProjectSettings(row.workspace.id);
        return;
      case "copy-path":
        copy(checkoutPath(row));
        return;
      case "copy-branch":
        if (row.workspace.kind === "repository" && row.branch) copy(row.branch);
        return;
      case "copy-thread-id":
        copy(row.thread.id);
        return;
      case "archive":
        void park(row, { kind: "archive" });
        return;
      case "delete":
        void park(row, "delete");
        return;
    }
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
        projectScope.set(null);
        setSnoozedExpanded(true);
        setSettledExpanded(true);
        setSettledPage({ scopeId: undefined, count: rows.length });
        editRename({ id: row.thread.id, title: row.thread.title });
        return;
      case "snooze": {
        if (row.thread.awaitingApproval) return;
        const choice = operation.choice;
        if (choice.kind === "custom") {
          setCustomSnoozeId(row.thread.id);
          return;
        }
        const preset = resolveSnoozePresets(new Date()).find(
          (preset) => preset.id === choice.preset,
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
        copy(checkoutPath(row));
        return;
      case "copyBranch":
        if (row.workspace.kind === "repository" && row.branch) copy(row.branch);
        return;
      case "copyId":
        copy(row.thread.id);
        return;
      case "markUnread":
        threadVisits.markUnread(
          row.thread.id,
          row.thread.latestTurn?.completedAtMs,
        );
        return;
      case "filterByProject":
        toggleProjectFilter(row);
        return;
      case "regenerateTitle":
        regenerateTitle(row);
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
                    onScope={projectScope.set}
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
              <DndContext
                sensors={dndSensors}
                collisionDetection={dndCollisionDetection}
                modifiers={[
                  restrictToVerticalAxis,
                  restrictBelowPins,
                  restrictToFirstScrollableAncestor,
                ]}
                onDragStart={handleThreadDragStart}
                onDragOver={handleThreadDragOver}
                onDragEnd={handleThreadDragEnd}
              >
                <SidebarDragLifecycle onUnmount={cancelThreadDrag} />
                <SortableContext
                  items={sortableIds}
                  strategy={sidebarSortingStrategy}
                >
                  <ul
                    ref={threadList}
                    className="relative flex flex-col gap-px flex-1"
                  >
                    {listItems.map((item) => {
                      const from = dragState?.activeSection ?? null;
                      if (item.kind === "thread") {
                        const row = rowByKey.get(item.key);
                        if (!row) return null;
                        const section = item.section;
                        const isCard =
                          section === "active" ||
                          section === "pinned" ||
                          section === "working";
                        const drag = (sortable: SortableThreadRowBag) => ({
                          sortable,
                          dropVerb:
                            dragState?.activeKey === item.key
                              ? resolveSidebarDropVerb(
                                  dragState.activeSection,
                                  dragTargetSection,
                                )
                              : null,
                          dragOverPinned:
                            dragState?.activeKey === item.key &&
                            dragTargetSection === "pinned",
                        });
                        const shared = {
                          row,
                          active: row.thread.id === threadId,
                          onDropFiles: (files: File[]) => dropFiles(row, files),
                          onSelect: () =>
                            onSelectThread(row.workspace.id, row.thread.id),
                          onPullRequests: () =>
                            onSelectThread(
                              row.workspace.id,
                              row.thread.id,
                              pullRequestSurface(row.thread.pullRequests.links),
                            ),
                          onContextMenu: openMenu(row),
                          onUnpin: () =>
                            void onArrange(row.thread.id, { kind: "unpin" }),
                        };
                        return (
                          <SortableThreadRow
                            key={item.key}
                            id={item.key}
                            disabled={
                              searching ||
                              section === "working" ||
                              renaming?.id === item.key ||
                              optimisticDrop !== null
                            }
                          >
                            {(sortable) =>
                              isCard ? (
                                <ThreadRow
                                  key={`${item.key}:card`}
                                  {...shared}
                                  {...drag(sortable)}
                                  onSettle={() =>
                                    void park(row, { kind: "settle" })
                                  }
                                  onSnooze={(untilMs) =>
                                    void park(row, { kind: "snooze", untilMs })
                                  }
                                  onCustomSnooze={() =>
                                    setCustomSnoozeId(row.thread.id)
                                  }
                                />
                              ) : section === "snoozed" ? (
                                <SlimRow
                                  key={`${item.key}:slim`}
                                  {...shared}
                                  {...drag(sortable)}
                                  action="unsnooze"
                                  label={snoozeWakeLabel(
                                    row.thread.snoozedUntilMs ?? now,
                                    now,
                                  )}
                                  onAction={() =>
                                    void onArrange(row.thread.id, {
                                      kind: "wake",
                                    })
                                  }
                                />
                              ) : (
                                <SlimRow
                                  key={`${item.key}:slim`}
                                  {...shared}
                                  {...drag(sortable)}
                                  action="unsettle"
                                  label={
                                    row.thread.settledAtMs === null
                                      ? ""
                                      : formatSidebarTime(
                                          row.thread.settledAtMs,
                                        )
                                  }
                                  onAction={() =>
                                    void onArrange(row.thread.id, {
                                      kind: "unsettle",
                                    })
                                  }
                                />
                              )
                            }
                          </SortableThreadRow>
                        );
                      }
                      switch (item.marker) {
                        case "pinned-header":
                        case "pinned-divider":
                          return (
                            <SidebarDragBoundary
                              key={item.marker}
                              marker={item.marker}
                              label={
                                item.marker === "pinned-header"
                                  ? "Pinned"
                                  : "Active"
                              }
                              visible={from !== null}
                              isDropTarget={
                                dragTargetSection ===
                                (item.marker === "pinned-header"
                                  ? "pinned"
                                  : "active")
                              }
                            />
                          );
                        case "active-placeholder":
                          return (
                            <SidebarSectionPlaceholder
                              key={item.marker}
                              marker={item.marker}
                              label="Active"
                              showHint={
                                from !== null &&
                                (active.length === 0 ||
                                  (from === "active" &&
                                    active.length === 1 &&
                                    dragTargetSection !== null &&
                                    dragTargetSection !== "active"))
                              }
                              isDropTarget={dragTargetSection === "active"}
                            />
                          );
                        case "settled-placeholder":
                          return (
                            <SidebarSectionPlaceholder
                              key={item.marker}
                              marker={item.marker}
                              label="Settled"
                              showHint={
                                from !== null &&
                                (settled.length === 0 ||
                                  (from === "settled" &&
                                    settled.length === 1 &&
                                    dragTargetSection !== null &&
                                    dragTargetSection !== "settled"))
                              }
                              isDropTarget={dragTargetSection === "settled"}
                            />
                          );
                        case "working-header":
                          return (
                            <SidebarSectionHeader
                              key={item.marker}
                              marker={item.marker}
                              className="mt-auto"
                              label={
                                workingShelfExpanded
                                  ? "Working"
                                  : `Working (${workingTotal})`
                              }
                              disabled={searching}
                              toggle={{
                                expanded: workingShelfExpanded,
                                onToggle: toggleWorking,
                              }}
                            />
                          );
                        case "snoozed-header":
                          return (
                            <SidebarSectionHeader
                              key={item.marker}
                              marker={item.marker}
                              className={cn(workingTotal === 0 && "mt-auto")}
                              label={
                                snoozedShelfExpanded
                                  ? "Snoozed"
                                  : `Snoozed (${snoozedTotal})`
                              }
                              disabled={searching}
                              toggle={{
                                expanded: snoozedShelfExpanded,
                                onToggle: toggleSnoozed,
                              }}
                            />
                          );
                        case "settled-header":
                          return (
                            <SidebarSectionHeader
                              key={item.marker}
                              marker={item.marker}
                              className={cn(
                                workingTotal === 0 &&
                                  snoozedTotal === 0 &&
                                  "mt-auto",
                              )}
                              label={
                                settledShelfExpanded
                                  ? "Settled"
                                  : `Settled (${settledTotal})`
                              }
                              dragging={from !== null}
                              isDropTarget={dragTargetSection === "settled"}
                              disabled={searching}
                              toggle={{
                                expanded: settledShelfExpanded,
                                onToggle: toggleSettled,
                              }}
                            />
                          );
                      }
                    })}
                    {settledExpanded && hiddenCount > 0 ? (
                      <li className="list-none">
                        <button
                          type="button"
                          onClick={() =>
                            setSettledPage({
                              scopeId: scope?.id,
                              count:
                                settledVisibleCount + SETTLED_TAIL_PAGE_COUNT,
                            })
                          }
                          className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                        >
                          <PlusIcon aria-hidden className="size-4 shrink-0" />
                          Show {Math.min(
                            hiddenCount,
                            SETTLED_TAIL_PAGE_COUNT,
                          )}{" "}
                          more
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </SortableContext>
              </DndContext>
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
        <Menu
          key={`${menu.threadId}:${menu.point.x}:${menu.point.y}`}
          open
          point={menu.point}
          returnFocus={menu.row}
          onOpenChange={(open) => {
            if (!open) setMenu(undefined);
          }}
          trigger={() => null}
        >
          <ThreadActionMenuItems
            items={buildThreadActionMenuItems({
              branch:
                menuRow.workspace.kind === "repository" && menuRow.branch
                  ? menuRow.branch
                  : null,
              projectFilter: {
                label: menuRow.workspace.label,
                isActive: scope?.id === menuRow.workspace.id,
              },
              isPinned: menuRow.thread.pinnedAtMs !== null,
              isSettled: menuRow.thread.settledAtMs !== null,
              autoSettleEnabled: menuRow.thread.autoSettleEnabled,
              isSnoozed:
                menuRow.thread.snoozedUntilMs !== null &&
                menuRow.thread.snoozedUntilMs > now,
              canSnoozeNow: !menuRow.thread.awaitingApproval,
              isRegeneratingTitle: menuRow.thread.isRegeneratingTitle,
              isRenamePending: savingRename,
              isRunning:
                workingSessions.has(menuRow.thread.session.kind) ||
                menuRow.thread.awaitingApproval,
              supports: sidebarThreadMenuSupports,
              snoozePresets: menu.snoozePresets,
            })}
            onSelect={(id) => runThreadMenuAction(menuRow, id)}
          />
        </Menu>
      ) : null}
      {customSnoozeRow ? (
        <CustomSnoozeDialog
          onCancel={() => setCustomSnoozeId(undefined)}
          onSnooze={(untilMs) => {
            setCustomSnoozeId(undefined);
            void park(customSnoozeRow, { kind: "snooze", untilMs });
          }}
        />
      ) : null}
      {titleError !== undefined ? (
        <ToastViewport>
          <Toast
            type="error"
            title="Failed to regenerate thread title"
            description={titleError}
            onDismiss={() => setTitleError(undefined)}
            dismissAfterVisibleMs={10000}
          />
        </ToastViewport>
      ) : null}
    </RenameContext.Provider>
  );
}

const threadActionMenuIcons: Record<ThreadActionMenuIcon, LucideIcon> = {
  "message-square-plus": MessageSquarePlusIcon,
  pin: PinIcon,
  "pin-off": PinOffIcon,
  "circle-check": CircleCheckIcon,
  clock: ClockIcon,
  pencil: PencilIcon,
  "refresh-cw": RefreshCwIcon,
  "mail-open": MailOpenIcon,
  "folder-tree": FolderTreeIcon,
  timer: TimerIcon,
  copy: CopyIcon,
  folder: FolderIcon,
  "git-branch": GitBranchIcon,
  hash: HashIcon,
  settings: SettingsIcon,
  archive: ArchiveIcon,
  trash: Trash2Icon,
};

function ThreadActionMenuItems({
  items,
  onSelect,
}: {
  items: ReadonlyArray<ThreadActionMenuItem>;
  onSelect: (id: ThreadActionMenuId) => void;
}) {
  return items.map((item) => {
    const Icon = item.icon ? threadActionMenuIcons[item.icon] : null;
    const icon = Icon ? <Icon /> : null;
    return (
      <Fragment key={item.id}>
        {item.separatorBefore ? <MenuSeparator /> : null}
        {item.children ? (
          <MenuSub label={item.label} icon={icon} disabled={item.disabled}>
            <ThreadActionMenuItems items={item.children} onSelect={onSelect} />
          </MenuSub>
        ) : item.checked !== undefined ? (
          <MenuRadioItem
            checked={item.checked}
            disabled={item.disabled}
            onClick={() => onSelect(item.id)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <MenuRadioItemIndicator checked={item.checked} />
            </span>
          </MenuRadioItem>
        ) : (
          <MenuItem
            variant={item.destructive ? "destructive" : "default"}
            disabled={item.disabled}
            onClick={() => onSelect(item.id)}
          >
            {icon}
            {item.label}
          </MenuItem>
        )}
      </Fragment>
    );
  });
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

type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

function SortableThreadRow(props: {
  id: string;
  disabled: boolean;
  children: (bag: SortableThreadRowBag) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: props.id,
      disabled: { draggable: props.disabled },
      animateLayoutChanges: animateSidebarLayoutChanges,
    });
  return props.children({
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  });
}

function sortableRootProps(sortable: SortableThreadRowBag | undefined) {
  return sortable
    ? {
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          visibility:
            !sortable.isDragging && sortable.transform?.scaleY === 0
              ? ("hidden" as const)
              : undefined,
        },
        ...sortable.listeners,
      }
    : {};
}

const liftedRowClassName =
  "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg";

const dropVerbBadge: Record<SidebarDropVerb, ReactNode> = {
  pin: (
    <>
      <PinIcon aria-hidden className="size-3" />
      Pin
    </>
  ),
  unpin: (
    <>
      <PinOffIcon aria-hidden className="size-3" />
      Unpin
    </>
  ),
  settle: (
    <>
      <CircleCheckIcon aria-hidden className="size-3" />
      Settle
    </>
  ),
  unsettle: (
    <>
      <Undo2Icon aria-hidden className="size-3" />
      Un-settle
    </>
  ),
  wake: (
    <>
      <AlarmClockOffIcon aria-hidden className="size-3" />
      Wake
    </>
  ),
};

function DropDestination({ verb }: { verb: SidebarDropVerb | null }) {
  return verb === null ? null : (
    <span
      role="status"
      className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
    >
      {dropVerbBadge[verb]}
    </span>
  );
}

function SortableSidebarMarker(props: {
  marker: SidebarListMarker;
  className?: string;
  children?: ReactNode;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(props.marker),
    disabled: { draggable: true },
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      data-testid={`sidebar-${props.marker}`}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: props.marker.endsWith("-placeholder") ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

function SidebarSectionPlaceholder(props: {
  marker: "active-placeholder" | "settled-placeholder";
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      className="relative mx-0.5 -mb-px h-0"
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

const SIDEBAR_DRAG_LABEL_HEIGHT = 24;

function SidebarDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      className="pointer-events-none relative mx-0.5 -mb-px h-0"
    >
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget
                ? "text-primary"
                : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

function SidebarSectionHeader(props: {
  marker: "working-header" | "snoozed-header" | "settled-header";
  label: string;
  className?: string;
  dragging?: boolean;
  isDropTarget?: boolean;
  disabled: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
}) {
  const snoozed = props.marker === "snoozed-header";
  return (
    <SortableSidebarMarker
      marker={props.marker}
      className={cn("mx-0.5 h-8", props.className)}
    >
      <button
        type="button"
        onClick={props.toggle.onToggle}
        aria-expanded={props.toggle.expanded}
        disabled={props.disabled}
        className={cn(
          "flex h-full w-full items-center gap-2 px-2 text-left text-xs font-medium",
          snoozed ? "text-info-foreground" : "text-sidebar-muted-foreground/60",
          props.dragging && "text-sidebar-foreground/80",
          props.isDropTarget && "text-primary",
          "cursor-pointer disabled:cursor-default",
        )}
      >
        <span className="shrink-0">{props.label}</span>
        <span
          aria-hidden
          className={cn(
            "h-px min-w-2 flex-1",
            snoozed ? "bg-info/20" : "bg-sidebar-border/60",
            props.dragging && "bg-sidebar-foreground/25",
            props.isDropTarget && "bg-primary/50",
          )}
        />
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform",
            props.toggle.expanded && "rotate-180",
          )}
        />
      </button>
    </SortableSidebarMarker>
  );
}

function PinIndicator({
  isPinned,
  sortable,
  dropVerb,
  dragOverPinned,
  onUnpin,
}: {
  isPinned: boolean;
  sortable: SortableThreadRowBag | undefined;
  dropVerb: SidebarDropVerb | null;
  dragOverPinned: boolean;
  onUnpin: () => void;
}) {
  if (
    !isPinned ||
    (sortable?.isDragging && !(dragOverPinned && dropVerb === null))
  )
    return null;
  return sortable?.isDragging ? (
    <PinIcon
      aria-label="Pinned"
      role="img"
      className="size-3 shrink-0 text-muted-foreground/65"
    />
  ) : (
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
  onCustomSnooze,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (untilMs: number) => void;
  onCustomSnooze: () => void;
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
        <MenuSeparator />
        <MenuItem onClick={onCustomSnooze}>Custom…</MenuItem>
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

type RowDrag = {
  sortable?: SortableThreadRowBag | undefined;
  dropVerb: SidebarDropVerb | null;
  dragOverPinned: boolean;
};

function ThreadRow({
  row,
  onDropFiles,
  active,
  onSelect,
  onPullRequests,
  onSettle,
  onSnooze,
  onCustomSnooze,
  onUnpin,
  onContextMenu,
  sortable,
  dropVerb,
  dragOverPinned,
}: {
  row: Row;
  onDropFiles: (files: File[]) => void;
  active: boolean;
  onSelect: () => void;
  onPullRequests: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onSettle: () => void;
  onSnooze: (untilMs: number) => void;
  onCustomSnooze: () => void;
  onUnpin: () => void;
} & RowDrag) {
  const status = resolveSidebarThreadStatus(row.thread);
  const isWorking = status === "working";
  const lastVisitedAtMs = useThreadLastVisitedAt(row.thread.id);
  const { wokeAtMs } = row.thread;
  const isWoke = isThreadWoke({
    wokeAtMs,
    lastVisitedAtMs,
    settled: row.thread.settledAtMs !== null,
  });
  const isUnread = hasUnseenCompletion({
    latestCompletedAtMs: row.thread.latestTurn?.completedAtMs,
    lastVisitedAtMs,
  });
  const recede = shouldRecedeSidebarThread({
    status,
    isUnread,
    isWoke,
    isActive: active,
  });
  const { fileDrop, isDragOver } = useThreadFileDrop(onDropFiles);
  // Settling and snoozing are refused while an approval waits, so the buttons stay hidden.
  const canSettle = !row.thread.awaitingApproval;
  const isWokeStatus = !row.thread.awaitingApproval && !isWorking && isWoke;
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  // The button unmounts while an approval waits, so it must not reopen after.
  useEffect(() => {
    if (!canSettle) setSnoozeOpen(false);
  }, [canSettle]);
  return (
    <li
      data-thread-item
      {...sortableRootProps(sortable)}
      {...fileDrop}
      className={cn(
        "list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]",
        sortable?.isDragging && "relative z-20",
      )}
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
          sortable?.isDragging && liftedRowClassName,
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
            <PinIndicator
              isPinned={row.thread.pinnedAtMs !== null}
              sortable={sortable}
              dropVerb={dropVerb}
              dragOverPinned={dragOverPinned}
              onUnpin={onUnpin}
            />
            {sortable?.isDragging ? (
              <DropDestination verb={dropVerb} />
            ) : (
              <span className="group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
                <span
                  className={cn(
                    isWokeStatus
                      ? "pointer-events-auto"
                      : cn(
                          "pointer-events-none",
                          canSettle &&
                            "group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-hover/sidebar-row:absolute group-hover/sidebar-row:right-0 group-hover/sidebar-row:opacity-0",
                        ),
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
                      <CircleDashedIcon
                        aria-hidden
                        className="size-4 shrink-0"
                      />
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
                  ) : isWoke && wokeAtMs !== null ? (
                    <Tooltip content="Dismiss Woke notification">
                      <button
                        type="button"
                        aria-label="Dismiss Woke notification"
                        onClick={rowAction(() =>
                          threadVisits.markVisited(row.thread.id, wokeAtMs),
                        )}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring text-warning-foreground"
                      >
                        <AlarmClockIcon
                          aria-hidden
                          className="size-4 shrink-0"
                        />
                        <span role="status">Woke</span>
                      </button>
                    </Tooltip>
                  ) : isUnread ? (
                    <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300">
                      <CircleCheckIcon
                        aria-hidden
                        className="size-4 shrink-0"
                      />
                      <span role="status">Done</span>
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
                      onCustomSnooze={onCustomSnooze}
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
            )}
          </div>
          <div className="mt-1 flex min-w-0">
            <ThreadTitle
              thread={row.thread}
              className={cn(
                "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none truncate",
                recede
                  ? "font-normal text-secondary-label"
                  : isUnread || isWoke
                    ? "font-medium text-foreground"
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
  sortable,
  dropVerb,
  dragOverPinned,
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
} & RowDrag) {
  const lastVisitedAtMs = useThreadLastVisitedAt(row.thread.id);
  const isUnread = hasUnseenCompletion({
    latestCompletedAtMs: row.thread.latestTurn?.completedAtMs,
    lastVisitedAtMs,
  });
  const recede = shouldRecedeSidebarThread({
    status: resolveSidebarThreadStatus(row.thread),
    isUnread,
    isWoke: false,
    isActive: active,
  });
  const { fileDrop, isDragOver } = useThreadFileDrop(onDropFiles);
  const unsettle = action === "unsettle";
  return (
    <li
      data-thread-item
      {...sortableRootProps(sortable)}
      {...fileDrop}
      className={cn(
        "list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]",
        sortable?.isDragging && "relative z-20",
      )}
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
            : recede
              ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
          sortable?.isDragging && liftedRowClassName,
          "flex h-9 items-center gap-2.5 px-2.5",
        )}
      >
        <span className="sr-only">{row.thread.title}</span>
        <span
          className={cn(
            "shrink-0 transition-opacity",
            (!active || unsettle) &&
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
            recede
              ? "text-secondary-label/70"
              : active
                ? "text-foreground"
                : isUnread
                  ? "text-muted-foreground"
                  : "text-secondary-label/70",
          )}
        />
        <PrBadge row={row} onOpen={onPullRequests} />
        <PinIndicator
          isPinned={row.thread.pinnedAtMs !== null}
          sortable={sortable}
          dropVerb={dropVerb}
          dragOverPinned={dragOverPinned}
          onUnpin={onUnpin}
        />
        {sortable?.isDragging ? (
          <DropDestination verb={dropVerb} />
        ) : (
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
        )}
      </div>
    </li>
  );
}

function WorktreeIndicator({
  path,
  branch,
  sandbox,
}: Extract<Checkout, { kind: "worktree" }>) {
  const label = `Worktree: ${pathBasename(path)} (${branch})`;
  return (
    <>
      <span
        role="img"
        aria-label={label}
        title={label}
        className="inline-flex items-center justify-center"
      >
        <FolderGit2Icon className="size-3 text-muted-foreground/40" />
      </span>
      {sandbox ? (
        <span
          role="img"
          aria-label="Sandbox"
          title="Runs in a sandbox"
          className="inline-flex items-center justify-center"
        >
          <ContainerIcon className="size-3 text-muted-foreground/40" />
        </span>
      ) : null}
    </>
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
          <span className="shrink-0 font-bold">L1</span>
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
