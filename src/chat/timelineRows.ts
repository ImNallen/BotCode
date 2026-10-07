// Ported from T3 Code v0.0.45 apps/web/src/components/chat/MessagesTimeline.logic.ts, MessagesTimeline.tsx, agentSpawnSummary.ts, packages/client-runtime/src/work-log/presentation.ts and apps/server/src/orchestration/ActivityPayloadProjection.ts (MIT).
import type { ImageAttachment, Item, Thread } from "../ipc";
import { formatDuration } from "../lib/time";

type Turn = Thread["turns"][number];
type McpItem = Extract<Item, { kind: "mcp_tool_call" }>;
type ToolStatus = McpItem["status"];

export type WorkAction =
  | "command"
  | "edit"
  | "read"
  | "search"
  | "other"
  | "approval";

export type WorkIcon =
  | "terminal"
  | "square-pen"
  | "eye"
  | "globe"
  | "wrench"
  | "hammer"
  | "bot";

export type McpCall = {
  type: "mcpToolCall";
  id: string;
  tool: string;
  server: string;
  status: ToolStatus;
  arguments: McpItem["arguments"];
  appContext: null;
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
  running: boolean;
  failed: boolean;
};

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
      attachments: ImageAttachment[];
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
      failed: boolean;
      active: boolean;
      shimmer: boolean;
      entries: ActivityEntry[];
      expanded: boolean;
    }
  | { kind: "live"; id: string; entry: WorkEntry }
  | { kind: "agents"; id: string; label: string; live: boolean }
  | { kind: "context-compaction"; id: string; label: string }
  | { kind: "error"; id: string; text: string };

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);

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
  const program = first.split("/").at(-1) ?? first;
  if (SHELLS.has(program)) {
    const flag = parts.findIndex((part) => /^-[a-z]*c$/.test(part));
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
    appContext: null,
    error: item.error === null ? null : { message: item.error },
    durationMs: item.durationMs,
    ...(summary ? { result: { content: summary } } : {}),
  };
}

type ToolFields = Pick<WorkEntry, "action" | "icon" | "heading"> &
  Partial<Pick<WorkEntry, "label" | "detail" | "mcpCall">>;

function toolEntry(id: string, status: ToolStatus, fields: ToolFields) {
  return {
    id,
    command: null,
    detail: "",
    mcpCall: null,
    label: fields.heading,
    ...fields,
    running: status === "inProgress",
    failed: status === "failed" || status === "declined",
  } satisfies WorkEntry;
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
  | {
      kind: "subagent";
      id: string;
      agentThreadId: string;
      activity: Extract<Item, { kind: "sub_agent_activity" }>["activity"];
    };

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
        running: item.status === "inProgress",
        failed: item.status === "failed" || item.status === "declined",
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
        running: item.status === "inProgress",
        failed: item.status === "failed" || item.status === "declined",
      });
    }
    case "mcp_tool_call":
      return work(
        toolEntry(item.id, item.status, {
          action: "other",
          icon: "wrench",
          heading: toolHeading(item.title),
          mcpCall: mcpCall(item),
        }),
      );
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
      return item.agentPath === "/root"
        ? []
        : [
            {
              kind: "subagent",
              id: item.id,
              agentThreadId: item.agentThreadId,
              activity: item.activity,
            },
          ];
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

function collapseSubagents(list: ItemEntry[]): Entry[] {
  const states = new Map<string, "running" | "idle" | "stopped">();
  for (const entry of list) {
    if (entry.kind !== "subagent") continue;
    if (entry.activity === "started")
      states.set(entry.agentThreadId, "running");
    else if (entry.activity === "completed")
      states.set(entry.agentThreadId, "idle");
    else if (entry.activity === "interrupted")
      states.set(entry.agentThreadId, "stopped");
  }
  const first = list.find((entry) => entry.kind === "subagent");
  const count = states.size;
  const live = [...states.values()].includes("running");
  return list.flatMap((entry): Entry[] => {
    if (entry.kind !== "subagent") return [entry];
    return entry !== first || count === 0
      ? []
      : [
          {
            kind: "agents",
            id: `agents:${entry.id}`,
            label: `${live ? "Kicked off" : "Ran"} ${count} subagent${count === 1 ? "" : "s"}`,
            live,
          },
        ];
  });
}

function entries(turn: Turn): Entry[] {
  return collapseSubagents(
    turn.items.flatMap((item) => present(item, turn.id)),
  );
}

export function liveWorkEntryLabel(entry: WorkEntry, active: boolean): string {
  const command = entry.command?.trim();
  if (!command) return entry.label;
  const verb = entry.failed
    ? "Failed"
    : active || entry.running
      ? "Running"
      : "Ran";
  return `${verb} ${commandProgramName(command) ?? "command"}`;
}

export function workEntryCanExpand(
  entry: WorkEntry,
  visibleLabel: string,
): boolean {
  return (
    (entry.failed && visibleLabel.trim().length > 0) ||
    entry.mcpCall !== null ||
    Boolean(entry.command?.trim() || entry.detail.trim())
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
  addBlock(entry.detail);
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
    case "other":
      return `Used ${n} ${n === 1 ? "tool" : "tools"}`;
    case "approval":
      return `Requested ${n} ${n === 1 ? "approval" : "approvals"}`;
  }
}

export function summarizeToolGroup(entries: readonly WorkEntry[]): string {
  const counts = new Map<WorkAction, number>();
  for (const entry of entries)
    counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  const labels = [...counts].map(([action, n], index) => {
    const label = toolGroupActionLabel(action, n);
    return index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1);
  });
  if (labels.length < 2) return labels[0] ?? "";
  if (labels.length === 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function toolGroupIcon(entries: readonly WorkEntry[]): WorkIcon {
  const icons = new Set(entries.map((entry) => entry.icon));
  const [only] = icons;
  return icons.size === 1 && only ? only : "hammer";
}

function activityGroup(
  run: ActivityEntry[],
  active: boolean,
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
  const liveWork =
    trailing.findLast((entry) => entry.running) ?? trailing.at(-1);
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
    failed: iconWork?.failed ?? false,
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
  const flush = (atEnd: boolean) => {
    const last = run.at(-1);
    if (!last) return;
    if (run.some((entry) => entry.kind === "reasoning")) {
      const active =
        options.live &&
        atEnd &&
        !(last.kind === "work" && last.entry.failed && !last.entry.running);
      rows.push(activityGroup(run, active, options.liveId, expandedGroups));
      hasActivityRow ||= active;
      run = [];
      return;
    }
    const work = run.flatMap((entry) =>
      entry.kind === "work" ? [entry.entry] : [],
    );
    const settledRun = work.filter((entry) => !entry.running);
    const live = work.filter((entry) => entry.running).at(-1);
    if (settledRun.length === 1) {
      const [entry] = settledRun;
      if (entry) rows.push({ kind: "work", id: entry.id, entry, at });
    } else if (settledRun.length > 1) {
      const id = `group:${settledRun[0]?.id}`;
      rows.push({
        kind: "work-group",
        id,
        label: summarizeToolGroup(settledRun),
        icon: toolGroupIcon(settledRun),
        entries: settledRun,
        expanded: expandedGroups.has(id),
        at,
      });
    }
    if (live) {
      rows.push({ kind: "live", id: `live:${live.id}`, entry: live });
      hasActivityRow = true;
    }
    run = [];
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
      at: turn.startedAtMs,
      editable: true,
      delivery: null,
    });
    const list = entries(turn);
    if (isRunning(turn)) {
      const lastCompaction = list.findLast(
        (entry) => entry.kind === "compaction",
      );
      const compacting = lastCompaction?.complete === false;
      rows.push({
        kind: "working",
        id: `working:${turn.id}`,
        startedAtMs: turn.startedAtMs,
        compacting,
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
              (entry) => entry.kind !== "work" || !entry.entry.running,
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
        const label =
          approval.action.kind === "command"
            ? approval.action.command
            : "File change approval";
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
            running: true,
            failed: false,
          },
        });
      }
      if (!hasActivityRow && pending.length === 0)
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
              !entry.entry.failed
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
