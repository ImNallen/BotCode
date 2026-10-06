// Pace and reset maths copied from pingdotgg/t3code v0.0.45 packages/shared/src/usageLimits.ts (MIT).
import { queryOptions } from "@tanstack/react-query";
import { ipc, type LimitWindow, type UsageLimits } from "../ipc";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const usageLimitsQuery = queryOptions({
  queryKey: ["usage-limits"],
  queryFn: () => ipc.usageLimits(false),
  retry: false,
  staleTime: Infinity,
});

export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

export function windowLabel(kind: LimitWindow["kind"]): string {
  return { session: "Session", weekly: "Weekly", monthly: "Monthly" }[kind];
}

export function accountLabel(limits: UsageLimits | undefined): string {
  return limits?.kind === "reported" && limits.plan
    ? `Codex · ${limits.plan}`
    : "Codex";
}

export function limitsNotice(limits: UsageLimits): string | null {
  if (limits.kind === "unsupported")
    return "This account has no subscription limits.";
  if (limits.kind === "failed") return limits.message;
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function remainingPercent(window: LimitWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

export function elapsedShare(window: LimitWindow, now: number): number | null {
  if (window.resetsAtMs === null) return null;
  const length = window.durationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(
    0,
    Math.min(1, (length - (window.resetsAtMs - now)) / length),
  );
}

export function timeLeftPercent(
  window: LimitWindow,
  now: number,
): number | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

export type LimitPace = "ahead" | "on" | "under";

const PACE_TOLERANCE = 5;

export function paceOf(window: LimitWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null) return null;
  const gap = window.usedPercent - elapsed * 100;
  if (gap > PACE_TOLERANCE) return "ahead";
  if (gap < -PACE_TOLERANCE) return "under";
  return "on";
}

function formatDuration(ms: number): string {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatResetsIn(
  window: LimitWindow,
  now: number,
): string | null {
  if (window.resetsAtMs === null) return null;
  return window.resetsAtMs <= now
    ? "resets now"
    : `resets in ${formatDuration(window.resetsAtMs - now)}`;
}

export function usageNoticeKey(
  scope: string,
  latestTurnId: string | null,
  approvalId: string | null,
): string {
  return JSON.stringify([scope, latestTurnId, approvalId]);
}
