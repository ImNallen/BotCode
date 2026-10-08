// Ported from T3 Code v0.0.45 apps/web/src/components/preview/{PreviewView,PreviewEmptyState}.tsx and components/ui/{empty,discovery-list}.tsx (MIT).
import { GlobeIcon, RadioTowerIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { native } from "../ipc";
import { Button } from "../ui/controls";
import { DeviceToolbar } from "./DeviceToolbar";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { previewIpc, subscribePreview } from "./ipc";
import {
  acceptsPreviewEvent,
  initialPreview,
  normalizePreviewUrl,
  previewScopeKey,
  type DiscoveredServer,
  type Navigation,
  type PreviewScope,
  type PreviewState,
  type ViewportSize,
} from "./model";
import { attachPreviewHost, measurePreviewHost } from "./nativeHost";

export function PreviewSurface({ scope }: { scope: PreviewScope }) {
  const [state, setState] = useState<PreviewState>(initialPreview);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string>();
  const host = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const eventVersion = useRef(0);
  const operation = useRef(0);
  const refreshGeometry = useRef<() => void>(() => {});
  const discover = useRef<() => void>(() => {});
  const scopeKey = previewScopeKey(scope);
  useEffect(() => {
    if (!native) return;
    active.current = true;
    let disposed = false;
    let off: (() => void) | undefined;
    const report = (cause: unknown) => {
      if (!disposed)
        setError(cause instanceof Error ? cause.message : String(cause));
    };
    void subscribePreview((event) => {
      if (disposed || !acceptsPreviewEvent(scope, event)) return;
      eventVersion.current++;
      setState(event.state);
    }).then((unsubscribe) => {
      if (disposed) unsubscribe();
      else off = unsubscribe;
    }, report);
    const beforeAttach = eventVersion.current;
    const binding = attachPreviewHost({
      scope,
      transport: previewIpc,
      measure: () => {
        const node = host.current;
        return node && stateRef.current.url
          ? measurePreviewHost(node)
          : { rect: null, visible: false };
      },
      onState: (next) => {
        if (eventVersion.current === beforeAttach) setState(next);
      },
      onError: report,
    });
    let frame = 0;
    const refresh = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        binding.refresh();
      });
    };
    refreshGeometry.current = refresh;
    const size = new ResizeObserver(refresh);
    if (host.current) size.observe(host.current);
    const overlays = new MutationObserver(refresh);
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "inert", "aria-hidden", "style", "class"],
    });
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      active.current = false;
      operation.current++;
      off?.();
      cancelAnimationFrame(frame);
      size.disconnect();
      overlays.disconnect();
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
      document.removeEventListener("visibilitychange", refresh);
      refreshGeometry.current = () => {};
      binding.dispose();
    };
  }, [scopeKey]);
  useEffect(() => {
    refreshGeometry.current();
  }, [state.url]);
  useEffect(() => {
    if (!native || state.url) return;
    let disposed = false;
    let busy = false;
    const scan = () => {
      if (disposed || busy) return;
      busy = true;
      setDiscovering(true);
      void previewIpc
        .discover()
        .then(
          (next) => {
            if (!disposed) {
              setServers(next);
              setDiscoveryError(undefined);
            }
          },
          (cause: unknown) => {
            if (!disposed)
              setDiscoveryError(
                cause instanceof Error ? cause.message : String(cause),
              );
          },
        )
        .finally(() => {
          busy = false;
          if (!disposed) setDiscovering(false);
        });
    };
    discover.current = scan;
    scan();
    const timer = window.setInterval(scan, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      discover.current = () => {};
    };
  }, [scopeKey, state.url]);
  const run = async (
    request: () => Promise<PreviewState>,
  ): Promise<boolean> => {
    const version = eventVersion.current;
    const requestId = ++operation.current;
    setPending(true);
    setError(undefined);
    try {
      const next = await request();
      if (!active.current || requestId !== operation.current) return false;
      if (version === eventVersion.current) setState(next);
      return true;
    } catch (cause) {
      if (active.current && requestId === operation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      if (active.current && requestId === operation.current) setPending(false);
    }
  };
  const navigate = (action: Navigation) => {
    void run(() => previewIpc.navigate(scope, action));
  };
  const open = (input: string) => {
    try {
      const url = normalizePreviewUrl(input);
      void run(() => previewIpc.open(scope, url));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const resize = (viewport: ViewportSize | null) =>
    run(() => previewIpc.viewport(scope, viewport));
  if (!native)
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          Preview is only available in the Bot Code desktop app.
        </p>
      </div>
    );
  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-preview-surface
    >
      <PreviewChromeRow
        state={state}
        pending={pending}
        onOpen={open}
        onNavigate={navigate}
      />
      <DeviceToolbar
        viewport={state.viewport}
        measured={state.measuredViewport}
        pending={pending}
        onChange={resize}
      />
      {error || state.error ? (
        <p className="shrink-0 px-3 py-2 text-xs text-destructive" role="alert">
          {error ?? state.error}
        </p>
      ) : null}
      <div
        ref={host}
        className="relative min-h-0 flex-1 overflow-hidden"
        data-preview-webview-host
      >
        {!state.url ? (
          <div className="flex h-full min-h-0 overflow-y-auto px-5 py-8">
            <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
              {servers.length === 0 ? (
                <div
                  className="flex min-w-0 flex-1 flex-col items-center justify-center text-balance text-center gap-6 p-6 md:p-12"
                  data-slot="empty"
                >
                  <GlobeIcon className="size-4.5 text-muted-foreground" />
                  <h2 className="font-semibold text-xl" data-slot="empty-title">
                    No preview yet
                  </h2>
                  <p
                    className="text-muted-foreground text-sm [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4 [[data-slot=empty-title]+&]:mt-1 [[data-slot=empty-description]+&]:mt-1"
                    data-slot="empty-description"
                  >
                    Type a URL above, or run a dev script. Browser-ready
                    localhost servers will show up here automatically.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <RadioTowerIcon className="size-4 shrink-0" />
                    <h2 className="font-medium">Local servers</h2>
                  </div>
                  <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-background">
                    {servers.map((server) => (
                      <button
                        key={server.url}
                        type="button"
                        onClick={() => open(server.url)}
                        className="group flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64"
                      >
                        <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium text-foreground">
                            {server.title ?? `localhost:${server.port}`}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {server.url}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="px-1 text-xs text-muted-foreground">
                    Select a live local server to open it in this browser tab.
                  </p>
                </div>
              )}
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={discovering}
                onClick={() => discover.current()}
              >
                <RefreshCwIcon />
                {discovering ? "Looking for servers…" : "Refresh local servers"}
              </Button>
              {discoveryError ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {discoveryError}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
