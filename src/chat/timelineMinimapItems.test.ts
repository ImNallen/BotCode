// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/chat/timelineMinimapItems.test.ts (MIT).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveTimelineMinimapItems,
  resolveTimelineMinimapPreview,
} from "./timelineMinimapItems";
import type { TimelineRow } from "./timelineRows";

function rows(
  entries: ReadonlyArray<readonly ["user" | "assistant", string]>,
): TimelineRow[] {
  return entries.map(
    ([role, text], index): TimelineRow =>
      role === "user"
        ? {
            kind: "user",
            id: `user:turn-${index}`,
            turnId: `turn-${index}`,
            text,
            attachments: [],
            records: [],
            at: index * 1000,
            editable: true,
            delivery: null,
          }
        : {
            kind: "assistant",
            id: `assistant:message-${index}`,
            text,
            streaming: false,
            meta: false,
            at: index * 1000,
          },
  );
}

describe("timeline minimap previews", () => {
  it("previews the last assistant response before the next prompt and retains jump targets", () => {
    const source = rows([
      ["user", "  Inspect\n this  "],
      ["assistant", "Working"],
      ["assistant", " Done\t now "],
      ["user", "Next"],
      ["assistant", "Second answer"],
    ]);
    const items = deriveTimelineMinimapItems(source);
    assert.equal(items.length, 2);
    assert.deepEqual(resolveTimelineMinimapPreview(items[0]!), {
      ...items[0],
      userText: "Inspect this",
      assistantText: "Done now",
    });
    assert.equal(source[items[0]!.rowIndex]!.id, items[0]!.id);
    assert.equal(
      resolveTimelineMinimapPreview(items[1]!)?.assistantText,
      "Second answer",
    );
    assert.equal(items[0]?.assistantText, " Done\t now ");
  });

  it("handles an unanswered prompt, empty responses, and a closed preview", () => {
    const items = deriveTimelineMinimapItems(
      rows([
        ["user", "First"],
        ["assistant", " \n\t"],
        ["user", "Next"],
      ]),
    );
    assert.deepEqual(
      items.map((item) => resolveTimelineMinimapPreview(item)?.assistantText),
      [null, null],
    );
    assert.equal(resolveTimelineMinimapPreview(null), null);
  });

  it("shows fresh streaming text without changing the jump target", () => {
    const first = deriveTimelineMinimapItems(
      rows([
        ["user", "Explain"],
        ["assistant", "First"],
      ]),
    )[0]!;
    const next = { ...first, assistantText: "First\n second" };
    assert.deepEqual(resolveTimelineMinimapPreview(next), {
      ...first,
      assistantText: "First second",
    });
    assert.equal(resolveTimelineMinimapPreview(first)?.assistantText, "First");
  });

  it("marks steered input as its own turn", () => {
    const source: TimelineRow[] = [
      ...rows([
        ["user", "Start"],
        ["assistant", "Before steer"],
      ]),
      { ...rows([["user", "Steer"]])[0]!, id: "input:steer" },
      ...rows([["assistant", "After steer"]]),
    ];
    assert.deepEqual(
      deriveTimelineMinimapItems(source).map((item) => [
        item.id,
        item.rowIndex,
        item.assistantText,
      ]),
      [
        ["user:turn-0", 0, "Before steer"],
        ["input:steer", 2, "After steer"],
      ],
    );
  });
});
