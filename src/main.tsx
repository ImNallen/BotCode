import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ipc, native, subscribe } from "./ipc";
import { router } from "./router";
import "./styles.css";
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 1500 } },
});
const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () =>
  document.documentElement.classList.toggle("dark", scheme.matches);
applyScheme();
scheme.addEventListener("change", applyScheme);
if (native && /Mac/.test(navigator.userAgent))
  document.documentElement.classList.add("macos-desktop");
const root = document.getElementById("root");
if (!root) throw new Error("Z1 Code root element is missing.");
const mount = () =>
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
if (native) {
  void subscribe(client)
    .then(() => {
      void client.prefetchQuery({
        queryKey: ["workspaces"],
        queryFn: ipc.workspaces,
      });
      mount();
    })
    .catch((error) => {
      root.textContent =
        error instanceof Error
          ? error.message
          : "Z1 Code could not connect to its native runtime.";
    });
} else {
  mount();
}
