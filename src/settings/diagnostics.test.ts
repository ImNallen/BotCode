import assert from "node:assert/strict";
import { it } from "node:test";
import { resourceHistory, resourceSnapshot, type ProcessSample } from "../ipc";
import {
  formatBytes,
  formatCpuTime,
  formatDurationMicros,
  formatRate,
  formatSampleInterval,
  resourceHistoryBarHeight,
  resourceHistoryCpuScaleMax,
  visibleProcesses,
} from "./DiagnosticsSettings.logic";
import { defaults } from "./preferences";
import {
  categories,
  settingsSection,
  visibleRows,
  visibleSections,
} from "./settingsCatalog";

const aggregate = {
  processCount: 1,
  currentCpuPercent: 107.6923076923077,
  cpuTimeMs: 14,
  currentRssBytes: 15630336,
  peakRssBytes: 15630336,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  ioReadBytesPerSecond: 0.0,
  ioWriteBytesPerSecond: 0.0,
  processStarts: 1,
  processExits: 0,
};
const rustSnapshot = {
  readAtMs: 1791799067485,
  sampleIntervalMs: 5000,
  ioSemantics: "storage",
  processes: [
    {
      identity: { pid: 55232, startTimeMs: 1791799066000 },
      ppid: 54926,
      depth: 0,
      name: "l1_core-bea660d399127f90",
      command: "target/debug/deps/l1_core-bea660d399127f90 --nocapture",
      category: "app",
      threadId: "0b15bf10-0bcd-462e-92b2-e51149153fd1",
      cpuPercent: 107.6923076923077,
      cpuTimeMs: 46,
      residentBytes: 15630336,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      ioReadBytesPerSecond: 0.0,
      ioWriteBytesPerSecond: 0.0,
      childPids: [],
    },
  ],
  groups: {
    all: aggregate,
    backend: aggregate,
    webview: { ...aggregate, processCount: 0, processStarts: 0 },
  },
  health: {
    status: "healthy",
    lastError: null,
    collectionMicros: 12740,
    scannedProcessCount: 1195,
    retainedProcessCount: 1,
    inaccessibleProcessCount: 0,
  },
};
const rustHistory = {
  readAtMs: 1791799067486,
  windowMs: 300000,
  bucketMs: 15000,
  buckets: [
    {
      startedAtMs: 1791798767486,
      avgCpuPercent: 0.0,
      maxCpuPercent: 0.0,
      maxRssBytes: 0,
      ioReadBytes: 0,
      ioWriteBytes: 0,
    },
  ],
  topProcesses: [
    {
      identity: { pid: 55232, startTimeMs: 1791799066000 },
      name: "l1_core",
      command: "l1_core",
      category: "backend-child",
      cpuTimeMs: 14,
      maxCpuPercent: 107.7,
      peakRssBytes: 15630336,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      sampleCount: 2,
    },
  ],
};

function process(pid: number, ppid: number): ProcessSample {
  return {
    ...resourceSnapshot.parse(rustSnapshot).processes[0]!,
    identity: { pid, startTimeMs: pid * 10 },
    ppid,
  };
}

it("collapsing a process hides exactly its descendants", () => {
  const rows = [
    process(1, 0),
    process(2, 1),
    process(3, 2),
    process(4, 3),
    process(5, 1),
    process(6, 0),
  ];
  const pids = (collapsed: string[]) =>
    visibleProcesses(rows, new Set(collapsed)).map((row) => row.identity.pid);
  assert.deepEqual(pids([]), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(pids(["2:20"]), [1, 2, 5, 6]);
  assert.deepEqual(pids(["1:10"]), [1, 6]);
  assert.deepEqual(pids(["2:999"]), [1, 2, 3, 4, 5, 6]);
});

it("history bars hide zero, lift tiny values to the minimum, and floor the CPU scale at 1", () => {
  assert.equal(
    resourceHistoryBarHeight({ value: 0, max: 50, minimumVisiblePercent: 2 }),
    0,
  );
  assert.equal(
    resourceHistoryBarHeight({
      value: 0.01,
      max: 100,
      minimumVisiblePercent: 2,
    }),
    2,
  );
  assert.equal(
    resourceHistoryBarHeight({ value: 25, max: 50, minimumVisiblePercent: 2 }),
    50,
  );
  assert.equal(resourceHistoryCpuScaleMax([]), 1);
  assert.equal(resourceHistoryCpuScaleMax([{ avgCpuPercent: 0.25 }]), 1);
  assert.equal(
    resourceHistoryCpuScaleMax([{ avgCpuPercent: 5 }, { avgCpuPercent: 2 }]),
    5,
  );
  assert.equal(
    resourceHistoryBarHeight({
      value: 0.5,
      max: resourceHistoryCpuScaleMax([{ avgCpuPercent: 0.5 }]),
      minimumVisiblePercent: 2,
    }),
    50,
  );
});

it("formats bytes, rates, CPU time, collection time and the sampling interval like T3", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1_536), "1.50 KB");
  assert.equal(formatBytes(200 * 1_024), "200 KB");
  assert.equal(formatBytes(10 * 1_024 * 1_024), "10.0 MB");
  assert.equal(formatRate(2_048), "2.00 KB/s");
  assert.equal(formatCpuTime(1_500), "1.50s");
  assert.equal(formatCpuTime(12_000), "12.0s");
  assert.equal(formatCpuTime(90_000), "1.50m");
  assert.equal(formatCpuTime(7_200_000), "2.00h");
  assert.equal(formatDurationMicros(850), "850 µs");
  assert.equal(formatDurationMicros(12_740), "12.74 ms");
  assert.equal(formatDurationMicros(2_500_000), "2.50 s");
  assert.equal(formatSampleInterval(500), "500 ms");
  assert.equal(formatSampleInterval(1_000), "1 second");
  assert.equal(formatSampleInterval(5_000), "5 seconds");
});

it("parses Rust-shaped telemetry and rejects an unknown process category", () => {
  const snapshot = resourceSnapshot.parse(rustSnapshot);
  assert.equal(snapshot.processes[0]?.category, "app");
  assert.equal(snapshot.groups.webview.processCount, 0);
  assert.equal(snapshot.health.lastError, null);
  assert.equal(
    resourceHistory.parse(rustHistory).topProcesses[0]?.sampleCount,
    2,
  );
  const monitor = {
    ...rustSnapshot,
    processes: [{ ...rustSnapshot.processes[0], category: "resource-monitor" }],
  };
  assert.equal(resourceSnapshot.safeParse(monitor).success, false);
});

it("keeps Diagnostics out of the sidebar and reaches it from a searchable General row", () => {
  assert.equal(settingsSection.parse("diagnostics"), "diagnostics");
  for (const scope of [{ kind: "all" }, { kind: "unavailable" }] as const)
    assert.ok(!visibleSections(scope).includes("diagnostics"));
  assert.ok(visibleSections({ kind: "all" }).includes("general"));
  const group = categories.general.groups.at(-1);
  assert.equal(group?.title, "Diagnostics");
  const rows = group && visibleRows(group, { kind: "all" }, defaults);
  assert.deepEqual(
    rows?.map((row) => [row.id, row.title, row.description]),
    [
      [
        "diagnostics",
        "Diagnostics",
        "Inspect processes, resource use, and logs on this device.",
      ],
      [
        "open-source-licenses",
        "Open source licenses",
        "Notices for dependencies, assets, and code used by L1 Code.",
      ],
    ],
  );
  const searchText =
    `${categories.general.title} ${group?.title} ${rows?.[0]?.title} ${rows?.[0]?.description} ${rows?.[0]?.keywords}`.toLowerCase();
  for (const term of ["cpu", "memory", "processes", "logs"])
    assert.ok(searchText.includes(term), term);
});
