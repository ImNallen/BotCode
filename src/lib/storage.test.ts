import assert from "node:assert/strict";
import { it } from "node:test";
import { persistentStorage } from "./storage";

it("keeps scoped drafts visible across a fast round trip while disk writes are pending", async () => {
  let finish: (() => void) | undefined;
  const writes: [string, string | null][] = [];
  const store = persistentStorage(async (key, value) => {
    writes.push([key, value]);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  store.load({ "composer-draft:a": "old a", "composer-draft:b": "old b" });
  const save = store.setItem("composer-draft:a", "edited a");
  assert.equal(store.getItem("composer-draft:b"), "old b");
  assert.equal(store.getItem("composer-draft:a"), "edited a");
  await Promise.resolve();
  finish?.();
  await save;
  assert.deepEqual(writes, [["composer-draft:a", "edited a"]]);
  assert.equal(store.getItem("composer-draft:a"), "edited a");
});

it("publishes durable stash state only after success and restores the committed cache on failure", async () => {
  let fail: ((cause: Error) => void) | undefined;
  const store = persistentStorage(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  store.load({ stash: "kept" });
  const save = store.setItemDurable("stash", "new");
  assert.equal(store.getItem("stash"), "kept");
  await Promise.resolve();
  fail?.(new Error("disk full"));
  await assert.rejects(save, /disk full/);
  assert.equal(store.getItem("stash"), "kept");
});

it("does not roll an older failed write over newer input", async () => {
  const finishers: { resolve: () => void; reject: (cause: Error) => void }[] =
    [];
  const store = persistentStorage(
    () =>
      new Promise<void>((resolve, reject) =>
        finishers.push({ resolve, reject }),
      ),
  );
  store.load({ draft: "original" });
  const old = store.setItem("draft", "older");
  const latest = store.setItem("draft", "latest");
  await Promise.resolve();
  finishers[0]?.reject(new Error("old failed"));
  await assert.rejects(old, /old failed/);
  assert.equal(store.getItem("draft"), "latest");
  await Promise.resolve();
  finishers[1]?.resolve();
  await latest;
  assert.equal(store.getItem("draft"), "latest");
});
