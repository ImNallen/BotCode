import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { z } from "zod";
import { Workbench } from "./Workbench";
import { SettingsPage, settingsSection } from "./settings/SettingsPage";
const search = z.object({
  workspace: z.uuid().optional(),
  thread: z.uuid().optional(),
});
export type Selection = z.infer<typeof search>;
const route = createRootRoute({
  validateSearch: (input) => search.parse(input),
  component: Workbench,
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
export const router = createRouter({
  routeTree: route.addChildren([index, settings, section]),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
