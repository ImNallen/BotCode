import assert from "node:assert/strict";
import { it } from "node:test";
import {
  lifecycleLabel,
  menuActions,
  primaryControl,
  type HeaderControls,
} from "./prLifecycle.ts";
import type { LifecycleAction, PrReviewDetail } from "./prReview.ts";

type Header = Pick<
  PrReviewDetail,
  "capabilities" | "autoMergeMethod" | "snapshot"
>;
function header({
  primary,
  actions = [],
  autoMergeMethod = null,
  lifecycle = { kind: "open", draft: false },
}: {
  primary: PrReviewDetail["capabilities"]["primary"];
  actions?: LifecycleAction[];
  autoMergeMethod?: PrReviewDetail["autoMergeMethod"];
  lifecycle?: PrReviewDetail["snapshot"]["lifecycle"];
}): Header {
  return {
    capabilities: { primary, actions, explanation: null, edit: false },
    autoMergeMethod,
    snapshot: {
      nodeId: "PR_fixture",
      title: "Fixture",
      lifecycle,
      base: "main",
      head: "feature",
      headRepository: "fixture/project",
      headOid: "a".repeat(40),
      hostUpdatedAt: "2026-10-05T12:00:00Z",
    },
  };
}

it("names merge methods with GitHub's merge button wording", () => {
  assert.equal(lifecycleLabel({ kind: "merge", method: "merge" }), "Merge");
  assert.equal(
    lifecycleLabel({ kind: "merge", method: "squash" }),
    "Squash and merge",
  );
  assert.equal(
    lifecycleLabel({ kind: "enable_auto_merge", method: "rebase" }),
    "Enable auto-merge (rebase and merge)",
  );
});

it("keeps the armed auto-merge badge beside Resolve conflicts", () => {
  const disable: LifecycleAction = { kind: "disable_auto_merge" };
  assert.deepEqual(
    primaryControl(
      header({
        primary: "resolve_conflicts",
        actions: [disable],
        autoMergeMethod: "squash",
      }),
    ),
    {
      primary: { kind: "resolve_conflicts" },
      armedBadge: "Auto-merge (squash and merge)",
    } satisfies HeaderControls,
  );
  assert.equal(
    primaryControl(header({ primary: "resolve_conflicts", actions: [disable] }))
      .armedBadge,
    "Auto-merge",
  );
  assert.equal(
    primaryControl(header({ primary: "resolve_conflicts" })).armedBadge,
    null,
  );
});

it("shows armed auto-merge once, in the primary slot, with its method", () => {
  assert.deepEqual(
    primaryControl(
      header({
        primary: "auto_merge_armed",
        actions: [{ kind: "disable_auto_merge" }],
        autoMergeMethod: "rebase",
      }),
    ),
    {
      primary: {
        kind: "auto_merge_armed",
        label: "Auto-merge (rebase and merge)",
      },
      armedBadge: null,
    } satisfies HeaderControls,
  );
});

it("offers the first allowed method as the header button and keeps the rest in the menu", () => {
  const squash: LifecycleAction = {
    kind: "enable_auto_merge",
    method: "squash",
  };
  const rebase: LifecycleAction = {
    kind: "enable_auto_merge",
    method: "rebase",
  };
  const close: LifecycleAction = { kind: "set_closed", closed: true };
  const draft: LifecycleAction = { kind: "set_draft", draft: true };
  const { primary } = primaryControl(
    header({
      primary: "enable_auto_merge",
      actions: [close, draft, squash, rebase],
    }),
  );
  assert.deepEqual(primary, {
    kind: "action",
    action: squash,
    label: "Auto-merge (squash and merge)",
  });
  assert.deepEqual(menuActions([close, draft, squash, rebase], primary), {
    lifecycle: [draft, rebase],
    closing: [close],
  });
});

it("labels the merge and ready buttons from their lifecycle action", () => {
  assert.deepEqual(
    primaryControl(
      header({
        primary: "merge",
        actions: [
          { kind: "set_draft", draft: true },
          { kind: "merge", method: "squash" },
        ],
      }),
    ).primary,
    {
      kind: "action",
      action: { kind: "merge", method: "squash" },
      label: "Squash and merge",
    },
  );
  assert.deepEqual(
    primaryControl(
      header({
        primary: "ready",
        actions: [{ kind: "set_draft", draft: false }],
        lifecycle: { kind: "open", draft: true },
      }),
    ).primary,
    {
      kind: "action",
      action: { kind: "set_draft", draft: false },
      label: "Ready for review",
    },
  );
  assert.deepEqual(primaryControl(header({ primary: "ready" })).primary, {
    kind: "none",
  });
});

it("shows terminal states without an armed badge", () => {
  assert.deepEqual(
    primaryControl(
      header({
        primary: "merged",
        autoMergeMethod: "squash",
        lifecycle: { kind: "merged", mergedAt: null },
      }),
    ),
    { primary: { kind: "state", state: "merged" }, armedBadge: null },
  );
});
