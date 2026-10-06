import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContextUsage } from "../ipc";
import {
  ContextWindowDetails,
  ContextWindowMeter,
  formatContextWindowTokens,
} from "./ContextWindowMeter";

const render = (usage: ContextUsage, modelDisplayName: string | null) => ({
  meter: renderToStaticMarkup(
    createElement(ContextWindowMeter, { usage, modelDisplayName }),
  ),
  details: renderToStaticMarkup(
    createElement(ContextWindowDetails, { usage, modelDisplayName }),
  ),
});

it("formats token counts as T3 does", () => {
  assert.equal(formatContextWindowTokens(999), "999");
  assert.equal(formatContextWindowTokens(1500), "1.5k");
  assert.equal(formatContextWindowTokens(20575), "21k");
  assert.equal(formatContextWindowTokens(258400), "258k");
  assert.equal(formatContextWindowTokens(1_250_000), "1.3m");
  assert.equal(formatContextWindowTokens(null), "0");
});

it("reports the share of the window used", () => {
  const { meter, details } = render(
    { usedTokens: 20575, maxTokens: 258400, totalProcessedTokens: 41150 },
    "GPT-5",
  );
  assert.ok(meter.includes('aria-label="Context window 8% used"'));
  assert.ok(!meter.includes("var(--color-error)"));
  assert.ok(details.includes("8%"));
  assert.ok(details.includes("21k/258k"));
  assert.ok(details.includes("Total processed"));
  assert.ok(details.includes("41k"));
  assert.ok(
    details.includes("Context for GPT-5 compacts automatically when needed."),
  );
  assert.ok(details.includes('role="progressbar"'));
});

it("turns the ring to the error colour past 90%", () => {
  const { meter } = render(
    { usedTokens: 240000, maxTokens: 258400, totalProcessedTokens: null },
    null,
  );
  assert.ok(meter.includes("var(--color-error)"));
});

it("counts tokens without a bar when the window size is unknown", () => {
  const { meter, details } = render(
    { usedTokens: 20575, maxTokens: null, totalProcessedTokens: null },
    null,
  );
  assert.ok(meter.includes('aria-label="Context window 21k tokens used"'));
  assert.ok(!details.includes('role="progressbar"'));
  assert.ok(!details.includes("Total processed"));
  assert.ok(details.includes("Context compacts automatically when needed."));
});
