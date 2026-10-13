// Ported from T3 Code v0.0.45 apps/web/src/components/chat/MessagesTimeline.logic.ts, MessagesTimeline.tsx, agentSpawnSummary.ts, packages/client-runtime/src/work-log/presentation.ts and apps/server/src/orchestration/ActivityPayloadProjection.ts (MIT).
import type {
  Approval,
  Attachment,
  Item,
  Subagent,
  Thread,
  ToolIcon,
  ToolPresentation,
} from "../ipc";
import { fileKind } from "../panel/filePreview";
import { inSandbox } from "../lib/sandbox";
import type { ComposerContextRecord } from "./composerContext";
import { pathBasename } from "./composer-logic";
import { formatDuration } from "../lib/time";
import { deriveAgentSpawnSummary } from "./agentSpawnSummary";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isActiveSubagentStatus,
} from "./subagents";

type Turn = Thread["turns"][number];
type McpItem = Extract<Item, { kind: "mcp_tool_call" }>;
type ToolStatus = McpItem["status"];

function pendingApprovalLabel(action: Approval["action"]): string {
  switch (action.kind) {
    case "command":
      return action.command;
    case "file_change":
      return "File change approval";
    case "permission":
      return "App permission approval";
    case "mcp_elicitation":
      return "App access approval";
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export type WorkAction =
  | "command"
  | "edit"
  | "read"
  | "search"
  | "browser"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "other"
  | "approval";

export type WorkIcon =
  | "terminal"
  | "square-pen"
  | "eye"
  | "globe"
  | "wrench"
  | "hammer"
  | "bot"
  | "browser"
  | "computer"
  | "pull-request";

export type McpCall = {
  type: "mcpToolCall";
  id: string;
  tool: string;
  server: string;
  status: ToolStatus;
  arguments: McpItem["arguments"];
  appContext: McpItem["appContext"];
  error: { message: string } | null;
  durationMs: number | null;
  result?: { content: string };
};

export type WorkEntry = {
  id: string;
  action: WorkAction;
  icon: WorkIcon;
  heading: string;
  label: string;
  command: string | null;
  detail: string;
  mcpCall: McpCall | null;
  status: ToolStatus;
  presentation: ToolPresentation | null;
  viewedImagePath: string | null;
};

export function workEntryFailed(entry: WorkEntry): boolean {
  return entry.status === "failed" || entry.status === "declined";
}

export function workEntryToolIcon(entry: WorkEntry): ToolIcon | null {
  return entry.presentation?.icon ?? entry.presentation?.source.icon ?? null;
}

export function workEntryViewedImagePath(entry: WorkEntry): string | null {
  const path = entry.viewedImagePath?.trim();
  return path && !/[\r\n]/.test(path) && fileKind(path).kind === "image"
    ? path
    : null;
}

export type ReasoningEntry = {
  kind: "reasoning";
  id: string;
  text: string;
  streaming: boolean;
};

export type ActivityEntry =
  | ReasoningEntry
  | { kind: "work"; id: string; entry: WorkEntry };

export type TimelineRow =
  | {
      kind: "user";
      id: string;
      turnId: string;
      text: string;
      attachments: Attachment[];
      records: ComposerContextRecord[];
      at: number | null;
      editable: boolean;
      delivery: Extract<Item, { kind: "user_input" }>["delivery"] | null;
    }
  | {
      kind: "checkpoint";
      id: string;
      turnId: string;
      checkpoint: Turn["checkpoint"];
    }
  | {
      kind: "working";
      id: string;
      startedAtMs: number | null;
      compacting: boolean;
      // The sandbox's agent is launching, which can include building its image.
      startingSandbox: boolean;
    }
  | { kind: "thinking"; id: string; compacting: boolean }
  | {
      kind: "fold";
      id: string;
      turnId: string;
      label: string;
      expanded: boolean;
      at: number | null;
    }
  | {
      kind: "assistant";
      id: string;
      text: string;
      streaming: boolean;
      meta: boolean;
      at: number | null;
    }
  | { kind: "plan"; id: string; text: string; streaming: boolean }
  | { kind: "work"; id: string; entry: WorkEntry; at: number | null }
  | {
      kind: "work-group";
      id: string;
      label: string;
      icon: WorkIcon;
      toolIcon: ToolIcon | null;
      entries: WorkEntry[];
      expanded: boolean;
      at: number | null;
    }
  | {
      kind: "activity-group";
      id: string;
      groupId: string;
      label: string;
      icon: WorkIcon | "brain";
      toolIcon: ToolIcon | null;
      failed: boolean;
      active: boolean;
      shimmer: boolean;
      entries: ActivityEntry[];
      expanded: boolean;
    }
  | { kind: "live"; id: string; entry: WorkEntry }
  | {
      kind: "work-live";
      id: string;
      groupId: string;
      entry: WorkEntry;
      entries: WorkEntry[];
      expanded: boolean;
      active: boolean;
    }
  | {
      kind: "agents";
      id: string;
      label: string;
      live: boolean;
      failed: boolean;
      expanded: boolean;
      members: AgentSpawnMember[];
    }
  | { kind: "context-compaction"; id: string; label: string }
  | { kind: "error"; id: string; text: string };

const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
]);

function tokens(command: string): string[] {
  return (
    command
      .match(/'[^']*'|"(?:\\.|[^"])*"|\S+/g)
      ?.map((token) => token.replace(/^(['"])([\s\S]*)\1$/, "$2")) ?? []
  );
}

export function commandProgramName(command: string): string | null {
  const parts = tokens(command.trim());
  const first = parts[0];
  if (!first) return null;
  const program = pathBasename(first).replace(/\.exe$/i, "");
  if (SHELLS.has(program.toLowerCase())) {
    const flag = parts.findIndex((part) =>
      /^(?:-[a-z]*c|-command|\/c)$/i.test(part),
    );
    const payload = flag >= 0 ? parts[flag + 1] : undefined;
    if (payload) return commandProgramName(payload);
  }
  return program;
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function toolHeading(title: string): string {
  const heading = normalizeCompactToolLabel(title);
  return `${heading.charAt(0).toUpperCase()}${heading.slice(1)}`;
}

function summarizeToolTextOutput(value: string): string | null {
  let meaningfulLineCount = 0;
  for (const raw of value.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length === 0) continue;
    meaningfulLineCount += 1;
    if (line !== "```")
      return line.length <= 84 ? line : `${line.slice(0, 83).trimEnd()}…`;
  }
  return meaningfulLineCount > 1
    ? `${meaningfulLineCount.toLocaleString()} lines`
    : null;
}

function mcpCall(item: McpItem): McpCall {
  const summary = item.result ? summarizeToolTextOutput(item.result) : null;
  return {
    type: "mcpToolCall",
    id: item.id,
    tool: item.tool,
    server: item.server,
    status: item.status,
    arguments: item.arguments,
    appContext: item.appContext,
    error: item.error === null ? null : { message: item.error },
    durationMs: item.durationMs,
    ...(summary ? { result: { content: summary } } : {}),
  };
}

const BOTCODE_TOOL_LABELS: Record<
  string,
  readonly [action: string, running: string, completed: string, detail: string]
> = {
  link_pull_request: ["Link", "Linking", "Linked", "a pull request"],
  unlink_pull_request: ["Unlink", "Unlinking", "Unlinked", "a pull request"],
  list_thread_pull_requests: [
    "Check",
    "Checking",
    "Checked",
    "linked pull requests",
  ],
  preview_status: ["Get", "Getting", "Got", "preview browser status"],
  preview_open: ["Open", "Opening", "Opened", "a page in the preview browser"],
  preview_navigate: [
    "Navigate",
    "Navigating",
    "Navigated",
    "the preview browser",
  ],
  preview_snapshot: [
    "Take a snapshot of",
    "Taking a snapshot of",
    "Took a snapshot of",
    "the preview page",
  ],
  preview_click: ["Click", "Clicking", "Clicked", "in the preview browser"],
  preview_press: [
    "Press",
    "Pressing",
    "Pressed",
    "a key in the preview browser",
  ],
  preview_type: ["Type", "Typing", "Typed", "in the preview browser"],
  preview_scroll: ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
  preview_resize: ["Resize", "Resizing", "Resized", "the preview browser"],
  preview_evaluate: [
    "Evaluate",
    "Evaluating",
    "Evaluated",
    "script in the preview browser",
  ],
  preview_wait_for: ["Wait", "Waiting", "Waited", "for the preview page"],
  preview_set_appearance: [
    "Set",
    "Setting",
    "Set",
    "preview browser appearance",
  ],
};

const PR_TOOL_ACTIONS: Readonly<Record<string, WorkAction>> = {
  link_pull_request: "link-pr",
  unlink_pull_request: "unlink-pr",
  list_thread_pull_requests: "list-prs",
};

function pullRequestNumber(args: McpItem["arguments"]): number | null {
  if (args === null || typeof args !== "object" || Array.isArray(args))
    return null;
  const { url, number } = args;
  if (typeof url === "string") {
    try {
      const parsed = new URL(url);
      const match = /^\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/|$)/u.exec(
        parsed.pathname,
      );
      if (match?.[1]) return Number(match[1]);
    } catch {
      return null;
    }
  }
  return typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
    ? number
    : null;
}

function botcodeToolPresentation(
  call: Pick<McpCall, "server" | "tool" | "arguments">,
  status: ToolStatus,
): { displayName: string; icon: WorkIcon; action: WorkAction } | null {
  if (
    call.server !== "botcode" ||
    !Object.hasOwn(BOTCODE_TOOL_LABELS, call.tool)
  )
    return null;
  const labels = BOTCODE_TOOL_LABELS[call.tool];
  if (!labels) return null;
  const [action, running, completed, detail] = labels;
  const verb = {
    inProgress: running,
    completed,
    failed: `Failed to ${action.toLowerCase()}`,
    declined: `Declined to ${action.toLowerCase()}`,
  }[status];
  const prAction = PR_TOOL_ACTIONS[call.tool];
  const number =
    prAction && prAction !== "list-prs"
      ? pullRequestNumber(call.arguments)
      : null;
  return {
    displayName: `${verb} ${number === null ? detail : `PR #${number}`}`,
    icon: prAction ? "pull-request" : "browser",
    action: prAction ?? "browser",
  };
}

type ToolFields = Pick<WorkEntry, "action" | "icon" | "heading"> &
  Partial<
    Pick<
      WorkEntry,
      "label" | "detail" | "mcpCall" | "presentation" | "viewedImagePath"
    >
  >;

function toolEntry(id: string, status: ToolStatus, fields: ToolFields) {
  return {
    id,
    command: null,
    detail: "",
    mcpCall: null,
    presentation: null,
    viewedImagePath: null,
    label: fields.heading,
    ...fields,
    status,
  } satisfies WorkEntry;
}

function itemStatus(status: string): ToolStatus {
  return status === "inProgress" || status === "failed" || status === "declined"
    ? status
    : "completed";
}

type Entry =
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | ReasoningEntry
  | Extract<TimelineRow, { kind: "plan" }>
  | { kind: "work"; id: string; entry: WorkEntry }
  | Extract<TimelineRow, { kind: "user" }>
  | { kind: "compaction"; id: string; complete: boolean }
  | Extract<TimelineRow, { kind: "agents" }>;

type ItemEntry =
  | Exclude<Entry, { kind: "agents" }>
  | { kind: "subagent"; id: string };

function work(entry: WorkEntry): ItemEntry[] {
  return [{ kind: "work", id: entry.id, entry }];
}

function present(item: Item, turnId: string): ItemEntry[] {
  switch (item.kind) {
    case "user_input":
      return [
        {
          kind: "user",
          id: `input:${item.id}`,
          turnId,
          text: item.text,
          attachments: item.attachments,
          records: item.context?.records ?? [],
          at: null,
          editable: false,
          delivery: item.delivery,
        },
      ];
    case "assistant":
      return [
        {
          kind: "assistant",
          id: item.id,
          text: item.text,
          streaming: !item.complete,
        },
      ];
    case "plan":
      return [
        {
          kind: "plan",
          id: item.id,
          text: item.text,
          streaming: !item.complete,
        },
      ];
    case "reasoning":
      return item.text.trim()
        ? [
            {
              kind: "reasoning",
              id: item.id,
              text: item.text,
              streaming: !item.complete,
            },
          ]
        : [];
    case "command":
      return work({
        id: item.id,
        action: "command",
        icon: "terminal",
        heading: item.command,
        label: item.command,
        command: item.command,
        detail: item.output,
        mcpCall: null,
        status: itemStatus(item.status),
        presentation: null,
        viewedImagePath: null,
      });
    case "file_change": {
      const [first] = item.paths;
      const label = first
        ? item.paths.length === 1
          ? first
          : `${first} +${item.paths.length - 1} more`
        : "Changed files";
      return work({
        id: item.id,
        action: "edit",
        icon: "square-pen",
        heading: label,
        label,
        command: null,
        detail: item.text,
        mcpCall: null,
        status: itemStatus(item.status),
        presentation: null,
        viewedImagePath: null,
      });
    }
    case "mcp_tool_call": {
      const tool = botcodeToolPresentation(item, item.status);
      return work(
        toolEntry(item.id, item.status, {
          action: tool?.action ?? "other",
          icon: tool?.icon ?? item.presentation?.surface ?? "wrench",
          heading: tool?.displayName ?? toolHeading(item.title),
          mcpCall: mcpCall(item),
          presentation: item.presentation,
        }),
      );
    }
    case "dynamic_tool_call":
      return work(
        toolEntry(item.id, item.status, {
          action: "other",
          icon: "hammer",
          heading: "Tool call",
        }),
      );
    case "collab_agent_tool_call":
      return work(
        toolEntry(item.id, item.status, {
          action: "other",
          icon: "bot",
          heading: "Tool",
          label: item.prompt?.trim() || "Tool",
          detail: item.prompt ?? "",
        }),
      );
    case "web_search":
      return work(
        toolEntry(item.id, item.status, {
          action: "search",
          icon: "globe",
          heading: "Web search",
          label: item.query.trim() || "Web search",
          detail: item.query,
        }),
      );
    case "image_view":
      return work(
        toolEntry(item.id, "completed", {
          action: "read",
          icon: "eye",
          heading: "Image view",
          label: item.path.trim() || "Image view",
          detail: item.path,
          viewedImagePath: item.path,
        }),
      );
    case "image_generation":
      return work(
        toolEntry(item.id, item.status, {
          action: "read",
          icon: "eye",
          heading: "Image view",
        }),
      );
    case "context_compaction":
      return [{ kind: "compaction", id: item.id, complete: item.complete }];
    case "sub_agent_activity":
      return item.activity === "started"
        ? [{ kind: "subagent", id: item.id }]
        : [];
    case "hook_prompt":
    case "function_call_output":
    case "sleep":
    case "review_mode":
      return [];
    default: {
      const unhandled: never = item;
      return unhandled;
    }
  }
}

const AGENT_MEMBER_STATUS_LABEL: Record<Subagent["status"], string> = {
  running: "Working",
  waiting: "Working",
  idle: "Idle",
  failed: "Failed",
  interrupted: "Stopped",
};

export type AgentSpawnMember = {
  id: string;
  title: string;
  role: string | null;
  failed: boolean;
  statusLabel: string;
  firstLine: string | null;
  body: string;
};

export function agentSpawnMember(agent: Subagent): AgentSpawnMember {
  const activity = agent.progress;
  const durationMs =
    agent.completedAtMs !== null
      ? agent.completedAtMs - agent.startedAtMs
      : null;
  const meta = [
    durationMs !== null && durationMs >= 0 ? formatDuration(durationMs) : null,
    agent.totalTokens
      ? `${formatSubagentTokenCount(agent.totalTokens)} tok`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const statusLabel =
    isActiveSubagentStatus(agent.status) || !meta
      ? AGENT_MEMBER_STATUS_LABEL[agent.status]
      : `${AGENT_MEMBER_STATUS_LABEL[agent.status]} · ${meta}`;
  return {
    id: agent.id,
    title: agent.title,
    role:
      agent.role.trim().toLowerCase() !== agent.title.trim().toLowerCase()
        ? agent.role
        : null,
    failed: agent.status === "failed",
    statusLabel,
    firstLine:
      activity?.split("\n").find((line) => line.trim().length > 0) ?? null,
    body: [
      activity?.trim() || null,
      formatSubagentModelLabel(agent.model, agent.effort),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function placeAgentSpawn(
  list: ItemEntry[],
  members: readonly Subagent[],
  expandedGroups: ReadonlySet<string>,
): Entry[] {
  const anchor = list.find((entry) => entry.kind === "subagent");
  return list.flatMap((entry): Entry[] => {
    if (entry.kind !== "subagent") return [entry];
    if (entry !== anchor || members.length === 0) return [];
    const id = `agents:${entry.id}`;
    const { live, lead, failed } = deriveAgentSpawnSummary(members);
    return [
      {
        kind: "agents",
        id,
        label: lead,
        live,
        failed,
        expanded: expandedGroups.has(id),
        members: members.map(agentSpawnMember),
      },
    ];
  });
}

function entries(
  turn: Turn,
  subagents: readonly Subagent[],
  expandedGroups: ReadonlySet<string>,
): Entry[] {
  return placeAgentSpawn(
    turn.items.flatMap((item) => present(item, turn.id)),
    subagents.filter((agent) => agent.spawnTurnId === turn.id),
    expandedGroups,
  );
}

function liveActivityToolStatus(
  status: ToolStatus,
  presentTense: boolean,
): ToolStatus {
  if (status === "failed" || status === "declined") return status;
  return presentTense || status === "inProgress" ? "inProgress" : "completed";
}

export function liveWorkEntryLabel(entry: WorkEntry, active: boolean): string {
  const status = liveActivityToolStatus(entry.status, active);
  const tool = entry.mcpCall && botcodeToolPresentation(entry.mcpCall, status);
  if (tool) return tool.displayName;
  const command = entry.command?.trim();
  if (!command) return entry.label;
  const verb = {
    inProgress: "Running",
    failed: "Failed",
    declined: "Declined",
    completed: "Ran",
  }[status];
  return `${verb} ${commandProgramName(command) ?? "command"}`;
}

export function workEntryCanExpand(
  entry: WorkEntry,
  visibleLabel: string,
): boolean {
  return (
    (workEntryFailed(entry) && visibleLabel.trim().length > 0) ||
    entry.mcpCall !== null ||
    Boolean(
      entry.command?.trim() ||
      entry.detail.trim() ||
      workEntryViewedImagePath(entry),
    )
  );
}

export function workEntryExpandedBody(
  entry: WorkEntry,
  visibleLabel: string,
): string | null {
  const blocks: string[] = [];
  const seen = new Set<string>([visibleLabel.trim()]);
  const addBlock = (value: string | null) => {
    const text = value?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    blocks.push(text);
  };
  if (entry.mcpCall)
    addBlock(`MCP call\n${JSON.stringify(entry.mcpCall, null, 2)}`);
  const command = entry.command?.trim();
  if (command === visibleLabel.trim()) seen.add(command);
  else addBlock(entry.command);
  const detail = entry.detail.trim();
  if (detail !== workEntryViewedImagePath(entry)) addBlock(detail);
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function toolGroupActionLabel(action: WorkAction, n: number): string {
  switch (action) {
    case "command":
      return `Ran ${n} ${n === 1 ? "command" : "commands"}`;
    case "edit":
      return `Changed ${n} ${n === 1 ? "file" : "files"}`;
    case "read":
      return `Read ${n} ${n === 1 ? "file" : "files"}`;
    case "search":
      return `Searched the web ${n} ${n === 1 ? "time" : "times"}`;
    case "browser":
      return `Used browser ${n} ${n === 1 ? "time" : "times"}`;
    case "link-pr":
      return `Linked ${n} ${n === 1 ? "pull request" : "pull requests"}`;
    case "unlink-pr":
      return `Unlinked ${n} ${n === 1 ? "pull request" : "pull requests"}`;
    case "list-prs":
      return n === 1
        ? "Checked linked pull requests"
        : `Checked linked pull requests ${n} times`;
    case "other":
      return `Used ${n} ${n === 1 ? "tool" : "tools"}`;
    case "approval":
      return `Requested ${n} ${n === 1 ? "approval" : "approvals"}`;
  }
}

export function summarizeToolGroup(entries: readonly WorkEntry[]): string {
  const sources = new Map<string, ToolPresentation["source"]>();
  const counts = new Map<WorkAction, number>();
  for (const entry of entries) {
    if (entry.presentation) {
      sources.set(entry.presentation.source.key, entry.presentation.source);
      continue;
    }
    counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  }
  const labels = [...counts].map(([action, n]) =>
    toolGroupActionLabel(action, n),
  );
  if (sources.size > 0) {
    const sourceValues = [...sources.values()];
    const names = sourceValues.map((source) => source.name);
    const formattedNames =
      names.length < 2
        ? names[0]
        : names.length === 2
          ? names.join(" and ")
          : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
    const allIntegrations = sourceValues.every(
      (source) => source.kind === "integration",
    );
    labels.unshift(
      `Used ${formattedNames}${allIntegrations ? ` ${sources.size === 1 ? "integration" : "integrations"}` : ""}`,
    );
  }
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  if (sentenceLabels.length < 2) return sentenceLabels[0] ?? "";
  if (sentenceLabels.length === 2) return sentenceLabels.join(" and ");
  return `${sentenceLabels.slice(0, -1).join(", ")}, and ${sentenceLabels.at(-1)}`;
}

function toolGroupIcons(entries: readonly WorkEntry[]): {
  icon: WorkIcon;
  toolIcon: ToolIcon | null;
} {
  const primary = entries.find((entry) => entry.presentation)?.presentation;
  const primaryIcon = primary
    ? (entries.find(
        (entry) =>
          entry.presentation?.source.key === primary.source.key &&
          entry.presentation.icon,
      )?.presentation?.icon ?? primary.source.icon)
    : null;
  const icons = new Set(entries.map((entry) => entry.icon));
  const [only] = icons;
  return {
    icon: primary?.surface ?? (icons.size === 1 && only ? only : "hammer"),
    toolIcon:
      primaryIcon ??
      entries.findLast((entry) => entry.presentation?.icon)?.presentation
        ?.icon ??
      null,
  };
}

function liveToolRun(work: readonly WorkEntry[]) {
  let start = work.length;
  while (start > 0) {
    start -= 1;
    const entry = work[start];
    if (entry && workEntryFailed(entry)) break;
  }
  const entries = work.slice(start);
  const latest = entries.at(-1);
  const running = entries.findLast((entry) => entry.status === "inProgress");
  return {
    entries,
    entry: running ?? latest,
    latestFailed: running === undefined && latest?.status === "failed",
    keepsLive: running !== undefined || latest?.status === "completed",
  };
}

function activityGroup(
  run: ActivityEntry[],
  live: boolean,
  liveId: string,
  expandedGroups: ReadonlySet<string>,
): Extract<TimelineRow, { kind: "activity-group" }> {
  const work = run.flatMap((entry) =>
    entry.kind === "work" ? [entry.entry] : [],
  );
  const thoughtCount = run.filter((entry) => entry.kind === "reasoning").length;
  const lastThought = run.findLastIndex((entry) => entry.kind === "reasoning");
  const trailing = run
    .slice(lastThought + 1)
    .flatMap((entry) => (entry.kind === "work" ? [entry.entry] : []));
  const tools = liveToolRun(trailing);
  const active =
    live &&
    !tools.latestFailed &&
    (tools.entry === undefined || tools.keepsLive);
  const liveWork =
    trailing.findLast((entry) => entry.status === "inProgress") ??
    trailing.at(-1);
  const iconWork = active ? liveWork : work.at(-1);
  const groupId = `activity-group:${run[0]?.id}`;
  return {
    kind: "activity-group",
    id: active ? liveId : groupId,
    groupId,
    label: active
      ? liveWork
        ? liveWorkEntryLabel(liveWork, true)
        : "Thinking"
      : work.length > 0
        ? summarizeToolGroup(work)
        : `Thought${thoughtCount > 1 ? ` (×${thoughtCount})` : ""}`,
    icon: iconWork?.icon ?? "brain",
    toolIcon: iconWork ? workEntryToolIcon(iconWork) : null,
    failed: iconWork ? workEntryFailed(iconWork) : false,
    active,
    shimmer: active && liveWork === undefined,
    entries: run,
    expanded: expandedGroups.has(groupId),
  };
}

const settled = new Set(["completed", "interrupted", "failed", "lost"]);

function isRunning(turn: Turn): boolean {
  if (turn.delivery.kind === "not_sent") return false;
  return !settled.has(turn.execution.kind);
}

function pushVisible(
  rows: TimelineRow[],
  visible: Entry[],
  options: {
    expandedGroups: ReadonlySet<string>;
    at: number | null;
    terminalId: string | null;
    meta: boolean;
    live: boolean;
    liveId: string;
  },
): boolean {
  const { expandedGroups, at } = options;
  let hasActivityRow = false;
  let run: ActivityEntry[] = [];
  const workLive = (
    entries: WorkEntry[],
    entry: WorkEntry,
    active: boolean,
    id: string | null,
  ) => {
    const groupId = `group:${entries[0]?.id}`;
    rows.push({
      kind: "work-live",
      id: id ?? `work-live:${entries[0]?.id}`,
      groupId,
      entry,
      entries,
      expanded: expandedGroups.has(groupId),
      active,
    });
    hasActivityRow ||= active;
  };
  const pushWork = (work: WorkEntry[]) => {
    const running = options.live
      ? work.findLast((entry) => entry.status === "inProgress")
      : undefined;
    if (running) {
      workLive(work, running, true, null);
    } else if (work.length === 1) {
      const [entry] = work;
      if (entry) rows.push({ kind: "work", id: entry.id, entry, at });
    } else if (work.length > 1) {
      const id = `group:${work[0]?.id}`;
      rows.push({
        kind: "work-group",
        id,
        label: summarizeToolGroup(work),
        ...toolGroupIcons(work),
        entries: work,
        expanded: expandedGroups.has(id),
        at,
      });
    }
  };
  const flush = (atEnd: boolean) => {
    if (run.length === 0) return;
    const live = options.live && atEnd;
    if (run.some((entry) => entry.kind === "reasoning")) {
      const row = activityGroup(run, live, options.liveId, expandedGroups);
      rows.push(row);
      hasActivityRow ||= row.active;
      run = [];
      return;
    }
    const work = run.flatMap((entry) =>
      entry.kind === "work" ? [entry.entry] : [],
    );
    run = [];
    if (!live) {
      pushWork(work);
      return;
    }
    const tools = liveToolRun(work);
    pushWork(work.slice(0, work.length - tools.entries.length));
    if (tools.entry && !tools.latestFailed)
      workLive(
        tools.entries,
        tools.entry,
        tools.keepsLive,
        tools.keepsLive ? options.liveId : null,
      );
  };
  for (const entry of visible) {
    if (entry.kind === "work" || entry.kind === "reasoning") {
      run.push(entry);
      continue;
    }
    flush(false);
    switch (entry.kind) {
      case "user":
      case "plan":
        rows.push(entry);
        break;
      case "assistant":
        rows.push({
          kind: "assistant",
          id: entry.id,
          text: entry.text,
          streaming: entry.streaming,
          meta: options.meta && entry.id === options.terminalId,
          at,
        });
        break;
      case "agents":
        rows.push(entry);
        hasActivityRow ||= options.live && entry.live;
        break;
      case "compaction":
        if (entry.complete)
          rows.push({
            kind: "context-compaction",
            id: entry.id,
            label: "Context compacted",
          });
        break;
      default: {
        const unhandled: never = entry;
        return unhandled;
      }
    }
  }
  flush(true);
  return hasActivityRow;
}

export function deriveRows(
  thread: Thread,
  unfolded: ReadonlySet<string>,
  expandedGroups: ReadonlySet<string>,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const latest = thread.turns.at(-1);
  for (const turn of thread.turns) {
    rows.push({
      kind: "user",
      id: `user:${turn.id}`,
      turnId: turn.id,
      text: turn.prompt,
      attachments: turn.attachments,
      records: turn.context?.records ?? [],
      at: turn.startedAtMs,
      editable: true,
      delivery: null,
    });
    const list = entries(turn, thread.subagents, expandedGroups);
    if (isRunning(turn)) {
      const lastCompaction = list.findLast(
        (entry) => entry.kind === "compaction",
      );
      const compacting = lastCompaction
        ? !lastCompaction.complete
        : turn.kind === "compaction";
      const startingSandbox =
        !compacting &&
        thread.session.kind === "connecting" &&
        inSandbox(thread.checkout);
      rows.push({
        kind: "working",
        id: `working:${turn.id}`,
        startedAtMs: turn.startedAtMs,
        compacting,
        startingSandbox,
      });
      const pending = thread.approvals.filter(
        (approval) =>
          approval.turnId === turn.id && approval.state === "pending",
      );
      const liveId = `live-activity:${turn.id}`;
      const hasActivityRow = pushVisible(
        rows,
        pending.length > 0
          ? list.filter(
              (entry) =>
                entry.kind !== "work" || entry.entry.status !== "inProgress",
            )
          : list,
        {
          expandedGroups,
          at: null,
          terminalId: null,
          meta: false,
          live: pending.length === 0,
          liveId,
        },
      );
      for (const approval of pending) {
        const label = pendingApprovalLabel(approval.action);
        rows.push({
          kind: "live",
          id: `approval:${approval.id}`,
          entry: {
            id: approval.id,
            action: "approval",
            icon: "hammer",
            heading: label,
            label,
            command: null,
            detail: "",
            mcpCall: null,
            status: "inProgress",
            presentation: null,
            viewedImagePath: null,
          },
        });
      }
      if (!hasActivityRow && pending.length === 0 && !startingSandbox)
        rows.push({ kind: "thinking", id: liveId, compacting });
    } else {
      const terminalIndex = list.findLastIndex(
        (entry) =>
          (entry.kind === "assistant" || entry.kind === "plan") &&
          !entry.streaming,
      );
      const terminal = terminalIndex >= 0 ? list[terminalIndex] : undefined;
      const boundary = terminalIndex >= 0 ? terminalIndex : list.length;
      const trailing = list.filter(
        (entry, index) => index > boundary && entry.kind !== "reasoning",
      );
      const hidden = new Set(
        list
          .filter((entry, index) => {
            if (
              entry === terminal ||
              entry.kind === "user" ||
              entry.kind === "plan" ||
              entry.kind === "agents"
            )
              return false;
            if (
              index < boundary ||
              entry.kind === "reasoning" ||
              entry.kind === "compaction"
            )
              return true;
            return (
              trailing.length === 1 &&
              entry.kind === "work" &&
              !workEntryFailed(entry.entry)
            );
          })
          .map((entry) => entry.id),
      );
      const foldable = list.some(
        (entry) =>
          hidden.has(entry.id) &&
          entry.kind !== "reasoning" &&
          entry.kind !== "compaction",
      );
      const at = turn.completedAtMs;
      const visible = { expandedGroups, at, meta: true, live: false };
      const terminalId = terminal?.id ?? null;
      const liveId = `live-activity:${turn.id}`;
      if (foldable) {
        const expanded = unfolded.has(turn.id);
        const elapsed =
          turn.startedAtMs !== null && turn.completedAtMs !== null
            ? formatDuration(turn.completedAtMs - turn.startedAtMs)
            : null;
        const stopped =
          turn === latest && turn.execution.kind === "interrupted";
        rows.push({
          kind: "fold",
          id: `fold:${turn.id}`,
          turnId: turn.id,
          label: stopped
            ? elapsed
              ? `You stopped after ${elapsed}`
              : "You stopped this response"
            : elapsed
              ? `Worked for ${elapsed}`
              : "Worked",
          expanded,
          at,
        });
        pushVisible(
          rows,
          expanded ? list : list.filter((entry) => !hidden.has(entry.id)),
          { ...visible, terminalId, liveId },
        );
      } else {
        pushVisible(rows, list, { ...visible, terminalId, liveId });
      }
    }
    const failure =
      turn.delivery.kind === "not_sent" || turn.delivery.kind === "uncertain"
        ? turn.delivery.reason
        : turn.execution.kind === "failed" || turn.execution.kind === "lost"
          ? turn.execution.reason
          : null;
    if (failure)
      rows.push({ kind: "error", id: `error:${turn.id}`, text: failure });
    if (
      !isRunning(turn) &&
      (turn.checkpoint.kind === "complete" ||
        turn.checkpoint.kind === "unavailable")
    )
      rows.push({
        kind: "checkpoint",
        id: `checkpoint:${turn.id}`,
        turnId: turn.id,
        checkpoint: turn.checkpoint,
      });
  }
  return rows;
}

const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(
    1,
    (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING,
  );
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(
  index: number,
  itemCount: number,
): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(
    0,
    Math.min(1, (input.pointerY - input.railTop) / input.railHeight),
  );
  return Math.max(
    0,
    Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))),
  );
}

export function resolveTimelineMinimapCurrentIndex(input: {
  readonly scrollTop: number;
  readonly scrollBottom: number;
  readonly itemBounds: ReadonlyArray<{
    readonly top: number | null;
    readonly height: number | null;
  }>;
}): number | null {
  let precedingIndex: number | null = null;

  for (const [index, item] of input.itemBounds.entries()) {
    if (item.top === null) {
      continue;
    }
    const inView =
      item.top < input.scrollBottom &&
      item.top + Math.max(1, item.height ?? 1) > input.scrollTop;
    if (inView) {
      return index;
    }
    if (item.top <= input.scrollTop) {
      precedingIndex = index;
    }
  }

  return precedingIndex;
}

function resolveTimelineSideGutter(
  viewportWidth: number,
  contentWidth: number,
): number {
  if (
    !Number.isFinite(viewportWidth) ||
    viewportWidth <= 0 ||
    !Number.isFinite(contentWidth)
  ) {
    return 0;
  }
  return Math.max(
    0,
    (viewportWidth - Math.min(viewportWidth, contentWidth)) / 2,
  );
}

export function resolveTimelineMinimapHasPersistentGutter(
  viewportWidth: number,
  contentWidth: number,
): boolean {
  return (
    resolveTimelineSideGutter(viewportWidth, contentWidth) >=
    TIMELINE_MINIMAP_PERSISTENT_GUTTER
  );
}

const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";

export function resolveTimelineMinimapHitStripWidth(
  viewportWidth: number,
  contentWidth: number,
): number {
  const sideGutter = resolveTimelineSideGutter(viewportWidth, contentWidth);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

const TIMELINE_MINIMAP_NAVIGATION_OFFSET = 4;
const TIMELINE_MINIMAP_NAVIGATION_BUTTON_WIDTH = 20;
const TIMELINE_MINIMAP_NAVIGATION_REACH =
  TIMELINE_MINIMAP_NAVIGATION_OFFSET +
  TIMELINE_MINIMAP_NAVIGATION_BUTTON_WIDTH / 2;

export function resolveTimelineMinimapNavigationInteractive(
  collapsedWidth: number,
): boolean {
  return collapsedWidth >= TIMELINE_MINIMAP_NAVIGATION_REACH;
}

export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}
