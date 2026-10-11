import assert from "node:assert/strict";
import { it } from "node:test";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  snoozeCalendarDisabled,
  snoozeDateLabel,
  type CustomSnoozeInput,
} from "./snooze.ts";
import { resolveWeekStartsOn } from "./weekStart.ts";

const DATE_ERROR = "Choose a valid date and time in the future.";
const DURATION_ERROR = "Enter a positive duration.";
const now = new Date(2026, 8, 14, 14, 30);

function inTimeZone<T>(timeZone: string, run: () => T) {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

it("converts a local date and time to an absolute wake time", () => {
  assert.deepEqual(
    resolveCustomSnooze(
      { mode: "date", date: "2026-09-15", time: "09:15" },
      now,
    ),
    { ok: true, untilMs: new Date(2026, 8, 15, 9, 15).getTime() },
  );
  assert.deepEqual(
    inTimeZone("Europe/Stockholm", () =>
      resolveCustomSnooze(
        { mode: "date", date: "2026-09-15", time: "09:15" },
        new Date("2026-09-14T12:00:00Z"),
      ),
    ),
    { ok: true, untilMs: Date.parse("2026-09-15T07:15:00Z") },
  );
});

it("rejects past, present and invalid calendar input with T3's message", () => {
  for (const [date, time] of [
    ["2026-09-14", "14:30"],
    ["2026-09-13", "09:00"],
    ["2027-02-29", "09:00"],
    ["2026-13-01", "09:00"],
    ["2026-09-15", "24:00"],
    ["2026-09-15", "09:60"],
    ["", "09:00"],
    ["2026-09-15", ""],
  ] as const)
    assert.deepEqual(
      resolveCustomSnooze({ mode: "date", date, time }, now),
      { ok: false, error: DATE_ERROR },
      `${date} ${time}`,
    );
});

it("resolves a duration from the confirmation time", () => {
  const confirmedAt = new Date(now.getTime() + 5 * 60_000);
  for (const [unit, amount, elapsedMs] of [
    ["minutes", "45", 45 * 60_000],
    ["hours", "1.5", 90 * 60_000],
    ["days", "2", 48 * 3_600_000],
  ] as const)
    assert.deepEqual(
      resolveCustomSnooze({ mode: "duration", amount, unit }, confirmedAt),
      { ok: true, untilMs: confirmedAt.getTime() + elapsedMs },
    );
});

it("rejects empty, zero, negative and unrepresentable durations", () => {
  for (const amount of ["", "0", "-1", "NaN", "Infinity", "1e300", "two"]) {
    const input: CustomSnoozeInput = {
      mode: "duration",
      amount,
      unit: "hours",
    };
    assert.deepEqual(
      resolveCustomSnooze(input, now),
      { ok: false, error: DURATION_ERROR },
      amount,
    );
  }
});

it("rejects a local time skipped by the spring DST change", () => {
  assert.deepEqual(
    inTimeZone("America/Los_Angeles", () =>
      resolveCustomSnooze(
        { mode: "date", date: "2027-03-14", time: "02:30" },
        new Date("2027-03-01T00:00:00Z"),
      ),
    ),
    { ok: false, error: DATE_ERROR },
  );
});

it("formats local input values without converting to UTC", () => {
  const date = new Date(2026, 0, 2, 3, 4);
  assert.equal(localSnoozeDate(date), "2026-01-02");
  assert.equal(localSnoozeTime(date), "03:04");
});

it("labels the date button with the local calendar day in every time zone", () => {
  for (const timeZone of ["Pacific/Kiritimati", "UTC", "Pacific/Pago_Pago"])
    inTimeZone(timeZone, () => {
      assert.equal(snoozeDateLabel("2026-10-11", "en-US"), "Oct 11, 2026");
      assert.equal(snoozeDateLabel("2027-01-02", "en-US"), "Jan 2, 2027");
    });
});

it("disables calendar days before today without moving the clock", () => {
  const clock = new Date(2026, 8, 14, 14, 30);
  assert.deepEqual(snoozeCalendarDisabled(clock), {
    before: new Date(2026, 8, 14),
  });
  assert.equal(clock.getTime(), new Date(2026, 8, 14, 14, 30).getTime());
});

it("starts the calendar week on the locale's first day", () => {
  assert.equal(resolveWeekStartsOn("en-US"), 0);
  assert.equal(resolveWeekStartsOn("sv-SE"), 1);
  assert.equal(resolveWeekStartsOn("ar-EG"), 6);
  assert.equal(resolveWeekStartsOn("!!"), undefined);
});
