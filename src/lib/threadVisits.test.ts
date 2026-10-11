import assert from "node:assert/strict";
import { it } from "node:test";
import { persistentStorage } from "./storage";
import {
  THREAD_VISITS_KEY,
  createThreadVisitStore,
  hasUnseenCompletion,
  isOpenThreadWokeVisible,
  isThreadWoke,
  markThreadUnread,
  markThreadVisited,
} from "./threadVisits";

it("never moves a visit backward", () => {
  const visited = markThreadVisited({}, "a", 5_000);
  assert.deepEqual(visited, { a: 5_000 });
  assert.equal(markThreadVisited(visited, "a", 4_000), visited);
  assert.equal(markThreadVisited(visited, "a", 5_000), visited);
  assert.deepEqual(markThreadVisited(visited, "a", 6_000), { a: 6_000 });
  assert.deepEqual(markThreadVisited(visited, "b", 1_000), {
    a: 5_000,
    b: 1_000,
  });
  assert.equal(markThreadVisited(visited, "a", Number.NaN), visited);
});

it("marks a thread unread one millisecond before its latest completion", () => {
  const visits = { a: 9_000 };
  assert.deepEqual(markThreadUnread(visits, "a", 7_000), { a: 6_999 });
  assert.equal(markThreadUnread(visits, "a", null), visits);
  assert.equal(markThreadUnread(visits, "a", undefined), visits);
  const unread = { a: 6_999 };
  assert.equal(markThreadUnread(unread, "a", 7_000), unread);
});

it("shows Woke until a visit at or after the wake", () => {
  const woke = (wokeAtMs: number | null, lastVisitedAtMs?: number) =>
    isThreadWoke({ wokeAtMs, lastVisitedAtMs, settled: false });
  assert.equal(woke(null), false);
  assert.equal(woke(null, 1_000), false);
  assert.equal(woke(10_000), true);
  assert.equal(woke(10_000, 2_000), true);
  assert.equal(woke(10_000, 9_999), true);
  assert.equal(woke(10_000, Number.NaN), true);
  assert.equal(woke(10_000, 10_000), false);
  assert.equal(woke(10_000, 12_000), false);
  assert.equal(
    isThreadWoke({ wokeAtMs: 10_000, lastVisitedAtMs: 2_000, settled: true }),
    false,
  );
});

it("shows the open thread's Woke banner until a visit or a later completion", () => {
  const visible = (
    lastVisitedAtMs: number | undefined,
    latestCompletedAtMs: number | null,
    settled = false,
  ) =>
    isOpenThreadWokeVisible({
      wokeAtMs: 10_000,
      lastVisitedAtMs,
      latestCompletedAtMs,
      settled,
    });
  assert.equal(visible(4_000, 4_000), true);
  assert.equal(visible(10_000, 4_000), false);
  assert.equal(visible(4_000, 10_500), false);
  assert.equal(visible(4_000, 4_000, true), false);
  assert.equal(visible(undefined, null), true);
  assert.equal(visible(Number.NaN, 4_000), true);
  assert.equal(
    isOpenThreadWokeVisible({
      wokeAtMs: null,
      lastVisitedAtMs: undefined,
      latestCompletedAtMs: null,
      settled: false,
    }),
    false,
  );
});

it("keeps visits across a restart through the device storage", async () => {
  const disk = new Map<string, string>();
  const write = async (key: string, value: string | null) => {
    if (value === null) disk.delete(key);
    else disk.set(key, value);
  };
  const before = createThreadVisitStore(persistentStorage(write));
  let notified = 0;
  before.subscribe(() => notified++);
  before.markVisited("a", 2_000);
  before.markVisited("a", 1_000);
  before.markUnread("b", 7_000);
  assert.equal(notified, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const restarted = persistentStorage(write);
  restarted.load(Object.fromEntries(disk));
  assert.deepEqual(createThreadVisitStore(restarted).read(), {
    a: 2_000,
    b: 6_999,
  });
});

it("drops malformed stored visits without losing valid ones", () => {
  const saved = persistentStorage(async () => {});
  saved.load({
    [THREAD_VISITS_KEY]: JSON.stringify({ a: 3_000, b: "soon", "": 1 }),
  });
  assert.deepEqual(createThreadVisitStore(saved).read(), { a: 3_000 });
  const corrupt = persistentStorage(async () => {});
  corrupt.load({ [THREAD_VISITS_KEY]: "{" });
  assert.deepEqual(createThreadVisitStore(corrupt).read(), {});
});

it("shows Done for a completion after the last visit, until the thread is visited again", () => {
  const visits = createThreadVisitStore(persistentStorage(async () => {}));
  const done = (latestCompletedAtMs: number | null) =>
    hasUnseenCompletion({
      latestCompletedAtMs,
      lastVisitedAtMs: visits.read().a,
    });
  assert.equal(done(5_000), false, "never visited counts as read");
  visits.markVisited("a", 5_000);
  assert.equal(done(5_000), false, "visiting the completion reads it");
  assert.equal(done(8_000), true, "a later completion is unread");
  assert.equal(done(null), false, "a running turn has no completion");
  visits.markVisited("a", 8_000);
  assert.equal(done(8_000), false);
  visits.markUnread("a", 8_000);
  assert.equal(done(8_000), true, "Mark unread brings Done back");
  visits.markVisited("a", 8_000);
  assert.equal(done(8_000), false, "opening the thread clears it");
  visits.markUnread("b", null);
  assert.equal(
    hasUnseenCompletion({
      latestCompletedAtMs: null,
      lastVisitedAtMs: visits.read().b,
    }),
    false,
    "Mark unread without a completion does nothing",
  );
});
