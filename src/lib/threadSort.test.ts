import assert from "node:assert/strict";
import { it } from "node:test";
import {
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
  planPinnedReorder,
  topOfPinnedRunOrderKey,
} from "./threadSort";

it("finds a key strictly between neighbors, above the top and below the bottom", () => {
  assert.equal(pinOrderKeyBetween(null, null), "n");
  for (const [before, after] of [
    ["f", "m"],
    ["m", "n"],
    ["mz", "n"],
    ["b", "bb"],
    [null, "b"],
    [null, "ab"],
    ["z", null],
    ["zzz", null],
  ] as const) {
    const key = pinOrderKeyBetween(before, after);
    assert.ok(key !== null, `${before}..${after}`);
    if (before !== null) assert.ok(key > before, `${key} > ${before}`);
    if (after !== null) assert.ok(key < after, `${key} < ${after}`);
    assert.ok(!key.endsWith("a"), `${key} leaves room before it`);
  }
});

it("refuses corrupt or out-of-order neighbors so the caller rewrites the section", () => {
  assert.equal(pinOrderKeyBetween("m", "f"), null);
  assert.equal(pinOrderKeyBetween("m", "m"), null);
  assert.equal(pinOrderKeyBetween("ba", null), null);
  assert.equal(pinOrderKeyBetween(null, "M"), null);
});

it("spreads unique, sorted keys that still leave room before each one", () => {
  for (const count of [0, 1, 650, 675, 676, 1_001, 2_000]) {
    const keys = generateSpreadPinOrderKeys(count);
    assert.equal(keys.length, count);
    assert.equal(new Set(keys).size, count);
    assert.deepEqual([...keys].sort(), keys);
    for (const [index, after] of keys.entries()) {
      const before = keys[index - 1] ?? null;
      const between = pinOrderKeyBetween(before, after);
      assert.ok(between !== null && between < after);
      if (before !== null) assert.ok(between > before);
    }
  }
});

it("never reuses a key held by a hidden row", () => {
  const midpoint = pinOrderKeyBetween("f", "t")!;
  const assignments = planPinnedReorder({
    orderedIds: ["a", "moved", "b"],
    keysById: new Map([
      ["a", "f"],
      ["b", "t"],
      ["moved", "z"],
      ["snoozed", midpoint],
    ]),
    movedId: "moved",
  });
  assert.equal(assignments.length, 1);
  const [assignment] = assignments;
  assert.ok(assignment);
  assert.equal(assignment.id, "moved");
  const orderKey = assignment.orderKey;
  assert.ok(orderKey > "f" && orderKey < "t" && orderKey !== midpoint);

  const reserved = generateSpreadPinOrderKeys(6);
  const materialized = planPinnedReorder({
    orderedIds: ["c", "a", "b"],
    keysById: new Map<string, string | null>([
      ["a", null],
      ["b", null],
      ["c", null],
      ...reserved.map((key, i) => [`hidden-${i}`, key] as const),
    ]),
    movedId: "c",
  });
  assert.deepEqual(
    materialized.map((assignment) => assignment.id),
    ["c", "a", "b"],
  );
  const keys = materialized.map((assignment) => assignment.orderKey);
  assert.deepEqual([...keys].sort(), keys);
  assert.ok(keys.every((key) => !reserved.includes(key)));
});

it("places a fresh pin above every arranged pin, or mid-alphabet when none has a key", () => {
  assert.equal(topOfPinnedRunOrderKey([]), "n");
  assert.equal(
    topOfPinnedRunOrderKey([{ pinOrderKey: null }, { pinOrderKey: null }]),
    "n",
  );
  const key = topOfPinnedRunOrderKey([
    { pinOrderKey: "m" },
    { pinOrderKey: "f" },
    { pinOrderKey: null },
  ]);
  assert.ok(key !== undefined && key < "f");
});
