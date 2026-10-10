import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import assert from "node:assert/strict";
import { it } from "node:test";
import {
  PreferencesProvider,
  projectSetting,
  usePreferences,
} from "./preferences";
import { ProjectSettingRow } from "./ProjectSettingRow";
import { categories, visibleRows } from "./settingsCatalog";

const project = "a99f9d7d-e62d-4823-a09d-5379d154b993";
function inspectPreferences(stored: unknown) {
  let observed: ReturnType<typeof usePreferences>["preferences"] | undefined;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => JSON.stringify(stored) },
  });
  function Inspect() {
    observed = usePreferences().preferences;
    return createElement(ProjectSettingRow, {
      id: "merge",
      setting: "autoSettleOnMerge",
      scope: {
        kind: "project",
        workspace: {
          id: project,
          label: "Fixture",
          root: "/fixture",
          kind: "repository",
          projectIcon: null,
          faviconPath: null,
        },
      },
    });
  }
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  let html: string;
  try {
    const content: ReactNode = createElement(PreferencesProvider, {
      children: createElement(Inspect),
    });
    html = renderToStaticMarkup(
      createElement(RouterContextProvider, { router, children: content }),
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  assert.ok(observed);
  return { preferences: observed, html };
}
it("loads independent merge defaults and project inheritance when inactivity is disabled", () => {
  const { preferences, html } = inspectPreferences({
    sidebarAutoSettleAfterDays: null,
    projectOverrides: { [project]: { autoSettleOnMerge: false } },
  });
  assert.equal(preferences.sidebarAutoSettleAfterDays, null);
  assert.deepEqual(
    projectSetting(preferences, undefined, "autoSettleOnMerge"),
    { value: true, overridden: false },
  );
  assert.deepEqual(projectSetting(preferences, project, "autoSettleOnMerge"), {
    value: false,
    overridden: true,
  });
  assert.ok(/Auto-settle merged pull requests/.test(html));
  assert.ok(/Overridden for this project/.test(html));
  assert.ok(/Reset to inherited value/.test(html));
  assert.ok(/aria-checked="false"/.test(html));
  const inherited = inspectPreferences({
    sidebarAutoSettleAfterDays: null,
    autoSettleOnMerge: false,
    projectOverrides: {},
  });
  assert.deepEqual(
    projectSetting(inherited.preferences, project, "autoSettleOnMerge"),
    { value: false, overridden: false },
  );
  assert.ok(/Inherited from All projects/.test(inherited.html));
});
it("falls back independently on invalid stored settings and exposes merge settlement to General search", () => {
  const { preferences } = inspectPreferences({
    autoSettleOnMerge: "invalid",
    sidebarAutoSettleAfterDays: null,
    projectOverrides: { [project]: { autoSettleOnMerge: "invalid" } },
  });
  assert.equal(preferences.autoSettleOnMerge, true);
  assert.equal(
    projectSetting(preferences, project, "autoSettleOnMerge").overridden,
    false,
  );
  const organization = categories.general.groups.find(
    (group) => group.id === "organization",
  );
  assert.ok(organization);
  const rows = visibleRows(organization, { kind: "all" });
  assert.ok(
    rows?.some(
      (row) =>
        row.setting === "autoSettleOnMerge" && row.keywords?.includes("merged"),
    ),
  );
});
