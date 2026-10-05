import assert from "node:assert/strict";
import { it } from "node:test";
import { lifecycleLabel } from "./prLifecycle.ts";

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
