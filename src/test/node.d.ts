declare module "node:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void): void;
  export function beforeEach(fn: () => void): void;
  export function afterEach(fn: () => void): void;
  export const mock: {
    timers: {
      enable(options?: { apis?: ("setTimeout" | "Date")[] }): void;
      tick(milliseconds: number): void;
      runAll(): void;
      reset(): void;
    };
  };
}

declare function setImmediate(callback: () => void): unknown;

declare module "node:assert/strict" {
  const assert: {
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
  };
  export default assert;
}
