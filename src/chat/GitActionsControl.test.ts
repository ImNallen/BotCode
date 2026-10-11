import assert from "node:assert/strict";
import { it } from "node:test";
import { act, createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { checkoutKey, type GitStatus } from "../ipc";
import { type FakeNode, withFakeDom } from "../test/fakeDom";
import { GitActionsControl } from "./GitActionsControl";

const checkout = { workspaceId: "workspace", threadId: "thread" };
const dirty: GitStatus = {
  branch: {
    name: "feature",
    isDefault: false,
    base: "main",
    aheadOfBase: 0,
    upstream: { remote: "origin", branch: "feature", ahead: 0, behind: 0 },
  },
  origin: true,
  files: [{ path: "src/a.ts", insertions: 3, deletions: 1 }],
};

function slots(node: FakeNode, slot: string): FakeNode[] {
  return [
    ...(node.attributes.get("data-slot") === slot ? [node] : []),
    ...node.childNodes.flatMap((child) => slots(child, slot)),
  ];
}

it("the collapsed header menu shows the quick Git action and a Git actions submenu", () =>
  withFakeDom(async ({ subtree, root }) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(checkoutKey("git", checkout), dirty);
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const render = (presentation: "toolbar" | "menu") =>
      act(() =>
        root.render(
          createElement(RouterContextProvider, {
            router,
            children: createElement(QueryClientProvider, {
              client,
              children: createElement(GitActionsControl, {
                checkout,
                thread: {
                  id: "thread",
                  checkout: { kind: "local" },
                  session: { kind: "ready" },
                },
                threads: [],
                onError() {},
                onOpenPullRequests() {},
                presentation,
              }),
            }),
          }),
        ),
      );
    await render("menu");
    const [quick] = slots(subtree, "menu-item");
    assert.equal(quick?.attributes.get("data-density"), "touch");
    assert.equal(quick?.textContent, "Commit, push & PR");
    const [sub] = slots(subtree, "menu-sub-trigger");
    assert.equal(sub?.attributes.get("data-density"), "touch");
    assert.equal(sub?.textContent, "Git actions");
    await render("toolbar");
    assert.equal(slots(subtree, "menu-sub-trigger").length, 0);
    assert.equal(slots(subtree, "menu-item").length, 0);
    client.clear();
  }));
