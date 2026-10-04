// Layout and classes follow pingdotgg/t3code v0.0.45 components/Sidebar.tsx,
// sidebar/SidebarChrome.tsx, sidebar/SidebarThreadHeader.tsx and ThreadStatusIndicators.tsx (MIT).
// The Pinned section, Snoozed shelf and Settled shelf follow Sidebar.tsx classification,
// SidebarSectionHeader, SnoozeMenuButton, slim rows, settled paging, the snooze wake timer and
// planForwardNavigation, and Sidebar.logic.ts shouldNavigateAfterThreadPark.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlarmClockOffIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  ClockIcon,
  PinIcon,
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
import {
  workingSessions,
  type Arrange,
  type Workspace,
  type WorkspaceView,
} from "./ipc";
import { cn } from "./lib/cn";
import { formatSidebarTime } from "./lib/time";
import { basename } from "./panel/panelState";
import { WorkspaceBadge } from "./ProjectBadge";
import { OpenAI } from "./ui/icons";
import { Button } from "./ui/controls";
import { ProjectScopeMenu } from "./ProjectScopeMenu";
import { storage } from "./lib/storage";
import { Menu, MenuItem, MenuShortcut } from "./ui/menu";
import { resolveSnoozePresets, snoozeWakeLabel } from "./lib/snooze";

type Row = {
  workspace: Workspace;
  branch: string;
  thread: WorkspaceView["threads"][number];
};

const SCOPE_KEY = "z1:sidebar-project-scope";
const SNOOZED_EXPANDED_KEY = "z1:sidebar:snoozed-expanded";
const SETTLED_EXPANDED_KEY = "z1:sidebar:settled-expanded";
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;

type SidebarSections = {
  pinned: Row[];
  active: Row[];
  snoozed: Row[];
  snoozedTotal: number;
  settled: Row[];
  settledTotal: number;
  hiddenCount: number;
};

// A thread is Snoozed, then Settled, then Pinned, then Active, in T3's order.
// Search shows every matching shelf row, so a query never hides a result.
function partitionSidebarRows({
  rows,
  query,
  scopeId,
  openThreadId,
  now,
  snoozedExpanded,
  settledExpanded,
  settledVisibleCount,
}: {
  rows: Row[];
  query: string;
  scopeId: string | undefined;
  openThreadId: string | undefined;
  now: number;
  snoozedExpanded: boolean;
  settledExpanded: boolean;
  settledVisibleCount: number;
}): SidebarSections {
  const needle = query.trim().toLowerCase();
  const pinned: Row[] = [];
  const active: Row[] = [];
  const snoozed: Row[] = [];
  const settled: Row[] = [];
  for (const row of rows) {
    if (scopeId && row.workspace.id !== scopeId) continue;
    if (needle && !row.thread.title.toLowerCase().includes(needle)) continue;
    const { snoozedUntilMs, settledAtMs, pinnedAtMs } = row.thread;
    (snoozedUntilMs !== null && snoozedUntilMs > now
      ? snoozed
      : settledAtMs !== null
        ? settled
        : pinnedAtMs !== null
          ? pinned
          : active
    ).push(row);
  }
  pinned.sort(
    (a, b) => (b.thread.pinnedAtMs ?? 0) - (a.thread.pinnedAtMs ?? 0),
  );
  active.sort(
    (a, b) => (b.thread.updatedAtMs ?? 0) - (a.thread.updatedAtMs ?? 0),
  );
  snoozed.sort(
    (a, b) => (a.thread.snoozedUntilMs ?? 0) - (b.thread.snoozedUntilMs ?? 0),
  );
  settled.sort(
    (a, b) => (b.thread.settledAtMs ?? 0) - (a.thread.settledAtMs ?? 0),
  );
  const totals = {
    snoozedTotal: snoozed.length,
    settledTotal: settled.length,
  };
  if (needle)
    return { pinned, active, snoozed, settled, ...totals, hiddenCount: 0 };
  // The open thread never hides under Show more or a collapsed shelf.
  const isOpen = (row: Row) => row.thread.id === openThreadId;
  const page = settled.slice(0, settledVisibleCount);
  const open = settled.slice(settledVisibleCount).find(isOpen);
  if (open) page.push(open);
  return {
    pinned,
    active,
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
}: {
  workspaces: Workspace[];
  views: (WorkspaceView | undefined)[];
  workspaceId: string | undefined;
  threadId: string | undefined;
  onSelectThread: (workspaceId: string, threadId: string) => void;
  onNewThread: (workspaceId?: string) => void;
  onOpenRepository: () => void;
  onOpenProjectSettings: (workspaceId: string) => void;
  onArrange: (threadId: string, action: Arrange) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [scopeId, setScopeId] = useState(() => storage.getItem(SCOPE_KEY));
  const scope = workspaces.find((workspace) => workspace.id === scopeId);
  const searchField = useRef<HTMLLabelElement>(null);
  const scopeTrigger = useRef<HTMLElement | null>(null);
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
  const [, setTick] = useState(0);
  const now = Date.now();
  const {
    pinned,
    active,
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
  });
  const nextWakeMs = Math.min(
    ...rows.flatMap(({ thread }) =>
      thread.snoozedUntilMs !== null && thread.snoozedUntilMs > now
        ? [thread.snoozedUntilMs]
        : [],
    ),
  );
  const client = useQueryClient();
  useEffect(() => {
    if (nextWakeMs === Infinity) return;
    // setTimeout delays are signed 32-bit, so a far wake re-arms instead of firing at once.
    const delay = Math.min(nextWakeMs - Date.now() + 50, 2_147_483_647);
    const id = window.setTimeout(() => {
      setTick((tick) => tick + 1);
      // The core decides auto-settling, so a woken idle thread needs a fresh summary.
      void client.invalidateQueries({ queryKey: ["workspace"] });
    }, delay);
    return () => window.clearTimeout(id);
  }, [nextWakeMs, client]);
  const wakeLabelsShown = snoozed.length > 0;
  useEffect(() => {
    if (!wakeLabelsShown) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 60_000);
    return () => window.clearInterval(id);
  }, [wakeLabelsShown]);
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
  const cards = [...pinned, ...active];
  // Settling or snoozing the open thread moves forward to the next card,
  // wrapping, or to a new draft in its project. The plan is taken before the
  // list changes.
  const park = async (row: Row, action: Arrange) => {
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
    if (!(await onArrange(row.thread.id, action))) return;
    if (openThread.current === row.thread.id) forward?.();
  };
  return (
    <>
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
                title="New thread"
                disabled={!scope && !workspaceId}
                onClick={() => onNewThread(scope?.id)}
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
            {cards.length + snoozedTotal + settledTotal > 0 ? (
              <ul className="relative flex flex-col gap-px flex-1">
                {cards.map((row) => (
                  <ThreadRow
                    key={row.thread.id}
                    row={row}
                    active={row.thread.id === threadId}
                    onSelect={() =>
                      onSelectThread(row.workspace.id, row.thread.id)
                    }
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
                    className="mt-auto"
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
                    onSelect={() =>
                      onSelectThread(row.workspace.id, row.thread.id)
                    }
                    onAction={() =>
                      void onArrange(row.thread.id, { kind: "wake" })
                    }
                    onUnpin={() =>
                      void onArrange(row.thread.id, { kind: "unpin" })
                    }
                  />
                ))}
                <SectionHeader
                  className={cn(snoozedTotal === 0 && "mt-auto")}
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
                    onSelect={() =>
                      onSelectThread(row.workspace.id, row.thread.id)
                    }
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
    </>
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

// Clicks inside the portaled popup still bubble to the row through React,
// so the wrapper keeps them from selecting the thread.
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
    <span className="flex" onClick={(event) => event.stopPropagation()}>
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

function ThreadRow({
  row,
  active,
  onSelect,
  onSettle,
  onSnooze,
  onUnpin,
}: {
  row: Row;
  active: boolean;
  onSelect: () => void;
  onSettle: () => void;
  onSnooze: (untilMs: number) => void;
  onUnpin: () => void;
}) {
  const isWorking = workingSessions.has(row.thread.session.kind);
  const recede = !active;
  // Settling and snoozing are refused while an approval waits, so the buttons stay hidden.
  const canSettle = !row.thread.awaitingApproval;
  const [snoozeOpenRaw, setSnoozeOpen] = useState(false);
  const snoozeOpen = snoozeOpenRaw && canSettle;
  return (
    <li
      data-thread-item
      className="list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]"
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        onKeyDown={rowKeyDown(onSelect)}
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
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
            <span
              aria-hidden
              className={cn(
                "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none truncate",
                recede
                  ? "font-normal text-secondary-label"
                  : "font-medium text-foreground/90",
              )}
            >
              {row.thread.title}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
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
  action,
  label,
  active,
  onSelect,
  onAction,
  onUnpin,
}: {
  row: Row;
  action: "unsettle" | "unsnooze";
  label: string;
  active: boolean;
  onSelect: () => void;
  onAction: () => void;
  onUnpin: () => void;
}) {
  const recede = !active;
  const unsettle = action === "unsettle";
  return (
    <li
      data-thread-item
      className="list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]"
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        onKeyDown={rowKeyDown(onSelect)}
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          unsettle &&
            "[&:not(:hover):not(:focus-within)_*]:text-secondary-label/70",
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
        <span
          aria-hidden
          className={cn(
            "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none",
            recede ? "font-normal" : "font-medium",
            "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
            recede ? "text-secondary-label/70" : "text-foreground",
          )}
        >
          {row.thread.title}
        </span>
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
  const label = `Worktree: ${basename(path)} (${branch})`;
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

export function SidebarBrand() {
  return (
    <div
      data-tauri-drag-region="deep"
      className="@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:px-0 drag-region"
    >
      <span className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md md:flex text-foreground">
        <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
          <span className="shrink-0 font-bold">Z1</span>
          <span className="truncate [text-box:trim-both_cap_alphabetic] text-muted-foreground">
            Code
          </span>
        </span>
      </span>
    </div>
  );
}
