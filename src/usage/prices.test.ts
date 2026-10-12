// Ports T3 Code v0.0.45 components/usage/usagePriceForm.test.ts and usagePriceTable.test.ts (MIT)
// for one environment.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyUsagePriceChanges,
  parseUsagePriceForm,
  readUsagePrices,
  usagePriceCell,
  usagePriceForm,
  usagePriceTableChanges,
  type UsagePriceDraft,
} from "./prices";

describe("model price entry", () => {
  it("preserves exact model IDs and fractional rates", () => {
    assert.deepEqual(
      parseUsagePriceForm({
        ...usagePriceForm(),
        model: "  vendor/Example-Model  ",
        inputCostPerMillionTokens: "2.5",
        outputCostPerMillionTokens: "10",
      }),
      {
        model: "vendor/Example-Model",
        price: {
          inputCostPerMillionTokens: 2.5,
          outputCostPerMillionTokens: 10,
        },
      },
    );
  });

  it("keeps free cache tokens distinct from blank cache prices", () => {
    const parsed = parseUsagePriceForm({
      ...usagePriceForm(),
      model: "example-model",
      inputCostPerMillionTokens: "2",
      outputCostPerMillionTokens: "8",
      cacheReadCostPerMillionTokens: "0",
      cacheWriteCostPerMillionTokens: " ",
    });
    assert.deepEqual(parsed?.price, {
      inputCostPerMillionTokens: 2,
      outputCostPerMillionTokens: 8,
      cacheReadCostPerMillionTokens: 0,
    });
  });

  it("preserves all prices when editing, including small fractional prices", () => {
    const price = {
      inputCostPerMillionTokens: 0,
      outputCostPerMillionTokens: 8,
      cacheReadCostPerMillionTokens: 0.0000001,
      cacheWriteCostPerMillionTokens: 3.5,
    };
    assert.deepEqual(
      parseUsagePriceForm(usagePriceForm("example-model", price)),
      { model: "example-model", price },
    );
  });

  for (const inputCostPerMillionTokens of [
    "",
    " ",
    "-1",
    "Infinity",
    "NaN",
    "1e999",
    "$2",
    "0x10",
  ]) {
    it(`rejects invalid required prices: ${JSON.stringify(inputCostPerMillionTokens)}`, () => {
      assert.equal(
        parseUsagePriceForm({
          ...usagePriceForm("example-model", {
            inputCostPerMillionTokens: 2,
            outputCostPerMillionTokens: 8,
          }),
          inputCostPerMillionTokens,
        }),
        null,
      );
    });
  }

  it("rejects invalid optional rates and missing model IDs", () => {
    const form = usagePriceForm("example-model", {
      inputCostPerMillionTokens: 2,
      outputCostPerMillionTokens: 8,
    });
    assert.equal(
      parseUsagePriceForm({ ...form, cacheReadCostPerMillionTokens: "-1" }),
      null,
    );
    assert.equal(
      parseUsagePriceForm({
        ...form,
        cacheWriteCostPerMillionTokens: "invalid",
      }),
      null,
    );
    assert.equal(parseUsagePriceForm({ ...form, model: " " }), null);
  });
});

const price = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };
const draft = (values: UsagePriceDraft["values"]): UsagePriceDraft => ({
  id: "model:example",
  model: "example",
  isNew: false,
  values,
});

describe("price table edits", () => {
  it("shows saved cells and automatic pricing", () => {
    const prices = { example: price };
    assert.equal(
      usagePriceCell(prices, "example", "inputCostPerMillionTokens").value,
      "2",
    );
    assert.deepEqual(
      usagePriceCell(prices, "example", "cacheReadCostPerMillionTokens"),
      { value: "", placeholder: "Input rate" },
    );
    assert.deepEqual(
      usagePriceCell(prices, "example", "outputCostPerMillionTokens"),
      { value: "8", placeholder: "0.00" },
    );
    assert.equal(
      usagePriceCell({}, "example", "inputCostPerMillionTokens").placeholder,
      "Automatic",
    );
  });

  for (const model of ["constructor", "toString", "__proto__"]) {
    it(`handles an exact model ID named ${model}`, () => {
      assert.deepEqual(usagePriceCell({}, model, "inputCostPerMillionTokens"), {
        value: "",
        placeholder: "Automatic",
      });
      const result = usagePriceTableChanges({}, [
        {
          ...draft({
            inputCostPerMillionTokens: "2",
            outputCostPerMillionTokens: "8",
          }),
          model,
          isNew: true,
        },
      ]);
      assert.deepEqual(result.changes, [{ model, price }]);
      const saved = applyUsagePriceChanges({}, result.changes);
      assert.deepEqual(Object.keys(saved), [model]);
      assert.equal(
        usagePriceCell(saved, model, "inputCostPerMillionTokens").value,
        "2",
      );
      assert.deepEqual(
        readUsagePrices(JSON.parse(JSON.stringify(saved))),
        saved,
      );
    });
  }

  it("changes only edited columns while preserving other prices and models", () => {
    const prices = {
      example: { ...price, cacheReadCostPerMillionTokens: 0 },
      untouched: price,
    };
    const plan = usagePriceTableChanges(prices, [
      draft({ inputCostPerMillionTokens: "3" }),
    ]);
    assert.deepEqual(plan.changes, [
      {
        model: "example",
        price: {
          ...price,
          inputCostPerMillionTokens: 3,
          cacheReadCostPerMillionTokens: 0,
        },
      },
    ]);
    assert.deepEqual(applyUsagePriceChanges(prices, plan.changes), {
      untouched: price,
      example: {
        ...price,
        inputCostPerMillionTokens: 3,
        cacheReadCostPerMillionTokens: 0,
      },
    });
  });

  it("batches new rows and resets, and distinguishes blank cache rates from explicit zero", () => {
    const prices = { example: price };
    const plan = usagePriceTableChanges(prices, [
      { ...draft({}), removed: true },
      {
        id: "new:1",
        model: "  vendor/Model  ",
        isNew: true,
        values: {
          inputCostPerMillionTokens: "2",
          outputCostPerMillionTokens: "8",
          cacheReadCostPerMillionTokens: "0",
          cacheWriteCostPerMillionTokens: "",
        },
      },
    ]);
    assert.equal(plan.errors.size, 0);
    assert.deepEqual(plan.changes, [
      { model: "example", price: null },
      {
        model: "vendor/Model",
        price: { ...price, cacheReadCostPerMillionTokens: 0 },
      },
    ]);
    assert.deepEqual(applyUsagePriceChanges(prices, plan.changes), {
      "vendor/Model": { ...price, cacheReadCostPerMillionTokens: 0 },
    });
  });

  it("requires complete prices before turning automatic pricing into an override", () => {
    const edits = [draft({ inputCostPerMillionTokens: "3" })];
    assert.equal(
      usagePriceTableChanges({ example: price }, edits).errors.size,
      0,
    );
    const missing = usagePriceTableChanges({}, edits);
    assert.deepEqual(missing.changes, []);
    assert.equal(missing.errors.get("model:example"), "Output is required.");
  });

  it("ignores empty new rows without blocking other edits", () => {
    const prices = { example: price };
    const empty: UsagePriceDraft = {
      id: "new:1",
      model: " ",
      isNew: true,
      values: { inputCostPerMillionTokens: " " },
    };
    const plan = usagePriceTableChanges(prices, [
      draft({ inputCostPerMillionTokens: "3" }),
      empty,
    ]);
    assert.equal(plan.errors.size, 0);
    assert.deepEqual(plan.changes, [
      { model: "example", price: { ...price, inputCostPerMillionTokens: 3 } },
    ]);
    assert.deepEqual(usagePriceTableChanges(prices, [empty]).changes, []);
    assert.equal(
      usagePriceTableChanges(prices, [
        { ...empty, values: { inputCostPerMillionTokens: "0" } },
      ]).errors.get(empty.id),
      "Enter a model ID.",
    );
  });

  it("does not write unchanged rates and rejects invalid edited cells", () => {
    const prices = { example: price };
    assert.deepEqual(
      usagePriceTableChanges(prices, [
        draft({ inputCostPerMillionTokens: "2.00" }),
      ]).changes,
      [],
    );
    assert.equal(
      usagePriceTableChanges(prices, [
        draft({ cacheReadCostPerMillionTokens: "-1" }),
      ]).errors.get("model:example"),
      "Use non-negative numbers for prices.",
    );
    assert.equal(
      usagePriceTableChanges(prices, [
        draft({ outputCostPerMillionTokens: "" }),
      ]).errors.get("model:example"),
      "Output is required.",
    );
  });
});

it("keeps valid saved prices and drops malformed entries", () => {
  assert.deepEqual(
    readUsagePrices({
      " vendor/Model ": price,
      free: { ...price, cacheReadCostPerMillionTokens: 0 },
      negative: { ...price, inputCostPerMillionTokens: -1 },
      half: { inputCostPerMillionTokens: 2 },
      text: { ...price, outputCostPerMillionTokens: "8" },
      "  ": price,
    }),
    {
      "vendor/Model": price,
      free: { ...price, cacheReadCostPerMillionTokens: 0 },
    },
  );
  assert.deepEqual(readUsagePrices([price]), {});
  assert.deepEqual(readUsagePrices("prices"), {});
  assert.deepEqual(readUsagePrices(undefined), {});
});
