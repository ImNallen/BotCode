import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreferencesProvider, usePreferences } from "./preferences";
import { categories } from "./settingsCatalog";

function storedMeter(stored: unknown) {
  let observed: boolean | undefined;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => JSON.stringify(stored) },
  });
  function Inspect() {
    observed = usePreferences().preferences.contextWindowMeter;
    return null;
  }
  try {
    renderToStaticMarkup(
      createElement(PreferencesProvider, { children: createElement(Inspect) }),
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  return observed;
}

it("shows the context window indicator unless it was turned off", () => {
  assert.equal(storedMeter({ appearance: "dark" }), true);
  assert.equal(storedMeter({ contextWindowMeter: "invalid" }), true);
  assert.equal(storedMeter({ contextWindowMeter: false }), false);
  const application = categories.general.groups.find(
    (group) => group.id === "application",
  );
  assert.ok(
    application?.rows.some(
      (row) =>
        row.id === "context-window-indicator" &&
        row.title === "Context window indicator",
    ),
  );
});

function storedNotifications(stored: unknown) {
  let observed: { mode: string; inApp: boolean } | undefined;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => JSON.stringify(stored) },
  });
  function Inspect() {
    const { preferences } = usePreferences();
    observed = {
      mode: preferences.notificationMode,
      inApp: preferences.inAppNotificationsEnabled,
    };
    return null;
  }
  try {
    renderToStaticMarkup(
      createElement(PreferencesProvider, { children: createElement(Inspect) }),
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  return observed;
}

it("starts notifications off and restores each stored mode independently from in-app notifications", () => {
  assert.deepEqual(storedNotifications({}), { mode: "off", inApp: false });
  assert.deepEqual(
    storedNotifications({
      notificationMode: "both",
      inAppNotificationsEnabled: "yes",
    }),
    { mode: "off", inApp: false },
  );
  for (const notificationMode of [
    "off",
    "notifications",
    "sound",
    "notifications-and-sound",
  ]) {
    assert.deepEqual(
      storedNotifications({
        notificationMode,
        inAppNotificationsEnabled: true,
      }),
      { mode: notificationMode, inApp: true },
    );
  }
});

it("defaults follow-ups to Queue, persists Steer and restores Queue with defaults", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let stored: unknown = {};
  let observed: string | undefined;
  let reset: (() => void) | undefined;
  let update: ReturnType<typeof usePreferences>["update"] | undefined;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => JSON.stringify(stored),
      setItem: (_key: string, text: string) => {
        stored = JSON.parse(text);
      },
    },
  });
  function Inspect() {
    const state = usePreferences();
    observed = state.preferences.followUpBehavior;
    reset = state.reset;
    update = state.update;
    return null;
  }
  const render = () =>
    renderToStaticMarkup(
      createElement(PreferencesProvider, { children: createElement(Inspect) }),
    );
  try {
    render();
    assert.equal(observed, "queue");
    stored = { followUpBehavior: "invalid" };
    render();
    assert.equal(observed, "queue");
    assert.ok(update);
    update({ followUpBehavior: "steer" });
    render();
    assert.equal(observed, "steer");
    assert.ok(reset);
    reset();
    render();
    assert.equal(observed, "queue");
    assert.ok(
      categories.general.groups
        .flatMap((group) => group.rows)
        .some((row) => row.id === "follow-up-behavior"),
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
