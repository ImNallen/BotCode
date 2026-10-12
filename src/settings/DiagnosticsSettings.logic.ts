// Ported from pingdotgg/t3code v0.0.45 components/settings/ResourceTelemetryDiagnostics.logic.ts and ResourceTelemetryDiagnostics.tsx (MIT).
import type { ProcessCategory, ProcessSample, ResourceSnapshot } from "../ipc";

export const HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 15_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 30_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 2 * 60_000 },
] as const;
export const DEFAULT_HISTORY_WINDOW = HISTORY_WINDOWS[1];

export function formatBytes(value: number): string {
  if (value < 1_024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let next = value;
  let unitIndex = -1;
  do {
    next /= 1_024;
    unitIndex += 1;
  } while (next >= 1_024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 100 ? 0 : next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

export function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

export function formatCpuTime(valueMs: number): string {
  const seconds = valueMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`;
  return `${(minutes / 60).toFixed(2)}h`;
}

export function formatDurationMicros(value: number): string {
  if (value < 1_000) return `${Math.round(value)} µs`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(2)} ms`;
  return `${(value / 1_000_000).toFixed(2)} s`;
}

export function formatSampleInterval(valueMs: number): string {
  if (valueMs < 1_000) return `${Math.max(0, Math.round(valueMs))} ms`;
  const seconds = valueMs / 1_000;
  return `${seconds.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${
    seconds === 1 ? "second" : "seconds"
  }`;
}

export function processIdentityKey(process: {
  identity: ProcessSample["identity"];
}): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

export function formatProcessName(
  process: Pick<ProcessSample, "command" | "name">,
): string {
  if (process.name.trim()) return process.name;
  const firstToken = process.command.trim().split(/\s+/)[0] ?? process.command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  return (
    normalized.split(/[\\/]/).findLast((segment) => segment.length > 0) ??
    normalized
  );
}

const CATEGORY_LABELS: Record<ProcessCategory, string> = {
  app: "App",
  provider: "Provider",
  terminal: "Terminal",
  webview: "Webview",
  "backend-child": "Backend child",
};

export function categoryLabel(category: ProcessCategory): string {
  return CATEGORY_LABELS[category];
}

export function categoryDotClass(category: ProcessCategory): string {
  if (category === "webview") return "bg-info";
  if (category === "app") return "bg-violet-500";
  return "bg-success";
}

export function canSignalProcess(process: ProcessSample): boolean {
  return (
    process.category === "backend-child" ||
    process.category === "provider" ||
    process.category === "terminal"
  );
}

export function ioSemanticsLabel(
  semantics: ResourceSnapshot["ioSemantics"],
): string {
  return semantics === "storage" ? "Storage bytes" : "All I/O bytes";
}

export function visibleProcesses(
  processes: readonly ProcessSample[],
  collapsed: ReadonlySet<string>,
): readonly ProcessSample[] {
  const childrenByParent = new Map<number, ProcessSample[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process);
    childrenByParent.set(process.ppid, children);
  }

  const hidden = new Set<string>();
  const hideDescendants = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      const key = processIdentityKey(child);
      if (hidden.has(key)) continue;
      hidden.add(key);
      hideDescendants(child.identity.pid);
    }
  };
  for (const process of processes) {
    if (collapsed.has(processIdentityKey(process))) {
      hideDescendants(process.identity.pid);
    }
  }
  return processes.filter(
    (process) => !hidden.has(processIdentityKey(process)),
  );
}

export function resourceHistoryBarHeight(input: {
  readonly value: number;
  readonly max: number;
  readonly minimumVisiblePercent: number;
}): number {
  if (input.value <= 0) return 0;
  return Math.max(
    input.minimumVisiblePercent,
    (input.value / Math.max(1, input.max)) * 100,
  );
}

export function resourceHistoryCpuScaleMax(
  buckets: ReadonlyArray<{ readonly avgCpuPercent: number }>,
): number {
  return Math.max(1, ...buckets.map((bucket) => bucket.avgCpuPercent));
}
