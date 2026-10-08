// Summary, totals and breakdown classes follow T3 Code v0.0.45 components/usage/UsagePage.tsx (MIT).
import { useState } from "react";
import type { UsageHistoryReport, UsagePeriod, UsageTotals } from "../ipc";
import { Toggle } from "../ui/controls";
import {
  formatCost,
  formatMetric,
  formatTokens,
  metricValue,
  periodLabel,
  sortedModels,
  totalTokens,
  unpricedLabel,
  type UsagePreferences,
} from "./history";

function PartialPrice({ totals }: { totals: UsageTotals }) {
  const label = unpricedLabel(totals);
  return label ? (
    <span className="text-xs text-muted-foreground" title={label}>
      {" "}
      · partial pricing<span className="sr-only">. {label}</span>
    </span>
  ) : null;
}
function UsageChart({
  report,
  period,
  metric,
}: {
  report: UsageHistoryReport;
  period: UsagePeriod;
  metric: "cost" | "tokens";
}) {
  const [selected, setSelected] = useState<number>();
  const peak = Math.max(
    1e-12,
    ...report.buckets.map((bucket) => metricValue(bucket.totals, metric)),
  );
  const detail = selected === undefined ? undefined : report.buckets[selected];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className="flex h-44 items-end gap-1 border-b border-border"
        role="group"
        aria-label={`${period === "past24Hours" ? "Hourly" : "Daily"} ${metric === "tokens" ? "processed tokens" : "API cost estimates"}`}
      >
        {report.buckets.map((bucket, index) => {
          const label = `${periodLabel(bucket.startMs, period, report.timeZone)}. ${formatMetric(bucket.totals, metric)}${metric === "tokens" ? " tokens" : " API estimate"}. ${formatTokens(totalTokens(bucket.totals.tokens))} processed tokens. ${unpricedLabel(bucket.totals) ?? "All records priced."}`;
          return (
            <button
              key={bucket.startMs}
              type="button"
              className="relative flex h-full min-w-0 flex-1 cursor-pointer items-end rounded-t-sm outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-muted/50"
              aria-label={label}
              title={label}
              onFocus={() => setSelected(index)}
              onMouseEnter={() => setSelected(index)}
              onClick={() => setSelected(index)}
            >
              <span
                className="w-full rounded-t-sm bg-foreground/65"
                style={{
                  height: `${Math.max(1, (metricValue(bucket.totals, metric) / peak) * 100)}%`,
                }}
              />
            </button>
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>
          {report.buckets[0]
            ? periodLabel(report.buckets[0].startMs, period, report.timeZone)
            : ""}
        </span>
        <span>
          {report.buckets.at(-1)
            ? periodLabel(
                report.buckets.at(-1)?.startMs ?? report.endMs,
                period,
                report.timeZone,
              )
            : ""}
        </span>
      </div>
      <p className="min-h-8 text-xs text-muted-foreground" aria-live="polite">
        {detail
          ? `${periodLabel(detail.startMs, period, report.timeZone)} · ${formatMetric(detail.totals, metric)}${metric === "tokens" ? " tokens" : " API estimate"}${detail.totals.unpricedRecords ? ` · ${unpricedLabel(detail.totals)}` : ""}`
          : "Focus or point to a bar to see its value."}
      </p>
    </div>
  );
}
export function UsageHistorySection({
  report,
  period,
  metric,
  breakdown,
  onBreakdownChange,
}: {
  report: UsageHistoryReport;
  period: UsagePeriod;
  metric: "cost" | "tokens";
  breakdown: UsagePreferences["breakdown"];
  onBreakdownChange: (value: UsagePreferences["breakdown"]) => void;
}) {
  const unpriced = unpricedLabel(report.totals);
  const rows =
    breakdown === "model"
      ? sortedModels(report, metric).map((row) => ({
          key: row.model,
          label: row.model,
          totals: row.totals,
        }))
      : [...report.buckets].reverse().map((bucket) => ({
          key: String(bucket.startMs),
          label: periodLabel(bucket.startMs, period, report.timeZone),
          totals: bucket.totals,
        }));
  const pricing = report.coverage.pricing;
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span className="text-4xl font-semibold text-foreground tabular-nums">
              {formatMetric(report.totals, metric)}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatTokens(report.totals.sessions)} sessions
              {metric === "cost" ? " · API estimate" : " · processed tokens"}
              {metric === "cost" && <PartialPrice totals={report.totals} />}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm text-foreground">Codex</span>
              <span className="text-sm font-medium tabular-nums">
                {formatMetric(report.totals, metric)}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {metric === "cost"
                ? `${formatTokens(totalTokens(report.totals.tokens))} processed tokens`
                : `${formatCost(report.totals)} API estimate`}
            </span>
          </div>
          {unpriced && (
            <p className="text-xs text-muted-foreground">
              {unpriced} Estimates include priced records only.
            </p>
          )}
          {report.totals.records === 0 && (
            <p className="text-sm text-muted-foreground">
              No activity in this window.
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm font-medium">
            {period === "past24Hours" ? "Hourly" : "Daily"}{" "}
            {metric === "tokens" ? "processed tokens" : "cost"}
          </h2>
          <UsageChart
            key={`${period}-${metric}`}
            report={report}
            period={period}
            metric={metric}
          />
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Totals</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-3">
          {[
            {
              label: "Processed tokens",
              value: totalTokens(report.totals.tokens),
            },
            { label: "Cached input", value: report.totals.tokens.cachedInput },
            {
              label: "Uncached input",
              value: report.totals.tokens.uncachedInput,
            },
            {
              label: "Cache creation",
              value: report.totals.tokens.cacheCreation,
            },
            { label: "Output", value: report.totals.tokens.output },
            {
              label: "Reasoning (included in output)",
              value: report.totals.tokens.reasoning,
            },
          ].map(({ label, value }) => (
            <div key={label} className="flex flex-col gap-1">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-sm font-medium tabular-nums">
                {formatTokens(value)}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Breakdown</h2>
          <div
            className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5"
            role="group"
            aria-label="Usage breakdown"
          >
            <Toggle
              size="sm"
              variant="segmented"
              pressed={breakdown === "model"}
              onClick={() => onBreakdownChange("model")}
            >
              Model
            </Toggle>
            <Toggle
              size="sm"
              variant="segmented"
              pressed={breakdown === "time"}
              onClick={() => onBreakdownChange("time")}
            >
              {period === "past24Hours" ? "Hour" : "Day"}
            </Toggle>
          </div>
        </div>
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-2/5" />
            <col className="w-1/5" />
            <col className="w-1/5" />
            <col className="w-1/5" />
          </colgroup>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 font-normal">
                {breakdown === "model"
                  ? "Model"
                  : period === "past24Hours"
                    ? "Hour"
                    : "Day"}
              </th>
              <th className="py-2 text-right font-normal">Cost</th>
              <th className="py-2 text-right font-normal">Share</th>
              <th className="py-2 text-right font-normal">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="py-6 text-center text-muted-foreground"
                >
                  No activity in this window.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-border/50 transition-colors hover:bg-muted/50"
                >
                  <td className="truncate py-2 pr-3" title={row.label}>
                    {row.label}
                  </td>
                  <td
                    className="py-2 text-right tabular-nums"
                    title={unpricedLabel(row.totals)}
                  >
                    {formatCost(row.totals)}
                    {row.totals.unpricedRecords > 0 &&
                    row.totals.unpricedRecords < row.totals.records
                      ? "*"
                      : ""}
                  </td>
                  <td className="py-2 text-right text-muted-foreground tabular-nums">
                    {metricValue(report.totals, metric) === 0
                      ? "0"
                      : (
                          (metricValue(row.totals, metric) /
                            metricValue(report.totals, metric)) *
                          100
                        ).toLocaleString("en-US", { maximumFractionDigits: 1 })}
                    %
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatTokens(totalTokens(row.totals.tokens))}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
      <section
        className="flex flex-col gap-2 text-xs text-muted-foreground"
        aria-label="Usage coverage"
      >
        <p>
          Local Codex transcripts ·{" "}
          {report.coverage.partial ? "Partial coverage" : "Transcript coverage"}{" "}
          · Refreshed{" "}
          {new Intl.DateTimeFormat("en-US", {
            timeZone: report.timeZone,
            dateStyle: "medium",
            timeStyle: "medium",
          }).format(report.generatedAtMs)}
        </p>
        <p className="break-all">Codex home {report.coverage.home}</p>
        <p>
          {report.coverage.scannedFiles} files scanned ·{" "}
          {report.coverage.reusedFiles} reused · {report.coverage.skippedFiles}{" "}
          skipped · {report.coverage.suppressedDuplicates} duplicate events
          suppressed · {report.coverage.suppressedForkCopies} fork copies
          suppressed
        </p>
        {report.coverage.sources.map((source) => (
          <p className="break-all" key={source.path}>
            {source.path} · {source.status}
          </p>
        ))}
        {report.coverage.messages.map((message) => (
          <p key={message}>{message}</p>
        ))}
        <p>
          API-equivalent USD estimates use{" "}
          <a
            className="underline underline-offset-2"
            href={pricing.source}
            target="_blank"
            rel="noreferrer"
          >
            LiteLLM published base rates
          </a>
          . Rates {pricing.status}
          {pricing.fetchedAtMs !== null
            ? ` · fetched ${new Intl.DateTimeFormat("en-US", { timeZone: report.timeZone, dateStyle: "medium", timeStyle: "short" }).format(pricing.fetchedAtMs)}`
            : ""}
          . These estimates do not describe your ChatGPT subscription bill.
        </p>
        {pricing.version && (
          <p className="break-all" title={pricing.version}>
            Rate table {pricing.version}
          </p>
        )}
        {pricing.message && <p>{pricing.message}</p>}
      </section>
    </>
  );
}
