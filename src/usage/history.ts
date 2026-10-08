// Usage metrics and periods follow T3 Code v0.0.45 usageShortcuts and usagePagePreferences (MIT).
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import {
  ipc,
  type UsageHistoryReport,
  type UsagePeriod,
  type UsageTotals,
} from "../ipc";
import { usagePeriodSchema } from "./schema";
import { storage as appStorage, type Storage } from "../lib/storage";

export const METRICS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "limits", label: "Limits" },
] satisfies { value: UsageMetric; label: string }[];
export const PERIODS = [
  { value: "past24Hours", label: "Past 24h" },
  { value: "sevenDays", label: "7 days" },
  { value: "thirtyDays", label: "30 days" },
  { value: "ninetyDays", label: "90 days" },
] satisfies { value: UsagePeriod; label: string }[];
export const metricSchema = z.enum(["cost", "tokens", "limits"]);
export type UsageMetric = z.infer<typeof metricSchema>;
const preferencesSchema = z.strictObject({
  metric: metricSchema,
  period: usagePeriodSchema,
  breakdown: z.enum(["model", "time"]),
});
export type UsagePreferences = z.infer<typeof preferencesSchema>;
const DEFAULT_PREFERENCES: UsagePreferences = {
  metric: "limits",
  period: "thirtyDays",
  breakdown: "model",
};
const STORAGE_KEY = "bot-code:usage-page-preferences:v1";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
export function readUsagePreferences(storage?: PreferenceStorage): {
  preferences: UsagePreferences;
  error: string | undefined;
} {
  try {
    const raw = (storage ?? appStorage).getItem(STORAGE_KEY);
    const parsed = raw
      ? preferencesSchema.safeParse(JSON.parse(raw))
      : undefined;
    return {
      preferences: parsed?.success ? parsed.data : DEFAULT_PREFERENCES,
      error: undefined,
    };
  } catch {
    return {
      preferences: DEFAULT_PREFERENCES,
      error:
        "Usage preferences could not be read. Changes still apply in this window.",
    };
  }
}
export async function saveUsagePreferences(
  preferences: UsagePreferences,
  storage?: PreferenceStorage,
): Promise<string | undefined> {
  try {
    await (storage ?? appStorage).setItem(
      STORAGE_KEY,
      JSON.stringify(preferencesSchema.parse(preferences)),
    );
    return undefined;
  } catch {
    return "Usage preferences could not be saved. Changes still apply in this window.";
  }
}
export function usageHistoryQuery(period: UsagePeriod, timeZone: string) {
  return queryOptions({
    queryKey: ["usage-history", period, timeZone],
    queryFn: () => ipc.usageHistory({ period, timeZone, refresh: false }),
    staleTime: Infinity,
    retry: false,
  });
}
export function totalTokens(tokens: UsageTotals["tokens"]): number {
  return (
    tokens.uncachedInput +
    tokens.cachedInput +
    tokens.cacheCreation +
    tokens.output
  );
}
export function metricValue(
  totals: UsageTotals,
  metric: "tokens" | "cost",
): number {
  return metric === "tokens"
    ? totalTokens(totals.tokens)
    : totals.estimatedCostUsd;
}
export function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}
export function formatCost(totals: UsageTotals): string {
  if (totals.records > 0 && totals.records === totals.unpricedRecords)
    return "Unavailable";
  return `$${totals.estimatedCostUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}
export function formatMetric(
  totals: UsageTotals,
  metric: "tokens" | "cost",
): string {
  return metric === "tokens"
    ? formatTokens(totalTokens(totals.tokens))
    : formatCost(totals);
}
export function sortedModels(
  report: UsageHistoryReport,
  metric: "tokens" | "cost",
) {
  return [...report.models].sort(
    (a, b) =>
      metricValue(b.totals, metric) - metricValue(a.totals, metric) ||
      a.model.localeCompare(b.model),
  );
}
export function periodLabel(
  startMs: number,
  period: UsagePeriod,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    ...(period === "past24Hours"
      ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" }
      : {}),
  }).format(startMs);
}
export function unpricedLabel(totals: UsageTotals): string | undefined {
  if (totals.unpricedRecords === 0) return undefined;
  const share =
    totals.records === 0 ? 0 : (totals.unpricedRecords / totals.records) * 100;
  return `${formatTokens(totals.unpricedTokens)} tokens in ${formatTokens(totals.unpricedRecords)} records (${share.toLocaleString("en-US", { maximumFractionDigits: 1 })}%) are unpriced.`;
}
