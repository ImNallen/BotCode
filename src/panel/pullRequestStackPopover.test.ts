import assert from "node:assert/strict";
import { it } from "node:test";
import {
  Children,
  createElement,
  isValidElement,
  type ReactNode,
  type ComponentProps,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterContextProvider,
} from "@tanstack/react-router";
import {
  PullRequestStackPopoverTrigger,
  PullRequestStackPopoverContent,
} from "./PullRequestStackPopover";
import { PullRequestStackLayers } from "./PullRequestStackLayers";
import { pullRequestKey } from "./pullRequestKey";
import { pullRequestStack } from "./pullRequestStack";
import { pullRequestListEntry } from "./prInbox";
import { InboxRow } from "./PullRequestInboxPage";
import { ipc } from "../ipc";

const reference = {
  key: pullRequestKey.parse("github.com/fixture/project/42"),
  number: 42,
};
const membership = { number: 50, position: 2, size: 3, base: "main" };
const stack = pullRequestStack.parse({
  id: "50",
  number: 50,
  base: "main",
  url: "https://github.com/fixture/project/stacks/50",
  layers: [41, 42, 43].map((number) => ({
    number,
    headBranch: `layer-${number}`,
    state: "open",
    title: `Layer ${number}`,
  })),
});
function triggerSpan(node: ReactNode) {
  if (!isValidElement<{ children?: ReactNode }>(node))
    throw new Error("Expected trigger tooltip");
  const wrapper = Children.only(node.props.children);
  if (!isValidElement<{ children?: ReactNode }>(wrapper))
    throw new Error("Expected trigger wrapper");
  const span = Children.only(wrapper.props.children);
  if (
    !isValidElement<
      Omit<ComponentProps<"span">, "onClick" | "onKeyDown"> & {
        onClick?: (event: { stopPropagation(): void }) => void;
        onKeyDown?: (event: {
          key: string;
          repeat: boolean;
          stopPropagation(): void;
          preventDefault(): void;
        }) => void;
      }
    >(span)
  )
    throw new Error("Expected trigger span");
  return span;
}
it("pointer, Enter, Space and arrows open only the stack trigger with the requested focus edge", () => {
  let open = false;
  let initialFocus: "first" | "last" = "first";
  let stops = 0;
  let prevents = 0;
  const span = triggerSpan(
    PullRequestStackPopoverTrigger({
      membership,
      onOpenWithFocus(focus) {
        open = true;
        initialFocus = focus;
      },
      trigger: {
        ref() {},
        onClick() {
          open = !open;
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
      },
    }),
  );
  assert.equal(span.props.role, "button");
  assert.equal(span.props.tabIndex, 0);
  assert.equal(span.props["aria-label"], "Stack 50, layer 2 of 3");
  assert.equal(
    span.props.className,
    "inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs font-normal text-muted-foreground",
  );
  const click = {
    stopPropagation() {
      stops++;
    },
  };
  span.props.onClick?.(click);
  assert.equal(open, true);
  const key = (key: string, repeat = false) => ({
    key,
    repeat,
    stopPropagation() {
      stops++;
    },
    preventDefault() {
      prevents++;
    },
  });
  for (const value of [key("Enter"), key(" ")]) {
    span.props.onKeyDown?.(value);
  }
  assert.equal(open, true);
  span.props.onKeyDown?.(key(" ", true));
  open = false;
  span.props.onKeyDown?.(key("ArrowDown"));
  assert.equal(open, true);
  assert.equal(initialFocus, "first");
  open = false;
  span.props.onKeyDown?.(key("ArrowUp"));
  assert.equal(open, true);
  assert.equal(initialFocus, "last");
  assert.equal(stops, 6);
  assert.equal(prevents, 5);
});

it("an unopened inbox badge renders source labels without a full stack read or QueryClient", () => {
  const calls: string[] = [];
  const read = ipc.readPullRequestStack;
  ipc.readPullRequestStack = async () => {
    calls.push("readPullRequestStack");
    throw new Error("Closed badge must not invoke IPC");
  };
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  try {
    const entry = pullRequestListEntry.parse({
      key: reference.key,
      provider: "github",
      host: "github.com",
      projectId: "11111111-1111-4111-8111-111111111111",
      projectTitle: "Repo",
      repository: "fixture/project",
      number: 42,
      title: "Middle layer",
      url: "https://github.com/fixture/project/pull/42",
      author: null,
      headBranch: "middle",
      baseBranch: "bottom",
      state: "open",
      isDraft: false,
      mergeability: "unknown",
      additions: 1,
      deletions: 0,
      createdAt: "",
      updatedAt: "",
      viewerReviewRequested: false,
      labels: [],
      stack: membership,
    });
    const html = renderToStaticMarkup(
      createElement(RouterContextProvider, {
        router,
        children: createElement(InboxRow, {
          entry,
          selected: false,
          search: "",
          onSelect() {},
          onSelectLayer() {},
        }),
      }),
    );
    assert.match(html, /Stack 50, layer 2 of 3/);
    assert.match(html, /2\/3/);
    assert.ok(html.indexOf("Stack 50") < html.indexOf("+1"));
    assert.deepEqual(calls, []);
  } finally {
    ipc.readPullRequestStack = read;
  }
});

it("the open body renders loading, host failure, absence and retry with top-first navigation", () => {
  for (const [state, label] of [
    [{ kind: "empty", pending: true, error: null }, "Loading stack…"],
    [
      { kind: "empty", pending: false, error: null },
      "This pull request is no longer in a stack.",
    ],
    [
      { kind: "empty", pending: false, error: "Host unavailable" },
      "Host unavailable",
    ],
  ] satisfies [
    ComponentProps<typeof PullRequestStackPopoverContent>["state"],
    string,
  ][]) {
    const html = renderToStaticMarkup(
      createElement(PullRequestStackPopoverContent, {
        state,
        reference,
        stackNumber: 50,
        onSelect() {},
      }),
    );
    assert.match(html, /Stack #50/);
    assert.ok(html.includes(label));
  }
  let refreshed = false;
  const content = PullRequestStackPopoverContent({
    state: {
      kind: "stack",
      stack,
      notice: "Stack data may be stale. We couldn’t refresh it.",
      error: true,
      refresh() {
        refreshed = true;
      },
    },
    reference,
    stackNumber: 50,
    onSelect() {},
  });
  if (!isValidElement<{ children?: ReactNode }>(content))
    throw new Error("Expected body");
  const children = Children.toArray(content.props.children);
  const retry = children[1];
  if (!isValidElement<{ onClick?: () => void }>(retry))
    throw new Error("Expected retry item");
  retry.props.onClick?.();
  assert.equal(refreshed, true);
  const html = renderToStaticMarkup(content);
  assert.match(html, /Retry stack refresh/);
  assert.match(html, /May be stale/);
  assert.ok(html.indexOf("#43") < html.indexOf("#42"));
  let selected = reference;
  const layers = PullRequestStackLayers({
    stack,
    reference,
    onSelect(target) {
      selected = target;
    },
  });
  const row = Children.toArray(layers.props.children)[0];
  if (!isValidElement<{ onClick?: () => void }>(row))
    throw new Error("Expected top layer item");
  row.props.onClick?.();
  assert.deepEqual(selected, {
    key: "github.com/fixture/project/43",
    number: 43,
  });
});
