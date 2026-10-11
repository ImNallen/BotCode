import assert from "node:assert/strict";
import { it } from "node:test";
import { persistentStorage } from "../lib/storage";
import {
  completeOnboarding,
  ONBOARDING_COMPLETED_KEY,
  resolveFirstRun,
} from "./firstRun";

it("waits for authoritative workspace evidence before choosing a fresh install", async () => {
  const store = persistentStorage(async () => {});
  let finish: ((workspaces: readonly unknown[]) => void) | undefined;
  let resolved = false;
  const decision = resolveFirstRun(
    store,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  ).then((result) => {
    resolved = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(resolved, false);
  finish?.([]);
  assert.equal(await decision, "wizard");
  assert.equal(store.getItem(ONBOARDING_COMPLETED_KEY), null);
});
it("never opens the workspace after an authoritative read fails", async () => {
  const store = persistentStorage(async () => {});
  await assert.rejects(
    resolveFirstRun(store, async () => {
      throw new Error("read failed");
    }),
    /read failed/,
  );
  assert.equal(store.getItem(ONBOARDING_COMPLETED_KEY), null);
  assert.equal(await resolveFirstRun(store, async () => []), "wizard");
});
it("durably marks an existing workspace before letting it through", async () => {
  let save: (() => void) | undefined;
  const store = persistentStorage(
    () =>
      new Promise<void>((resolve) => {
        save = resolve;
      }),
  );
  let resolved = false;
  const result = resolveFirstRun(store, async () => [{ id: "existing" }]).then(
    (decision) => {
      resolved = true;
      return decision;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(store.getItem(ONBOARDING_COMPLETED_KEY), null);
  save?.();
  assert.equal(await result, "app");
  assert.ok(store.getItem(ONBOARDING_COMPLETED_KEY));
});
it("retains recoverable first-run state when saving fails, then retries", async () => {
  let fail = true;
  const store = persistentStorage(async () => {
    if (fail) throw new Error("disk full");
  });
  await assert.rejects(completeOnboarding(store), /disk full/);
  assert.equal(store.getItem(ONBOARDING_COMPLETED_KEY), null);
  fail = false;
  await completeOnboarding(store);
  assert.equal(
    await resolveFirstRun(store, async () => {
      throw new Error("must not read");
    }),
    "app",
  );
});
it("does not reopen onboarding after removing all projects or resetting preferences", async () => {
  const store = persistentStorage(async () => {});
  await completeOnboarding(store);
  await store.removeItemDurable("preferences");
  assert.equal(await resolveFirstRun(store, async () => []), "app");
});
it("holds legacy installs in recovery if marking completion cannot be saved", async () => {
  const store = persistentStorage(async () => {
    throw new Error("disk full");
  });
  await assert.rejects(
    resolveFirstRun(store, async () => [{ id: "existing" }]),
    /disk full/,
  );
  assert.equal(store.getItem(ONBOARDING_COMPLETED_KEY), null);
});
