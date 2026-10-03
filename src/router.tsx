import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { z } from "zod";
import { Workbench } from "./Workbench";
const search = z.object({
  workspace: z.uuid().optional(),
  thread: z.uuid().optional(),
  path: z.string().optional(),
  view: z.enum(["file", "unstaged", "staged"]).catch("file"),
});
export type Selection = z.infer<typeof search>;
const route = createRootRoute({
  validateSearch: (input) => search.parse(input),
  component: Outlet,
});
const index = createRoute({
  getParentRoute: () => route,
  path: "/",
  component: Workbench,
});
export const router = createRouter({ routeTree: route.addChildren([index]) });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
