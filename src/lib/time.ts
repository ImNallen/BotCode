// Formatting copied from pingdotgg/t3code v0.0.45 timestampFormat.ts,
// packages/shared/src/orchestrationTiming.ts and MessagesTimeline.tsx (MIT).
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
});
const dateWithYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
  year: "numeric",
});

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export function formatWorkingTimer(startedAt: number, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  return formatDuration(elapsedSeconds * 1_000);
}

export function formatDayAwareTimestamp(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = timeFormatter.format(date);
  const today = new Date(now);
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const startOfDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const dayDiff = Math.round((startOfToday - startOfDay) / 86_400_000);
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `yesterday at ${time}`;
  const formatter =
    date.getFullYear() === today.getFullYear()
      ? dateFormatter
      : dateWithYearFormatter;
  return `${formatter.format(date)} ${time}`;
}

export function formatUpcomingTimestamp(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = timeFormatter.format(date);
  const today = new Date(now);
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const startOfDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const dayDiff = Math.round((startOfDay - startOfToday) / 86_400_000);
  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `tomorrow at ${time}`;
  const formatter =
    date.getFullYear() === today.getFullYear()
      ? dateFormatter
      : dateWithYearFormatter;
  return `${formatter.format(date)} ${time}`;
}

export function formatSidebarTime(at: number, now = Date.now()): string {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// Copied from pingdotgg/t3code 3e6b450 apps/web/src/timestampFormat.ts (MIT).
export function formatRelativeTimeLabel(
  isoDate: string,
  now = Date.now(),
): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = now - date.getTime();
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
