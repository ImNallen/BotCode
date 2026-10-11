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
import type { ProjectScript } from "../ipc";
import { PreferencesProvider } from "../settings/preferences";
import { ProjectScriptsControl } from "./ProjectScriptsControl";

const build: ProjectScript = {
  id: "build",
  name: "Build",
  command: "make",
  icon: "build",
  runOnWorktreeCreate: false,
  async: true,
  previewUrl: null,
  autoOpenPreview: false,
};

function render(scripts: ProjectScript[], presentation: "toolbar" | "menu") {
  const client = new QueryClient();
  client.setQueryData(["project-file-config", "workspace"], { scripts: [] });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderToStaticMarkup(
    createElement(RouterContextProvider, {
      router,
      children: createElement(QueryClientProvider, {
        client,
        children: createElement(PreferencesProvider, {
          children: createElement(ProjectScriptsControl, {
            workspaceId: "workspace",
            scripts,
            onRun() {},
            presentation,
          }),
        }),
      }),
    }),
  );
}

const label = (text: string) =>
  new RegExp(`<span data-slot="menu-item-label"[^>]*>${text}</span>`);

it("the collapsed header menu runs the primary script and lists the rest under Project actions", () => {
  const menu = render([build], "menu");
  assert.match(menu, label("Run Build"));
  assert.match(menu, label("Project actions"));
  assert.ok(!label("Add project action…").test(menu));
  assert.ok(!/aria-label="Script actions"/.test(menu));
  const empty = render([], "menu");
  assert.match(empty, label("Add project action…"));
  assert.ok(!label("Project actions").test(empty));
  const toolbar = render([build], "toolbar");
  assert.match(toolbar, /aria-label="Script actions"/);
  assert.ok(!label("Run Build").test(toolbar));
});
