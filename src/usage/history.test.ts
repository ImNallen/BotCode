import assert from "node:assert/strict";
import { it } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ipc, type UsageHistoryReport, type UsageTotals } from "../ipc";
import { UsageHistorySection } from "./UsageHistory";
import {
  formatCost,
  formatMetric,
  readUsagePreferences,
  saveUsagePreferences,
  sortedModels,
  totalTokens,
  usageHistoryQuery,
} from "./history";
import { usageHistoryReportSchema, usageHistoryRequestSchema } from "./schema";

const a: UsageTotals = {
  tokens: {
    uncachedInput: 2300,
    cachedInput: 700,
    cacheCreation: 0,
    output: 300,
    reasoning: 90,
  },
  estimatedCostUsd: 0.00735,
  records: 2,
  unpricedRecords: 0,
  unpricedTokens: 0,
  sessions: 1,
};
const b: UsageTotals = {
  tokens: {
    uncachedInput: 350,
    cachedInput: 100,
    cacheCreation: 50,
    output: 50,
    reasoning: 20,
  },
  estimatedCostUsd: 0.0013,
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  sessions: 1,
};
const unknown: UsageTotals = {
  tokens: {
    uncachedInput: 100,
    cachedInput: 0,
    cacheCreation: 0,
    output: 10,
    reasoning: 0,
  },
  estimatedCostUsd: 0,
  records: 1,
  unpricedRecords: 1,
  unpricedTokens: 110,
  sessions: 1,
};
const report: UsageHistoryReport = {
  generatedAtMs: Date.parse("2026-10-08T12:00:00Z"),
  timeZone: "Europe/Stockholm",
  startMs: Date.parse("2026-10-07T00:00:00Z"),
  endMs: Date.parse("2026-10-08T12:00:00Z"),
  totals: {
    tokens: {
      uncachedInput: 2750,
      cachedInput: 800,
      cacheCreation: 50,
      output: 360,
      reasoning: 110,
    },
    estimatedCostUsd: 0.00865,
    records: 4,
    unpricedRecords: 1,
    unpricedTokens: 110,
    sessions: 3,
  },
  buckets: [
    {
      startMs: Date.parse("2026-10-07T00:00:00Z"),
      endMs: Date.parse("2026-10-08T00:00:00Z"),
      totals: {
        ...a,
        tokens: {
          uncachedInput: 800,
          cachedInput: 200,
          cacheCreation: 0,
          output: 100,
          reasoning: 40,
        },
        estimatedCostUsd: 0.0025,
        records: 1,
      },
    },
    {
      startMs: Date.parse("2026-10-08T00:00:00Z"),
      endMs: Date.parse("2026-10-08T12:00:00Z"),
      totals: {
        tokens: {
          uncachedInput: 1950,
          cachedInput: 600,
          cacheCreation: 50,
          output: 260,
          reasoning: 70,
        },
        estimatedCostUsd: 0.00615,
        records: 3,
        unpricedRecords: 1,
        unpricedTokens: 110,
        sessions: 3,
      },
    },
  ],
  models: [
    { model: "model-b", totals: b },
    { model: "unknown", totals: unknown },
    { model: "model-a", totals: a },
  ],
  coverage: {
    home: "/isolated/codex",
    sources: [{ path: "/isolated/codex/sessions", status: "ok" }],
    scannedFiles: 3,
    reusedFiles: 0,
    skippedFiles: 0,
    malformedRecords: 0,
    suppressedDuplicates: 1,
    suppressedForkCopies: 2,
    earliestIncludedMs: Date.parse("2026-10-07T09:00:00Z"),
    latestIncludedMs: Date.parse("2026-10-08T09:02:00Z"),
    retainedRecords: 0,
    partial: false,
    messages: [],
    pricing: {
      status: "cached",
      version: `sha256:${"a".repeat(64)}`,
      source:
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      fetchedAtMs: Date.parse("2026-10-08T11:00:00Z"),
      knownModels: 2,
      message: null,
    },
  },
};
function render(
  metric: "tokens" | "cost",
  breakdown: "model" | "time" = "model",
  period: "sevenDays" | "past24Hours" = "sevenDays",
  data = report,
) {
  return renderToStaticMarkup(
    createElement(UsageHistorySection, {
      report: data,
      metric,
      period,
      breakdown,
      onBreakdownChange: () => {},
    }),
  );
}
it("switches token and cost projections with exact fixture values and accessible chart details", () => {
  assert.equal(totalTokens(report.totals.tokens), 3960);
  assert.equal(formatMetric(report.totals, "tokens"), "3,960");
  assert.equal(formatMetric(report.totals, "cost"), "$0.00865");
  const tokens = render("tokens");
  const cost = render("cost");
  assert.ok(tokens.includes(">3,960<"));
  assert.ok(cost.includes(">$0.00865<"));
  assert.ok(tokens.includes("2,860 tokens"));
  assert.ok(cost.includes("$0.00615 API estimate"));
  assert.ok(tokens.includes("110 tokens in 1 records (25%) are unpriced."));
  assert.ok(cost.includes("partial pricing"));
  assert.ok(cost.includes("Unavailable"));
  assert.ok(cost.includes("Reasoning (included in output)"));
  assert.ok(cost.includes("Cache creation"));
  assert.ok(cost.includes("API-equivalent USD estimates"));
  assert.ok(cost.includes("/isolated/codex"));
  assert.ok(cost.includes('aria-label="Daily API cost estimates"'));
  assert.ok(tokens.includes('aria-label="Daily processed tokens"'));
});
it("uses the selected metric to sort models and changes time breakdown resolution", () => {
  const changed = {
    ...report,
    models: [
      { model: "cheap", totals: { ...a, estimatedCostUsd: 0.001 } },
      { model: "expensive", totals: { ...b, estimatedCostUsd: 0.2 } },
    ],
  };
  assert.deepEqual(
    sortedModels(changed, "tokens").map((row) => row.model),
    ["cheap", "expensive"],
  );
  assert.deepEqual(
    sortedModels(changed, "cost").map((row) => row.model),
    ["expensive", "cheap"],
  );
  const daily = render("tokens", "time");
  const hourly = render("tokens", "time", "past24Hours");
  assert.ok(daily.includes(">Day<"));
  assert.ok(!daily.includes(">model-a<"));
  assert.ok(daily.includes(">2,860<"));
  assert.ok(hourly.includes(">Hour<"));
  assert.ok(hourly.includes("Hourly processed tokens"));
  assert.ok(hourly.includes("GMT+2"));
  assert.equal(formatCost(unknown), "Unavailable");
  assert.equal(
    formatCost({ ...unknown, records: 0, unpricedRecords: 0 }),
    "$0.00",
  );
});
it("preserves token history and warnings when rates or transcript coverage fail", () => {
  const data = {
    ...report,
    coverage: {
      ...report.coverage,
      partial: true,
      retainedRecords: 1,
      messages: ["Includes retained usage after source removal."],
      pricing: {
        ...report.coverage.pricing,
        status: "stale",
        message: "Could not refresh API rates. Offline.",
      },
    },
  } satisfies UsageHistoryReport;
  const html = render("tokens", "model", "sevenDays", data);
  assert.ok(html.includes(">3,960<"));
  assert.ok(html.includes("Partial coverage"));
  assert.ok(html.includes("Includes retained usage"));
  assert.ok(html.includes("Offline"));
});
it("starts in Limits and validates persisted metric, period and breakdown", async () => {
  const storage = {
    value: "",
    getItem() {
      return this.value;
    },
    async setItem(_key: string, value: string) {
      this.value = value;
    },
  };
  assert.deepEqual(readUsagePreferences(storage).preferences, {
    metric: "limits",
    period: "thirtyDays",
    breakdown: "model",
  });
  const selected = {
    metric: "tokens",
    period: "past24Hours",
    breakdown: "time",
  } satisfies Parameters<typeof saveUsagePreferences>[0];
  assert.equal(await saveUsagePreferences(selected, storage), undefined);
  assert.deepEqual(readUsagePreferences(storage).preferences, selected);
  storage.value = JSON.stringify({ ...selected, period: "allTime" });
  assert.equal(readUsagePreferences(storage).preferences.metric, "limits");
  const broken = {
    getItem() {
      throw new Error("Blocked");
    },
    async setItem() {
      throw new Error("Blocked");
    },
  };
  assert.ok(readUsagePreferences(broken).error?.includes("could not be read"));
  assert.ok(
    (await saveUsagePreferences(selected, broken))?.includes(
      "could not be saved",
    ),
  );
});
it("validates history IPC and queries each selected period separately, retaining a good report after failure", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { crypto: globalThis.crypto },
  });
  const calls: unknown[] = [];
  const client = new QueryClient();
  try {
    mockIPC((command, payload) => {
      assert.equal(command, "usage_history");
      calls.push(payload);
      return report;
    });
    for (const period of [
      "past24Hours",
      "sevenDays",
      "thirtyDays",
      "ninetyDays",
    ] satisfies Parameters<typeof usageHistoryQuery>[0][]) {
      const query = usageHistoryQuery(period, report.timeZone);
      const value = await client.fetchQuery(query);
      assert.equal(totalTokens(value.totals.tokens), 3960);
      assert.deepEqual(calls.at(-1), {
        request: { period, timeZone: report.timeZone, refresh: false },
      });
    }
    await ipc.usageHistory({
      period: "sevenDays",
      timeZone: report.timeZone,
      refresh: true,
    });
    assert.deepEqual(calls.at(-1), {
      request: {
        period: "sevenDays",
        timeZone: report.timeZone,
        refresh: true,
      },
    });
    mockIPC(() => {
      throw { code: "disk", message: "Unavailable" };
    });
    const query = usageHistoryQuery("sevenDays", report.timeZone);
    await client.invalidateQueries({
      queryKey: query.queryKey,
      refetchType: "none",
    });
    await assert.rejects(client.fetchQuery(query), /Unavailable/);
    assert.equal(
      client.getQueryData(query.queryKey)?.totals.tokens.cachedInput,
      800,
    );
    mockIPC(() => ({
      ...report,
      totals: { ...report.totals, unpricedRecords: -1 },
    }));
    await assert.rejects(
      ipc.usageHistory({
        period: "sevenDays",
        timeZone: report.timeZone,
        refresh: false,
      }),
      /unpricedRecords/,
    );
  } finally {
    client.clear();
    clearMocks();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
  assert.equal(
    usageHistoryReportSchema.safeParse({ ...report, unexpected: true }).success,
    false,
  );
  assert.equal(
    usageHistoryRequestSchema.safeParse({
      period: "allTime",
      timeZone: "UTC",
      refresh: false,
    }).success,
    false,
  );
  assert.equal(
    usageHistoryRequestSchema.safeParse({
      period: "sevenDays",
      timeZone: "unknown",
      refresh: false,
    }).success,
    false,
  );
});
