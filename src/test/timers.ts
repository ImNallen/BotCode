import { mock } from "node:test";

export const settle = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

// Async variants of Vitest's fake-timer helpers: node:test's mock timers fire
// synchronously, so promise continuations that schedule the next timer need a
// settle between ticks.
export async function advanceTimersByTimeAsync(milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 1) {
    mock.timers.tick(1);
    await settle();
  }
}

export async function runAllTimersAsync() {
  for (let round = 0; round < 10; round += 1) {
    await settle();
    mock.timers.runAll();
  }
  await settle();
}
