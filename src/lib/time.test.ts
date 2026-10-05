import assert from "node:assert/strict";
import { it } from "node:test";
import { formatRelativeTimeLabel } from "./time.ts";

it("formats relative update times the way T3 does", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  assert.equal(
    formatRelativeTimeLabel("2026-10-05T11:59:30Z", now),
    "just now",
  );
  assert.equal(
    formatRelativeTimeLabel("2026-10-05T12:00:30Z", now),
    "just now",
  );
  assert.equal(formatRelativeTimeLabel("2026-10-05T11:15:00Z", now), "45m ago");
  assert.equal(formatRelativeTimeLabel("2026-10-05T07:00:00Z", now), "5h ago");
  assert.equal(formatRelativeTimeLabel("2026-10-02T12:00:00Z", now), "3d ago");
  assert.equal(formatRelativeTimeLabel("not a date", now), "");
});
