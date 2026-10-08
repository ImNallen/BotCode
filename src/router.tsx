// Root error recovery ported from T3 Code v0.0.45 apps/web/src/routes/__root.tsx (MIT).
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { z } from "zod";
import { Workbench } from "./Workbench";
import { SettingsPage } from "./settings/SettingsPage";
import { settingsSection } from "./settings/settingsCatalog";
import { UsagePage } from "./usage/UsagePage";
import { RootRouteErrorView } from "./errors/RootRouteErrorView";
const search = z.object({
  workspace: z.uuid().optional(),
  thread: z.uuid().optional(),
  // The project settings apply to. Only settings routes carry it.
  project: z.uuid().optional(),
});
export type Selection = z.infer<typeof search>;
const route = createRootRoute({
  validateSearch: (input) => search.parse(input),
  component: Workbench,
  errorComponent: RootRouteErrorView,
});
const index = createRoute({
  getParentRoute: () => route,
  path: "/",
  component: () => null,
});
const settings = createRoute({
  getParentRoute: () => route,
  path: "/settings",
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/settings/$section",
      params: { section: "general" },
      search,
      replace: true,
    });
  },
});
const section = createRoute({
  getParentRoute: () => route,
  path: "/settings/$section",
  beforeLoad: ({ params, search }) => {
    if (!settingsSection.safeParse(params.section).success)
      throw redirect({
        to: "/settings/$section",
        params: { section: "general" },
        search,
        replace: true,
      });
  },
  component: SettingsPage,
});
const usage = createRoute({
  getParentRoute: () => route,
  path: "/usage",
  component: UsagePage,
});
export const router = createRouter({
  routeTree: route.addChildren([index, settings, section, usage]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
