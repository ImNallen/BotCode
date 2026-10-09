import assert from "node:assert/strict";
import { it } from "node:test";
import {
  Children,
  createElement,
  isValidElement,
  type ReactNode,
  type RefObject,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterContextProvider,
} from "@tanstack/react-router";
import { Menu } from "./menu";

it("shared menu arrows enter at either edge, wrap and retain Home/End navigation", () => {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  let active: object;
  const items = [0, 1, 2].map((index) => ({
    index,
    focus() {
      active = this;
    },
  }));
  const popup = {
    nodeType: 1,
    contains(node: object) {
      return node === popup || items.some((item) => item === node);
    },
    querySelectorAll() {
      return items;
    },
  };
  active = popup;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { nodeType: 1 },
      get activeElement() {
        return active;
      },
    },
  });
  type NavigationEvent = {
    key: string;
    defaultPrevented: boolean;
    preventDefault(): void;
  };
  let capture: ((event: NavigationEvent) => void) | undefined;
  function Capture() {
    const tree = Menu({ open: true, trigger: () => null, children: null });
    const portal = Children.toArray(tree.props.children)[0];
    if (!portal || typeof portal !== "object" || !("children" in portal))
      throw new Error("Expected open menu portal");
    const content: ReactNode = portal.children;
    if (
      !isValidElement<{
        ref?: RefObject<unknown>;
        onKeyDownCapture?: (event: NavigationEvent) => void;
      }>(content)
    )
      throw new Error("Expected popup");
    const ref = content.props.ref;
    if (!ref || typeof ref !== "object") throw new Error("Expected popup ref");
    ref.current = popup;
    capture = content.props.onKeyDownCapture;
    return null;
  }
  const navigate = (key: string) => {
    if (!capture) throw new Error("Expected menu key handler");
    let prevented = false;
    capture({
      key,
      defaultPrevented: false,
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  try {
    renderToStaticMarkup(
      createElement(RouterContextProvider, {
        router,
        children: createElement(Capture),
      }),
    );
    assert.equal(navigate("ArrowUp"), true);
    assert.equal(active, items[2]);
    assert.equal(navigate("ArrowDown"), true);
    assert.equal(active, items[0]);
    active = popup;
    assert.equal(navigate("ArrowDown"), true);
    assert.equal(active, items[0]);
    assert.equal(navigate("End"), true);
    assert.equal(active, items[2]);
    assert.equal(navigate("Home"), true);
    assert.equal(active, items[0]);
    assert.equal(navigate("ArrowUp"), true);
    assert.equal(active, items[2]);
    assert.equal(navigate("Enter"), false);
    assert.equal(active, items[2]);
  } finally {
    if (previousDocument)
      Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
