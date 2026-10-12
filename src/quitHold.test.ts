import assert from "node:assert/strict";
import { it } from "node:test";
import {
  HOLD_HINT_LINGER_MS,
  quitHintMessage,
  quitHintReceiver,
  quitShortcutHint,
  type QuitHintMode,
} from "./quitHold";

function fakeReceiver() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const shown: (QuitHintMode | null)[] = [];
  const receiver = quitHintReceiver((mode) => shown.push(mode), {
    set: (run, ms) => {
      timers.set(++nextId, { at: now + ms, run });
      return nextId;
    },
    clear: (id) => {
      if (id !== undefined) timers.delete(id);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.run();
    }
  };
  return { receiver, shown, advance, visible: () => shown.at(-1) ?? null };
}

it("words the hint for each mode with the platform's quit chord", () => {
  assert.equal(
    quitHintMessage("hold", "MacIntel"),
    "Hold ⌘Q or press twice to quit",
  );
  assert.equal(
    quitHintMessage("double-click", "MacIntel"),
    "Press ⌘Q again to quit",
  );
  assert.equal(
    quitHintMessage("hold", "Win32"),
    "Hold Ctrl+Q or press twice to quit",
  );
  assert.equal(
    quitHintMessage("double-click", "Linux x86_64"),
    "Press Ctrl+Q again to quit",
  );
});

it("keeps a released hold hint for 1200 ms, then hides it", () => {
  const { receiver, advance, visible } = fakeReceiver();
  receiver.receive({ state: "down", mode: "hold" });
  assert.equal(visible(), "hold");
  receiver.receive({ state: "up" });
  advance(HOLD_HINT_LINGER_MS - 1);
  assert.equal(visible(), "hold");
  advance(1);
  assert.equal(HOLD_HINT_LINGER_MS, 1200);
  assert.equal(visible(), null);
});

it("hides a double-press hint as soon as its window closes", () => {
  const { receiver, shown } = fakeReceiver();
  receiver.receive({ state: "down", mode: "double-click" });
  receiver.receive({ state: "up" });
  assert.deepEqual(shown, ["double-click", null]);
});

it("keeps a new press visible when an earlier hold hint was lingering", () => {
  const { receiver, advance, visible } = fakeReceiver();
  receiver.receive({ state: "down", mode: "hold" });
  receiver.receive({ state: "up" });
  advance(600);
  receiver.receive({ state: "down", mode: "double-click" });
  advance(HOLD_HINT_LINGER_MS);
  assert.equal(visible(), "double-click");
});

it("drops a pending hide when disposed", () => {
  const { receiver, advance, shown } = fakeReceiver();
  receiver.receive({ state: "down", mode: "hold" });
  receiver.receive({ state: "up" });
  receiver.dispose();
  advance(HOLD_HINT_LINGER_MS);
  assert.deepEqual(shown, ["hold"]);
});

it("accepts only the shell's down and up hints", () => {
  assert.ok(
    quitShortcutHint.safeParse({ state: "down", mode: "double-click" }).success,
  );
  assert.ok(quitShortcutHint.safeParse({ state: "up" }).success);
  assert.ok(
    !quitShortcutHint.safeParse({ state: "down", mode: "direct" }).success,
  );
  assert.ok(!quitShortcutHint.safeParse({ state: "down" }).success);
});
