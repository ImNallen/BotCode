// Error recovery ported from T3 Code v0.0.45 apps/web/src/routes/__root.tsx and components/RenderErrorBoundary.tsx (MIT).
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { configurePullRequestQueries, ipc, native, subscribe } from "./ipc";
import { loadStorage } from "./lib/storage";
import { router } from "./router";
import { loadPreferences, PreferencesProvider } from "./settings/preferences";
import "./styles.css";
import { FollowUpSender } from "./chat/FollowUpSender";
import { ErrorView } from "./errors/ErrorView";
import { RenderErrorBoundary } from "./errors/RenderErrorBoundary";
import { loadKeybindings, useKeybindingsSync } from "./keybindings/store";
import { migrateLegacyScriptShortcuts } from "./keybindings/legacyScripts";
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
let initialization: Promise<void> | undefined;
let unsubscribe: (() => void) | undefined;

function initialize(): Promise<void> {
  if (!native) return Promise.resolve();
  return (initialization ??= Promise.all([
    loadStorage(),
    loadPreferences(),
    loadKeybindings(),
  ])
    .then(async () => {
      await migrateLegacyScriptShortcuts();
      unsubscribe ??= await subscribe(client);
      void client.prefetchQuery({
        queryKey: ["workspaces"],
        queryFn: ipc.workspaces,
      });
    })
    .catch((error: unknown) => {
      initialization = undefined;
      throw error;
    }));
}

type StartupState =
  | { kind: "loading"; attempt: number }
  | { kind: "failed"; attempt: number; error: unknown }
  | { kind: "ready" };

function Startup() {
  useKeybindingsSync();
  const [state, setState] = useState<StartupState>(
    native ? { kind: "loading", attempt: 0 } : { kind: "ready" },
  );
  const attempt = state.kind === "ready" ? null : state.attempt;
  useEffect(() => {
    if (attempt === null) return;
    let active = true;
    void initialize().then(
      () => {
        if (active) setState({ kind: "ready" });
      },
      (error: unknown) => {
        if (active) setState({ kind: "failed", attempt, error });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  if (state.kind === "failed")
    return (
      <ErrorView
        error={state.error}
        area="Startup"
        onRetry={() =>
          setState({ kind: "loading", attempt: state.attempt + 1 })
        }
      />
    );
  if (state.kind === "loading")
    return (
      <div
        role="status"
        className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground"
      >
        Connecting to Bot Code...
      </div>
    );
  return (
    <QueryClientProvider client={client}>
      <PreferencesProvider>
        <FollowUpSender />
        <RouterProvider router={router} />
      </PreferencesProvider>
    </QueryClientProvider>
  );
}

createRoot(root).render(
  <StrictMode>
    <RenderErrorBoundary
      fallback={({ error, reset }) => (
        <ErrorView error={error} onRetry={reset} />
      )}
    >
      <Startup />
    </RenderErrorBoundary>
  </StrictMode>,
);
