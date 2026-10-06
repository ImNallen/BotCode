// Ported from T3 Code v0.0.45 apps/web/src/components/chat/MessagesTimeline.logic.ts and packages/client-runtime/src/work-log/presentation.ts (MIT).
import type { ImageAttachment, Item, Thread } from "../ipc";
import { formatDuration } from "../lib/time";

type Turn = Thread["turns"][number];

export type WorkKind = "command" | "file_change" | "tool" | "approval";

export type WorkEntry = {
  id: string;
  kind: WorkKind;
  label: string;
  detail: string;
  running: boolean;
  failed: boolean;
};

export type TimelineRow =
  | {
      kind: "user";
      id: string;
      turnId: string;
      text: string;
      attachments: ImageAttachment[];
      at: number | null;
    }
  | {
      kind: "checkpoint";
      id: string;
      turnId: string;
      checkpoint: Turn["checkpoint"];
    }
  | { kind: "working"; id: string; startedAtMs: number | null }
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
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "work"; id: string; entry: WorkEntry; at: number | null }
  | {
      kind: "work-group";
      id: string;
      entries: WorkEntry[];
      expanded: boolean;
      at: number | null;
    }
  | { kind: "live"; id: string; entry: WorkEntry }
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

function workEntry(item: Item): WorkEntry | null {
  switch (item.kind) {
    case "command":
      return {
        id: item.id,
        kind: "command",
        label: item.command,
        detail: item.output,
        running: item.status === "inProgress",
        failed: item.status === "failed" || item.status === "declined",
      };
    case "file_change": {
      const [first] = item.paths;
      return {
        id: item.id,
        kind: "file_change",
        label: first
          ? item.paths.length === 1
            ? first
            : `${first} +${item.paths.length - 1} more`
          : "Changed files",
        detail: item.text,
        running: item.status === "inProgress",
        failed: item.status === "failed" || item.status === "declined",
      };
    }
    case "other":
      return item.text && item.label !== "Reasoning"
        ? {
            id: item.id,
            kind: "tool",
            label: item.label,
            detail: item.text,
            running: false,
            failed: false,
          }
        : null;
    case "assistant":
      return null;
  }
}

export function liveLabel(entry: WorkEntry): string {
  if (entry.kind === "command" && entry.label)
    return `${entry.running ? "Running" : entry.failed ? "Failed" : "Ran"} ${commandProgramName(entry.label) ?? "command"}`;
  return entry.label;
}

const actionLabels: Record<WorkKind, (n: number) => string> = {
  command: (n) => `Ran ${n} ${n === 1 ? "command" : "commands"}`,
  file_change: (n) => `Changed ${n} ${n === 1 ? "file" : "files"}`,
  tool: (n) => `Used ${n} ${n === 1 ? "tool" : "tools"}`,
  approval: (n) => `Requested ${n} ${n === 1 ? "approval" : "approvals"}`,
};

export function summarizeWork(entries: WorkEntry[]): string {
  const counts = new Map<WorkKind, number>();
  for (const entry of entries)
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  const labels = [...counts].map(([kind, n], index) => {
    const label = actionLabels[kind](n);
    return index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1);
  });
  if (labels.length < 2) return labels[0] ?? "";
  if (labels.length === 2) return labels.join(" and ");
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

type Entry =
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "work"; id: string; entry: WorkEntry };

function entries(turn: Turn): Entry[] {
  return turn.items.flatMap((item): Entry[] => {
    if (item.kind === "assistant")
      return [
        {
          kind: "assistant",
          id: item.id,
          text: item.text,
          streaming: !item.complete,
        },
      ];
    if (item.kind === "other" && item.label === "Reasoning")
      return item.text
        ? [{ kind: "reasoning", id: item.id, text: item.text }]
        : [];
    const work = workEntry(item);
    return work ? [{ kind: "work", id: item.id, entry: work }] : [];
  });
}

const settled = new Set(["completed", "interrupted", "failed", "lost"]);

function isRunning(turn: Turn): boolean {
  if (turn.delivery.kind === "not_sent") return false;
  return !settled.has(turn.execution.kind);
}

function pushVisible(
  rows: TimelineRow[],
  visible: Entry[],
  expandedGroups: ReadonlySet<string>,
  at: number | null,
  terminalId: string | null,
  meta: boolean,
) {
  let run: WorkEntry[] = [];
  const flush = () => {
    const settledRun = run.filter((entry) => !entry.running);
    const live = run.filter((entry) => entry.running).at(-1);
    if (settledRun.length === 1) {
      const [entry] = settledRun;
      if (entry) rows.push({ kind: "work", id: entry.id, entry, at });
    } else if (settledRun.length > 1) {
      const id = `group:${settledRun[0]?.id}`;
      rows.push({
        kind: "work-group",
        id,
        entries: settledRun,
        expanded: expandedGroups.has(id),
        at,
      });
    }
    if (live) rows.push({ kind: "live", id: `live:${live.id}`, entry: live });
    run = [];
  };
  for (const entry of visible) {
    if (entry.kind === "work") {
      run.push(entry.entry);
      continue;
    }
    flush();
    if (entry.kind === "assistant")
      rows.push({
        kind: "assistant",
        id: entry.id,
        text: entry.text,
        streaming: entry.streaming,
        meta: meta && entry.id === terminalId,
        at,
      });
    else rows.push({ kind: "reasoning", id: entry.id, text: entry.text });
  }
  flush();
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
    });
    const list = entries(turn);
    if (isRunning(turn)) {
      rows.push({
        kind: "working",
        id: `working:${turn.id}`,
        startedAtMs: turn.startedAtMs,
      });
      const pending = thread.approvals.filter(
        (approval) =>
          approval.turnId === turn.id && approval.state === "pending",
      );
      pushVisible(
        rows,
        pending.length > 0
          ? list.filter(
              (entry) => entry.kind !== "work" || !entry.entry.running,
            )
          : list,
        expandedGroups,
        null,
        null,
        false,
      );
      for (const approval of pending) {
        rows.push({
          kind: "live",
          id: `approval:${approval.id}`,
          entry: {
            id: approval.id,
            kind: "approval",
            label:
              approval.action.kind === "command"
                ? approval.action.command
                : "File change approval",
            detail: "",
            running: true,
            failed: false,
          },
        });
      }
    } else {
      const terminalIndex = list.findLastIndex(
        (entry) => entry.kind === "assistant" && !entry.streaming,
      );
      const terminal = terminalIndex >= 0 ? list[terminalIndex] : undefined;
      const boundary = terminalIndex >= 0 ? terminalIndex : list.length;
      const trailing = list.filter(
        (entry, index) => index > boundary && entry.kind !== "reasoning",
      );
      const hidden = new Set(
        list
          .filter((entry, index) => {
            if (entry === terminal) return false;
            if (index < boundary || entry.kind === "reasoning") return true;
            return (
              trailing.length === 1 &&
              entry.kind === "work" &&
              !entry.entry.failed
            );
          })
          .map((entry) => entry.id),
      );
      const foldable = list.some(
        (entry) => hidden.has(entry.id) && entry.kind !== "reasoning",
      );
      const at = turn.completedAtMs;
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
          expandedGroups,
          at,
          terminal?.id ?? null,
          true,
        );
      } else {
        pushVisible(rows, list, expandedGroups, at, terminal?.id ?? null, true);
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
