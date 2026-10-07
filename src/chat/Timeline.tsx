// Ported from T3 Code v0.0.45 apps/web/src/components/chat/MessagesTimeline.tsx, MessageCopyButton.tsx and ChatView.tsx (MIT).
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ClockIcon,
  ArrowUpIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  HammerIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  Undo2Icon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { followUps, immediateIntent, type FollowUp } from "./followUps";
import { checkFollowUp, sendFollowUpNow } from "./FollowUpSender";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { ipc, setThreadSnapshot } from "../ipc";
import type { Thread, Skill, WorktreeSetup } from "../ipc";
import { cn } from "../lib/cn";
import { formatDayAwareTimestamp, formatWorkingTimer } from "../lib/time";
import { Button } from "../ui/controls";
import { ChatMarkdown } from "./ChatMarkdown";
import { attachmentUrl } from "./composerImages";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { ProposedPlanCard } from "./ProposedPlanCard";
import {
  deriveRows,
  liveLabel,
  summarizeWork,
  type TimelineRow,
  type WorkEntry,
  type WorkKind,
} from "./timelineRows";

const workIcons: Record<WorkKind, typeof TerminalIcon> = {
  command: TerminalIcon,
  file_change: SquarePenIcon,
  tool: WrenchIcon,
  approval: HammerIcon,
};

function groupIcon(entries: WorkEntry[]) {
  const kinds = new Set(entries.map((entry) => entry.kind));
  const [only] = kinds;
  return kinds.size === 1 && only ? workIcons[only] : HammerIcon;
}

function rowPadding(row: TimelineRow): string {
  switch (row.kind) {
    case "work-group":
      return row.expanded ? "pb-0" : "pb-2";
    case "fold":
    case "working":
      return "pb-1.5";
    case "assistant":
      return row.meta ? "pb-4" : "pb-2";
    case "reasoning":
    case "plan":
    case "work":
    case "live":
    case "error":
    case "checkpoint":
      return "pb-2";
    case "user":
      return "pb-4";
  }
}

function Timestamp({
  at,
  className,
}: {
  at: number | null;
  className?: string;
}) {
  if (at === null) return null;
  return (
    <span
      className={cn(
        "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
        className,
      )}
    >
      {formatDayAwareTimestamp(at)}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      aria-label="Copy message"
      title="Copy message"
      disabled={copied}
      size="xs"
      variant="ghost-muted"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? (
        <CheckIcon className="size-3 text-primary" />
      ) : (
        <CopyIcon className="size-3" />
      )}
    </Button>
  );
}

function UserRow({
  row,
  skills,
  disabled,
  onEdit,
}: {
  row: Extract<TimelineRow, { kind: "user" }>;
  skills: readonly Skill[];
  disabled: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
        <h3 className="sr-only select-none">You</h3>
        {row.attachments.length > 0 ? (
          <div className="mb-2 grid max-w-[210px] grid-cols-2 gap-2">
            {row.attachments.map((image) => (
              <div
                key={image.id}
                className="bg-background/70 aspect-[4/3] overflow-hidden rounded-lg border border-border/80"
              >
                <img
                  src={attachmentUrl(image)}
                  alt={image.name}
                  className="block size-full object-cover"
                />
              </div>
            ))}
          </div>
        ) : null}
        {row.text ? (
          <div data-user-message-body="true" className="relative">
            <ChatMarkdown
              text={row.text}
              skills={skills}
              className="text-message-foreground"
              lineBreaks
            />
          </div>
        ) : null}
      </div>
      {row.delivery && row.delivery.kind !== "accepted" ? (
        <p className="max-w-[80%] text-xs text-secondary-label">
          {row.delivery.kind === "not_sent" || row.delivery.kind === "uncertain"
            ? row.delivery.reason
            : "Sending follow-up"}
        </p>
      ) : null}
      <div className="flex w-full max-w-[80%]  items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          {row.at !== null ? (
            <p className="text-muted-foreground text-xs tabular-nums">
              {formatDayAwareTimestamp(row.at)}
            </p>
          ) : null}
          <div className="flex items-center gap-0.5">
            {row.text ? <CopyButton text={row.text} /> : null}
            {row.editable ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={onEdit}
                aria-label="Edit from here"
                title="Edit from here"
              >
                <Undo2Icon className="size-3" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "assistant" }>;
}) {
  return (
    <div className="relative min-w-0 px-1 py-0.5">
      <h3 className="sr-only select-none">Codex</h3>
      <ChatMarkdown
        text={row.text || (row.streaming ? "" : "(empty response)")}
        streaming={row.streaming}
      />
      {row.meta ? (
        <div className="flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200 opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100 mt-1.5">
          <CopyButton text={row.text} />
          {row.at !== null ? (
            <p className="text-muted-foreground text-xs tabular-nums">
              {formatDayAwareTimestamp(row.at)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FoldRow({
  row,
  onToggle,
}: {
  row: Extract<TimelineRow, { kind: "fold" }>;
  onToggle: () => void;
}) {
  return (
    <div className="group/timeline-row relative flex items-center gap-1 border-b border-border/60 pb-2 pe-0.5 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        onClick={onToggle}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        {row.expanded ? (
          <ChevronDownIcon className="size-3.5" />
        ) : (
          <ChevronRightIcon className="size-3.5" />
        )}
      </button>
      <Timestamp at={row.at} className="ms-auto" />
    </div>
  );
}

function WorkingRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "working" }>;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span className="relative shrink-0 overflow-hidden whitespace-nowrap">
          {row.startedAtMs !== null ? (
            <>
              Working for{" "}
              <span className="tabular-nums">
                {formatWorkingTimer(row.startedAtMs, now)}
              </span>
            </>
          ) : (
            "Working..."
          )}
        </span>
      </div>
    </div>
  );
}

function WorkEntryRow({
  entry,
  at,
  inGroup,
}: {
  entry: WorkEntry;
  at: number | null;
  inGroup: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon =
    entry.failed && entry.kind !== "command"
      ? CircleAlertIcon
      : workIcons[entry.kind];
  const canExpand = entry.detail.trim().length > 0;
  const toggle = () => canExpand && setExpanded((value) => !value);
  return (
    <div
      role={canExpand ? "button" : undefined}
      tabIndex={canExpand ? 0 : undefined}
      aria-label={canExpand ? entry.label : undefined}
      aria-expanded={canExpand ? expanded : undefined}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      }}
      className={cn(
        "group/timeline-row relative flex flex-col rounded-md px-0.5 transition-colors",
        inGroup ? "py-0" : "py-0.5",
        expanded && "mb-1",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center",
            entry.failed ? "text-tool-error-icon/40" : "text-icon-muted",
          )}
          role={entry.failed ? "img" : undefined}
          aria-label={entry.failed ? "Tool call failed" : undefined}
        >
          <Icon className="block size-4 shrink-0 stroke-2 opacity-70 light:brightness-60" />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
              <span
                className={cn(
                  "min-w-0 flex-1",
                  expanded
                    ? "whitespace-pre-wrap break-words select-text"
                    : "truncate",
                  "text-secondary-label",
                )}
              >
                {entry.label}
              </span>
            </p>
          </div>
          {entry.failed && entry.kind === "command" ? (
            <XIcon
              aria-hidden
              className="size-3 shrink-0 text-tool-error-icon/40"
            />
          ) : null}
          <Timestamp at={at} />
          <span
            aria-hidden
            className={cn(
              "flex size-4 shrink-0 items-center justify-center",
              !canExpand && "invisible",
            )}
          >
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        </div>
      </div>
      {expanded ? (
        <div
          className="mt-1 ms-7 cursor-default rounded-md bg-muted/40 px-3 py-2"
          onClick={(event) => event.stopPropagation()}
        >
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text">
            {entry.detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function WorkGroupRow({
  row,
  onToggle,
}: {
  row: Extract<TimelineRow, { kind: "work-group" }>;
  onToggle: () => void;
}) {
  const Icon = groupIcon(row.entries);
  return (
    <>
      <button
        type="button"
        aria-expanded={row.expanded}
        onClick={onToggle}
        className="group/tool-group group/timeline-row relative flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          <Icon className="size-4 shrink-0 stroke-2 opacity-70 light:brightness-60" />
        </span>
        <span className="min-w-0 flex-1 truncate text-secondary-label">
          {summarizeWork(row.entries)}
        </span>
        <Timestamp at={row.at} />
      </button>
      {row.expanded ? (
        <div className="pb-1">
          <div
            role="region"
            aria-label="Tool calls"
            className="scrollbar-gutter-stable max-h-[min(18rem,50dvh)] scroll-py-6 overflow-x-hidden overflow-y-auto rounded-md"
          >
            {row.entries.map((entry) => (
              <WorkEntryRow key={entry.id} entry={entry} at={null} inGroup />
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

function LiveRow({ entry }: { entry: WorkEntry }) {
  const Icon = workIcons[entry.kind];
  return (
    <div className="flex min-h-6 w-full max-w-full items-center rounded-md text-left">
      <div
        className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed"
        style={
          { "--visible-animation-state": "running" } as React.CSSProperties
        }
      >
        <span className="flex min-h-6 min-w-0 items-center gap-1.5 py-0.5 px-0.5 text-secondary-label">
          <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
            <Icon className="block size-4 shrink-0 stroke-2 opacity-70 light:brightness-60" />
          </span>
          <span className="min-w-0 flex-1 truncate live-tool-shine">
            {liveLabel(entry)}
          </span>
        </span>
      </div>
    </div>
  );
}

function ReasoningRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "reasoning" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={cn("flex flex-col", expanded && "mb-1")}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex cursor-pointer select-none items-center gap-1.5 rounded-md px-0.5 py-0.5 text-start transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          <BrainIcon
            aria-hidden
            className="block size-4 shrink-0 stroke-2 opacity-70"
          />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="relative min-w-0 flex-1 truncate text-secondary-label text-sm leading-relaxed">
            Thought
          </span>
          <span
            aria-hidden
            className="flex size-4 shrink-0 items-center justify-center"
          >
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="mt-1 ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text">
          <ChatMarkdown
            text={row.text}
            className="text-foreground"
            lineBreaks
          />
        </div>
      ) : null}
    </div>
  );
}

function ErrorRow({ text }: { text: string }) {
  return (
    <div className="group/timeline-row relative flex flex-col rounded-md px-0.5 py-0.5">
      <div className="flex select-none items-center gap-1.5">
        <span className="flex size-6 shrink-0 items-center justify-center text-destructive">
          <CircleAlertIcon className="block size-4 shrink-0 stroke-2 opacity-70 light:brightness-60" />
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed font-medium text-destructive select-text">
          {text}
        </p>
      </div>
    </div>
  );
}

function WholePixelRow({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = inner.current;
    const frame = outer.current;
    if (!content || !frame) return;
    const fit = () => {
      frame.style.height = `${Math.ceil(content.getBoundingClientRect().height)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={outer}
      data-timeline-root="true"
      className="mx-auto w-full min-w-0 max-w-(--chat-max-width) overflow-x-clip"
    >
      <div ref={inner}>{children}</div>
    </div>
  );
}

export function Timeline({
  thread,
  skills,
  clearance,
  reverting,
  busy,
  onEdit,
  onOpenTurnDiff,
  onRemoveQueued,
}: {
  thread: Thread;
  skills: readonly Skill[];
  clearance: number;
  reverting: boolean;
  busy: boolean;
  onEdit: (turnId: string) => void;
  onRemoveQueued: (id: string) => void;
  onOpenTurnDiff: (turnId: string, filePath?: string) => void;
}) {
  useSyncExternalStore(
    followUps.subscribe,
    followUps.snapshot,
    followUps.snapshot,
  );
  const queued = followUps.rows(thread.id);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const rows = useMemo(
    () => deriveRows(thread, unfolded, expandedGroups),
    [thread, unfolded, expandedGroups],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const [showScroll, setShowScroll] = useState(false);
  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !content.current) return;
    const follow = () => {
      if (atEnd.current) element.scrollTop = element.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div className="relative h-full min-h-0">
        <div
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            const end =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              2;
            atEnd.current = end;
            setShowScroll(!end);
          }}
          className="scrollbar-gutter-both h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5 topbar-scroll-fade"
        >
          <div ref={content}>
            <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />
            {thread.worktreeSetup ? (
              <SetupTimelineEntry
                key={thread.id}
                threadId={thread.id}
                setup={thread.worktreeSetup}
              />
            ) : null}
            {rows.map((row) => (
              <WholePixelRow key={row.id}>
                <div
                  data-timeline-row-kind={row.kind}
                  className={cn(
                    rowPadding(row),
                    row.kind === "assistant" && "group/assistant",
                  )}
                >
                  {row.kind === "user" ? (
                    <UserRow
                      skills={skills}
                      row={row}
                      disabled={
                        reverting || busy || Boolean(thread.pendingRevert)
                      }
                      onEdit={() => onEdit(row.turnId)}
                    />
                  ) : row.kind === "assistant" ? (
                    <AssistantRow row={row} />
                  ) : row.kind === "plan" ? (
                    <ProposedPlanCard
                      text={row.text}
                      streaming={row.streaming}
                    />
                  ) : row.kind === "fold" ? (
                    <FoldRow
                      row={row}
                      onToggle={() =>
                        setUnfolded((set) => toggle(set, row.turnId))
                      }
                    />
                  ) : row.kind === "working" ? (
                    <WorkingRow row={row} />
                  ) : row.kind === "work" ? (
                    <section
                      aria-label="Activity"
                      className="-mx-1 space-y-0.5 px-1 py-0.5"
                    >
                      <div className="space-y-px">
                        <WorkEntryRow
                          entry={row.entry}
                          at={row.at}
                          inGroup={false}
                        />
                      </div>
                    </section>
                  ) : row.kind === "work-group" ? (
                    <WorkGroupRow
                      row={row}
                      onToggle={() =>
                        setExpandedGroups((set) => toggle(set, row.id))
                      }
                    />
                  ) : row.kind === "live" ? (
                    <LiveRow entry={row.entry} />
                  ) : row.kind === "reasoning" ? (
                    <ReasoningRow row={row} />
                  ) : row.kind === "checkpoint" ? (
                    thread.checkout.kind === "folder" ? null : (
                      <CheckpointRow
                        row={row}
                        onOpenTurnDiff={onOpenTurnDiff}
                      />
                    )
                  ) : (
                    <ErrorRow text={row.text} />
                  )}
                </div>
              </WholePixelRow>
            ))}
            {queued.map((row, index) => (
              <WholePixelRow key={`queue:${row.id}`}>
                <div className="pb-4">
                  <QueuedMessageRow
                    skills={skills}
                    row={row}
                    next={index === 0}
                    thread={thread}
                    onRemove={onRemoveQueued}
                  />
                </div>
              </WholePixelRow>
            ))}
            <div aria-hidden>
              <div style={{ height: clearance }} />
              <div className="h-3 sm:h-4" />
            </div>
          </div>
        </div>
      </div>
      {showScroll ? (
        <div
          className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
          style={{ bottom: clearance + 4 }}
        >
          <Button
            aria-label="Scroll to end"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              const element = scroller.current;
              element?.scrollTo({
                top: element.scrollHeight,
                behavior: "smooth",
              });
            }}
            className="pointer-events-auto"
            size="xs"
            variant="glass"
          >
            <ChevronDownIcon className="size-3.5" />
            Scroll to end
          </Button>
        </div>
      ) : null}
    </>
  );
}

function CheckpointRow({
  row,
  onOpenTurnDiff,
}: {
  row: Extract<TimelineRow, { kind: "checkpoint" }>;
  onOpenTurnDiff: (turnId: string, filePath?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (row.checkpoint.kind === "complete")
    return row.checkpoint.files.length ? (
      <ChangedFilesCard
        turnId={row.turnId}
        files={row.checkpoint.files}
        allDirectoriesExpanded={expanded}
        onToggleAllDirectories={() => setExpanded((value) => !value)}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    ) : null;
  if (row.checkpoint.kind === "unavailable")
    return (
      <p className="px-1 text-xs text-muted-foreground">
        Turn diff unavailable. {row.checkpoint.reason}
      </p>
    );
  return null;
}

function QueuedMessageRow({
  row,
  skills,
  next,
  thread,
  onRemove,
}: {
  row: FollowUp;
  skills: readonly Skill[];
  next: boolean;
  thread: Thread;
  onRemove: (id: string) => void;
}) {
  const client = useQueryClient();

  const sending = ["preparing", "dispatching"].includes(row.state.kind);
  const checking = row.state.kind === "checking";
  const canRemove = ["waiting", "held", "preparing"].includes(row.state.kind);
  const status =
    row.state.kind === "held" || row.state.kind === "checking"
      ? row.state.reason
      : sending
        ? "Sending to the agent"
        : next
          ? "Sends when the turn ends and its checkpoint finishes"
          : "Sends after the messages above it";
  return (
    <div className="flex flex-col items-end" data-queued-message-id={row.id}>
      <div className="max-w-[80%] rounded-2xl border border-dashed border-border p-3 text-message-foreground/80">
        {row.text.trim() ? (
          <ChatMarkdown text={row.text} lineBreaks skills={skills} />
        ) : null}
        {row.attachments.length ? (
          <div
            className={cn(
              "text-secondary-label text-xs",
              row.text.trim() && "mt-1.5",
            )}
          >
            {row.attachments.length} attachment
            {row.attachments.length === 1 ? "" : "s"}
          </div>
        ) : null}
        <div
          className="mt-2 flex items-center gap-4 text-secondary-label text-xs"
          data-scroll-anchor-ignore
        >
          <span
            className="inline-flex h-6 items-center gap-1"
            title={status}
            aria-label={`${checking ? "Checking delivery" : sending ? "Sending" : "Queued"}. ${status}.`}
          >
            <ClockIcon className="size-3.5" aria-hidden />
            {checking
              ? "Checking delivery"
              : sending
                ? "Sending"
                : row.state.kind === "held"
                  ? "Held"
                  : "Queued"}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            {checking ? (
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                onClick={() => checkFollowUp(client, thread.id, row.id)}
              >
                Check delivery
              </Button>
            ) : null}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              onPointerDown={(event) => event.preventDefault()}
              disabled={
                !next || sending || checking || immediateIntent(thread) === null
              }
              onClick={() => sendFollowUpNow(client, thread, row.id)}
              aria-label="Send now"
              title="Send now"
            >
              <ArrowUpIcon className="size-3.5" aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              onPointerDown={(event) => event.preventDefault()}
              disabled={!canRemove}
              onClick={() => onRemove(row.id)}
              aria-label="Cancel and return to the composer"
              title="Cancel and return to the composer"
            >
              <XIcon className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>
        {row.state.kind === "held" || checking ? (
          <p className="mt-1 text-xs text-secondary-label">{status}</p>
        ) : null}
      </div>
    </div>
  );
}

function SetupTimelineEntry({
  threadId,
  setup,
}: {
  threadId: Thread["id"];
  setup: WorktreeSetup;
}) {
  const client = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string>();
  return (
    <WholePixelRow>
      <WorktreeSetupCard
        snapshot={setup}
        retrying={retrying}
        onRetry={() => {
          setRetrying(true);
          setRetryError(undefined);
          void ipc
            .retryWorktreeSetup(threadId)
            .then((snapshot) => setThreadSnapshot(client, snapshot))
            .catch((error) =>
              setRetryError(
                error instanceof Error ? error.message : String(error),
              ),
            )
            .finally(() => setRetrying(false));
        }}
      />
      {retryError ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {retryError}
        </p>
      ) : null}
    </WholePixelRow>
  );
}
