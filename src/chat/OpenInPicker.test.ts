import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PreferencesProvider } from "../settings/preferences";
import { OpenInPicker } from "./OpenInPicker";

function render(
  stored: unknown,
  available: string[] | undefined,
  compact: boolean,
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => JSON.stringify(stored) },
  });
  const client = new QueryClient();
  if (available) client.setQueryData(["available-editors"], available);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  try {
    return renderToStaticMarkup(
      createElement(RouterContextProvider, {
        router,
        children: createElement(QueryClientProvider, {
          client,
          children: createElement(PreferencesProvider, {
            children: createElement(OpenInPicker, {
              target: {
                kind: "workspace",
                workspace_id: "workspace",
                thread_id: null,
                path: "src/main.ts",
              },
              compact,
            }),
          }),
        }),
      }),
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

it("shows the stored editor on the Open button and disables it with no editor installed", () => {
  const header = render(
    { preferredEditor: "zed" },
    ["cursor", "zed", "file-manager"],
    false,
  );
  assert.ok(/aria-label="Open in editor"/.test(header));
  assert.ok(/zed-logo-a/.test(header));
  assert.ok(!/disabled=""/.test(header));
  const fallback = render({ preferredEditor: "webstorm" }, ["cursor"], false);
  assert.ok(!/zed-logo-a/.test(fallback));
  assert.ok(/fill-\[#26251E\]/.test(fallback));
  const viewer = render({}, undefined, true);
  assert.ok(
    /<button[^>]*aria-label="Open file in preferred editor"[^>]*disabled=""/.test(
      viewer,
    ),
  );
});
