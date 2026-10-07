import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderCapabilities } from "../ipc";
import {
  captureDraftSettings,
  draftSessionSettings,
  finishDraftSettings,
  PermissionModeOptions,
  resolvePermissionMode,
  type DraftSessionSettings,
} from "./permissionModes";

const capabilities: ProviderCapabilities = {
  provider: "fixture",
  defaultPermissionMode: "full-access",
  supportedApprovalKinds: ["command", "permission"],
  permissionModes: [
    {
      value: "approval-required",
      label: "Supervised",
      description: "Review actions.",
    },
    {
      value: "full-access",
      label: "Full access",
      description: "Allow actions.",
    },
  ],
};
const draft: DraftSessionSettings = {
  model: null,
  effort: null,
  permissionMode: null,
  interactionMode: "default",
};

it("renders only the provider's permission choices in both composer and settings", () => {
  for (const presentation of ["composer", "settings"] as const) {
    const html = renderToStaticMarkup(
      createElement(PermissionModeOptions, {
        options: capabilities.permissionModes,
        selected: "full-access",
        presentation,
        onSelect: () => undefined,
      }),
    );
    assert.ok(html.includes("Supervised"));
    assert.ok(html.includes("Review actions."));
    assert.ok(html.includes("Full access"));
    assert.ok(html.includes('aria-checked="true"'));
    assert.equal(html.match(/role="menuitemradio"/g)?.length, 2);
    assert.ok(!html.includes("Auto-accept edits"));
    assert.ok(!html.includes('aria-label="Auto"'));
  }
});

it("waits for capabilities before constructing send settings and follows supported defaults", () => {
  assert.equal(
    draftSessionSettings({ draft, preferred: null, capabilities: undefined }),
    undefined,
  );
  assert.deepEqual(
    draftSessionSettings({ draft, preferred: null, capabilities }),
    { ...draft, permissionMode: "full-access" },
  );
  assert.equal(
    draftSessionSettings({
      draft,
      preferred: "approval-required",
      capabilities,
    })?.permissionMode,
    "approval-required",
  );
  assert.equal(
    resolvePermissionMode({ preferred: "auto", capabilities }),
    "full-access",
  );
  assert.equal(
    resolvePermissionMode({
      preferred: null,
      capabilities: { ...capabilities, permissionModes: [] },
    }),
    undefined,
  );
});

it("keeps model changes inheriting permissions and captures even an explicit selection of the default", () => {
  const next = draftSessionSettings({ draft, preferred: null, capabilities });
  assert.ok(next);
  const modelChoice = captureDraftSettings({
    current: draft,
    next: { ...next, model: "fixture-model" },
  });
  assert.equal(modelChoice.permissionMode, null);
  assert.equal(
    draftSessionSettings({
      draft: modelChoice,
      preferred: "approval-required",
      capabilities,
    })?.permissionMode,
    "approval-required",
  );
  const explicit = captureDraftSettings({
    current: modelChoice,
    next: { ...next, model: "fixture-model" },
    permissionModeSelected: true,
  });
  assert.equal(explicit.permissionMode, "full-access");
  const changedDefaults = draftSessionSettings({
    draft: explicit,
    preferred: "approval-required",
    capabilities,
  });
  assert.equal(changedDefaults?.permissionMode, "full-access");
  assert.equal(changedDefaults?.model, "fixture-model");
  const effort = captureDraftSettings({
    current: explicit,
    next: { ...next, effort: "high" },
  });
  assert.equal(effort.permissionMode, "full-access");
});

it("retains a draft's explicit choice while browsing and resets the accepted draft for the next thread", () => {
  const chosen: DraftSessionSettings = {
    ...draft,
    model: "fixture-model",
    permissionMode: "approval-required",
  };
  const retained = finishDraftSettings({
    current: chosen,
    acceptedAsThread: false,
  });
  assert.equal(retained, chosen);
  assert.equal(
    draftSessionSettings({
      draft: retained,
      preferred: "full-access",
      capabilities,
    })?.permissionMode,
    "approval-required",
  );
  const fresh = finishDraftSettings({
    current: chosen,
    acceptedAsThread: true,
  });
  assert.equal(fresh.permissionMode, null);
  assert.equal(fresh.model, null);
  assert.equal(
    draftSessionSettings({
      draft: fresh,
      preferred: "full-access",
      capabilities,
    })?.permissionMode,
    "full-access",
  );
});
