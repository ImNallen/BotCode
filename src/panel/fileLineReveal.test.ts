import assert from "node:assert/strict";
import { it } from "node:test";
import { clampFileLine, centeredFileLineScrollTop } from "./fileLineReveal";

it("clamps stale matched lines to current contents and centers a virtual line outside the mounted window", () => {
  assert.equal(clampFileLine("first\nsecond\n", 321), 2);
  assert.equal(clampFileLine("", 321), 1);
  assert.equal(clampFileLine("first\nsecond", 0), 1);
  assert.equal(
    centeredFileLineScrollTop({
      scrollHeight: 10000,
      viewportHeight: 600,
      fileTop: 0,
      top: 6400,
      height: 20,
    }),
    6110,
  );
  assert.equal(
    centeredFileLineScrollTop({
      scrollHeight: 500,
      viewportHeight: 600,
      fileTop: 0,
      top: 0,
      height: 20,
    }),
    0,
  );
});
