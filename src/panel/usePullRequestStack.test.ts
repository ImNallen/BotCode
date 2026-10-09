import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { checkoutKey } from "../ipc";
import { cachedPr } from "./pullRequests";
import { pullRequestKey } from "./pullRequestKey";
import { pullRequestStack } from "./pullRequestStack";
import { usePullRequestStack } from "./usePullRequestStack";

it("the shared mounted hook restores workspace sibling navigation, blocks cached refresh actions and honors fresh absence", () => {
  const workspaceId = "fixture-workspace";
  const access = { workspaceId };
  const reference = {
    key: pullRequestKey.parse("github.com/fixture/project/42"),
    number: 42,
  };
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  const stack = {
    id: "50",
    number: 50,
    base: "main",
    url: "https://github.com/fixture/project/stacks/50",
    observedAt: 100,
    layers: [41, 42, 43].map((number) => ({
      number,
      headBranch: `layer-${number}`,
      state: "open",
    })),
  };
  const pr = cachedPr.parse({
    key: "github.com/fixture/project/41",
    revision: 1,
    stack,
    snapshot: null,
    freshness: { kind: "never_loaded" },
  });
  client.setQueryData(checkoutKey("workspace", { workspaceId }), {
    threads: [
      { pullRequests: { links: [{ pr, source: "manual", linkedAt: 1 }] } },
    ],
  });
  function render() {
    const views: ReturnType<typeof usePullRequestStack>[] = [];
    function Probe() {
      views.push(usePullRequestStack({ workspaceId, access, reference }));
      return null;
    }
    renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(Probe)),
    );
    const view = views[0];
    assert.ok(view);
    return view;
  }
  try {
    const pending = render();
    assert.equal(pending.data?.layers.length, 3);
    assert.equal(pending.data?.layers[1]?.headSha, undefined);
    assert.equal(pending.isFresh, false);
    assert.equal(pending.notice, "Refreshing stack… Showing saved data.");
    client.setQueryData(
      ["pr-stack", access, reference.key],
      pullRequestStack.parse({
        ...stack,
        capabilities: { mergeMethods: ["merge"], canRebase: true },
        layers: stack.layers.map((layer) => ({
          ...layer,
          headSha: "a".repeat(40),
        })),
      }),
    );
    const refreshing = render();
    assert.equal(refreshing.isFetching, true);
    assert.equal(refreshing.isFresh, false);
    assert.equal(refreshing.data?.layers[1]?.headSha, "a".repeat(40));
    assert.equal(refreshing.notice, "Refreshing stack… Showing saved data.");
    client.setQueryData(["pr-stack", access, reference.key], null);
    const absence = render();
    assert.equal(absence.data, null);
    assert.equal(absence.notice, null);
  } finally {
    client.clear();
  }
});
