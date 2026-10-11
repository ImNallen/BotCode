import assert from "node:assert/strict";
import { it } from "node:test";
import { headerActionsCollapsed } from "./ChatHeaderActions";

it("collapses the header actions below a 512px header or on a phone-width window", () => {
  assert.equal(headerActionsCollapsed(511, false), true);
  assert.equal(headerActionsCollapsed(512, false), false);
  assert.equal(headerActionsCollapsed(900, false), false);
  assert.equal(headerActionsCollapsed(900, true), true);
});
