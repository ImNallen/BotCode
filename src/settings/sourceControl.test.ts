import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PreferencesProvider,
  projectSetting,
  usePreferences,
} from "./preferences";
import { categories } from "./settingsCatalog";
import { primaryControl } from "../panel/prLifecycle";
import { prReviewDetail } from "../panel/prReview";

it("persists independent source control defaults, project overrides, explicit null and resets", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let stored = JSON.stringify({
    appearance: "dark",
    defaultAutoPull: "bad",
    automaticGitFetchInterval: -1,
    sourceControlWritingStyle: {},
  });
  let state: ReturnType<typeof usePreferences> | undefined;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => stored,
      setItem: (_: string, value: string) => {
        stored = value;
      },
    },
  });
  function Inspect() {
    state = usePreferences();
    return null;
  }
  const render = () => {
    renderToStaticMarkup(
      createElement(PreferencesProvider, { children: createElement(Inspect) }),
    );
    assert.ok(state);
    return state;
  };
  const id = "67ce24cf-70e2-44b3-99f4-53bd8d155d19";
  try {
    let current = render();
    assert.equal(current.preferences.appearance, "dark");
    assert.equal(current.preferences.automaticGitFetchInterval, 30_000);
    assert.equal(current.preferences.defaultAutoPull, false);
    assert.deepEqual(current.preferences.sourceControlWritingStyle, {
      mode: "repo_conventions",
      customInstructions: "",
      followChangeRequestTemplates: true,
    });
    current.update({
      defaultAutoPull: true,
      automaticGitFetchInterval: 0,
      pullRequestMergeMethod: "squash",
      sourceControlWritingStyle: {
        mode: "custom",
        customInstructions: "  Keep concise  ",
        followChangeRequestTemplates: false,
      },
    });
    current = render();
    current.patchProject(id, {
      defaultAutoPull: false,
      pullRequestMergeMethod: null,
      sourceControlWritingStyle: {
        ...current.preferences.sourceControlWritingStyle,
        mode: "conventional_commits",
      },
    });
    current = render();
    assert.equal(
      projectSetting(current.preferences, id, "defaultAutoPull").value,
      false,
    );
    assert.deepEqual(
      projectSetting(current.preferences, id, "pullRequestMergeMethod"),
      { value: null, overridden: true },
    );
    assert.deepEqual(
      projectSetting(current.preferences, id, "sourceControlWritingStyle")
        .value,
      {
        mode: "conventional_commits",
        customInstructions: "Keep concise",
        followChangeRequestTemplates: false,
      },
    );
    assert.equal(current.preferences.automaticGitFetchInterval, 0);
    current.patchProject(id, { defaultAutoPull: undefined });
    current = render();
    assert.equal(
      projectSetting(current.preferences, id, "defaultAutoPull").value,
      true,
    );
    current.reset();
    current = render();
    assert.deepEqual(current.preferences.projectOverrides, {});
    assert.equal(current.preferences.pullRequestMergeMethod, null);
    assert.equal(current.preferences.automaticGitFetchInterval, 30_000);
    assert.equal(categories["source-control"].scoped, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

it("uses the resolved default for ordinary merge and auto-merge lifecycle payloads", () => {
  for (const kind of ["merge", "enable_auto_merge"] as const) {
    const detail = {
      snapshot: prReviewDetail.shape.snapshot.parse({
        nodeId: "PR1",
        title: "Title",
        lifecycle: { kind: "open", draft: false },
        base: "main",
        head: "feature",
        headRepository: "example/project",
        headOid: "a".repeat(40),
        hostUpdatedAt: "2026-10-10T00:00:00Z",
      }),
      capabilities: prReviewDetail.shape.capabilities.parse({
        primary: kind,
        actions: [
          { kind, method: "merge" },
          { kind, method: "squash" },
        ],
        explanation: null,
        edit: false,
      }),
      autoMergeMethod: null,
    };
    const control = primaryControl(detail, "squash").primary;
    assert.equal(control.kind, "action");
    if (control.kind === "action")
      assert.deepEqual(control.action, { kind, method: "squash" });
  }
});
