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
        resetCredits: null,
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

it("offers banked reset credits under the windows and hides an empty bank", () => {
  const section = (resetCredits: {
    availableCount: number;
    nextExpiresAtMs: number | null;
  }) =>
    renderToStaticMarkup(
      createElement(UsageLimitsSection, {
        limits: {
          kind: "reported",
          plan: "ChatGPT Pro 20x Subscription",
          windows: [weekly],
          resetCredits,
        },
        error: undefined,
        now,
      }),
    );
  const banked = section({
    availableCount: 2,
    nextExpiresAtMs: now + 2 * 86_400_000,
  });
  assert.ok(banked.includes("2 reset credits banked · next expires in 2d 0h"));
  assert.ok(banked.includes(">Use reset</button>"));
  const empty = section({ availableCount: 0, nextExpiresAtMs: null });
  assert.ok(!empty.includes("banked"));
  assert.ok(!empty.includes("Use reset"));
});
