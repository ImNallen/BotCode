// Ports T3 Code v0.0.45 packages/contracts/src/settings.ts UsageModelPriceOverride and
// components/usage/usagePriceForm.ts and usagePriceTable.ts (MIT), for one environment.
import { z } from "zod";

const price = z.number().nonnegative();
export const usagePriceOverrideSchema = z.object({
  inputCostPerMillionTokens: price,
  outputCostPerMillionTokens: price,
  cacheReadCostPerMillionTokens: price.optional(),
  cacheWriteCostPerMillionTokens: price.optional(),
});
export type UsagePriceOverride = z.infer<typeof usagePriceOverrideSchema>;
export type UsagePrices = Readonly<Record<string, UsagePriceOverride>>;

export function readUsagePrices(
  value: unknown,
): Record<string, UsagePriceOverride> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([model, entry]) => {
      const parsed = usagePriceOverrideSchema.safeParse(entry);
      return model.trim() !== "" && parsed.success
        ? [[model.trim(), parsed.data]]
        : [];
    }),
  );
}

export const USAGE_PRICE_FIELDS = [
  { key: "inputCostPerMillionTokens", label: "Input", optional: false },
  { key: "outputCostPerMillionTokens", label: "Output", optional: false },
  { key: "cacheReadCostPerMillionTokens", label: "Cache read", optional: true },
  {
    key: "cacheWriteCostPerMillionTokens",
    label: "Cache write",
    optional: true,
  },
] as const;

export type UsagePriceField = (typeof USAGE_PRICE_FIELDS)[number]["key"];
export type UsagePriceForm = { model: string } & Record<
  UsagePriceField,
  string
>;

export function usagePriceForm(
  model = "",
  price?: UsagePriceOverride,
): UsagePriceForm {
  return {
    model,
    inputCostPerMillionTokens:
      price?.inputCostPerMillionTokens.toString() ?? "",
    outputCostPerMillionTokens:
      price?.outputCostPerMillionTokens.toString() ?? "",
    cacheReadCostPerMillionTokens:
      price?.cacheReadCostPerMillionTokens?.toString() ?? "",
    cacheWriteCostPerMillionTokens:
      price?.cacheWriteCostPerMillionTokens?.toString() ?? "",
  };
}

export function parseUsagePriceForm(
  form: UsagePriceForm,
): { model: string; price: UsagePriceOverride } | null {
  const model = form.model.trim();
  if (model.length === 0) return null;
  const rates: Partial<Record<UsagePriceField, number>> = {};
  for (const field of USAGE_PRICE_FIELDS) {
    const raw = form[field.key].trim();
    if (raw === "") {
      if (field.optional) continue;
      return null;
    }
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    rates[field.key] = value;
  }
  if (
    rates.inputCostPerMillionTokens === undefined ||
    rates.outputCostPerMillionTokens === undefined
  ) {
    return null;
  }
  return {
    model,
    price: {
      inputCostPerMillionTokens: rates.inputCostPerMillionTokens,
      outputCostPerMillionTokens: rates.outputCostPerMillionTokens,
      ...(rates.cacheReadCostPerMillionTokens === undefined
        ? {}
        : {
            cacheReadCostPerMillionTokens: rates.cacheReadCostPerMillionTokens,
          }),
      ...(rates.cacheWriteCostPerMillionTokens === undefined
        ? {}
        : {
            cacheWriteCostPerMillionTokens:
              rates.cacheWriteCostPerMillionTokens,
          }),
    },
  };
}

export interface UsagePriceDraft {
  readonly id: string;
  readonly model: string;
  readonly isNew: boolean;
  readonly values: Partial<Pick<UsagePriceForm, UsagePriceField>>;
  readonly removed?: boolean;
}

export interface UsagePriceChange {
  readonly model: string;
  readonly price: UsagePriceOverride | null;
}

export function isEmptyUsagePriceDraft(draft: UsagePriceDraft) {
  return (
    draft.isNew &&
    draft.model.trim() === "" &&
    Object.values(draft.values).every((value) => value.trim() === "")
  );
}

function modelPrice(prices: UsagePrices, model: string) {
  return Object.hasOwn(prices, model) ? prices[model] : undefined;
}

export function usagePriceCell(
  prices: UsagePrices,
  model: string,
  field: UsagePriceField,
) {
  const optional = USAGE_PRICE_FIELDS.find(
    (entry) => entry.key === field,
  )!.optional;
  const current = modelPrice(prices, model);
  if (!current) return { value: "", placeholder: "Automatic" };
  return {
    value: usagePriceForm(model, current)[field],
    placeholder: optional ? "Input rate" : "0.00",
  };
}

export function usagePriceTableChanges(
  prices: UsagePrices,
  drafts: readonly UsagePriceDraft[],
) {
  const changes: UsagePriceChange[] = [];
  const errors = new Map<string, string>();
  for (const draft of drafts) {
    if (isEmptyUsagePriceDraft(draft)) continue;
    const model = draft.model.trim();
    if (draft.removed) {
      if (modelPrice(prices, model)) changes.push({ model, price: null });
      continue;
    }
    const original = usagePriceForm(model, modelPrice(prices, model));
    const form = { ...original, ...draft.values };
    const parsed = parseUsagePriceForm(form);
    if (parsed === null) {
      const missing = USAGE_PRICE_FIELDS.find(
        (field) => !field.optional && form[field.key].trim() === "",
      );
      errors.set(
        draft.id,
        model === ""
          ? "Enter a model ID."
          : missing
            ? `${missing.label} is required.`
            : "Use non-negative numbers for prices.",
      );
      continue;
    }
    const next = usagePriceForm(model, parsed.price);
    if (
      USAGE_PRICE_FIELDS.some(
        (field) => original[field.key] !== next[field.key],
      )
    )
      changes.push(parsed);
  }
  return { changes, errors };
}

export function applyUsagePriceChanges(
  prices: UsagePrices,
  changes: readonly UsagePriceChange[],
): Record<string, UsagePriceOverride> {
  const changed = new Map(changes.map(({ model, price }) => [model, price]));
  return Object.fromEntries([
    ...Object.entries(prices).filter(([model]) => !changed.has(model)),
    ...[...changed].filter(
      (entry): entry is [string, UsagePriceOverride] => entry[1] !== null,
    ),
  ]);
}
