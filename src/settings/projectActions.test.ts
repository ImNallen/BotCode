import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreferencesProvider, usePreferences } from "./preferences";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  buildProjectScript,
  updateProjectScripts,
  scriptEditorInput,
} from "./projectActions";
import { nextProjectScriptId } from "../chat/projectScripts";
import { projectScript } from "../ipc";

it("edits action metadata, keeps identity and replaces the single setup action", () => {
  const existing = buildProjectScript("install", {
    ...EMPTY_PROJECT_SCRIPT_INPUT,
    name: "Install",
    command: "pnpm i",
    runOnWorktreeCreate: true,
    waitForSetup: true,
  });
  const input = {
    ...EMPTY_PROJECT_SCRIPT_INPUT,
    name: " Dev ",
    command: " pnpm dev ",
    runOnWorktreeCreate: true,
    waitForSetup: true,
    previewUrl: " http://localhost:5173 ",
    autoOpenPreview: true,
  };
  const actions = updateProjectScripts([existing], "dev", input, true);
  assert.equal(actions[0]?.runOnWorktreeCreate, false);
  assert.equal(actions[1]?.async, false);
  assert.equal(actions[1]?.name, "Dev");
  assert.equal(actions[1]?.previewUrl, "http://localhost:5173");
  assert.equal(actions[1]?.autoOpenPreview, true);
  const edited = updateProjectScripts(
    actions,
    "dev",
    { ...input, name: "Renamed", runOnWorktreeCreate: false, previewUrl: null },
    false,
  );
  assert.equal(edited.length, 2);
  assert.equal(edited[1]?.id, "dev");
  assert.equal(edited[1]?.async, true);
  assert.equal(edited[1]?.autoOpenPreview, false);
  assert.equal(scriptEditorInput(existing, "mod+shift+i").waitForSetup, true);
  assert.equal(nextProjectScriptId("Dev", ["dev", "dev-2"]), "dev-3");
  assert.ok(
    nextProjectScriptId("A name much longer than twenty four letters", [])
      .length <= 24,
  );
  assert.equal(
    projectScript.safeParse({ ...existing, name: " ", icon: "unknown" })
      .success,
    false,
  );
});

it("saves T3 settings overrides, restores defaults and leaves shared files to the backend", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let stored: unknown = {};
  let context: ReturnType<typeof usePreferences> | undefined;
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
    context = usePreferences();
    return null;
  }
  const render = () =>
    renderToStaticMarkup(
      createElement(PreferencesProvider, { children: createElement(Inspect) }),
    );
  const id = "00000000-0000-4000-8000-000000000001";
  const action = buildProjectScript("dev", {
    ...EMPTY_PROJECT_SCRIPT_INPUT,
    name: "Dev",
    command: "pnpm dev",
  });
  try {
    render();
    assert.ok(context);
    await context.saveActions(undefined, [action]);
    await context.saveActions(id, [
      {
        ...action,
        runOnWorktreeCreate: true,
        async: false,
        previewUrl: "http://localhost:5173",
        autoOpenPreview: true,
      },
    ]);
    let raw = stored as {
      defaultProjectScripts: unknown[];
      projectSettingsOverrides: Record<
        string,
        { defaultProjectScripts: unknown[] }
      >;
    };
    assert.deepEqual(raw.defaultProjectScripts, [
      {
        id: "dev",
        name: "Dev",
        command: "pnpm dev",
        icon: "play",
        runOnWorktreeCreate: false,
      },
    ]);
    assert.deepEqual(raw.projectSettingsOverrides[id]?.defaultProjectScripts, [
      {
        id: "dev",
        name: "Dev",
        command: "pnpm dev",
        icon: "play",
        runOnWorktreeCreate: true,
        async: false,
        previewUrl: "http://localhost:5173",
        autoOpenPreview: true,
      },
    ]);
    render();
    assert.equal(
      context.preferences.projectSettingsOverrides[id]
        ?.defaultProjectScripts?.[0]?.async,
      false,
    );
    await context.saveActions(id, []);
    render();
    assert.deepEqual(
      context.preferences.projectSettingsOverrides[id]?.defaultProjectScripts,
      [],
    );
    await context.saveActions(id, null);
    render();
    assert.equal(context.preferences.projectSettingsOverrides[id], undefined);
    assert.equal(context.preferences.defaultProjectScripts[0]?.async, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
