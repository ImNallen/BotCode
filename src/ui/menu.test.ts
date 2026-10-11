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
import { Menu, MenuItem, MenuItemLabel, menuPlacement } from "./menu";

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

it("flips a popup to the side that has room for it", () => {
  const settingsRow = { top: 238, bottom: 262 };
  assert.equal(menuPlacement("top", 346, settingsRow, 780, 4), "bottom");
  assert.equal(menuPlacement("top", 200, settingsRow, 780, 4), "top");
  const composerControl = { top: 680, bottom: 710 };
  assert.equal(menuPlacement("top", 346, composerControl, 780, 4), "top");
  assert.equal(menuPlacement("bottom", 346, composerControl, 780, 4), "top");
});

type PopupProps = {
  hidden?: boolean;
  inert?: boolean;
  "aria-label"?: string;
  children?: ReactNode;
  onClick?: (event: { target: unknown }) => void;
};

function renderPopup(props: Partial<Parameters<typeof Menu>[0]>) {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body: { nodeType: 1 } },
  });
  let popup: PopupProps | null = null;
  function Capture() {
    const tree = Menu({ trigger: () => null, children: null, ...props });
    const portal = Children.toArray(tree.props.children)[0];
    if (portal && typeof portal === "object" && "children" in portal) {
      const content: ReactNode = portal.children;
      if (isValidElement<PopupProps>(content)) popup = content.props;
    }
    return null;
  }
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
  } finally {
    if (previousDocument)
      Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
  return popup as PopupProps | null;
}

class FakeElement {
  closest() {
    return { hasAttribute: () => false };
  }
}
const itemClick = { target: new FakeElement() };

it("a kept-mounted menu keeps its closed popup hidden and inert, and only an open popup closes on item clicks", () => {
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: FakeElement,
  });
  try {
    assert.equal(renderPopup({ open: false }), null);
    const closes: boolean[] = [];
    const closed = renderPopup({
      open: false,
      keepMounted: true,
      label: "Header actions",
      onOpenChange: (open) => closes.push(open),
      children: "Commit",
    });
    assert.equal(closed?.hidden, true);
    assert.equal(closed?.inert, true);
    assert.equal(closed?.["aria-label"], "Header actions");
    assert.match(renderToStaticMarkup(closed?.children), /Commit/);
    closed?.onClick?.(itemClick);
    assert.deepEqual(closes, []);
    const open = renderPopup({
      open: true,
      keepMounted: true,
      onOpenChange: (open) => closes.push(open),
    });
    assert.equal(open?.hidden, false);
    assert.equal(open?.inert, false);
    open?.onClick?.(itemClick);
    assert.deepEqual(closes, [false]);
  } finally {
    Reflect.deleteProperty(globalThis, "Element");
  }
});

it("touch density gives menu rows T3's 40px height and trims their labels", () => {
  const touch = renderToStaticMarkup(
    createElement(MenuItem, {
      density: "touch",
      children: createElement(MenuItemLabel, null, "Open in Zed"),
    }),
  );
  assert.match(touch, /data-density="touch"/);
  assert.match(touch, /min-h-10 sm:min-h-10/);
  assert.match(
    touch,
    /class="min-w-0 truncate in-data-\[density=touch\]:\[text-box:trim-both_cap_alphabetic\] supports-\[text-box:trim-both_cap_alphabetic\]:in-data-\[density=touch\]:py-\[0.5em\]"/,
  );
  const regular = renderToStaticMarkup(createElement(MenuItem, null, "Open"));
  assert.match(regular, /data-density="default"/);
  assert.ok(!/min-h-10/.test(regular));
});
