import nodeAssert from "node:assert/strict";

export { describe, it } from "node:test";

export const assert = {
  deepEqual: (actual: unknown, expected: unknown) =>
    nodeAssert.deepEqual(actual, expected),
  equal: (actual: unknown, expected: unknown) =>
    nodeAssert.equal(actual, expected),
  isTrue: (value: unknown) => nodeAssert.equal(value, true),
  isFalse: (value: unknown) => nodeAssert.equal(value, false),
  deepInclude: (
    actual: object | undefined,
    expected: Record<string, unknown>,
  ) => {
    nodeAssert.ok(actual, "deepInclude target is undefined");
    const picked = Object.fromEntries(
      Object.keys(expected).map((key) => [key, Reflect.get(actual, key)]),
    );
    nodeAssert.deepEqual(picked, expected);
  },
};
