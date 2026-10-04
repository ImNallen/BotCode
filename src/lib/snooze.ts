// Ports resolveSnoozePresets and snoozeWakeLabel from pingdotgg/t3code v0.0.45 packages/client-runtime/src/state/threadSettled.ts (MIT).
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export type SnoozePreset = {
  id: "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";
  label: string;
  whenLabel: string;
  untilMs: number;
};

function timeOfDayLabel(date: Date) {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function atHour(base: Date, hour: number) {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar days, not DAY_MS, so a DST change never skips a day.
function addDays(base: Date, days: number) {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

export function resolveSnoozePresets(now: Date): SnoozePreset[] {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeOfDayLabel(inAnHour),
      untilMs: inAnHour.getTime(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: timeOfDayLabel(inThreeHours),
      untilMs: inThreeHours.getTime(),
    },
  ];
  const evening = atHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS)
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeOfDayLabel(evening),
      untilMs: evening.getTime(),
    });
  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeOfDayLabel(tomorrow),
    untilMs: tomorrow.getTime(),
  });
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime())
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeOfDayLabel(nextWeek)}`,
      untilMs: nextWeek.getTime(),
    });
  return presets;
}

// Minutes round up so a hidden thread never reads "0m".
export function snoozeWakeLabel(untilMs: number, nowMs: number) {
  const remainingMs = untilMs - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS)
    return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}
