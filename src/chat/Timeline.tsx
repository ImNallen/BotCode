// Ported from T3 Code v0.0.45 apps/web/src/components/chat/MessagesTimeline.tsx, MessageCopyButton.tsx and ChatView.tsx (MIT).
import {
  type ComponentType,
  createContext,
  type MouseEvent,
  type ReactNode,
  use,
  useCallback,
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
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CopyIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  Minimize2Icon,
  ContainerIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
  Undo2Icon,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { followUps, immediateIntent, type FollowUp } from "./followUps";
import { checkFollowUp, sendFollowUpNow } from "./FollowUpSender";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { imageViewUrl, ipc, setThreadSnapshot } from "../ipc";
import type {
  NativeAppRef,
  Thread,
  Skill,
  ToolIcon,
  WorktreeSetup,
} from "../ipc";
import { cn } from "../lib/cn";
import { toolActivityFaviconUrl } from "../lib/favicon";
import { PullRequestGlyph } from "../panel/pullRequestPresentation";
import { useResolvedTheme } from "../panel/useResolvedTheme";
import { ComputerUseAppIcon } from "../ui/icons";
import { formatDayAwareTimestamp, formatWorkingTimer } from "../lib/time";
import { Button } from "../ui/controls";
import { Tooltip } from "../ui/tooltip";
import { ChatMarkdown } from "./ChatMarkdown";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import type { ComposerContextRecord } from "./composerContext";
import { copyContextContent } from "./composerContextClipboard";
import {
  attachmentIdentity,
  attachmentMediaKind,
  attachmentUrl,
} from "./composerAttachments";
import {
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { MediaVideoPlayer } from "./MediaVideoPlayer";
import {
  ChangedFilesCard,
  type FileContextMenuHandler,
} from "./ChangedFilesTree";
import { ProposedPlanCard } from "./ProposedPlanCard";
import {
  deriveRows,
  liveWorkEntryLabel,
  resolveTimelineMinimapCurrentIndex,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapNavigationInteractive,
  resolveTimelineMinimapTopPercent,
  TIMELINE_MINIMAP_MIN_ITEMS,
  workEntryCanExpand,
  workEntryExpandedBody,
  workEntryFailed,
  workEntryToolIcon,
  workEntryViewedImagePath,
  type ActivityEntry,
  type AgentSpawnMember,
  type ReasoningEntry,
  type TimelineRow,
  type WorkEntry,
  type WorkIcon,
} from "./timelineRows";
import {
  deriveTimelineMinimapItems,
  resolveTimelineMinimapPreview,
  type TimelineMinimapItem,
} from "./timelineMinimapItems";

function BrowserAppIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M8.5 19H7.2C4.4 19 3 17.5 3 14.6V7.4C3 4.5 4.5 3 7.4 3h8.2C18.5 3 20 4.5 20 7.4v2.4" />
      <circle cx="7.4" cy="7.2" r="0.75" fill="currentColor" stroke="none" />
      <path d="M11.2 7.2h4.3" />
      <path
        d="m12.4 11.4 7.5 2.6-3.4 1.6-1.5 3.6z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

type IconName = WorkIcon | "brain" | "circle-alert";

const workIcons: Record<IconName, ComponentType<{ className?: string }>> = {
  terminal: TerminalIcon,
  "square-pen": SquarePenIcon,
  eye: EyeIcon,
  globe: GlobeIcon,
  wrench: WrenchIcon,
  hammer: HammerIcon,
  bot: BotIcon,
  brain: BrainIcon,
  browser: BrowserAppIcon,
  computer: ComputerUseAppIcon,
  "pull-request": PullRequestGlyph.pullRequest,
  "circle-alert": CircleAlertIcon,
};

const TimelineCtx = createContext<{
  threadId: string;
  onExpandImage: (preview: ExpandedImagePreview) => void;
} | null>(null);

const failedToolIconClassName = "text-tool-error-icon/40";

function toolIconAcceptsTint(
  iconName: IconName,
  toolIcon: ToolIcon | null,
): boolean {
  return toolIcon === null && iconName !== "computer";
}

function ToolActivityIconView(props: {
  icon: ToolIcon | null;
  fallbackName: IconName;
  className: string;
  muted: boolean;
}) {
  const resolvedTheme = useResolvedTheme();
  const Fallback = workIcons[props.fallbackName];
  const fallback = (
    <Fallback
      className={cn(
        props.className,
        props.muted && "opacity-70 light:brightness-60",
      )}
    />
  );
  if (!props.icon) return fallback;
  if (props.icon.kind === "website") {
    const src = toolActivityFaviconUrl(props.icon, resolvedTheme);
    return src ? (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallbackName={props.fallbackName}
        className={props.className}
        muted={props.muted}
      />
    ) : (
      fallback
    );
  }
  if (props.icon.kind === "themed_logo") {
    const src =
      resolvedTheme === "dark"
        ? (props.icon.logoUrlDark ?? props.icon.logoUrl)
        : props.icon.logoUrl;
    return (
      <ToolActivityImageIcon
        key={src}
        cacheKey={src}
        src={src}
        fallbackName={props.fallbackName}
        className={props.className}
        muted={props.muted}
      />
    );
  }
  return (
    <NativeAppToolActivityIcon
      app={props.icon.app}
      fallbackName={props.fallbackName}
      className={props.className}
      muted={props.muted}
    />
  );
}

function NativeAppToolActivityIcon(props: {
  app: NativeAppRef;
  fallbackName: IconName;
  className: string;
  muted: boolean;
}) {
  const icon = useQuery({
    queryKey: ["native-app-icon", props.app],
    queryFn: () => ipc.nativeAppIcon(props.app),
    staleTime: Infinity,
  });
  const src = icon.data;
  if (!src) {
    const Fallback = workIcons[props.fallbackName];
    return (
      <Fallback
        className={cn(
          props.className,
          props.muted && "opacity-70 light:brightness-60",
        )}
      />
    );
  }
  const cacheKey = JSON.stringify(props.app);
  return (
    <ToolActivityImageIcon
      key={cacheKey}
      cacheKey={cacheKey}
      src={src}
      fallbackName={props.fallbackName}
      className={props.className}
      muted={props.muted}
    />
  );
}

const loadedToolActivityIconSrcs = new Map<string, string>();

function ToolActivityImageIcon(props: {
  cacheKey: string;
  src: string;
  fallbackName: IconName;
  className: string;
  muted: boolean;
}) {
  const [displayedSrc, setDisplayedSrc] = useState<string | null>(
    () => loadedToolActivityIconSrcs.get(props.cacheKey) ?? null,
  );
  const isLoading = displayedSrc !== props.src;
  const handleLoadError = (failedSrc: string) => {
    if (loadedToolActivityIconSrcs.get(props.cacheKey) === failedSrc) {
      loadedToolActivityIconSrcs.delete(props.cacheKey);
    }
    setDisplayedSrc((currentSrc) =>
      currentSrc === failedSrc ? null : currentSrc,
    );
  };
  const Fallback = workIcons[props.fallbackName];
  return (
    <>
      {displayedSrc === null ? (
        <Fallback
          className={cn(
            props.className,
            props.muted && "opacity-70 light:brightness-60",
          )}
        />
      ) : null}
      {displayedSrc ? (
        <span
          className={cn(
            props.className,
            "inline-block overflow-hidden rounded-xs bg-background",
            props.muted && "opacity-70",
          )}
        >
          <img
            src={displayedSrc}
            alt=""
            aria-hidden
            decoding="async"
            referrerPolicy="no-referrer"
            className={cn(
              "block size-full object-contain",
              props.muted && "light:brightness-60",
            )}
            onError={() => handleLoadError(displayedSrc)}
          />
        </span>
      ) : null}
      {isLoading ? (
        <img
          src={props.src}
          alt=""
          aria-hidden
          decoding="async"
          referrerPolicy="no-referrer"
          className="hidden"
          onLoad={() => {
            loadedToolActivityIconSrcs.set(props.cacheKey, props.src);
            setDisplayedSrc(props.src);
          }}
          onError={() => handleLoadError(props.src)}
        />
      ) : null}
    </>
  );
}

function ToolImagePreview({
  src,
  name,
  onExpand,
}: {
  src: string;
  name: string;
  onExpand: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const events = {
    onLoad: () => setLoaded(true),
    onError: () => setFailed(true),
  };
  if (loaded && !failed)
    return (
      <img
        src={src}
        alt={name}
        decoding="async"
        draggable={false}
        className="inline-block! h-auto w-auto max-h-[30rem] max-w-[min(100%,30rem)] cursor-zoom-in rounded-lg border border-border/40 object-contain"
        style={{ maxHeight: "16rem" }}
        role="button"
        tabIndex={0}
        aria-label={`Preview ${name}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onExpand();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onExpand();
        }}
        {...events}
      />
    );
  return (
    <span
      className="relative inline-block! aspect-video w-full max-w-[min(100%,30rem)] overflow-hidden rounded-lg border border-border/40 bg-muted/60"
      style={{ maxHeight: "16rem" }}
      {...(failed
        ? { role: "alert" as const }
        : { role: "status" as const, "aria-label": "Loading image" })}
    >
      {failed ? (
        <span className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
            {`Image unavailable · ${name}`}
          </span>
        </span>
      ) : (
        <img
          src={src}
          alt={name}
          decoding="async"
          draggable={false}
          className="invisible absolute inset-0 size-full"
          {...events}
        />
      )}
    </span>
  );
}

function rowPadding(row: TimelineRow): string {
  switch (row.kind) {
    case "work-group":
    case "work-live":
      return row.expanded ? "pb-0" : "pb-2";
    case "fold":
    case "working":
      return "pb-1.5";
    case "assistant":
      return row.meta ? "pb-4" : "pb-2";
    case "activity-group":
    case "thinking":
    case "agents":
    case "plan":
    case "work":
    case "live":
    case "error":
    case "checkpoint":
      return "pb-2";
    case "user":
    case "context-compaction":
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

function CopyButton({
  text,
  records,
}: {
  text: string;
  records?: readonly ComposerContextRecord[];
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      aria-label="Copy message"
      title="Copy message"
      disabled={copied}
      size="xs"
      variant="ghost-muted"
      onClick={() => {
        const copy =
          records && records.length > 0
            ? copyContextContent({ text, records: [...records] })
            : navigator.clipboard.writeText(text);
        void copy.then(() => {
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
  onExpandImage,
}: {
  row: Extract<TimelineRow, { kind: "user" }>;
  skills: readonly Skill[];
  disabled: boolean;
  onEdit: () => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
}) {
  const images = row.attachments.filter(
    (attachment) => attachment.kind === "image",
  );
  const videos = row.attachments.filter(
    (attachment) => attachmentMediaKind(attachment) === "video",
  );
  const expand = (attachment: (typeof row.attachments)[number]) => {
    const preview = buildExpandedImagePreview(
      row.attachments,
      attachmentIdentity(attachment),
    );
    if (preview) onExpandImage(preview);
  };
  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
        <h3 className="sr-only select-none">You</h3>
        {images.length > 0 || videos.length > 0 ? (
          <div className="mb-2 grid max-w-[210px] grid-cols-2 gap-2">
            {images.map((image) => (
              <div
                key={image.id}
                className="bg-background/70 aspect-[4/3] overflow-hidden rounded-lg border border-border/80"
              >
                <button
                  type="button"
                  className="block h-full w-full cursor-zoom-in"
                  aria-label={`Preview ${image.name}`}
                  onClick={() => expand(image)}
                >
                  <img
                    src={attachmentUrl(image)}
                    alt={image.name}
                    className="block size-full object-cover"
                  />
                </button>
              </div>
            ))}
            {videos.map((video) => (
              <MediaVideoPlayer
                key={attachmentIdentity(video)}
                src={attachmentUrl(video)}
                label={video.name}
                preload="visible"
                onOpen={() => expand(video)}
                className="block aspect-[4/3] w-full"
                videoClassName="aspect-auto size-full rounded-lg border border-border/80"
                stateClassName="aspect-auto min-h-full rounded-lg border border-border/80 bg-black text-white"
              />
            ))}
          </div>
        ) : null}
        {row.attachments.some(
          (attachment) =>
            attachment.kind === "file" &&
            attachmentMediaKind(attachment) === null,
        ) ? (
          <div className="mb-2 flex flex-col gap-1">
            {row.attachments
              .filter(
                (attachment) =>
                  attachment.kind === "file" &&
                  attachmentMediaKind(attachment) === null,
              )
              .map((file) => (
                <div
                  key={JSON.stringify([file.id, file.name])}
                  className="flex min-w-0 items-center gap-2 py-1 text-sm text-foreground"
                >
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0 text-xs text-secondary-label">
                    {(file.sizeBytes / 1024).toFixed(1)} KB
                  </span>
                </div>
              ))}
          </div>
        ) : null}
        {row.text ? (
          <div data-user-message-body="true" className="relative">
            <ChatMarkdown
              text={row.text}
              records={row.records}
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
            {row.text ? (
              <CopyButton text={row.text} records={row.records} />
            ) : null}
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
  thread,
}: {
  row: Extract<TimelineRow, { kind: "assistant" }>;
  thread: Pick<Thread, "id" | "workspaceId">;
}) {
  return (
    <div className="relative min-w-0 px-1 py-0.5">
      <h3 className="sr-only select-none">Codex</h3>
      <div
        data-assistant-citation-source={row.id}
        data-assistant-citation-environment={thread.workspaceId}
        data-assistant-citation-thread={thread.id}
      >
        <ChatMarkdown
          text={row.text || (row.streaming ? "" : "(empty response)")}
          streaming={row.streaming}
        />
      </div>
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
  const label = row.compacting ? (
    <CompactingLabel />
  ) : row.startingSandbox ? (
    <span className="inline-flex items-center gap-1.5">
      <ContainerIcon aria-hidden="true" className="size-3" />
      Starting sandbox…
    </span>
  ) : row.startedAtMs !== null ? (
    <>
      Working for{" "}
      <span className="tabular-nums">
        {formatWorkingTimer(row.startedAtMs, now)}
      </span>
    </>
  ) : (
    "Working..."
  );
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span
          className="relative shrink-0 overflow-hidden whitespace-nowrap"
          style={
            row.compacting || row.startingSandbox ? animationRunning : undefined
          }
        >
          {label}
          {row.compacting || row.startingSandbox ? (
            <ActivityShimmerOverlay>{label}</ActivityShimmerOverlay>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function CompactingLabel() {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Minimize2Icon aria-hidden="true" className="size-3" />
      Compacting…
    </span>
  );
}

function WorkEntryRow({
  entry,
  label,
  at,
  inGroup,
}: {
  entry: WorkEntry;
  label: string;
  at: number | null;
  inGroup: boolean;
}) {
  const ctx = use(TimelineCtx);
  const [expanded, setExpanded] = useState(false);
  const failed = workEntryFailed(entry);
  const destructive = failed && entry.action === "edit";
  const iconName: IconName = destructive ? "circle-alert" : entry.icon;
  const toolIcon = destructive ? null : workEntryToolIcon(entry);
  const viewedImagePath = workEntryViewedImagePath(entry);
  const viewedImage =
    viewedImagePath && ctx
      ? {
          src: imageViewUrl(ctx.threadId, entry.id),
          name: viewedImagePath.split(/[\\/]/).at(-1) || "image",
        }
      : null;
  const canExpand = workEntryCanExpand(entry, label);
  const body = expanded ? workEntryExpandedBody(entry, label) : null;
  const toggle = () => canExpand && setExpanded((value) => !value);
  return (
    <div
      role={canExpand ? "button" : undefined}
      tabIndex={canExpand ? 0 : undefined}
      aria-label={
        canExpand ? (failed ? `${label}, tool call failed` : label) : undefined
      }
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
            failed ? failedToolIconClassName : "text-icon-muted",
          )}
          role={failed ? "img" : undefined}
          aria-label={failed ? "Tool call failed" : undefined}
        >
          <ToolActivityIconView
            icon={toolIcon}
            fallbackName={iconName}
            className="block size-4 shrink-0 stroke-2"
            muted
          />
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
                {label}
              </span>
            </p>
          </div>
          {failed &&
          (entry.action === "command" ||
            (!destructive && !toolIconAcceptsTint(iconName, toolIcon))) ? (
            <XIcon
              aria-hidden
              className={cn("size-3 shrink-0", failedToolIconClassName)}
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
      {expanded && viewedImage && ctx ? (
        <div
          className="mt-1 ms-7 cursor-default"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <ToolImagePreview
            src={viewedImage.src}
            name={viewedImage.name}
            onExpand={() =>
              ctx.onExpandImage({ images: [viewedImage], index: 0 })
            }
          />
        </div>
      ) : null}
      {body ? (
        <div
          className="mt-1 ms-7 cursor-default rounded-md bg-muted/40 px-3 py-2"
          onClick={(event) => event.stopPropagation()}
        >
          <pre className={toolCallExpandedBodyClassName}>{body}</pre>
        </div>
      ) : null}
    </div>
  );
}

const toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text";

function WorkGroupEntries({ entries }: { entries: WorkEntry[] }) {
  return (
    <div
      role="region"
      aria-label="Tool calls"
      className="scrollbar-gutter-stable max-h-[min(18rem,50dvh)] scroll-py-6 overflow-x-hidden overflow-y-auto rounded-md"
    >
      {entries.map((entry) => (
        <WorkEntryRow
          key={entry.id}
          entry={entry}
          label={entry.label}
          at={null}
          inGroup
        />
      ))}
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
  return (
    <>
      <button
        type="button"
        aria-expanded={row.expanded}
        onClick={onToggle}
        className="group/tool-group group/timeline-row relative flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          <ToolActivityIconView
            icon={row.toolIcon}
            fallbackName={row.icon}
            className="size-4 shrink-0 stroke-2"
            muted
          />
        </span>
        <span className="min-w-0 flex-1 truncate text-secondary-label">
          {row.label}
        </span>
        <Timestamp at={row.at} />
      </button>
      {row.expanded ? (
        <div className="pb-1">
          <WorkGroupEntries entries={row.entries} />
        </div>
      ) : null}
    </>
  );
}

const animationRunning = {
  "--visible-animation-state": "running",
} as React.CSSProperties;

function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">
          {children}
        </span>
      </span>
    </span>
  );
}

function LiveActivityRow({
  label,
  icon,
  toolIcon = null,
  failed = false,
  active = false,
  shimmer = false,
}: {
  label: ReactNode;
  icon: IconName;
  toolIcon?: ToolIcon | null;
  failed?: boolean;
  active?: boolean;
  shimmer?: boolean;
}) {
  const animated = active && !failed;
  return (
    <div
      className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed"
      style={animated ? animationRunning : undefined}
    >
      <LiveActivityContent
        label={label}
        icon={icon}
        toolIcon={toolIcon}
        failed={failed}
        active={animated && !shimmer}
      />
      {animated && shimmer ? (
        <ActivityShimmerOverlay>
          <LiveActivityContent
            label={label}
            icon={icon}
            toolIcon={toolIcon}
            highlighted
          />
        </ActivityShimmerOverlay>
      ) : null}
    </div>
  );
}

function LiveActivityContent({
  label,
  icon,
  toolIcon = null,
  failed = false,
  active = false,
  highlighted = false,
}: {
  label: ReactNode;
  icon: IconName;
  toolIcon?: ToolIcon | null;
  failed?: boolean;
  active?: boolean;
  highlighted?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex min-h-6 min-w-0 items-center gap-1.5 py-0.5 px-0.5",
        highlighted ? "text-foreground" : "text-secondary-label",
      )}
    >
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center",
          failed
            ? failedToolIconClassName
            : highlighted
              ? "text-foreground"
              : "text-icon-muted",
        )}
        role={failed ? "img" : undefined}
        aria-label={failed ? "Tool call failed" : undefined}
      >
        <ToolActivityIconView
          icon={toolIcon}
          fallbackName={icon}
          className="block size-4 shrink-0 stroke-2"
          muted={!highlighted}
        />
      </span>
      <span
        className={cn("min-w-0 flex-1 truncate", active && "live-tool-shine")}
      >
        {label}
      </span>
      {failed && !toolIconAcceptsTint(icon, toolIcon) ? (
        <XIcon
          aria-hidden
          className={cn("size-3 shrink-0", failedToolIconClassName)}
        />
      ) : null}
    </span>
  );
}

function WorkLiveRow({
  row,
  onToggle,
}: {
  row: Extract<TimelineRow, { kind: "work-live" }>;
  onToggle: () => void;
}) {
  const label = liveWorkEntryLabel(row.entry, row.active);
  const failed = workEntryFailed(row.entry);
  return (
    <>
      <button
        type="button"
        className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-label={failed ? `${label}, tool call failed` : undefined}
        aria-expanded={row.expanded}
        onClick={onToggle}
      >
        <LiveActivityRow
          label={label}
          icon={row.entry.icon}
          toolIcon={workEntryToolIcon(row.entry)}
          failed={failed}
          active={row.active}
        />
      </button>
      {row.expanded ? (
        <div className="pb-1">
          <WorkGroupEntries entries={row.entries} />
        </div>
      ) : null}
    </>
  );
}

function LiveRow({ entry }: { entry: WorkEntry }) {
  return (
    <div className="flex min-h-6 w-full max-w-full items-center rounded-md text-left">
      <LiveActivityRow
        label={liveWorkEntryLabel(entry, true)}
        icon={entry.icon}
        active
      />
    </div>
  );
}

function ThinkingRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "thinking" }>;
}) {
  return (
    <div className="min-h-7">
      {row.compacting ? null : (
        <LiveActivityRow label="Thinking" icon="brain" active shimmer />
      )}
    </div>
  );
}

export function AgentSpawnRow({
  row,
  onToggle,
  onOpenAgents,
}: {
  row: Extract<TimelineRow, { kind: "agents" }>;
  onToggle: () => void;
  onOpenAgents?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={row.expanded}
        onClick={onToggle}
        className="flex cursor-pointer select-none rounded-md text-left transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <LiveActivityRow
          label={row.label}
          icon="bot"
          active={row.live}
          failed={row.failed}
        />
      </button>
      {row.expanded ? (
        <div className="ms-7 mt-0.5 flex flex-col">
          {row.members.map((member) => (
            <AgentSpawnMemberRow key={member.id} member={member} />
          ))}
          {onOpenAgents ? (
            <button
              type="button"
              onClick={onOpenAgents}
              className="mt-1 self-start rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Open Agents panel ›
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const stopRowToggle = (event: { stopPropagation: () => void }) =>
  event.stopPropagation();

function AgentSpawnMemberRow({ member }: { member: AgentSpawnMember }) {
  const [open, setOpen] = useState(false);
  const canExpand = member.body.length > 0;
  const toggleOpen = () => setOpen((value) => !value);
  return (
    <div
      role={canExpand ? "button" : undefined}
      tabIndex={canExpand ? 0 : undefined}
      aria-label={
        canExpand ? `${member.title}, ${member.statusLabel}` : undefined
      }
      aria-expanded={canExpand ? open : undefined}
      onClick={canExpand ? toggleOpen : undefined}
      onKeyDown={
        canExpand
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleOpen();
              }
            }
          : undefined
      }
      className={cn(
        "flex flex-col rounded-md px-1 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
    >
      <div className="flex select-none items-center gap-1.5">
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm leading-relaxed">
          <span
            className={cn(
              "min-w-0 truncate",
              member.failed ? "text-tool-error-icon/40" : "text-foreground/80",
            )}
          >
            {member.title}
          </span>
          {member.role ? (
            <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-3xs text-muted-foreground">
              {member.role}
            </span>
          ) : null}
        </p>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {member.statusLabel}
        </span>
      </div>
      {!open && member.firstLine ? (
        <p className="truncate text-xs text-muted-foreground">
          {member.firstLine}
        </p>
      ) : null}
      {open ? (
        <div
          className="mt-1 cursor-default rounded-md bg-muted/40 px-3 py-2"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className={toolCallExpandedBodyClassName}>{member.body}</pre>
        </div>
      ) : null}
    </div>
  );
}

function ContextCompactionRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "context-compaction" }>;
}) {
  return (
    <div
      role="separator"
      aria-label={row.label}
      className="mx-auto flex w-full max-w-(--chat-max-width) items-center gap-3 py-1 text-muted-foreground text-xs"
    >
      <span className="h-px flex-1 bg-border/70" />
      <span className="flex shrink-0 items-center gap-1.5">
        <Minimize2Icon aria-hidden="true" className="size-3" />
        {row.label}
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

type MarkdownNode = {
  type: string;
  value?: string;
  alt?: string | null;
  children?: MarkdownNode[];
};

function remarkThoughtPreview(fallback: string) {
  return (tree: MarkdownNode) => {
    const plainText = (node: MarkdownNode): string => {
      if (node.type === "html" || node.type === "definition") return "";
      if ("alt" in node) return node.alt ?? "";
      if (node.value !== undefined) return node.value;
      if (node.children) {
        const separator = [
          "root",
          "blockquote",
          "list",
          "listItem",
          "table",
          "tableRow",
        ].includes(node.type)
          ? " "
          : "";
        return node.children.map(plainText).join(separator);
      }
      return node.type === "break" ? " " : "";
    };
    tree.children = [
      {
        type: "text",
        value: plainText(tree).replace(/\s+/g, " ").trim() || fallback,
      },
    ];
  };
}

function ReasoningTraceBlock({
  messages,
  live,
  showHeader,
}: {
  messages: ReasoningEntry[];
  live: boolean;
  showHeader: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expanded = !showHeader || open;
  const streaming = live && messages.some((message) => message.streaming);
  if (
    messages.every((message) => message.text.trim().length === 0) &&
    !streaming
  )
    return null;
  const label = streaming ? "Thinking" : "Thought";
  const collapsedPreview = messages
    .find((message) => message.text.trim().length > 0)
    ?.text.trim();
  const headerText = expanded ? (
    label
  ) : (
    <ReactMarkdown remarkPlugins={[remarkGfm, [remarkThoughtPreview, label]]}>
      {collapsedPreview ?? label}
    </ReactMarkdown>
  );
  return (
    <div className="flex flex-col">
      {showHeader ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setOpen(!expanded)}
          className="flex min-h-6 cursor-pointer select-none items-center gap-1.5 rounded-md ps-0.5 pe-2 text-start text-sm leading-relaxed transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
            <BrainIcon
              aria-hidden
              className="block size-4 shrink-0 stroke-2 opacity-70"
            />
          </span>
          <span
            className="relative min-w-0 flex-1 truncate text-secondary-label"
            style={streaming ? animationRunning : undefined}
          >
            {headerText}
            {streaming ? (
              <ActivityShimmerOverlay>{headerText}</ActivityShimmerOverlay>
            ) : null}
          </span>
          <span
            className="flex size-4 shrink-0 items-center justify-center"
            aria-hidden
          >
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-90",
              )}
            />
          </span>
        </button>
      ) : null}
      {expanded ? (
        <div className="ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text">
          {messages.map((message) => (
            <ChatMarkdown
              key={message.id}
              className="text-foreground"
              text={message.text}
              streaming={streaming && message.streaming}
              lineBreaks
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function activitySections(entries: ActivityEntry[]) {
  const sections: (
    | { kind: "work"; id: string; entries: WorkEntry[] }
    | { kind: "reasoning"; id: string; messages: ReasoningEntry[] }
  )[] = [];
  for (const entry of entries) {
    const last = sections.at(-1);
    if (entry.kind === "work") {
      if (last?.kind === "work") last.entries.push(entry.entry);
      else
        sections.push({ kind: "work", id: entry.id, entries: [entry.entry] });
    } else if (last?.kind === "reasoning") last.messages.push(entry);
    else sections.push({ kind: "reasoning", id: entry.id, messages: [entry] });
  }
  return sections;
}

function ActivityGroupRow({
  row,
  onToggle,
}: {
  row: Extract<TimelineRow, { kind: "activity-group" }>;
  onToggle: () => void;
}) {
  const sections = activitySections(row.entries);
  const hasWork = row.entries.some((entry) => entry.kind === "work");
  const lastEntry = row.entries.at(-1);
  return (
    <div>
      <button
        type="button"
        className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-label={row.failed ? `${row.label}, tool call failed` : undefined}
        aria-expanded={row.expanded}
        onClick={onToggle}
      >
        <LiveActivityRow
          label={row.label}
          icon={row.icon}
          toolIcon={row.toolIcon}
          failed={row.failed}
          active={row.active}
          shimmer={row.shimmer}
        />
      </button>
      {row.expanded ? (
        <div className="mt-2">
          {sections.map((section) =>
            section.kind === "work" ? (
              <WorkGroupEntries key={section.id} entries={section.entries} />
            ) : (
              <ReasoningTraceBlock
                key={section.id}
                messages={section.messages}
                live={row.active && section.messages.at(-1) === lastEntry}
                showHeader={hasWork}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function ErrorRow({ text }: { text: string }) {
  const split = text.indexOf("\n\n");
  const summary = split < 0 ? text : text.slice(0, split);
  const detail = split < 0 ? null : text.slice(split + 2);
  return (
    <div className="group/timeline-row relative flex flex-col rounded-md px-0.5 py-0.5">
      <div className="flex select-none items-center gap-1.5">
        <span className="flex size-6 shrink-0 items-center justify-center text-destructive">
          <CircleAlertIcon className="block size-4 shrink-0 stroke-2 opacity-70 light:brightness-60" />
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-relaxed font-medium text-destructive select-text">
          {summary}
        </p>
      </div>
      {detail ? (
        <div className="mt-1 ms-7 rounded-md bg-muted/40 px-3 py-2">
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-secondary-label text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text">
            {detail}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function timelineMinimapEventTargetsPreview(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest("[data-minimap-preview]") !== null
  );
}

function TimelineMinimap({
  hasPersistentGutter,
  hitStripWidth,
  currentIndex,
  items,
  stripMap,
  onSelect,
}: {
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  currentIndex: number | null;
  items: ReadonlyArray<TimelineMinimapItem>;
  stripMap: Map<string, HTMLSpanElement>;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = useMemo(
    () =>
      resolveTimelineMinimapPreview(
        resolvedActiveIndex === null
          ? null
          : (items[resolvedActiveIndex] ?? null),
      ),
    [items, resolvedActiveIndex],
  );
  const navigationInteractive =
    resolveTimelineMinimapNavigationInteractive(hitStripWidth);
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";
  const resolvedCurrentIndex =
    currentIndex !== null && currentIndex >= 0 && currentIndex < items.length
      ? currentIndex
      : null;
  const previousItem =
    resolvedCurrentIndex === null
      ? null
      : (items[resolvedCurrentIndex - 1] ?? null);
  const nextItem =
    resolvedCurrentIndex === null
      ? null
      : (items[resolvedCurrentIndex + 1] ?? null);

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const updateActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const nextIndex = resolveActiveIndexFromPointer(event);
      setActiveIndex(nextIndex);
    },
    [resolveActiveIndexFromPointer],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0;
        return Math.max(0, Math.min(items.length - 1, base + delta));
      });
    },
    [items.length],
  );

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  return (
    <div
      className={cn(
        "group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 [@media(pointer:fine)]:block",
        hasPersistentGutter
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
      data-testid="timeline-minimap"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2",
            hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: resolveTimelineMinimapInteractiveWidth(
              hitStripWidth,
              activeItem !== null,
            ),
          }}
        >
          <TimelineMinimapNavigationButton
            direction="previous"
            disabled={previousItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (previousItem) onSelect(previousItem);
            }}
          />
          <button
            aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
            className="absolute inset-y-0 left-0 w-full cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            onBlur={() => setActiveIndex(null)}
            onClick={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              const nextIndex = resolveActiveIndexFromPointer(event);
              const selectedItem =
                nextIndex === null ? null : (items[nextIndex] ?? null);
              if (selectedItem) {
                onSelect(selectedItem);
              }
              event.currentTarget.blur();
            }}
            onFocus={() =>
              setActiveIndex((current) => current ?? resolvedCurrentIndex ?? 0)
            }
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActiveIndex(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActiveIndex(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(items.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (activeItem) {
                  onSelect(activeItem);
                }
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={updateActiveIndexFromPointer}
            onMouseDown={(event) => {
              if (timelineMinimapEventTargetsPreview(event.target)) {
                return;
              }
              event.preventDefault();
            }}
            type="button"
          >
            <div className="absolute top-0 left-3 h-full w-px bg-border/15" />
            {items.map((item, index) => {
              const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`;
              const activeDistance =
                resolvedActiveIndex === null
                  ? null
                  : Math.abs(index - resolvedActiveIndex);
              return (
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[width,background-color] duration-150 data-[in-view=true]:bg-foreground/90",
                    activeDistance === 0
                      ? "w-6 bg-muted-foreground/75"
                      : activeDistance === 1
                        ? "w-4"
                        : activeDistance === 2
                          ? "w-2.5"
                          : "w-2",
                  )}
                  data-in-view="false"
                  data-minimap-strip
                  key={item.id}
                  ref={(node) => {
                    if (node) {
                      stripMap.set(item.id, node);
                    } else {
                      stripMap.delete(item.id);
                    }
                  }}
                  style={{ top }}
                />
              );
            })}
            {activeItem ? (
              <span
                className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
                data-minimap-preview
                onMouseMove={(event) => event.stopPropagation()}
                style={{
                  top: `${activeTopPercent}%`,
                  transform: `translateY(${activeTooltipTranslate})`,
                }}
              >
                <span className="dropdown-glass block rounded-xl p-3 text-left text-popover-foreground shadow-xl shadow-black/25">
                  <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                    {activeItem.userText ?? "User message"}
                  </span>
                  {activeItem.assistantText ? (
                    <span
                      className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                      style={{
                        display: "-webkit-box",
                        WebkitBoxOrient: "vertical",
                        WebkitLineClamp: 3,
                      }}
                    >
                      {activeItem.assistantText}
                    </span>
                  ) : null}
                </span>
              </span>
            ) : null}
          </button>
          <TimelineMinimapNavigationButton
            direction="next"
            disabled={nextItem === null}
            interactive={navigationInteractive}
            onClick={() => {
              if (nextItem) onSelect(nextItem);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function TimelineMinimapNavigationButton({
  direction,
  disabled,
  interactive,
  onClick,
}: {
  direction: "previous" | "next";
  disabled: boolean;
  interactive: boolean;
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const Icon = previous ? ChevronUpIcon : ChevronDownIcon;

  return (
    <span
      className={cn(
        "absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
        interactive ? "pointer-events-auto" : "pointer-events-none",
        previous ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]",
      )}
    >
      <Tooltip content={label} side={previous ? "top" : "bottom"}>
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          size="icon-micro"
          type="button"
          variant="ghost-muted"
        >
          <Icon className="size-4 text-foreground/90" />
        </Button>
      </Tooltip>
    </span>
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
  onFileContextMenu,
  onRemoveQueued,
  onExpandImage,
  onOpenAgents,
}: {
  thread: Thread;
  skills: readonly Skill[];
  clearance: number;
  reverting: boolean;
  busy: boolean;
  onEdit: (turnId: string) => void;
  onRemoveQueued: (id: string) => void;
  onOpenTurnDiff: (turnId: string, filePath?: string) => void;
  onFileContextMenu?: FileContextMenuHandler;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onOpenAgents?: () => void;
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
  const viewport = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const [showScroll, setShowScroll] = useState(false);
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const [minimapRowMap] = useState(() => new Map<string, HTMLElement>());
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] =
    useState(false);
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const [minimapCurrentIndex, setMinimapCurrentIndex] = useState<number | null>(
    null,
  );
  const updateMinimap = useCallback(() => {
    const element = scroller.current;
    if (!element || minimapItems.length === 0) return;
    const scrollTop = element.scrollTop;
    const scrollBottom = scrollTop + element.clientHeight;
    const contentTop = element.getBoundingClientRect().top - scrollTop;
    const itemBounds = minimapItems.map((item) => {
      const rect = minimapRowMap.get(item.id)?.getBoundingClientRect();
      return rect
        ? { top: rect.top - contentTop, height: rect.height }
        : { top: null, height: null };
    });
    for (const [index, item] of minimapItems.entries()) {
      const strip = minimapStripMap.get(item.id);
      const bounds = itemBounds[index];
      const rowTop = bounds?.top ?? null;
      const rowHeight = bounds?.height ?? null;
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;
      if (strip) {
        strip.dataset.inView = inView ? "true" : "false";
      }
    }
    const nextCurrentIndex = resolveTimelineMinimapCurrentIndex({
      scrollTop,
      scrollBottom,
      itemBounds,
    });
    setMinimapCurrentIndex((current) =>
      current === nextCurrentIndex ? current : nextCurrentIndex,
    );
  }, [minimapItems, minimapRowMap, minimapStripMap]);
  useEffect(() => {
    const frame = requestAnimationFrame(updateMinimap);
    return () => cancelAnimationFrame(frame);
  }, [updateMinimap]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const viewportWidth = element.getBoundingClientRect().width;
      const contentWidth =
        element
          .querySelector<HTMLElement>("[data-timeline-root]")
          ?.getBoundingClientRect().width ?? viewportWidth;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(
        viewportWidth,
        contentWidth,
      );
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
      setMinimapHitStripWidth(
        resolveTimelineMinimapHitStripWidth(viewportWidth, contentWidth),
      );
    };
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [rows.length]);
  const selectMinimapItem = (item: TimelineMinimapItem) => {
    const element = scroller.current;
    const row = minimapRowMap.get(item.id);
    if (!element || !row) return;
    const top =
      row.getBoundingClientRect().top -
      element.getBoundingClientRect().top +
      element.scrollTop -
      24;
    atEnd.current = top >= element.scrollHeight - element.clientHeight - 2;
    element.scrollTo({ top, behavior: "smooth" });
  };
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
  const ctx = useMemo(
    () => ({ threadId: thread.id, onExpandImage }),
    [thread.id, onExpandImage],
  );
  return (
    <TimelineCtx value={ctx}>
      <div ref={viewport} className="relative h-full min-h-0">
        <div
          ref={scroller}
          data-assistant-citation-viewport
          data-chat-timeline-scroller="true"
          onScroll={(event) => {
            const element = event.currentTarget;
            const end =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              2;
            atEnd.current = end;
            setShowScroll(!end);
            updateMinimap();
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
                  ref={
                    row.kind === "user"
                      ? (node) => {
                          if (node) {
                            minimapRowMap.set(row.id, node);
                          } else {
                            minimapRowMap.delete(row.id);
                          }
                        }
                      : undefined
                  }
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
                      onExpandImage={onExpandImage}
                    />
                  ) : row.kind === "assistant" ? (
                    <AssistantRow row={row} thread={thread} />
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
                          label={row.entry.heading}
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
                  ) : row.kind === "activity-group" ? (
                    <ActivityGroupRow
                      row={row}
                      onToggle={() =>
                        setExpandedGroups((set) => toggle(set, row.groupId))
                      }
                    />
                  ) : row.kind === "work-live" ? (
                    <WorkLiveRow
                      row={row}
                      onToggle={() =>
                        setExpandedGroups((set) => toggle(set, row.groupId))
                      }
                    />
                  ) : row.kind === "live" ? (
                    <LiveRow entry={row.entry} />
                  ) : row.kind === "thinking" ? (
                    <ThinkingRow row={row} />
                  ) : row.kind === "agents" ? (
                    <AgentSpawnRow
                      row={row}
                      onToggle={() =>
                        setExpandedGroups((set) => toggle(set, row.id))
                      }
                      onOpenAgents={onOpenAgents}
                    />
                  ) : row.kind === "context-compaction" ? (
                    <ContextCompactionRow row={row} />
                  ) : row.kind === "checkpoint" ? (
                    thread.checkout.kind === "folder" ? null : (
                      <CheckpointRow
                        row={row}
                        onOpenTurnDiff={onOpenTurnDiff}
                        onFileContextMenu={onFileContextMenu}
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
        <TimelineMinimap
          items={minimapItems}
          hasPersistentGutter={minimapHasPersistentGutter}
          hitStripWidth={minimapHitStripWidth}
          currentIndex={minimapCurrentIndex}
          stripMap={minimapStripMap}
          onSelect={selectMinimapItem}
        />
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
      <AssistantSelectionToolbar
        viewportRef={scroller}
        environmentId={thread.workspaceId}
        threadId={thread.id}
      />
    </TimelineCtx>
  );
}

function CheckpointRow({
  row,
  onOpenTurnDiff,
  onFileContextMenu,
}: {
  row: Extract<TimelineRow, { kind: "checkpoint" }>;
  onOpenTurnDiff: (turnId: string, filePath?: string) => void;
  onFileContextMenu?: FileContextMenuHandler;
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
        onFileContextMenu={onFileContextMenu}
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
          <ChatMarkdown
            text={row.text}
            lineBreaks
            skills={skills}
            records={row.context?.records}
          />
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
