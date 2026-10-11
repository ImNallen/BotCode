import assert from "node:assert/strict";
import { it } from "node:test";
import { watchPermissionStatus } from "./permissionPolling";

function environment() {
  const focus = new EventTarget();
  const visibility = new EventTarget();
  let interval: (() => void) | undefined;
  let cleared = false;
  const window = {
    addEventListener: focus.addEventListener.bind(focus),
    removeEventListener: focus.removeEventListener.bind(focus),
    setInterval: (callback: TimerHandler, delay?: number) => {
      assert.equal(delay, 1500);
      interval = () => {
        if (typeof callback === "function") callback();
      };
      return 1;
    },
    clearInterval: (id?: number) => {
      assert.equal(id, 1);
      cleared = true;
    },
  };
  const document: { visibilityState: DocumentVisibilityState } & Pick<
    Document,
    "addEventListener" | "removeEventListener"
  > = {
    visibilityState: "visible",
    addEventListener: visibility.addEventListener.bind(visibility),
    removeEventListener: visibility.removeEventListener.bind(visibility),
  };
  return {
    window,
    document,
    tick: () => interval?.(),
    focus: () => focus.dispatchEvent(new Event("focus")),
    visibility: () => visibility.dispatchEvent(new Event("visibilitychange")),
    cleared: () => cleared,
  };
}
it("polls initially, refuses overlap, refreshes on focus and visibility, and skips hidden pages", async () => {
  const env = environment();
  let count = 0;
  let resolve: ((value: boolean) => void) | undefined;
  const statuses: boolean[] = [];
  const stop = watchPermissionStatus({
    ...env,
    check: () => {
      count++;
      return new Promise<boolean>((done) => {
        resolve = done;
      });
    },
    onStatus: (value) => statuses.push(value),
    onError: () => {},
  });
  assert.equal(count, 1);
  env.tick();
  env.focus();
  env.visibility();
  assert.equal(count, 1);
  resolve?.(true);
  await Promise.resolve();
  assert.deepEqual(statuses, [true]);
  env.document.visibilityState = "hidden";
  env.tick();
  env.focus();
  env.visibility();
  assert.equal(count, 1);
  env.document.visibilityState = "visible";
  env.visibility();
  assert.equal(count, 2);
  resolve?.(false);
  await Promise.resolve();
  env.focus();
  assert.equal(count, 3);
  stop();
  resolve?.(true);
  await Promise.resolve();
  assert.deepEqual(statuses, [true, false]);
  env.focus();
  env.visibility();
  env.tick();
  assert.equal(count, 3);
  assert.equal(env.cleared(), true);
});
it("reports failed checks, retries and clears the error only after a successful observation", async () => {
  const env = environment();
  let fail = true;
  const errors: (string | null)[] = [];
  const statuses: boolean[] = [];
  const stop = watchPermissionStatus({
    ...env,
    check: async () => {
      if (fail) throw new Error("unavailable");
      return false;
    },
    onStatus: (value) => statuses.push(value),
    onError: (value) => errors.push(value),
  });
  await Promise.resolve();
  assert.deepEqual(errors, [
    "Could not check permissions. We'll try again automatically.",
  ]);
  assert.deepEqual(statuses, []);
  fail = false;
  env.tick();
  await Promise.resolve();
  assert.deepEqual(statuses, [false]);
  assert.equal(errors.at(-1), null);
  stop();
});
it("drops a late failure after disposal", async () => {
  const env = environment();
  let reject: ((error: Error) => void) | undefined;
  const stop = watchPermissionStatus({
    ...env,
    check: () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
    onStatus: () => assert.fail("late status"),
    onError: () => assert.fail("late error"),
  });
  stop();
  reject?.(new Error("late"));
  await Promise.resolve();
});
