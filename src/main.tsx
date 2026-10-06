import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { configurePullRequestQueries, ipc, native, subscribe } from "./ipc";
import { loadStorage } from "./lib/storage";
import { router } from "./router";
import { loadPreferences, PreferencesProvider } from "./settings/preferences";
import "./styles.css";
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 1500 } },
});
configurePullRequestQueries(client);
if (native && /Mac/.test(navigator.userAgent))
  document.documentElement.classList.add("macos-desktop");
// With Tauri's native drop handling off, a file dropped outside the composer would open in the webview.
for (const type of ["dragover", "drop"] as const)
  window.addEventListener(type, (event) => {
    if (event.defaultPrevented || !event.dataTransfer?.types.includes("Files"))
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  });
const root = document.getElementById("root");
if (!root) throw new Error("Bot Code root element is missing.");
const mount = () =>
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <PreferencesProvider>
          <RouterProvider router={router} />
        </PreferencesProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
if (native) {
  void Promise.all([subscribe(client), loadStorage(), loadPreferences()])
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
          : "Bot Code could not connect to its native runtime.";
    });
} else {
  mount();
}
