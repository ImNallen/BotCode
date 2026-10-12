// The vitest subset T3's ported suites use, over node:test and node:assert, so
// a T3 test file carries over with its import line changed.
import assert from "node:assert/strict";
import { inspect, isDeepStrictEqual } from "node:util";

export { describe, it } from "node:test";

const asymmetric = Symbol("asymmetric matcher");
type AsymmetricMatcher = {
  [asymmetric]: (actual: unknown) => boolean;
  toString(): string;
};

function isAsymmetric(value: unknown): value is AsymmetricMatcher {
  return typeof value === "object" && value !== null && asymmetric in value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// vitest toEqual: recursive equality that ignores undefined properties.
function equals(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected[asymmetric](actual);
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => equals(actual[index], item))
    );
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const defined = (object: Record<string, unknown>) =>
      Object.keys(object).filter((key) => object[key] !== undefined);
    const keys = defined(expected);
    return (
      keys.length === defined(actual).length &&
      keys.every((key) => equals(actual[key], expected[key]))
    );
  }
  return isDeepStrictEqual(actual, expected);
}

// vitest toMatchObject: every expected property matches, extra actual properties are fine.
function matchesObject(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected[asymmetric](actual);
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => matchesObject(actual[index], item))
    );
  if (typeof expected === "object" && expected !== null)
    return (
      typeof actual === "object" &&
      actual !== null &&
      Object.entries(expected).every(([key, value]) =>
        matchesObject(Reflect.get(actual, key), value),
      )
    );
  return Object.is(actual, expected);
}

type Mock = ((...args: unknown[]) => unknown) & {
  mock: { calls: unknown[][] };
};

function isMock(value: unknown): value is Mock {
  return typeof value === "function" && "mock" in value;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function messageMatches(error: unknown, expected?: string | RegExp): boolean {
  if (error === undefined) return false;
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  return typeof expected === "string"
    ? message.includes(expected)
    : expected.test(message);
}

type Result = [pass: boolean, describe: string];

function matchers(actual: unknown) {
  const show = (value: unknown) => inspect(value, { depth: 6 });
  const calls = () => {
    assert.ok(isMock(actual), `${show(actual)} is not a vi.fn() mock`);
    return actual.mock.calls.length;
  };
  return {
    toBe: (expected: unknown): Result => [
      Object.is(actual, expected),
      `${show(actual)} to be ${show(expected)}`,
    ],
    toEqual: (expected: unknown): Result => [
      equals(actual, expected),
      `${show(actual)} to equal ${show(expected)}`,
    ],
    toMatchObject: (expected: unknown): Result => [
      matchesObject(actual, expected),
      `${show(actual)} to match ${show(expected)}`,
    ],
    toMatch: (expected: RegExp | string): Result => [
      typeof actual === "string" &&
        (typeof expected === "string"
          ? actual.includes(expected)
          : expected.test(actual)),
      `${show(actual)} to match ${show(expected)}`,
    ],
    toBeNull: (): Result => [actual === null, `${show(actual)} to be null`],
    toBeUndefined: (): Result => [
      actual === undefined,
      `${show(actual)} to be undefined`,
    ],
    toHaveLength: (length: number): Result => [
      (actual as { length?: unknown } | null)?.length === length,
      `${show(actual)} to have length ${length}`,
    ],
    toHaveProperty: (key: string): Result => [
      typeof actual === "object" && actual !== null && key in actual,
      `${show(actual)} to have property ${key}`,
    ],
    toBeGreaterThan: (expected: number): Result => [
      (actual as number) > expected,
      `${show(actual)} to be greater than ${expected}`,
    ],
    toBeGreaterThanOrEqual: (expected: number): Result => [
      (actual as number) >= expected,
      `${show(actual)} to be at least ${expected}`,
    ],
    toBeLessThan: (expected: number): Result => [
      (actual as number) < expected,
      `${show(actual)} to be less than ${expected}`,
    ],
    toBeCloseTo: (expected: number, digits = 2): Result => [
      Math.abs((actual as number) - expected) < 10 ** -digits / 2,
      `${show(actual)} to be close to ${expected}`,
    ],
    toThrow: (expected?: string | RegExp): Result => [
      messageMatches(thrown(actual as () => unknown), expected),
      `function to throw ${show(expected)}`,
    ],
    toHaveBeenCalled: (): Result => [calls() > 0, "mock to have been called"],
    toHaveBeenCalledOnce: (): Result => [
      calls() === 1,
      `mock to have been called once, got ${calls()}`,
    ],
    toHaveBeenCalledTimes: (times: number): Result => [
      calls() === times,
      `mock to have been called ${times} times, got ${calls()}`,
    ],
  };
}

type Matchers = ReturnType<typeof matchers>;
type Assertions = {
  [K in keyof Matchers]: (...args: Parameters<Matchers[K]>) => void;
};

function assertions(actual: unknown, negate: boolean): Assertions {
  const table = matchers(actual);
  return Object.fromEntries(
    Object.entries(table).map(([name, matcher]) => [
      name,
      (...args: unknown[]) => {
        const [pass, description] = (matcher as (...args: unknown[]) => Result)(
          ...args,
        );
        assert.ok(
          pass !== negate,
          `Expected ${negate ? "not " : ""}${description}`,
        );
      },
    ]),
  ) as Assertions;
}

export function expect(actual: unknown) {
  return {
    ...assertions(actual, false),
    not: assertions(actual, true),
    rejects: {
      toThrow: async (expected?: string | RegExp) => {
        let error: unknown;
        try {
          await actual;
        } catch (cause) {
          error = cause;
        }
        assert.ok(
          messageMatches(error, expected),
          `Expected promise to reject with ${inspect(expected)}, got ${inspect(error)}`,
        );
      },
    },
  };
}

expect.objectContaining = (
  expected: Record<string, unknown>,
): AsymmetricMatcher => ({
  [asymmetric]: (actual) => matchesObject(actual, expected),
  toString: () => `objectContaining(${inspect(expected)})`,
});

const stubbed = new Map<string, PropertyDescriptor | undefined>();

export const vi = {
  fn<Args extends unknown[], Return>(
    implementation?: (...args: Args) => Return,
  ): ((...args: Args) => Return | undefined) & { mock: { calls: Args[] } } {
    const calls: Args[] = [];
    return Object.assign(
      (...args: Args) => {
        calls.push(args);
        return implementation?.(...args);
      },
      { mock: { calls } },
    );
  },
  stubGlobal(name: string, value: unknown): void {
    if (!stubbed.has(name))
      stubbed.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  },
  unstubAllGlobals(): void {
    for (const [name, descriptor] of stubbed) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    stubbed.clear();
  },
};
