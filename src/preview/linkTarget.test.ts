import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { isWebUrl, openLink, resolveLinkTarget } from "./linkTarget.ts";
import type { PreviewScope } from "./model.ts";

const consoleError = console.error;
afterEach(() => {
  console.error = consoleError;
});
function captureErrors(): unknown[][] {
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => logged.push(args);
  return logged;
}

const plain = { metaKey: false, ctrlKey: false };
const inApp = {
  url: "https://localhost:3000",
  event: plain,
  preference: "app",
  canOpenInApp: true,
} as const;

it("opens a link in the app only when every condition allows it", () => {
  assert.equal(resolveLinkTarget(inApp), "app");
  assert.equal(
    resolveLinkTarget({ ...inApp, event: { metaKey: true, ctrlKey: false } }),
    "system",
  );
  assert.equal(
    resolveLinkTarget({ ...inApp, event: { metaKey: false, ctrlKey: true } }),
    "system",
  );
  assert.equal(resolveLinkTarget({ ...inApp, preference: "system" }), "system");
  assert.equal(resolveLinkTarget({ ...inApp, canOpenInApp: false }), "system");
  assert.equal(resolveLinkTarget({ ...inApp, url: "mailto:x@y" }), "system");
  assert.equal(
    resolveLinkTarget({ ...inApp, url: "vscode://file/x" }),
    "system",
  );
});

it("treats only http and https as web links", () => {
  assert.equal(isWebUrl("http://x"), true);
  assert.equal(isWebUrl("https://x"), true);
  assert.equal(isWebUrl("not a url"), false);
  assert.equal(isWebUrl("mailto:x@y"), false);
});

function fakes(previewFails: boolean) {
  const calls: { preview: [PreviewScope, string][]; external: string[] } = {
    preview: [],
    external: [],
  };
  return {
    calls,
    openPreview: async (scope: PreviewScope, url: string) => {
      calls.preview.push([scope, url]);
      if (previewFails) throw new Error("preview unavailable");
    },
    openExternal: async (url: string) => {
      calls.external.push(url);
    },
  };
}
const scope: PreviewScope = { kind: "thread", threadId: "t" };
const url = "https://example.com/page";

it("opens the Preview tab and leaves the system browser alone", async () => {
  const { calls, ...openers } = fakes(false);
  const target = await openLink({
    url,
    event: plain,
    preference: "app",
    scope,
    ...openers,
  });
  assert.equal(target, "app");
  assert.deepEqual(calls, { preview: [[scope, url]], external: [] });
});

it("falls back to the system browser when the Preview tab cannot open", async () => {
  const logged = captureErrors();
  const { calls, ...openers } = fakes(true);
  const target = await openLink({
    url,
    event: plain,
    preference: "app",
    scope,
    ...openers,
  });
  assert.equal(target, "system");
  assert.deepEqual(calls, { preview: [[scope, url]], external: [url] });
  assert.equal(
    logged[0]?.[0],
    "Failed to open link https://example.com in preview for thread:t.",
  );
});

it("uses the system browser when there is no preview scope or a modifier is held", async () => {
  const { calls, ...openers } = fakes(false);
  assert.equal(
    await openLink({
      url,
      event: plain,
      preference: "app",
      scope: null,
      ...openers,
    }),
    "system",
  );
  assert.equal(
    await openLink({
      url,
      event: { metaKey: true, ctrlKey: false },
      preference: "app",
      scope,
      ...openers,
    }),
    "system",
  );
  assert.deepEqual(calls, { preview: [], external: [url, url] });
});

it("rejects when the system browser fails after the preview fails", async () => {
  captureErrors();
  await assert.rejects(
    openLink({
      url,
      event: plain,
      preference: "app",
      scope,
      openPreview: async () => {
        throw new Error("preview unavailable");
      },
      openExternal: async () => {
        throw new Error("Only web links can be opened.");
      },
    }),
    /Only web links can be opened\./,
  );
});
