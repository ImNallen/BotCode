import {
  MonitorIcon,
  MousePointerClickIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ipc, native, type SandboxDesktop } from "../ipc";
import { previewIpc, subscribePreview } from "../preview/ipc";
import {
  acceptsPreviewEvent,
  initialPreview,
  type PreviewScope,
  type PreviewState,
} from "../preview/model";
import {
  attachPreviewHost,
  measurePreviewHost,
  watchPreviewHost,
} from "../preview/nativeHost";
import { Button } from "../ui/controls";
import { desktopUrl } from "./desktop";

type Phase =
  | { kind: "starting" }
  | { kind: "ready"; endpoint: SandboxDesktop }
  | { kind: "failed"; reason: string };

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function DesktopSurface({
  workspaceId,
  threadId,
}: {
  workspaceId: string;
  threadId: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const [control, setControl] = useState(false);
  const [state, setState] = useState<PreviewState>(initialPreview);
  const [error, setError] = useState<string>();
  const host = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const controlRef = useRef(control);
  controlRef.current = control;
  const refreshGeometry = useRef<() => void>(() => {});
  const scope: PreviewScope = { kind: "desktop", threadId };
  const endpoint = phase.kind === "ready" ? phase.endpoint : null;

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    setPhase({ kind: "starting" });
    ipc.sandboxDesktop(workspaceId, threadId).then(
      (next) => {
        if (!disposed) setPhase({ kind: "ready", endpoint: next });
      },
      (cause: unknown) => {
        if (!disposed) setPhase({ kind: "failed", reason: message(cause) });
      },
    );
    return () => {
      disposed = true;
    };
  }, [workspaceId, threadId, attempt]);

  useEffect(() => {
    if (!endpoint) return;
    let disposed = false;
    let off: (() => void) | undefined;
    const report = (cause: unknown) => {
      if (!disposed) setError(message(cause));
    };
    setError(undefined);
    void subscribePreview((event) => {
      if (!disposed && acceptsPreviewEvent(scope, event)) setState(event.state);
    }).then((unsubscribe) => {
      if (disposed) unsubscribe();
      else off = unsubscribe;
    }, report);
    void previewIpc
      .open(scope, desktopUrl(endpoint, controlRef.current))
      .then((next) => {
        if (!disposed) setState(next);
      }, report);
    const binding = attachPreviewHost({
      scope,
      transport: previewIpc,
      measure: () =>
        host.current && stateRef.current.url
          ? measurePreviewHost(host.current)
          : { rect: null, visible: false },
      onState: (next) => {
        if (!disposed) setState(next);
      },
      onError: report,
    });
    const unwatch = watchPreviewHost(host.current, binding.refresh);
    refreshGeometry.current = () => queueMicrotask(binding.refresh);
    return () => {
      disposed = true;
      off?.();
      unwatch();
      refreshGeometry.current = () => {};
      binding.dispose();
      void previewIpc.close(scope).catch(() => {});
    };
  }, [endpoint]);

  useEffect(() => {
    refreshGeometry.current();
  }, [state.url]);

  const toggleControl = () => {
    if (!endpoint) return;
    const next = !control;
    setControl(next);
    void previewIpc
      .open(scope, desktopUrl(endpoint, next))
      .catch((cause: unknown) => setError(message(cause)));
  };
  const reload = () => {
    void previewIpc
      .navigate(scope, { kind: "reload" })
      .catch((cause: unknown) => setError(message(cause)));
  };

  if (!native)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        The desktop is only available in the Bot Code desktop app.
      </div>
    );
  const problem = endpoint ? (error ?? state.error) : null;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-desktop-surface
    >
      <div
        className="mb-3 flex h-7 min-h-7 shrink-0 items-center gap-1 px-2"
        data-surface-subheader
      >
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
          {control ? "You control the desktop" : "View only"}
        </span>
        <Button
          variant="ghost"
          size="xs"
          type="button"
          aria-pressed={control}
          data-pressed={control ? "" : undefined}
          disabled={!endpoint}
          onClick={toggleControl}
        >
          <MousePointerClickIcon />
          Take control
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          aria-label="Reload desktop"
          title="Reload"
          disabled={!endpoint}
          onClick={reload}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {problem ? (
        <p className="shrink-0 px-3 py-2 text-xs text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
      <div
        ref={host}
        className="relative min-h-0 flex-1 overflow-hidden"
        data-preview-webview-host
      >
        {phase.kind !== "ready" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <MonitorIcon className="size-4.5 text-muted-foreground" />
            {phase.kind === "starting" ? (
              <p className="text-sm text-muted-foreground" role="status">
                Starting desktop…
              </p>
            ) : (
              <>
                <p className="max-w-sm text-sm text-destructive" role="alert">
                  {phase.reason}
                </p>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setAttempt((count) => count + 1)}
                >
                  Try again
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
