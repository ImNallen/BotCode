// Row markup and classes follow pingdotgg/t3code v0.0.45 components/chat/MessagesTimeline.tsx,
// MessageCopyButton.tsx and ChatView.tsx's scroll-to-end pill (MIT).
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
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
} from "lucide-react";
import type { Thread } from "../ipc";
import { cn } from "../lib/cn";
import { formatDayAwareTimestamp, formatWorkingTimer } from "../lib/time";
import { Button } from "../ui/controls";
import { ChatMarkdown } from "./ChatMarkdown";
import { attachmentUrl } from "./composerImages";
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
    case "work":
    case "live":
    case "error":
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

function UserRow({ row }: { row: Extract<TimelineRow, { kind: "user" }> }) {
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
              className="text-message-foreground"
              lineBreaks
            />
          </div>
        ) : null}
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          {row.at !== null ? (
            <p className="text-muted-foreground text-xs tabular-nums">
              {formatDayAwareTimestamp(row.at)}
            </p>
          ) : null}
          <div className="flex items-center gap-0.5">
            {row.text ? <CopyButton text={row.text} /> : null}
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
  clearance,
}: {
  thread: Thread;
  clearance: number;
}) {
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
                    <UserRow row={row} />
                  ) : row.kind === "assistant" ? (
                    <AssistantRow row={row} />
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
                  ) : (
                    <ErrorRow text={row.text} />
                  )}
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
