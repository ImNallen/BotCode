import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ProviderCapabilities } from "../ipc";
import { resolvePermissionMode } from "../chat/permissionModes";
import {
  PreferencesProvider,
  projectSetting,
  usePreferences,
} from "./preferences";
import { ProjectSettingRow } from "./ProjectSettingRow";
import { categories, visibleRows } from "./settingsCatalog";
import type { SettingsScope } from "./settingsScope";

const project = "a99f9d7d-e62d-4823-a09d-5379d154b993";
const scope: SettingsScope = {
  kind: "project",
  workspace: {
    id: project,
    label: "Fixture",
    root: "/fixture",
    kind: "repository",
  },
};
const capabilities: ProviderCapabilities = {
  provider: "fixture",
  defaultPermissionMode: "full-access",
  permissionModes: [
    {
      value: "full-access",
      label: "Fixture full access",
      description: "Allow actions.",
    },
    {
      value: "approval-required",
      label: "Fixture supervised",
      description: "Review actions.",
    },
  ],
  supportedApprovalKinds: ["command"],
};

type PreferencesApi = ReturnType<typeof usePreferences>;
function preferencesFixture(
  stored: unknown,
  exercise: (
    read: (scope?: SettingsScope) => { api: PreferencesApi; html: string },
  ) => void,
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let text = JSON.stringify(stored);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => text,
      setItem: (_key: string, next: string) => {
        text = next;
      },
    },
  });
  try {
    exercise((picked = { kind: "all" }) => {
      let api: PreferencesApi | undefined;
      function Inspect() {
        api = usePreferences();
        return createElement(ProjectSettingRow, {
          id: "default-permissions",
          setting: "defaultPermissionMode",
          scope: picked,
        });
      }
      const client = new QueryClient();
      client.setQueryData(["provider-capabilities"], capabilities);
      const router = createRouter({
        routeTree: createRootRoute(),
        history: createMemoryHistory({ initialEntries: ["/"] }),
      });
      const html = renderToStaticMarkup(
        createElement(RouterContextProvider, {
          router,
          children: createElement(QueryClientProvider, {
            client,
            children: createElement(PreferencesProvider, {
              children: createElement(Inspect),
            }),
          }),
        }),
      );
      assert.ok(api);
      return { api, html };
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

it("inherits the provider's default without saving it and applies all-project and project choices", () => {
  preferencesFixture({}, (read) => {
    const initial = read();
    assert.equal(initial.api.preferences.defaultPermissionMode, null);
    assert.ok(initial.html.includes("Fixture full access"));
    assert.ok(!initial.html.includes('aria-label="Reset default permissions"'));
    initial.api.update({ defaultPermissionMode: "approval-required" });
    const all = read(scope);
    assert.equal(
      projectSetting(all.api.preferences, project, "defaultPermissionMode")
        .value,
      "approval-required",
    );
    assert.ok(all.html.includes("Fixture supervised"));
    assert.ok(all.html.includes("Inherited from All projects"));
    all.api.patchProject(project, { defaultPermissionMode: "full-access" });
    const overridden = read(scope);
    assert.equal(
      projectSetting(
        overridden.api.preferences,
        project,
        "defaultPermissionMode",
      ).value,
      "full-access",
    );
    assert.ok(overridden.html.includes("Overridden for this project"));
    assert.ok(overridden.html.includes("Reset to inherited value"));
    overridden.api.patchProject(project, { defaultPermissionMode: undefined });
    const inherited = read(scope);
    assert.deepEqual(
      projectSetting(
        inherited.api.preferences,
        project,
        "defaultPermissionMode",
      ),
      { value: "approval-required", overridden: false },
    );
    inherited.api.reset();
    const reset = read(scope);
    assert.equal(reset.api.preferences.defaultPermissionMode, null);
    assert.deepEqual(reset.api.preferences.projectOverrides, {});
    assert.ok(reset.html.includes("Fixture full access"));
  });
});

it("validates saved permissions independently and keeps defaults eligible for No project", () => {
  preferencesFixture(
    {
      defaultPermissionMode: "unsafe",
      appearance: "dark",
      projectOverrides: {
        [project]: {
          defaultPermissionMode: "unsafe",
          newThreadCheckout: "worktree",
        },
      },
    },
    (read) => {
      const { api, html } = read({
        ...scope,
        workspace: { ...scope.workspace, kind: "scratch" },
      });
      assert.equal(api.preferences.defaultPermissionMode, null);
      assert.equal(api.preferences.appearance, "dark");
      assert.equal(
        projectSetting(api.preferences, project, "newThreadCheckout").value,
        "worktree",
      );
      const permissions = projectSetting(
        api.preferences,
        project,
        "defaultPermissionMode",
      );
      assert.deepEqual(permissions, { value: null, overridden: false });
      assert.equal(
        resolvePermissionMode({ capabilities, preferred: permissions.value }),
        "full-access",
      );
      assert.ok(html.includes('aria-label="Default permissions"'));
      assert.ok(!html.includes('disabled=""'));
      assert.ok(
        !html.includes("Threads without a project start in their own folder."),
      );
    },
  );
  const group = categories.general.groups.find(
    (row) => row.id === "new-threads",
  );
  assert.ok(group);
  assert.ok(
    visibleRows(group, scope)?.some(
      (row) =>
        row.id === "default-permissions" &&
        row.setting === "defaultPermissionMode",
    ),
  );
});
