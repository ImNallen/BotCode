import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act, createElement } from "react";
import {
  findAll,
  fireEvent,
  withFakeDom,
  type FakeNode,
} from "../test/fakeDom";
import { OpenSourceLicensesPanel } from "./OpenSourceLicenses";
import {
  initialLicensesPanelState,
  licensesPanelReducer,
  licensesPanelView,
  type LicensesPanelAction,
} from "./OpenSourceLicenses.logic";
import type {
  ThirdPartyLicenseEntry,
  ThirdPartyLicenseManifest,
} from "./thirdPartyLicenses";

const alpha: ThirdPartyLicenseEntry = {
  bundles: ["web"],
  kind: "package",
  license: "MIT",
  name: "alpha",
  noticeText: "Alpha MIT notice",
  sourceUrl: "https://example.com/alpha",
  version: "1.0.0",
};
const beta: ThirdPartyLicenseEntry = {
  bundles: ["desktop"],
  kind: "package",
  license: "Apache-2.0",
  name: "beta",
  noticeText: "Beta Apache notice",
  sourceUrl: null,
  version: "2.0.0",
};
const manifest: ThirdPartyLicenseManifest = {
  schemaVersion: 1,
  entries: [alpha, beta],
};

function reduce(...actions: LicensesPanelAction[]) {
  return actions.reduce(licensesPanelReducer, initialLicensesPanelState);
}

const loaded: LicensesPanelAction = {
  type: "manifest",
  manifest: { status: "ready", manifest },
};

describe("open source licenses panel state", () => {
  it("counts every notice when nothing is filtered", () => {
    assert.equal(licensesPanelView(reduce(loaded)).countLabel, "2 notices");
  });

  it("filters by license and shows the filtered count", () => {
    const view = licensesPanelView(
      reduce(
        loaded,
        { type: "search-opened" },
        { type: "query-changed", query: "apache" },
      ),
    );
    assert.equal(view.countLabel, "1 of 2");
    assert.deepEqual(view.entries, [beta]);
  });

  it("Escape clears the query and closes the search", () => {
    const state = reduce(
      loaded,
      { type: "search-opened" },
      { type: "query-changed", query: "apache" },
      { type: "search-escaped" },
    );
    assert.equal(state.searchOpen, false);
    assert.equal(licensesPanelView(state).countLabel, "2 notices");
  });

  it("blurring keeps a search with a query open", () => {
    const typed = reduce(
      loaded,
      { type: "search-opened" },
      { type: "query-changed", query: "apache" },
      { type: "search-blurred" },
    );
    assert.equal(typed.searchOpen, true);
    const empty = reduce(
      loaded,
      { type: "search-opened" },
      { type: "search-blurred" },
    );
    assert.equal(empty.searchOpen, false);
  });
});

type FetchStub = () => Promise<Response>;

function json(body: unknown, status = 200): FetchStub {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

async function renderPanel(
  responses: FetchStub[],
  check: (dom: {
    subtree: FakeNode;
    requests: string[];
    settle: () => Promise<void>;
  }) => Promise<void>,
) {
  const previousFetch = globalThis.fetch;
  const previousObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver",
  );
  const requests: string[] = [];
  globalThis.fetch = ((input: string) => {
    requests.push(input);
    const next = responses.shift();
    assert.ok(next, `unexpected request ${input}`);
    return next();
  }) as typeof fetch;
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
  try {
    await withFakeDom(async ({ subtree, root }) => {
      Object.assign(window, {
        requestAnimationFrame: () => 0,
        cancelAnimationFrame() {},
        setTimeout: () => 0,
        clearTimeout() {},
      });
      const settle = () =>
        act(async () => {
          await new Promise((resolve) => setImmediate(() => resolve(null)));
        });
      await act(() => root.render(createElement(OpenSourceLicensesPanel)));
      await settle();
      await check({ subtree, requests, settle });
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousObserver)
      Object.defineProperty(globalThis, "ResizeObserver", previousObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
}

function buttonNamed(subtree: FakeNode, name: string): FakeNode {
  const button = findAll(subtree, "BUTTON").find(
    (node) =>
      node.attributes.get("aria-label") === name ||
      node.textContent.includes(name),
  );
  assert.ok(button, `button ${name}`);
  return button;
}

function expanded(subtree: FakeNode, name: string) {
  return String(buttonNamed(subtree, name).attributes.get("aria-expanded"));
}

function noticeTexts(subtree: FakeNode): string[] {
  return findAll(subtree, "PRE").map((node) => node.textContent);
}

describe("open source licenses panel", () => {
  it("loads the manifest, keeps one notice open at a time and opens search", () =>
    renderPanel([json(manifest)], async ({ subtree, requests }) => {
      assert.deepEqual(requests, ["/third-party-licenses.json"]);
      assert.match(subtree.textContent, /2 notices/);
      assert.deepEqual(noticeTexts(subtree), []);

      await fireEvent(subtree, buttonNamed(subtree, "alpha"), "click");
      assert.deepEqual(noticeTexts(subtree), ["Alpha MIT notice"]);
      assert.equal(expanded(subtree, "alpha"), "true");

      await fireEvent(subtree, buttonNamed(subtree, "beta"), "click");
      assert.deepEqual(noticeTexts(subtree), ["Beta Apache notice"]);
      assert.equal(expanded(subtree, "alpha"), "false");

      await fireEvent(
        subtree,
        buttonNamed(subtree, "Search open-source licenses"),
        "click",
      );
      assert.deepEqual(
        findAll(subtree, "INPUT").map((node) =>
          node.attributes.get("placeholder"),
        ),
        ["Search licenses"],
      );
    }));

  it("shows the failure and refetches on Try again", () =>
    renderPanel(
      [json({}, 500), json(manifest)],
      async ({ subtree, requests, settle }) => {
        assert.match(
          subtree.textContent,
          /Open-source notices are unavailable/,
        );
        assert.match(
          subtree.textContent,
          /The license manifest request failed with status 500\./,
        );

        await fireEvent(subtree, buttonNamed(subtree, "Try again"), "click");
        await settle();
        assert.equal(requests.length, 2);
        assert.match(subtree.textContent, /2 notices/);
        assert.equal(/unavailable/.test(subtree.textContent), false);
      },
    ));

  it("rejects a manifest with a javascript: source link", () =>
    renderPanel(
      [
        json({
          schemaVersion: 1,
          entries: [{ ...alpha, sourceUrl: "javascript:alert(1)" }],
        }),
      ],
      async ({ subtree }) => {
        assert.match(
          subtree.textContent,
          /Open-source notices are unavailable/,
        );
        assert.match(
          subtree.textContent,
          /License entry 1 has an invalid shape\./,
        );
        assert.equal(
          findAll(subtree, "BUTTON").some(
            (node) => node.attributes.get("title") === "Project source",
          ),
          false,
        );
      },
    ));
});
