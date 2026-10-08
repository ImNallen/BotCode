import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreferencesProvider, usePreferences } from "./preferences";
import { categories, visibleRows } from "./settingsCatalog";

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

it("starts the preferred editor automatic, persists a choice and restores automatic with defaults", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let stored: unknown = { preferredEditor: "sublime" };
  let observed: string | null | undefined;
  let state: ReturnType<typeof usePreferences> | undefined;
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
    state = usePreferences();
    observed = state.preferences.preferredEditor;
    return null;
  }
  const render = () =>
    renderToStaticMarkup(
      createElement(PreferencesProvider, { children: createElement(Inspect) }),
    );
  try {
    render();
    assert.equal(observed, null);
    state?.update({ preferredEditor: "zed" });
    assert.equal(
      (stored as { preferredEditor?: unknown }).preferredEditor,
      "zed",
    );
    render();
    assert.equal(observed, "zed");
    state?.reset();
    render();
    assert.equal(observed, null);
    assert.ok(
      categories.general.groups
        .flatMap((group) => group.rows)
        .some(
          (row) =>
            row.id === "preferred-editor" && row.title === "Preferred editor",
        ),
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

it("defaults Working off, saves it on this device, and resets it without a project override", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let stored: unknown = {};
  let observed: boolean | undefined;
  let update: ReturnType<typeof usePreferences>["update"] | undefined;
  let reset: (() => void) | undefined;
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
    observed = state.preferences.sidebarWorkingShelfEnabled;
    update = state.update;
    reset = state.reset;
    return null;
  }
  const render = () =>
    renderToStaticMarkup(
      createElement(PreferencesProvider, { children: createElement(Inspect) }),
    );
  try {
    render();
    assert.equal(observed, false);
    stored = { sidebarWorkingShelfEnabled: "yes" };
    render();
    assert.equal(observed, false);
    assert.ok(update);
    update({ sidebarWorkingShelfEnabled: true });
    render();
    assert.equal(observed, true);
    update({ sidebarWorkingShelfEnabled: false });
    render();
    assert.equal(observed, false);
    update({ sidebarWorkingShelfEnabled: true });
    assert.ok(reset);
    reset();
    render();
    assert.equal(observed, false);
    const row = categories.general.groups
      .flatMap((group) => group.rows)
      .find((row) => row.id === "working-shelf");
    assert.equal(row?.title, "Working section (beta)");
    assert.equal(row?.setting, undefined);
    const organization = categories.general.groups.find(
      (group) => group.id === "organization",
    );
    assert.ok(organization);
    for (const scope of [
      { kind: "all" },
      {
        kind: "project",
        workspace: {
          id: "67ce24cf-70e2-44b3-99f4-53bd8d155d19",
          root: "/project",
          label: "Project",
          kind: "repository",
        },
      },
    ] satisfies Array<import("./settingsScope").SettingsScope>) {
      assert.ok(
        visibleRows(organization, scope)?.some(
          (row) => row.id === "working-shelf",
        ),
      );
    }
    assert.equal(
      Object.prototype.hasOwnProperty.call(stored, "projectOverrides"),
      true,
    );
    assert.ok(
      /hide fold running monitoring threads inbox sidebar shelf/.test(
        row?.keywords ?? "",
      ),
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
