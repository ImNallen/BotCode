import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { Workspace } from "../ipc";
import {
  customWorktreeCleanup,
  defaults,
  PreferencesProvider,
  resolveWorktreeCleanup,
  usePreferences,
} from "./preferences";
import { categories, visibleRows } from "./settingsCatalog";
import type { SettingsScope } from "./settingsScope";
import { StorageSettingsRow } from "./StorageSettings";

const project = "a99f9d7d-e62d-4823-a09d-5379d154b993";
const other = "67ce24cf-70e2-44b3-99f4-53bd8d155d19";
const workspace = (kind: Workspace["kind"]): Workspace => ({
  id: project,
  label: "Fixture",
  root: "/fixture",
  kind,
  projectIcon: null,
  faviconPath: null,
});
const repository: SettingsScope = {
  kind: "project",
  workspace: workspace("repository"),
};
const customRules = {
  worktreeAfterDays: 12,
  worktreeOnMerge: true,
  worktreeOnDelete: false,
  worktreeUnchanged: true,
};

function withStorage<T>(stored: { value: unknown }, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => JSON.stringify(stored.value),
      setItem: (_key: string, text: string) => {
        stored.value = JSON.parse(text);
      },
    },
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

function render(stored: unknown, scope?: SettingsScope) {
  let state: ReturnType<typeof usePreferences> | undefined;
  function Storage() {
    state = usePreferences();
    if (!scope) return null;
    return createElement(
      Fragment,
      null,
      ...categories.storage.groups.flatMap((group) =>
        (visibleRows(group, scope, state!.preferences) ?? []).map((info) =>
          createElement(StorageSettingsRow, { key: info.id, info, scope }),
        ),
      ),
    );
  }
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const html = withStorage({ value: stored }, () => {
    const content: ReactNode = createElement(PreferencesProvider, {
      children: createElement(Storage),
    });
    return renderToStaticMarkup(
      createElement(RouterContextProvider, { router, children: content }),
    );
  });
  assert.ok(state);
  return { preferences: state.preferences, html };
}

function control(html: string, label: string) {
  return html.match(new RegExp(`<[^>]*aria-label="${label}"[^>]*>`))?.[0];
}

it("reads every storage cleanup key independently and defaults each to off", () => {
  assert.deepEqual(render({}).preferences.storageCleanup, {
    worktreeAfterDays: null,
    worktreeOnMerge: false,
    worktreeUnchanged: false,
    worktreeOnDelete: false,
    browserArtifactsAfterDays: null,
    logsAfterDays: null,
  });
  assert.deepEqual(
    render({
      storageCleanup: {
        worktreeAfterDays: 2.5,
        worktreeOnMerge: true,
        worktreeUnchanged: "yes",
        worktreeOnDelete: true,
        browserArtifactsAfterDays: 30,
        logsAfterDays: 3651,
      },
    }).preferences.storageCleanup,
    {
      worktreeAfterDays: null,
      worktreeOnMerge: true,
      worktreeUnchanged: false,
      worktreeOnDelete: true,
      browserArtifactsAfterDays: 30,
      logsAfterDays: null,
    },
  );
});

it("keeps valid worktree cleanup overrides and reads malformed ones as inherit", () => {
  const { preferences } = render({
    autoSettleOnMerge: true,
    projectOverrides: {
      [project]: { worktreeCleanup: { mode: "custom", rules: customRules } },
      [other]: {
        autoSettleOnMerge: false,
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 3 } },
      },
      "fc3a4b7e-6a43-4c6f-9a0e-0f5a3f0d1c2b": { worktreeCleanup: "off" },
    },
  });
  assert.deepEqual(preferences.projectOverrides, {
    [project]: { worktreeCleanup: { mode: "custom", rules: customRules } },
    [other]: { autoSettleOnMerge: false },
  });
  assert.deepEqual(
    render({
      projectOverrides: { [project]: { worktreeCleanup: { mode: "off" } } },
    }).preferences.projectOverrides,
    { [project]: { worktreeCleanup: { mode: "off" } } },
  );
});

it("resolves worktree rules per project: custom, off, or the global rules", () => {
  const global = {
    ...defaults.storageCleanup,
    worktreeAfterDays: 8,
    worktreeOnDelete: true,
    logsAfterDays: 14,
  };
  const preferences = {
    ...defaults,
    storageCleanup: global,
    projectOverrides: {
      [project]: {
        worktreeCleanup: { mode: "custom" as const, rules: customRules },
      },
      [other]: { worktreeCleanup: { mode: "off" as const } },
    },
  };
  const inherited = {
    worktreeAfterDays: 8,
    worktreeOnMerge: false,
    worktreeOnDelete: true,
    worktreeUnchanged: false,
  };
  assert.deepEqual(resolveWorktreeCleanup(preferences, project), customRules);
  assert.deepEqual(resolveWorktreeCleanup(preferences, other), {
    worktreeAfterDays: null,
    worktreeOnMerge: false,
    worktreeOnDelete: false,
    worktreeUnchanged: false,
  });
  assert.deepEqual(
    resolveWorktreeCleanup(preferences, "fc3a4b7e-6a43-4c6f-9a0e-0f5a3f0d1c2b"),
    inherited,
  );
  assert.deepEqual(resolveWorktreeCleanup(preferences, undefined), inherited);
});

it("seeds Custom from the global rules, keeps existing custom rules, and Inherit removes the key", () => {
  const stored = {
    value: {
      storageCleanup: { worktreeAfterDays: 8, worktreeUnchanged: true },
      projectOverrides: { [project]: { autoSettleOnMerge: false } },
    } as Record<string, unknown>,
  };
  withStorage(stored, () => {
    let state: ReturnType<typeof usePreferences> | undefined;
    function Inspect() {
      state = usePreferences();
      return null;
    }
    renderToStaticMarkup(
      createElement(PreferencesProvider, { children: createElement(Inspect) }),
    );
    assert.ok(state);
    const seeded = customWorktreeCleanup(state.preferences, project, {});
    assert.deepEqual(seeded, {
      mode: "custom",
      rules: {
        worktreeAfterDays: 8,
        worktreeOnMerge: false,
        worktreeOnDelete: false,
        worktreeUnchanged: true,
      },
    });
    state.patchProject(project, { worktreeCleanup: seeded });
    const preferences = {
      ...state.preferences,
      projectOverrides: {
        [project]: {
          worktreeCleanup: { mode: "custom" as const, rules: customRules },
        },
      },
    };
    assert.deepEqual(
      customWorktreeCleanup(preferences, project, { worktreeOnDelete: true }),
      {
        mode: "custom",
        rules: { ...customRules, worktreeOnDelete: true },
      },
      "editing a custom rule keeps the project's other custom rules",
    );
    assert.deepEqual(
      (stored.value.projectOverrides as Record<string, unknown>)[project],
      { autoSettleOnMerge: false, worktreeCleanup: seeded },
    );
    state.patchProject(project, { worktreeCleanup: undefined });
    assert.deepEqual(
      (stored.value.projectOverrides as Record<string, unknown>)[project],
      { autoSettleOnMerge: false },
    );
  });
});

it("shows the global rules and Artifacts and logs for all projects, in T3's order", () => {
  const { html } = render(
    { storageCleanup: { worktreeOnMerge: true, logsAfterDays: 14 } },
    { kind: "all" },
  );
  const titles = [
    "Delete worktrees with deleted threads",
    "Delete inactive worktrees",
    "Delete merged worktrees",
    "Delete unchanged worktrees",
    "Delete old browser artifacts",
    "Delete old rotated logs",
  ];
  const positions = titles.map((title) => html.indexOf(title));
  assert.ok(positions.every((at) => at >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
  assert.equal(control(html, "Automatic worktree cleanup"), undefined);
  assert.match(
    control(html, "Delete merged worktrees") ?? "",
    /aria-checked="true"/,
  );
  assert.match(html, /Delete old rotated logs in days/);
});

it("shows the project Select and hides the rule rows until Custom", () => {
  for (const [cleanup, description] of [
    [undefined, "Use each machine&#x27;s worktree cleanup settings."],
    [
      { mode: "off" },
      "Keep this project&#x27;s worktrees until you delete them manually.",
    ],
  ] as const) {
    const { html } = render(
      {
        storageCleanup: { worktreeOnMerge: true },
        projectOverrides: cleanup
          ? { [project]: { worktreeCleanup: cleanup } }
          : {},
      },
      repository,
    );
    assert.ok(control(html, "Automatic worktree cleanup"));
    assert.ok(html.includes(description), description);
    for (const hidden of [
      "Delete inactive worktrees",
      "Delete merged worktrees",
      "Delete old browser artifacts",
    ])
      assert.ok(!html.includes(hidden), hidden);
  }
  const { html, preferences } = render(
    {
      storageCleanup: { worktreeOnMerge: false },
      projectOverrides: {
        [project]: { worktreeCleanup: { mode: "custom", rules: customRules } },
      },
    },
    repository,
  );
  assert.ok(html.includes("Use these rules for this project."));
  assert.ok(html.includes(">Custom<"));
  assert.match(
    control(html, "Delete merged worktrees") ?? "",
    /aria-checked="true"/,
    "project scope shows the custom rules, not the global ones",
  );
  assert.ok(!html.includes("Delete old browser artifacts"));
  const worktrees = categories.storage.groups[0]!;
  assert.ok(
    visibleRows(worktrees, repository, preferences)?.some(
      (row) => row.id === "worktree-on-merge",
    ),
  );
  assert.ok(
    !visibleRows(worktrees, repository, defaults)?.some(
      (row) => row.id === "worktree-on-merge",
    ),
    "search skips rule rows the page hides",
  );
});

it("disables worktree cleanup for No project", () => {
  const { html } = render(
    {},
    { kind: "project", workspace: workspace("scratch") },
  );
  assert.match(control(html, "Automatic worktree cleanup") ?? "", /disabled/);
  assert.ok(html.includes("Worktree cleanup requires a repository project."));
  assert.ok(!html.includes("Delete inactive worktrees"));
});
