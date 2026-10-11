// Ported from pingdotgg/t3code v0.0.45 packages/client-runtime/src/state/threadSort.ts and hooks/useThreadActions.ts (MIT).

const PIN_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

function isValidPinOrderKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    if (!PIN_ORDER_DIGITS.includes(char)) return false;
  }
  return key.at(-1) !== PIN_ORDER_DIGITS[0];
}

function pinOrderMidpoint(a: string, b: string): string {
  if (b !== "" && a >= b)
    throw new Error("pinOrderMidpoint: bounds out of order");
  if (b !== "") {
    let n = 0;
    while ((a.charAt(n) || PIN_ORDER_DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + pinOrderMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : PIN_ORDER_DIGITS.indexOf(a.charAt(0));
  const digitB =
    b === "" ? PIN_ORDER_DIGITS.length : PIN_ORDER_DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return PIN_ORDER_DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  if (b.length > 1) return b.charAt(0);
  return PIN_ORDER_DIGITS.charAt(digitA) + pinOrderMidpoint(a.slice(1), "");
}

export function pinOrderKeyBetween(
  before: string | null,
  after: string | null,
): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidPinOrderKey(a)) return null;
  if (b !== "" && !isValidPinOrderKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return pinOrderMidpoint(a, b);
}

export function generateSpreadPinOrderKeys(count: number): string[] {
  let width = 2;
  let space = PIN_ORDER_DIGITS.length ** width;
  while (space <= (count + 1) * 2) {
    width += 1;
    space *= PIN_ORDER_DIGITS.length;
  }
  const step = space / (count + 1);
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let value = Math.round(step * (i + 1));
    if (value % PIN_ORDER_DIGITS.length === 0) value += 1;
    let key = "";
    for (let digit = 0; digit < width; digit += 1) {
      key = PIN_ORDER_DIGITS.charAt(value % PIN_ORDER_DIGITS.length) + key;
      value = Math.floor(value / PIN_ORDER_DIGITS.length);
    }
    keys.push(key);
  }
  return keys;
}

export function planPinnedReorder(input: {
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const { orderedIds, keysById, movedId } = input;
  const visibleIds = new Set(orderedIds);
  const reservedKeys = new Set(
    [...keysById].flatMap(([id, key]) =>
      !visibleIds.has(id) && key != null ? [key] : [],
    ),
  );
  const movedIndex = orderedIds.indexOf(movedId);
  if (movedIndex === -1) return [];
  const beforeId = movedIndex > 0 ? orderedIds[movedIndex - 1] : null;
  const afterId =
    movedIndex < orderedIds.length - 1 ? orderedIds[movedIndex + 1] : null;
  const beforeKey = beforeId != null ? (keysById.get(beforeId) ?? null) : null;
  const afterKey = afterId != null ? (keysById.get(afterId) ?? null) : null;
  const beforeUsable = beforeId === null || beforeKey != null;
  const afterUsable = afterId === null || afterKey != null;
  if (beforeUsable && afterUsable) {
    let key = pinOrderKeyBetween(beforeKey, afterKey);
    while (key !== null && reservedKeys.has(key))
      key = pinOrderKeyBetween(key, afterKey);
    if (key !== null) return [{ id: movedId, orderKey: key }];
  }
  const keys = generateSpreadPinOrderKeys(orderedIds.length + reservedKeys.size)
    .filter((key) => !reservedKeys.has(key))
    .slice(0, orderedIds.length);
  return orderedIds.flatMap((id, index) => {
    const key = keys[index]!;
    return keysById.get(id) === key ? [] : [{ id, orderKey: key }];
  });
}

type OrderedThread = {
  readonly id: string;
  readonly createdAtMs: number | null;
  readonly unsettledAtMs?: number | null | undefined;
  readonly pinOrderKey: string | null;
  readonly activeOrderKey: string | null;
};

const compareKeys = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export function comparePinnedThreads(
  left: OrderedThread,
  right: OrderedThread,
): number {
  const leftKey = left.pinOrderKey;
  const rightKey = right.pinOrderKey;
  if (leftKey != null && rightKey == null) return -1;
  if (leftKey == null && rightKey != null) return 1;
  const order =
    leftKey != null && rightKey != null
      ? compareKeys(leftKey, rightKey)
      : (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0);
  return order || left.id.localeCompare(right.id);
}

const activeAnchorMs = (thread: OrderedThread) =>
  Math.max(thread.createdAtMs ?? 0, thread.unsettledAtMs ?? 0);

export function compareActiveThreads(
  left: OrderedThread,
  right: OrderedThread,
): number {
  const leftKey = left.activeOrderKey;
  const rightKey = right.activeOrderKey;
  if (leftKey == null && rightKey != null) return -1;
  if (leftKey != null && rightKey == null) return 1;
  const order =
    leftKey != null && rightKey != null
      ? compareKeys(leftKey, rightKey)
      : activeAnchorMs(right) - activeAnchorMs(left);
  return order || left.id.localeCompare(right.id);
}

export function topOfPinnedRunOrderKey(
  threads: Iterable<Pick<OrderedThread, "pinOrderKey">>,
): string | undefined {
  let firstKey: string | null = null;
  for (const thread of threads) {
    if (thread.pinOrderKey == null) continue;
    if (firstKey === null || thread.pinOrderKey < firstKey)
      firstKey = thread.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}
