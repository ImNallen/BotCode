// Header and frame follow T3 Code v0.0.45 components/usage/UsagePage.tsx (MIT).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useRef, useState } from "react";
import { ipc } from "../ipc";
import { RefreshIcon } from "../panel/chrome";
import { Button, Toggle, selectTrigger } from "../ui/controls";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
} from "../WorkspaceBreadcrumb";
import { UsageLimitsSection } from "./UsageLimits";
import { UsageHistorySection } from "./UsageHistory";
import {
  METRICS,
  PERIODS,
  metricSchema,
  readUsagePreferences,
  saveUsagePreferences,
  usageHistoryQuery,
  type UsagePreferences,
} from "./history";
import { usagePeriodSchema } from "./schema";
import { usageLimitsQuery } from "./limits";

export function UsagePage() {
  const navigate = useNavigate();
  const selection = useSearch({ from: "__root__" });
  const client = useQueryClient();
  const [initialPreferences] = useState(readUsagePreferences);
  const [preferences, setPreferences] = useState(
    initialPreferences.preferences,
  );
  const [preferenceError, setPreferenceError] = useState(
    initialPreferences.error,
  );
  const [timeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const metric = preferences.metric;
  const showingLimits = metric === "limits";
  const limits = useQuery(usageLimitsQuery);
  const historyQuery = usageHistoryQuery(preferences.period, timeZone);
  const history = useQuery({ ...historyQuery, enabled: !showingLimits });
  const [limitsNow, setLimitsNow] = useState(Date.now);
  const [refreshing, setRefreshing] = useState(false);
  const [limitsRefreshError, setLimitsRefreshError] = useState<string>();
  const [historyRefreshError, setHistoryRefreshError] = useState<string>();
  const preferenceRevision = useRef(0);
  const updatePreferences = (next: UsagePreferences) => {
    setPreferences(next);
    const revision = ++preferenceRevision.current;
    void saveUsagePreferences(next).then((error) => {
      if (preferenceRevision.current === revision) setPreferenceError(error);
    });
  };
  const refresh = async () => {
    setRefreshing(true);
    const [limitsResult, historyResult] = await Promise.allSettled([
      ipc.usageLimits(true),
      ipc.usageHistory({ period: preferences.period, timeZone, refresh: true }),
    ]);
    if (limitsResult.status === "fulfilled") {
      client.setQueryData(usageLimitsQuery.queryKey, limitsResult.value);
      setLimitsRefreshError(undefined);
      setLimitsNow(Date.now());
    } else {
      const error: unknown = limitsResult.reason;
      setLimitsRefreshError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (historyResult.status === "fulfilled") {
      client.setQueryData(historyQuery.queryKey, historyResult.value);
      setHistoryRefreshError(undefined);
    } else {
      const error: unknown = historyResult.reason;
      setHistoryRefreshError(
        error instanceof Error ? error.message : String(error),
      );
    }
    setRefreshing(false);
  };
  const historyError = historyRefreshError ?? history.error?.message;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <header
        data-tauri-drag-region="deep"
        className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) drag-region [[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)]"
      >
        <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb">
          <WorkspaceBreadcrumbItem>
            <h1>Usage</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="ms-auto flex min-w-0 items-center justify-end gap-2">
          <div className="hidden items-center gap-2 xl:flex">
            <div
              className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5"
              role="group"
              aria-label="Usage metric"
            >
              {METRICS.map((option) => (
                <Toggle
                  key={option.value}
                  size="sm"
                  variant="segmented"
                  pressed={preferences.metric === option.value}
                  onClick={() =>
                    updatePreferences({ ...preferences, metric: option.value })
                  }
                >
                  {option.label}
                </Toggle>
              ))}
            </div>
            <div
              className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5"
              role="group"
              aria-label="Usage period"
            >
              {PERIODS.map((option) => (
                <Toggle
                  key={option.value}
                  size="sm"
                  variant="segmented"
                  disabled={showingLimits}
                  pressed={preferences.period === option.value}
                  onClick={() =>
                    updatePreferences({ ...preferences, period: option.value })
                  }
                >
                  {option.label}
                </Toggle>
              ))}
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-1 xl:hidden">
            <select
              aria-label="Usage metric"
              className={selectTrigger({ variant: "ghost", size: "xs" })}
              value={preferences.metric}
              onChange={(event) => {
                const parsed = metricSchema.safeParse(event.target.value);
                if (parsed.success)
                  updatePreferences({ ...preferences, metric: parsed.data });
              }}
            >
              {METRICS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Usage period"
              className={selectTrigger({ variant: "ghost", size: "xs" })}
              value={preferences.period}
              disabled={showingLimits}
              onChange={(event) => {
                const parsed = usagePeriodSchema.safeParse(event.target.value);
                if (parsed.success)
                  updatePreferences({ ...preferences, period: parsed.data });
              }}
            >
              {PERIODS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            onClick={() => void refresh()}
            aria-label={showingLimits ? "Refresh limits" : "Refresh usage"}
            aria-busy={refreshing}
            disabled={refreshing}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshIcon refreshing={refreshing} className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="md:hidden [[data-sidebar-state=collapsed]_&]:inline-flex"
            onClick={() =>
              void navigate({
                to: "/",
                search: { ...selection, project: undefined },
                hash: "",
                resetScroll: false,
              })
            }
          >
            <ArrowLeftIcon className="size-4" />
            Back
          </Button>
        </div>
      </header>
      <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 pt-6 pb-12 sm:px-6">
          {preferenceError && (
            <p role="status" className="text-xs text-muted-foreground">
              {preferenceError}
            </p>
          )}
          {showingLimits ? (
            <UsageLimitsSection
              limits={limits.data}
              error={limitsRefreshError ?? limits.error?.message}
              now={limitsNow}
            />
          ) : (
            <>
              {historyError && (
                <p role="alert" className="text-sm text-destructive">
                  Could not refresh usage. {historyError}
                  {history.data ? " Showing the last successful report." : ""}
                </p>
              )}
              {history.data ? (
                <UsageHistorySection
                  report={history.data}
                  period={preferences.period}
                  metric={metric}
                  breakdown={preferences.breakdown}
                  onBreakdownChange={(breakdown) =>
                    updatePreferences({ ...preferences, breakdown })
                  }
                />
              ) : history.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Reading local usage history...
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
