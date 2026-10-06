import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LimitWindow } from "../ipc";
import { LimitWindows, UsageLimitsSection } from "./UsageLimits";

const weekly: LimitWindow = {
  slot: "primary",
  kind: "weekly",
  usedPercent: 44,
  durationMins: 10080,
  resetsAtMs: 1_791_580_401_000,
};
const now = 1_791_580_401_000 - 3 * 86_400_000;

it("draws a window as quota left with the even-spending mark", () => {
  const html = renderToStaticMarkup(
    createElement(LimitWindows, { windows: [weekly], now, compact: true }),
  );
  assert.ok(html.includes(">Weekly<"));
  assert.ok(html.includes("56% left"));
  assert.ok(html.includes("resets in 3d 0h"));
  assert.ok(html.includes("width:56%"));
  assert.ok(html.includes("left:43%"));
  assert.ok(html.includes('aria-label="Under pace'));
});

it("shows the plan and the reason when a page has no windows", () => {
  const reported = renderToStaticMarkup(
    createElement(UsageLimitsSection, {
      limits: {
        kind: "reported",
        plan: "ChatGPT Pro 20x Subscription",
        windows: [weekly],
      },
      error: undefined,
      now,
    }),
  );
  assert.ok(reported.includes("Codex · ChatGPT Pro 20x Subscription"));
  assert.ok(reported.includes("width:56%"));
  const unsupported = renderToStaticMarkup(
    createElement(UsageLimitsSection, {
      limits: { kind: "unsupported" },
      error: undefined,
      now,
    }),
  );
  assert.ok(unsupported.includes("This account has no subscription limits."));
  assert.ok(!unsupported.includes('role="img"'));
});
