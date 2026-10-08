import assert from "node:assert/strict";
import { it } from "node:test";
import {
  acceptsPreviewEvent,
  initialPreview,
  normalizePreviewUrl,
  parseViewport,
  scopeForPreview,
  type PreviewAttachment,
  type PreviewScope,
} from "./model.ts";
import {
  attachPreviewHost,
  intersectPreviewRect,
  type PreviewLayout,
} from "./nativeHost.ts";
import { openProjectScriptPreview } from "./projectScriptPreview.ts";

const workspace = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const thread = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scope = scopeForPreview(workspace, thread);
function deferred<T>() {
  let resolve: (result: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("preview events cannot open a different conversation or project draft", () => {
  assert.equal(
    acceptsPreviewEvent(scope, {
      scope,
      state: initialPreview,
      openPanel: true,
    }),
    true,
  );
  assert.equal(
    acceptsPreviewEvent(scope, {
      scope: scopeForPreview(workspace, other),
      state: initialPreview,
      openPanel: true,
    }),
    false,
  );
  assert.equal(
    acceptsPreviewEvent(scope, {
      scope: scopeForPreview(workspace, undefined),
      state: initialPreview,
      openPanel: true,
    }),
    false,
  );
  assert.equal(
    acceptsPreviewEvent(scopeForPreview(workspace, undefined), {
      scope: scopeForPreview(other, undefined),
      state: initialPreview,
      openPanel: true,
    }),
    false,
  );
});

it("the address bar accepts localhost and refuses unsupported schemes and credentials", async () => {
  assert.equal(
    normalizePreviewUrl(" localhost:5173/page "),
    "http://localhost:5173/page",
  );
  assert.equal(
    normalizePreviewUrl("https://example.test"),
    "https://example.test/",
  );
  for (const url of [
    "",
    "javascript:alert(1)",
    "file:///tmp/page",
    "data:text/html,hi",
    "ftp://example.test",
    "https://user:secret@example.test",
    `https://example.test/${"x".repeat(8192)}`,
  ])
    await assert.rejects(async () => normalizePreviewUrl(url), /URL/);
});

it("custom CSS viewport dimensions reject partial, fractional and oversized input", () => {
  assert.deepEqual(parseViewport("375", "667"), { width: 375, height: 667 });
  for (const [width, height] of [
    ["", "667"],
    ["375.5", "667"],
    ["239", "667"],
    ["1280", "159"],
    ["3841", "720"],
    ["1280", "2161"],
  ])
    assert.equal(parseViewport(width ?? "", height ?? ""), null);
});

it("a native preview frame stays inside the renderer host and window", () => {
  assert.deepEqual(
    intersectPreviewRect(
      { x: -10, y: 80, width: 800, height: 500 },
      { x: 400, y: 100, width: 300, height: 400 },
    ),
    { x: 400, y: 100, width: 300, height: 400 },
  );
  assert.equal(
    intersectPreviewRect(
      { x: 1000, y: 0, width: 500, height: 500 },
      { x: 0, y: 0, width: 1000, height: 600 },
    ),
    null,
  );
});

it("closing the Preview tab before native attach completes releases its lease without showing it", async () => {
  const attached = deferred<PreviewAttachment>();
  const detached: number[] = [];
  const binding = attachPreviewHost({
    scope,
    transport: {
      attach: () => attached.promise,
      layout: async () => {
        assert.fail("A closed preview must not send a visible layout");
      },
      detach: async (lease) => {
        detached.push(lease);
      },
    },
    measure: () => ({
      rect: { x: 500, y: 100, width: 400, height: 600 },
      visible: true,
    }),
    onState: () => {
      assert.fail("A late attach must not update unmounted state");
    },
    onError: (error) => {
      throw error;
    },
  });
  binding.dispose();
  attached.resolve({ lease: 10, state: initialPreview });
  await attached.promise;
  await Promise.resolve();
  assert.deepEqual(detached, [10]);
});

it("native geometry carries a monotonic sequence and hiding a menu does not repeat an unchanged layout", async () => {
  let layout: PreviewLayout = {
    rect: { x: 500, y: 100, width: 400, height: 600 },
    visible: true,
  };
  const writes: Array<{
    lease: number;
    sequence: number;
    layout: PreviewLayout;
  }> = [];
  const detached: number[] = [];
  const binding = attachPreviewHost({
    scope,
    transport: {
      attach: async () => ({ lease: 11, state: initialPreview }),
      layout: async (lease, sequence, layout) => {
        writes.push({ lease, sequence, layout });
      },
      detach: async (lease) => {
        detached.push(lease);
      },
    },
    measure: () => layout,
    onState: () => {},
    onError: (error) => {
      throw error;
    },
  });
  await Promise.resolve();
  binding.refresh();
  layout = { rect: null, visible: false };
  binding.refresh();
  binding.refresh();
  layout = { rect: { x: 600, y: 100, width: 300, height: 600 }, visible: true };
  binding.refresh();
  binding.dispose();
  binding.refresh();
  assert.deepEqual(
    writes.map(({ lease, sequence, layout }) => [
      lease,
      sequence,
      layout.visible,
    ]),
    [
      [11, 1, true],
      [11, 2, false],
      [11, 3, true],
    ],
  );
  assert.deepEqual(detached, [11]);
});

it("a script opens its configured preview only while its original conversation is selected", async () => {
  let current: PreviewScope | null = scope;
  const opened = deferred<unknown>();
  const calls: Array<{ scope: PreviewScope; url: string }> = [];
  const start = () =>
    openProjectScriptPreview({
      script: { autoOpenPreview: true, previewUrl: "localhost:43127" },
      scope,
      currentScope: () => current,
      open: async (scope, url) => {
        calls.push({ scope, url });
        await opened.promise;
      },
    });
  const pending = start();
  assert.deepEqual(calls, [{ scope, url: "http://localhost:43127/" }]);
  current = scopeForPreview(workspace, other);
  opened.resolve(null);
  await pending;
  await start();
  assert.equal(calls.length, 1);
  current = scope;
  await start();
  current = null;
  await start();
  assert.equal(calls.length, 2);
});

it("a script without auto-open never navigates the browser", async () => {
  await openProjectScriptPreview({
    script: { autoOpenPreview: false, previewUrl: "http://localhost:43127" },
    scope,
    currentScope: () => scope,
    open: async () => {
      assert.fail("Auto-open is disabled");
    },
  });
});

it("finishing a script's preview startup does not reopen a closed panel or replace a newer tab", async () => {
  const opened = deferred<unknown>();
  let selected = "terminal";
  const pending = openProjectScriptPreview({
    script: { autoOpenPreview: true, previewUrl: "localhost:43127" },
    scope,
    currentScope: () => scope,
    open: async () => {
      selected = "preview";
      await opened.promise;
    },
  });
  assert.equal(selected, "preview");
  selected = "closed";
  opened.resolve(null);
  await pending;
  assert.equal(selected, "closed");
  const again = deferred<unknown>();
  const startup = openProjectScriptPreview({
    script: { autoOpenPreview: true, previewUrl: "localhost:43127" },
    scope,
    currentScope: () => scope,
    open: async () => {
      selected = "preview";
      await again.promise;
    },
  });
  selected = "files";
  again.resolve(null);
  await startup;
  assert.equal(selected, "files");
});
