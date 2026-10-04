// Classes copied from pingdotgg/t3code v0.0.45 components/ui/toast.tsx (MIT).
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "./controls";

export type ToastType = "loading" | "success" | "error" | "info";

const icons = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
  success: CircleCheckIcon,
} as const;

const ERROR_DESCRIPTION_CLAMP_MIN_CHARS = 180;

const toastCornerOrbClass =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-popover/92 text-muted-foreground shadow-sm outline-none backdrop-blur-sm transition-[color,background-color,box-shadow] hover:bg-popover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

// A manual popover sits in the top layer, so the toast can show above a modal <dialog>
// opened before it. T3's z-100 viewport cannot rise above the top layer.
export function ToastViewport({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = ref.current;
    viewport?.showPopover();
    return () => viewport?.hidePopover();
  }, []);
  return createPortal(
    <div
      ref={ref}
      popover="manual"
      className="fixed z-100 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-header-offset:var(--workspace-topbar-height)] [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)] inset-auto top-[calc(var(--toast-inset)+var(--toast-header-offset))] right-(--toast-inset) overflow-visible border-0 bg-transparent p-0 text-popover-foreground"
      data-position="top-right"
      data-slot="toast-viewport"
    >
      {children}
    </div>,
    document.body,
  );
}

export function Toast({
  type,
  title,
  description,
  action,
  onDismiss,
  dismissAfterVisibleMs,
}: {
  type: ToastType;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
  dismissAfterVisibleMs?: number;
}) {
  const Icon = icons[type];
  return (
    <div
      role={type === "error" ? "alert" : "status"}
      className="dropdown-glass relative w-full overflow-visible select-none rounded-lg text-popover-foreground shadow-xl shadow-black/25"
      data-type={type}
      data-slot="toast"
    >
      {onDismiss && dismissAfterVisibleMs ? (
        <VisibleAutoDismiss ms={dismissAfterVisibleMs} onDismiss={onDismiss} />
      ) : null}
      {onDismiss ? (
        <div className="absolute z-20 -top-1.5 -right-1.5">
          <button
            aria-label="Dismiss notification"
            className={toastCornerOrbClass}
            data-slot="toast-close"
            onClick={onDismiss}
            type="button"
          >
            <XIcon className="size-3" strokeWidth={2.25} />
          </button>
        </div>
      ) : null}
      <div
        className={cn(
          "pointer-events-auto min-h-0 overflow-y-visible pl-3.5 text-sm transition-opacity duration-250 [overflow-x:clip]",
          action
            ? "flex flex-col gap-2 py-2.5 pr-3.5"
            : "py-3 flex items-center justify-between gap-1.5 pr-10",
        )}
      >
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col gap-0.5",
            action ? "pr-5" : "flex-1",
          )}
        >
          <div className="flex min-w-0 gap-2">
            <div
              className="[&>svg]:h-lh [&>svg]:w-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
              data-slot="toast-icon"
            >
              <Icon
                className={cn(
                  "in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning in-data-[type=loading]:opacity-80",
                  type === "loading" && "motion-safe:animate-spin",
                )}
              />
            </div>
            <div
              className="min-w-0 wrap-break-word font-medium"
              data-slot="toast-title"
            >
              {title}
            </div>
          </div>
          {description ? (
            <div
              className={cn(
                "min-w-0 select-text wrap-break-word text-muted-foreground",
                type === "error" &&
                  description.length >= ERROR_DESCRIPTION_CLAMP_MIN_CHARS &&
                  "line-clamp-4",
              )}
              data-slot="toast-description"
            >
              {description}
            </div>
          ) : null}
        </div>
        {action ? (
          <div className="flex items-center gap-1.5 w-full justify-end">
            <Button
              className="shrink-0"
              data-slot="toast-action"
              onClick={action.onClick}
              size="xs"
            >
              {action.label}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function VisibleAutoDismiss({
  ms,
  onDismiss,
}: {
  ms: number;
  onDismiss: () => void;
}) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    let remainingMs = ms;
    let startedAtMs: number | null = null;
    let timeoutId: number | undefined;
    const pause = () => {
      if (startedAtMs === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      startedAtMs = null;
      window.clearTimeout(timeoutId);
    };
    const start = () => {
      if (startedAtMs !== null) return;
      startedAtMs = Date.now();
      timeoutId = window.setTimeout(() => dismiss.current(), remainingMs);
    };
    const sync = () =>
      document.visibilityState === "visible" && document.hasFocus()
        ? start()
        : pause();
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      window.clearTimeout(timeoutId);
    };
  }, [ms]);
  return null;
}
