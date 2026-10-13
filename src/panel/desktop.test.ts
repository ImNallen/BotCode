import assert from "node:assert/strict";
import { it } from "node:test";
import { desktopUrl, streamingDesktop } from "./desktop.ts";
import { eligibleSurfaces } from "./panelState.ts";
import type { PanelState } from "./RightPanel.tsx";

const thread = "9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e";
const other = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const panel = (active: number | null): PanelState => ({
  surfaces: [{ kind: "files" }, { kind: "desktop" }, { kind: "preview" }],
  active,
});

it("streams a sandbox thread's desktop only while its tab is the visible surface", () => {
  assert.equal(streamingDesktop(panel(1), true, thread), thread);
  assert.equal(streamingDesktop(panel(0), true, thread), null, "Files shown");
  assert.equal(streamingDesktop(panel(2), true, thread), null, "Preview shown");
  assert.equal(
    streamingDesktop(panel(null), true, thread),
    null,
    "launcher shown",
  );
  assert.equal(streamingDesktop(panel(1), false, thread), null, "a Mac thread");
  assert.equal(streamingDesktop(panel(1), true, undefined), null, "a draft");
  assert.equal(
    streamingDesktop(panel(1), true, other),
    other,
    "another thread streams under its own key, so the old connection closes",
  );
});

it("keeps the Desktop tab only on sandbox threads", () => {
  assert.deepEqual(eligibleSurfaces(panel(1), true, undefined, true), panel(1));
  assert.deepEqual(eligibleSurfaces(panel(2), true, undefined, false), {
    surfaces: [{ kind: "files" }, { kind: "preview" }],
    active: 1,
  });
  assert.deepEqual(eligibleSurfaces(panel(1), true), {
    surfaces: [{ kind: "files" }, { kind: "preview" }],
    active: null,
  });
});

it("puts the desktop secret in the fragment and asks for control only when taken", () => {
  const endpoint = { port: 51234, secret: "0123456789abcdef0123456789abcdef" };
  const viewing = new URL(desktopUrl(endpoint, false));
  assert.equal(viewing.origin, "http://127.0.0.1:51234");
  assert.equal(viewing.pathname, "/");
  assert.equal(viewing.search, "", "nothing secret reaches the server");
  const fragment = new URLSearchParams(viewing.hash.slice(1));
  assert.equal(fragment.get("secret"), endpoint.secret);
  assert.equal(fragment.get("control"), null, "view-only by default");
  const controlling = new URL(desktopUrl(endpoint, true));
  assert.equal(
    new URLSearchParams(controlling.hash.slice(1)).get("control"),
    "1",
  );
  assert.equal(
    controlling.href.split("#")[0],
    viewing.href.split("#")[0],
    "taking control changes only the fragment, so the page keeps its connection",
  );
});
