import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LimitWindow } from "../ipc";
import { LimitWindows } from "./UsageLimits";

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
