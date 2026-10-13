// Ported from pingdotgg/t3code v0.0.45 components/settings/ResourceTelemetryDiagnostics.tsx, ProcessSignalActions.tsx and DiagnosticsSettings.tsx (MIT).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  ActivityIcon,
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CpuIcon,
  DatabaseIcon,
  FolderOpenIcon,
  GaugeIcon,
  HardDriveIcon,
  MemoryStickIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ipc,
  resourceSnapshot,
  type ProcessSample,
  type ProcessSignal,
  type ResourceAggregate,
  type ResourceHistory,
  type ResourceSnapshot,
  type WorkspaceView,
} from "../ipc";
import { cn } from "../lib/cn";
import { notifyEditorResult } from "../lib/editorActions";
import { formatRelativeTimeLabel } from "../lib/time";
import { isWindowsPlatform } from "../lib/utils";
import { RefreshIcon } from "../panel/chrome";
import { Button, inlineButton, Toggle } from "../ui/controls";
import { ScrollArea } from "../ui/scrollArea";
import { Tooltip } from "../ui/tooltip";
import {
  DEFAULT_HISTORY_WINDOW,
  HISTORY_WINDOWS,
  canSignalProcess,
  categoryDotClass,
  categoryLabel,
  formatBytes,
  formatCpuTime,
  formatDurationMicros,
  formatProcessName,
  formatRate,
  formatSampleInterval,
  ioSemanticsLabel,
  processIdentityKey,
  resourceHistoryBarHeight,
  resourceHistoryCpuScaleMax,
  visibleProcesses,
} from "./DiagnosticsSettings.logic";
import { SettingsGroup } from "./settingsLayout";

const SIGNAL_NAMES: Record<ProcessSignal, string> = {
  interrupt: "SIGINT",
  kill: "SIGKILL",
};
const windows = isWindowsPlatform(navigator.platform);

const failure = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function useResourceTelemetry() {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const accept = useCallback((next: ResourceSnapshot) => {
    setSnapshot((current) =>
      current && current.readAtMs > next.readAtMs ? current : next,
    );
    setError(null);
  }, []);
  const refresh = useCallback(() => {
    setIsPending(true);
    ipc
      .resourceSnapshot()
      .then(accept, (cause: unknown) => setError(failure(cause)))
      .finally(() => setIsPending(false));
  }, [accept]);
  useEffect(() => {
    let disposed = false;
    let subscription: number | undefined;
    let unlisten: (() => void) | undefined;
    listen<unknown>("l1code:resource-telemetry", (event) => {
      const parsed = resourceSnapshot.safeParse(event.payload);
      if (parsed.success) accept(parsed.data);
    }).then(
      (off) => (disposed ? off() : (unlisten = off)),
      (cause: unknown) => setError(failure(cause)),
    );
    ipc.resourceSubscribe().then(
      (id) =>
        disposed
          ? void ipc.resourceUnsubscribe(id).catch(() => undefined)
          : (subscription = id),
      (cause: unknown) => setError(failure(cause)),
    );
    refresh();
    return () => {
      disposed = true;
      unlisten?.();
      if (subscription !== undefined)
        void ipc.resourceUnsubscribe(subscription).catch(() => undefined);
    };
  }, [accept, refresh]);
  return { snapshot, error, isPending, refresh };
}

function useNow(intervalMs = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function SourceStatusBadge({
  label,
  status,
}: {
  label: string;
  status: ResourceSnapshot["health"]["status"];
}) {
  const tone = status === "healthy" ? "default" : "warning";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-3xs font-semibold uppercase tracking-widest",
        tone === "default" &&
          "border-success/25 bg-success/10 text-success-foreground",
        tone === "warning" &&
          "border-warning/30 bg-warning/10 text-warning-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "default" && "bg-success",
          tone === "warning" && "bg-warning",
        )}
      />
      {label ? `${label} ${status}` : status}
    </span>
  );
}

function LastSampleLabel({ sampledAtMs }: { sampledAtMs: number | null }) {
  const now = useNow();
  if (sampledAtMs === null) {
    return (
      <span className="text-2xs text-muted-foreground/55">
        Waiting for sample
      </span>
    );
  }
  const label = formatRelativeTimeLabel(
    new Date(sampledAtMs).toISOString(),
    now,
  );
  const value = label.replace(/ ago$/, "");
  return (
    <span className="text-2xs text-muted-foreground/60">
      Updated <span className="font-mono tabular-nums">{value}</span>
      {value === label ? "" : " ago"}
    </span>
  );
}

function IconStat({
  icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string | undefined;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="group min-w-0 px-4 py-4 sm:px-5">
      <div className="flex items-center gap-2 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
        <span className="text-muted-foreground/55 transition-colors group-hover:text-foreground/65">
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div
        className={cn(
          "mt-2.5 truncate font-mono text-2xl font-semibold tracking-tighter tabular-nums text-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "danger" && "text-destructive",
        )}
      >
        {value}
      </div>
      {detail ? (
        <div className="mt-1.5 truncate text-3xs text-muted-foreground/60">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function AggregateCard({
  label,
  accentClass,
  aggregate,
}: {
  label: string;
  accentClass: string;
  aggregate: ResourceAggregate;
}) {
  return (
    <div className="relative overflow-hidden border-t border-border/60 px-4 py-4 first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0 sm:px-5">
      <span
        className={cn(
          "absolute inset-x-5 top-0 h-0.5 rounded-full opacity-75",
          accentClass,
        )}
      />
      <div className="flex items-center justify-between gap-3">
        <div className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground/75">
          {label}
        </div>
        <div className="rounded-md bg-muted/55 px-1.5 py-0.5 font-mono text-3xs tabular-nums text-muted-foreground/70">
          {aggregate.processCount}{" "}
          {aggregate.processCount === 1 ? "process" : "processes"}
        </div>
      </div>
      <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
        <MetricPair
          label="CPU"
          value={`${aggregate.currentCpuPercent.toFixed(1)}%`}
        />
        <MetricPair
          label="Memory"
          value={formatBytes(aggregate.currentRssBytes)}
        />
        <MetricPair
          label="Read"
          value={formatRate(aggregate.ioReadBytesPerSecond)}
        />
        <MetricPair
          label="Write"
          value={formatRate(aggregate.ioWriteBytesPerSecond)}
        />
      </div>
    </div>
  );
}

function MetricPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground/45">
        {label}
      </div>
      <div className="truncate font-mono text-xs font-medium tabular-nums text-foreground/90">
        {value}
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string | undefined;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/50 py-2.5 first:border-t-0">
      <span className="text-2xs text-muted-foreground/75">{label}</span>
      <span
        className={cn(
          "min-w-0 truncate text-right font-mono text-2xs tabular-nums text-foreground/85",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}

function HistoryWindowSelector({
  selectedWindowMs,
  onSelect,
}: {
  selectedWindowMs: number;
  onSelect: (windowMs: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Resource history period"
      data-slot="toggle-group"
      data-variant="segmented"
      className="flex gap-0.5 rounded-lg bg-input/40 p-0.5"
    >
      {HISTORY_WINDOWS.map((option) => (
        <Toggle
          key={option.windowMs}
          variant="segmented"
          size="segmented"
          pressed={option.windowMs === selectedWindowMs}
          onClick={() => onSelect(option.windowMs)}
        >
          {option.label}
        </Toggle>
      ))}
    </div>
  );
}

function ResourceHistoryChart({
  buckets,
}: {
  buckets: ResourceHistory["buckets"];
}) {
  const maxCpu = resourceHistoryCpuScaleMax(buckets);
  const maxIo = Math.max(
    1,
    ...buckets.map((bucket) => bucket.ioReadBytes + bucket.ioWriteBytes),
  );
  return (
    <div className="border-t border-border/60 px-4 py-4 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-3xs text-muted-foreground/65">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-foreground/70" /> CPU
          average
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-info/70" /> I/O reads
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-warning/80" /> I/O writes
        </span>
      </div>
      <div className="flex h-32 items-end gap-1 overflow-hidden rounded-lg border border-border/40 bg-muted/8 px-2 pt-3 pb-2">
        {buckets.map((bucket) => {
          const cpuHeight = resourceHistoryBarHeight({
            value: bucket.avgCpuPercent,
            max: maxCpu,
            minimumVisiblePercent: 2,
          });
          const readHeight = resourceHistoryBarHeight({
            value: bucket.ioReadBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });
          const writeHeight = resourceHistoryBarHeight({
            value: bucket.ioWriteBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });
          return (
            <Tooltip
              key={bucket.startedAtMs}
              content={`CPU avg ${bucket.avgCpuPercent.toFixed(1)}% · CPU peak ${bucket.maxCpuPercent.toFixed(1)}% · Read ${formatBytes(bucket.ioReadBytes)} · Write ${formatBytes(bucket.ioWriteBytes)}`}
            >
              <div className="grid h-full min-w-1 flex-1 grid-cols-3 items-end gap-px">
                <span
                  className="block rounded-t-sm bg-foreground/65"
                  style={{ height: `${cpuHeight}%` }}
                />
                <span
                  className="block rounded-t-sm bg-info/70"
                  style={{ height: `${readHeight}%` }}
                />
                <span
                  className="block rounded-t-sm bg-warning/80"
                  style={{ height: `${writeHeight}%` }}
                />
              </div>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function ProcessTreeName({
  process,
  threadTitle,
  collapsed,
  onToggle,
}: {
  process: ProcessSample;
  threadTitle: string | undefined;
  collapsed: boolean;
  onToggle: (process: ProcessSample) => void;
}) {
  const name = formatProcessName(process);
  const ChevronIcon = collapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 7) * 10}px` }}
    >
      {process.childPids.length > 0 ? (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={() => onToggle(process)}
          aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
        >
          <ChevronIcon className="size-3.5" />
        </Button>
      ) : (
        <span className="size-5" aria-hidden />
      )}
      <span
        className={cn(
          "size-1.5 rounded-full",
          categoryDotClass(process.category),
        )}
      />
      <Tooltip content={process.command || process.name}>
        <span className="min-w-0 truncate font-medium text-foreground">
          {name}
          {threadTitle ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {threadTitle}
            </span>
          ) : null}
        </span>
      </Tooltip>
    </div>
  );
}

function ProcessSignalActions({
  disabled,
  onSignal,
}: {
  disabled: boolean;
  onSignal: (signal: ProcessSignal) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      {windows ? null : (
        <Tooltip content="Send SIGINT">
          <button
            type="button"
            data-slot="inline-button"
            className={inlineButton({ tone: "muted" })}
            disabled={disabled}
            aria-label="Send SIGINT"
            onClick={() => onSignal("interrupt")}
          >
            INT
          </button>
        </Tooltip>
      )}
      <Tooltip content="Send SIGKILL">
        <button
          type="button"
          data-slot="inline-button"
          className={inlineButton({ tone: "destructive" })}
          disabled={disabled}
          aria-label="Send SIGKILL"
          onClick={() => onSignal("kill")}
        >
          KILL
        </button>
      </Tooltip>
    </div>
  );
}

function ProcessTable({
  snapshot,
  signalingKeys,
  onSignal,
}: {
  snapshot: ResourceSnapshot | null;
  signalingKeys: ReadonlySet<string>;
  onSignal: (process: ProcessSample, signal: ProcessSignal) => void;
}) {
  const client = useQueryClient();
  const processes = snapshot?.processes;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const visible = useMemo(
    () => visibleProcesses(processes ?? [], collapsed),
    [collapsed, processes],
  );
  const toggle = useCallback((process: ProcessSample) => {
    const key = processIdentityKey(process);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const threadTitle = (threadId: string | null) => {
    if (threadId === null) return undefined;
    for (const [, view] of client.getQueriesData<WorkspaceView>({
      queryKey: ["workspace"],
    })) {
      const thread = view?.threads.find((entry) => entry.id === threadId);
      if (thread) return thread.title;
    }
    return undefined;
  };

  return (
    <div className="border-t border-border/60">
      <ScrollArea
        scrollFade
        className="max-h-[min(68vh,48rem)] w-full max-w-full"
      >
        <table className="w-full min-w-[1320px] table-fixed text-left text-xs">
          <colgroup>
            <col className="w-[20%]" />
            <col className="w-[10%]" />
            <col className="w-[7%]" />
            <col className="w-[8%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[9%]" />
            <col className="w-[10%]" />
            <col className="w-[8%]" />
            <col className="w-[6%]" />
            <col className="w-[4%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-3xs uppercase tracking-widest text-muted-foreground/65">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
              <th className="px-3 py-2 font-semibold">Category</th>
              <th className="px-3 py-2 text-right font-semibold">CPU</th>
              <th className="px-3 py-2 text-right font-semibold">CPU Time</th>
              <th className="px-3 py-2 text-right font-semibold">Memory</th>
              <th className="px-3 py-2 text-right font-semibold">Read/s</th>
              <th className="px-3 py-2 text-right font-semibold">Write/s</th>
              <th className="px-3 py-2 text-right font-semibold">Read Total</th>
              <th className="px-3 py-2 text-right font-semibold">
                Write Total
              </th>
              <th className="px-3 py-2 text-right font-semibold">PID</th>
              <th className="px-2 py-2 text-right font-semibold sm:pr-4">
                Kill
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={11}
                  className="px-4 py-5 text-xs text-muted-foreground sm:px-5"
                >
                  Waiting for the native process monitor.
                </td>
              </tr>
            ) : null}
            {visible.map((process) => (
              <tr
                key={processIdentityKey(process)}
                className="hover:bg-muted/20"
              >
                <td className="px-4 py-2 sm:pl-5">
                  <ProcessTreeName
                    process={process}
                    threadTitle={threadTitle(process.threadId)}
                    collapsed={collapsed.has(processIdentityKey(process))}
                    onToggle={toggle}
                  />
                </td>
                <td className="truncate px-3 py-2 text-2xs text-muted-foreground">
                  {categoryLabel(process.category)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {process.cpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatCpuTime(process.cpuTimeMs)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatBytes(process.residentBytes)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-info-foreground">
                  {formatRate(process.ioReadBytesPerSecond)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-warning-foreground">
                  {formatRate(process.ioWriteBytesPerSecond)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {formatBytes(process.ioReadBytes)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  <Tooltip
                    content={
                      snapshot ? ioSemanticsLabel(snapshot.ioSemantics) : ""
                    }
                  >
                    <span>{formatBytes(process.ioWriteBytes)}</span>
                  </Tooltip>
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {process.identity.pid}
                </td>
                <td className="px-2 py-2 text-right sm:pr-4">
                  {canSignalProcess(process) ? (
                    <ProcessSignalActions
                      disabled={signalingKeys.has(processIdentityKey(process))}
                      onSignal={(signal) => onSignal(process, signal)}
                    />
                  ) : (
                    <span className="text-3xs text-muted-foreground/35">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

function HistoryProcessTable({
  processes,
}: {
  processes: ResourceHistory["topProcesses"];
}) {
  return (
    <div className="border-t border-border/60">
      <ScrollArea scrollFade className="max-h-[28rem] w-full max-w-full">
        <table className="w-full min-w-[1020px] table-fixed text-left text-xs">
          <colgroup>
            <col className="w-[24%]" />
            <col className="w-[11%]" />
            <col className="w-[10%]" />
            <col className="w-[10%]" />
            <col className="w-[11%]" />
            <col className="w-[11%]" />
            <col className="w-[11%]" />
            <col className="w-[7%]" />
            <col className="w-[5%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-3xs uppercase tracking-widest text-muted-foreground/65">
            <tr>
              <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
              <th className="px-3 py-2 font-semibold">Category</th>
              <th className="px-3 py-2 text-right font-semibold">CPU Time</th>
              <th className="px-3 py-2 text-right font-semibold">Peak CPU</th>
              <th className="px-3 py-2 text-right font-semibold">Peak Mem</th>
              <th className="px-3 py-2 text-right font-semibold">Read</th>
              <th className="px-3 py-2 text-right font-semibold">Write</th>
              <th className="px-3 py-2 text-right font-semibold">Samples</th>
              <th className="px-3 py-2 text-right font-semibold sm:pr-5">
                PID
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {processes.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-5 text-xs text-muted-foreground sm:px-5"
                >
                  No retained process samples in this window.
                </td>
              </tr>
            ) : null}
            {processes.map((process) => (
              <tr
                key={processIdentityKey(process)}
                className="hover:bg-muted/20"
              >
                <td className="px-4 py-2 sm:pl-5">
                  <Tooltip content={process.command || process.name}>
                    <span className="block truncate font-medium text-foreground">
                      {process.name || process.command}
                    </span>
                  </Tooltip>
                </td>
                <td className="truncate px-3 py-2 text-2xs text-muted-foreground">
                  {categoryLabel(process.category)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatCpuTime(process.cpuTimeMs)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {process.maxCpuPercent.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">
                  {formatBytes(process.peakRssBytes)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-info-foreground">
                  {formatBytes(process.ioReadBytes)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-warning-foreground">
                  {formatBytes(process.ioWriteBytes)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {process.sampleCount}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground sm:pr-5">
                  {process.identity.pid}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

function ErrorStrip({ error, edge }: { error: string; edge: "t" | "b" }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive sm:px-5",
        edge === "t" ? "border-t" : "border-b",
      )}
    >
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
      <span>{error}</span>
    </div>
  );
}

export function DiagnosticsSettings() {
  const telemetry = useResourceTelemetry();
  const snapshot = telemetry.snapshot;
  const all = snapshot?.groups.all;
  const [windowMs, setWindowMs] = useState<number>(
    DEFAULT_HISTORY_WINDOW.windowMs,
  );
  const selectedWindow =
    HISTORY_WINDOWS.find((option) => option.windowMs === windowMs) ??
    DEFAULT_HISTORY_WINDOW;
  const history = useQuery({
    queryKey: ["resource-history", selectedWindow.windowMs],
    queryFn: () =>
      ipc.resourceHistory(selectedWindow.windowMs, selectedWindow.bucketMs),
    refetchInterval: selectedWindow.bucketMs,
  });
  const [signalingKeys, setSignalingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const signalingKeysRef = useRef<ReadonlySet<string>>(new Set());
  const hasWebview = (snapshot?.groups.webview.processCount ?? 0) > 0;

  const signalProcess = useCallback(
    async (process: ProcessSample, signal: ProcessSignal) => {
      const key = processIdentityKey(process);
      if (signalingKeysRef.current.has(key)) return;
      const setKeys = (next: ReadonlySet<string>) => {
        signalingKeysRef.current = next;
        setSignalingKeys(next);
      };
      setKeys(new Set(signalingKeysRef.current).add(key));
      const name = SIGNAL_NAMES[signal];
      try {
        if (
          signal === "kill" &&
          !(await confirm(
            `Send SIGKILL to process ${process.identity.pid}? This cannot be handled by the process.`,
            { title: "Send SIGKILL", kind: "warning" },
          ))
        )
          return;
        const result = await ipc.signalProcess(process.identity, signal);
        if (!result.signaled)
          notifyEditorResult(
            "error",
            `Could not send ${name}`,
            result.message ??
              `Failed to send ${name} to process ${process.identity.pid}.`,
          );
      } catch (error) {
        notifyEditorResult(
          "error",
          `Could not send ${name}`,
          error instanceof Error ? error.message : `Failed to send ${name}.`,
        );
      } finally {
        const next = new Set(signalingKeysRef.current);
        next.delete(key);
        setKeys(next);
      }
    },
    [],
  );

  const openLogsFolder = () => {
    ipc
      .revealInFinder({ kind: "logs" })
      .catch((error: unknown) =>
        notifyEditorResult(
          "error",
          "Unable to open logs folder.",
          failure(error),
        ),
      );
  };

  return (
    <>
      <SettingsGroup
        id="resource-monitor"
        title="Resource monitor"
        icon={<ActivityIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <div className="flex min-h-7 min-w-7 items-center justify-end gap-2">
            {snapshot ? (
              <SourceStatusBadge
                label="Native"
                status={snapshot.health.status}
              />
            ) : null}
            <LastSampleLabel sampledAtMs={snapshot?.readAtMs ?? null} />
            <Tooltip content="Open logs folder">
              <Button
                size="icon-xs"
                variant="ghost-muted"
                onClick={openLogsFolder}
                aria-label="Open logs folder"
              >
                <FolderOpenIcon />
              </Button>
            </Tooltip>
            <Tooltip content="Refresh telemetry snapshot">
              <Button
                size="icon-micro"
                variant="ghost"
                disabled={telemetry.isPending}
                onClick={telemetry.refresh}
                aria-label="Refresh resource telemetry"
              >
                <RefreshIcon refreshing={telemetry.isPending} />
              </Button>
            </Tooltip>
          </div>
        }
      >
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm/5">
          <div className="flex flex-col gap-3 border-b border-border/60 bg-linear-to-r from-muted/45 via-muted/20 to-transparent px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div>
              <div className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
                L1 Code system footprint
              </div>
              <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                Live native counters for the app, Codex, terminals, and their
                child processes.
              </p>
            </div>
            <div className="flex items-center gap-2 text-3xs text-muted-foreground/65">
              <span className="size-1.5 rounded-full bg-success" />
              Sampling every{" "}
              {snapshot
                ? formatSampleInterval(snapshot.sampleIntervalMs)
                : "..."}
            </div>
          </div>
          <div className="grid grid-cols-2 divide-x divide-y divide-border/55 md:grid-cols-3">
            <IconStat
              icon={<CpuIcon className="size-3.5" />}
              label="Current CPU"
              value={all ? `${all.currentCpuPercent.toFixed(1)}%` : "..."}
              detail={
                all
                  ? `${formatCpuTime(all.cpuTimeMs)} observed CPU time`
                  : undefined
              }
            />
            <IconStat
              icon={<MemoryStickIcon className="size-3.5" />}
              label="Resident memory"
              value={all ? formatBytes(all.currentRssBytes) : "..."}
              detail={
                all
                  ? `${formatBytes(all.peakRssBytes)} combined process peaks`
                  : undefined
              }
            />
            <IconStat
              icon={<ActivityIcon className="size-3.5" />}
              label="Process count"
              value={all ? String(all.processCount) : "..."}
              detail={
                all
                  ? `${all.processStarts} starts · ${all.processExits} exits`
                  : undefined
              }
            />
            <IconStat
              icon={<HardDriveIcon className="size-3.5" />}
              label="Read throughput"
              value={all ? formatRate(all.ioReadBytesPerSecond) : "..."}
              detail={
                all ? `${formatBytes(all.ioReadBytes)} observed` : undefined
              }
            />
            <IconStat
              icon={<DatabaseIcon className="size-3.5" />}
              label="Write throughput"
              value={all ? formatRate(all.ioWriteBytesPerSecond) : "..."}
              detail={
                all ? `${formatBytes(all.ioWriteBytes)} observed` : undefined
              }
              tone={
                all && all.ioWriteBytesPerSecond >= 10 * 1_024 * 1_024
                  ? "danger"
                  : all && all.ioWriteBytesPerSecond >= 1_024 * 1_024
                    ? "warning"
                    : "default"
              }
            />
          </div>
          {telemetry.error ? (
            <ErrorStrip error={telemetry.error} edge="t" />
          ) : null}
          {snapshot ? (
            <div
              className={cn(
                "grid border-t border-border/60 bg-muted/10",
                hasWebview && "md:grid-cols-2",
              )}
            >
              <AggregateCard
                label="Backend + agents"
                accentClass="bg-success/80"
                aggregate={snapshot.groups.backend}
              />
              {hasWebview ? (
                <AggregateCard
                  label="Desktop"
                  accentClass="bg-info/80"
                  aggregate={snapshot.groups.webview}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup
        id="collection-health"
        title="Host & collection"
        icon={<GaugeIcon className="size-4 text-muted-foreground" />}
      >
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5">
          <div className="px-4 py-4 sm:px-5">
            <div className="mb-3 flex items-center gap-2 text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
              <span className="flex size-6 items-center justify-center rounded-md bg-muted/60">
                <GaugeIcon className="size-3.5" />
              </span>
              Collection health
            </div>
            {snapshot ? (
              <>
                <div className="flex items-start justify-between gap-4 border-t border-border/50 py-3 first:border-t-0">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">
                      Native process monitor
                    </div>
                    <div className="mt-1 text-2xs leading-relaxed text-muted-foreground/65">
                      {snapshot.health.lastError ?? "No reported errors"}
                    </div>
                  </div>
                  <SourceStatusBadge label="" status={snapshot.health.status} />
                </div>
                <DetailRow
                  label="Collection time"
                  value={formatDurationMicros(snapshot.health.collectionMicros)}
                />
                <DetailRow
                  label="Process scan"
                  value={`${snapshot.health.retainedProcessCount}/${snapshot.health.scannedProcessCount} retained`}
                />
                <DetailRow
                  label="Inaccessible"
                  value={String(snapshot.health.inaccessibleProcessCount)}
                  valueClassName={
                    snapshot.health.inaccessibleProcessCount > 0
                      ? "text-warning-foreground"
                      : undefined
                  }
                />
              </>
            ) : (
              <div className="py-4 text-xs text-muted-foreground">
                Waiting for collector health.
              </div>
            )}
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup
        id="resource-timeline"
        title="Resource timeline"
        icon={<HardDriveIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <div className="flex min-h-7 min-w-7 items-center justify-end gap-2">
            <HistoryWindowSelector
              selectedWindowMs={selectedWindow.windowMs}
              onSelect={setWindowMs}
            />
            <Button
              size="icon-micro"
              variant="ghost"
              disabled={history.isFetching}
              onClick={() => void history.refetch()}
              aria-label="Refresh resource history"
            >
              <RefreshIcon refreshing={history.isFetching} />
            </Button>
          </div>
        }
      >
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5">
          {history.error ? (
            <ErrorStrip error={failure(history.error)} edge="b" />
          ) : null}
          <ResourceHistoryChart buckets={history.data?.buckets ?? []} />
          <HistoryProcessTable processes={history.data?.topProcesses ?? []} />
        </div>
      </SettingsGroup>

      <SettingsGroup
        id="live-process-tree"
        title="Live process tree"
        icon={<CpuIcon className="size-4 text-muted-foreground" />}
        headerAction={
          snapshot ? (
            <div className="flex min-h-7 min-w-7 items-center justify-end">
              <span className="text-3xs text-muted-foreground/55">
                Identity: <span className="font-mono">PID + start time</span>
              </span>
            </div>
          ) : null
        }
      >
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5">
          <ProcessTable
            snapshot={snapshot}
            signalingKeys={signalingKeys}
            onSignal={(process, signal) => void signalProcess(process, signal)}
          />
        </div>
      </SettingsGroup>
    </>
  );
}
