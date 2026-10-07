// Ported from T3 Code v0.0.45 apps/web/src/lib/assistantTextSelection.test.ts (MIT).
import assert from "node:assert/strict";
import { it } from "node:test";
import { composerContextRecord } from "./composerContext";
import {
  createAssistantTextSelector,
  findAssistantCitationText,
} from "./assistantTextSelection";

it("preserves selected whitespace while locating quotes in normalized displayed text", () => {
  const text = "Before \n  quote\t \n after";
  const selector = createAssistantTextSelector(
    text,
    "Before \n".length,
    "Before \n  quote\t".length,
  );
  assert.deepEqual(selector, {
    text: "  quote\t",
    start: 6,
    end: 13,
    prefix: "Before",
    suffix: "after",
  });
  assert.ok(selector);
  const record = composerContextRecord.parse({
    version: 1,
    contextId: "citation-context",
    label: "Assistant quote",
    kind: "citation",
    environmentId: "workspace",
    threadId: "thread",
    messageId: "assistant-message",
    ...selector,
  });
  assert.equal(record.kind, "citation");
  if (record.kind === "citation") assert.equal(record.text, "  quote\t");
  assert.deepEqual(findAssistantCitationText(text, selector), {
    start: 6,
    end: 13,
  });
});

it("keeps UTF-16 offsets and clips neighboring context without splitting emoji", () => {
  for (const paddingLength of [0, 30, 31, 32]) {
    const padding = "x".repeat(paddingLength);
    const text = `😀${padding}quote${padding}🚀`;
    const start = text.indexOf("quote");
    const selector = createAssistantTextSelector(text, start, start + 5);
    assert.ok(selector);
    const keepEmoji = paddingLength + 2 <= 32;
    assert.deepEqual(selector, {
      text: "quote",
      start,
      end: start + 5,
      prefix: `${keepEmoji ? "😀" : ""}${padding}`,
      suffix: `${padding}${keepEmoji ? "🚀" : ""}`,
    });
    assert.equal(
      decodeURIComponent(encodeURIComponent(selector.prefix)),
      selector.prefix,
    );
    assert.equal(
      decodeURIComponent(encodeURIComponent(selector.suffix)),
      selector.suffix,
    );
  }
});

it("relocates multiline quotes after surrounding text changes and rejects context ties", () => {
  const quote = "selected\r\n  code 🚀";
  const text = `${quote} elsewhere\n😀${"x".repeat(31)}${quote}${"y".repeat(31)}🚀`;
  const start = text.lastIndexOf(quote);
  const selector = createAssistantTextSelector(
    text,
    start,
    start + quote.length,
  );
  assert.ok(selector);
  assert.equal(selector.text, quote);
  const expected = { start: selector.start, end: selector.end };
  assert.deepEqual(findAssistantCitationText(text, selector), expected);
  assert.deepEqual(
    findAssistantCitationText(`Inserted paragraph.\n${text}`, selector),
    {
      start: expected.start + "Inserted paragraph. ".length,
      end: expected.end + "Inserted paragraph. ".length,
    },
  );
  assert.equal(
    findAssistantCitationText("left quote right / left quote right", {
      text: "quote",
      start: 5,
      end: 10,
      prefix: "left ",
      suffix: " right",
    }),
    null,
  );
});

it("rejects empty or whitespace-only selections", () => {
  assert.equal(createAssistantTextSelector("", 0, 0), null);
  assert.equal(createAssistantTextSelector(" \n\t\r\n", 0, 6), null);
});
