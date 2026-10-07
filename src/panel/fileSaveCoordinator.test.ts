// Ported from pingdotgg/t3code v0.0.45 components/files/fileSaveCoordinator.test.ts (MIT).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { advanceTimersByTimeAsync, runAllTimersAsync } from "../test/timers";
import { FileSaveCoordinator } from "./fileSaveCoordinator";

function deferred() {
  let resolve!: (succeeded: boolean) => void;
  const promise = new Promise<boolean>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function persister(results: Promise<boolean>[] = []) {
  const calls: string[] = [];
  const persist = (contents: string) => {
    calls.push(contents);
    return results.shift() ?? Promise.resolve(true);
  };
  return { calls, persist };
}

function coordinatorFor(persist: (contents: string) => Promise<boolean>) {
  const pending: boolean[] = [];
  const confirmed: string[] = [];
  const coordinator = new FileSaveCoordinator({
    debounceMs: 500,
    persist,
    onPendingChange: (value) => pending.push(value),
    onConfirmed: (contents) => confirmed.push(contents),
  });
  return { coordinator, pending, confirmed };
}

describe("FileSaveCoordinator", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("debounces edits and persists only the latest contents", async () => {
    const { calls, persist } = persister();
    const { coordinator, pending, confirmed } = coordinatorFor(persist);

    coordinator.change("first");
    await advanceTimersByTimeAsync(300);
    coordinator.change("latest");
    await advanceTimersByTimeAsync(499);
    assert.deepEqual(calls, []);

    await advanceTimersByTimeAsync(1);
    assert.deepEqual(calls, ["latest"]);
    assert.deepEqual(confirmed, ["latest"]);
    assert.deepEqual(pending, [true, true, false]);
  });

  it("keeps pending state until an edit made during a write is also saved", async () => {
    const firstWrite = deferred();
    const { calls, persist } = persister([firstWrite.promise]);
    const { coordinator, pending } = coordinatorFor(persist);

    coordinator.change("first");
    await advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    await advanceTimersByTimeAsync(500);
    assert.equal(calls.length, 1);

    firstWrite.resolve(true);
    await runAllTimersAsync();
    assert.equal(calls.length, 2);
    assert.equal(calls.at(-1), "latest");
    assert.equal(pending.at(-1), false);
  });

  it("saves an edit made inside the debounce window when the editor closes", async () => {
    const { calls, persist } = persister();
    const { coordinator } = coordinatorFor(persist);

    coordinator.change("unsaved");
    coordinator.dispose();
    await runAllTimersAsync();

    assert.deepEqual(calls, ["unsaved"]);
  });

  it("flushes an edit made while a write was in flight when the editor closes", async () => {
    const inFlight = deferred();
    const { calls, persist } = persister([inFlight.promise]);
    const { coordinator } = coordinatorFor(persist);

    coordinator.change("first");
    await advanceTimersByTimeAsync(500);
    coordinator.change("latest");
    coordinator.dispose();
    inFlight.resolve(true);
    await runAllTimersAsync();

    assert.equal(calls.length, 2);
    assert.equal(calls.at(-1), "latest");
  });

  it("does not rewrite a write that lands while the editor closes", async () => {
    const inFlight = deferred();
    const { calls, persist } = persister([inFlight.promise]);
    const { coordinator } = coordinatorFor(persist);

    coordinator.change("only");
    await advanceTimersByTimeAsync(500);
    coordinator.dispose();
    inFlight.resolve(true);
    await runAllTimersAsync();

    assert.deepEqual(calls, ["only"]);
  });

  it("retries a failed write when the editor closes", async () => {
    const { calls, persist } = persister([Promise.resolve(false)]);
    const { coordinator } = coordinatorFor(persist);

    coordinator.change("latest");
    await advanceTimersByTimeAsync(500);
    assert.equal(calls.length, 1);

    coordinator.dispose();
    await runAllTimersAsync();

    assert.equal(calls.length, 2);
    assert.equal(calls.at(-1), "latest");
  });

  it("leaves the file pending when the latest write fails", async () => {
    const { coordinator, pending } = coordinatorFor(async () => false);

    coordinator.change("latest");
    await advanceTimersByTimeAsync(500);
    assert.ok(pending.includes(true));
    assert.ok(!pending.includes(false));
  });

  it("ignores editor changes emitted after disposal", async () => {
    const { calls, persist } = persister();
    const { coordinator, pending } = coordinatorFor(persist);

    coordinator.dispose();
    coordinator.change("stale contents");
    await runAllTimersAsync();

    assert.deepEqual(calls, []);
    assert.deepEqual(pending, []);
  });

  it("does not persist confirmed contents again on disposal", async () => {
    const { calls, persist } = persister();
    const { coordinator } = coordinatorFor(persist);

    coordinator.change("temporary edit");
    await advanceTimersByTimeAsync(500);
    coordinator.change("original contents");
    await advanceTimersByTimeAsync(500);
    assert.equal(calls.length, 2);

    coordinator.dispose();
    await runAllTimersAsync();

    assert.equal(calls.length, 2);
  });
});
