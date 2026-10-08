import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const instant = z.number().int().safe();
export const usagePeriodSchema = z.enum([
  "past24Hours",
  "sevenDays",
  "thirtyDays",
  "ninetyDays",
]);
export const usageHistoryRequestSchema = z.strictObject({
  period: usagePeriodSchema,
  timeZone: z
    .string()
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Usage requires a valid IANA time zone."),
  refresh: z.boolean(),
});
const tokens = z
  .strictObject({
    uncachedInput: count,
    cachedInput: count,
    cacheCreation: count,
    output: count,
    reasoning: count,
  })
  .refine((value) => value.reasoning <= value.output);
const totals = z
  .strictObject({
    tokens,
    estimatedCostUsd: z.number().finite().nonnegative(),
    records: count,
    unpricedRecords: count,
    unpricedTokens: count,
    sessions: count,
  })
  .refine((value) => value.unpricedRecords <= value.records);
export const usageHistoryReportSchema = z.strictObject({
  generatedAtMs: instant,
  timeZone: z.string(),
  startMs: instant,
  endMs: instant,
  totals,
  buckets: z
    .array(z.strictObject({ startMs: instant, endMs: instant, totals }))
    .max(90),
  models: z.array(z.strictObject({ model: z.string(), totals })),
  coverage: z.strictObject({
    home: z.string(),
    sources: z.array(
      z.strictObject({
        path: z.string(),
        status: z.enum(["ok", "missing", "partial", "failed"]),
      }),
    ),
    scannedFiles: count,
    reusedFiles: count,
    skippedFiles: count,
    malformedRecords: count,
    suppressedDuplicates: count,
    suppressedForkCopies: count,
    earliestIncludedMs: instant.nullable(),
    latestIncludedMs: instant.nullable(),
    retainedRecords: count,
    partial: z.boolean(),
    messages: z.array(z.string()),
    pricing: z.strictObject({
      status: z.enum(["fresh", "cached", "stale", "unavailable"]),
      source: z.string().url(),
      version: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .nullable(),
      fetchedAtMs: instant.nullable(),
      knownModels: count,
      message: z.string().nullable(),
    }),
  }),
});
export type UsagePeriod = z.infer<typeof usagePeriodSchema>;
export type UsageHistoryRequest = z.infer<typeof usageHistoryRequestSchema>;
export type UsageHistoryReport = z.infer<typeof usageHistoryReportSchema>;
export type UsageTotals = UsageHistoryReport["totals"];
