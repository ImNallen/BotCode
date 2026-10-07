// Ported from T3 Code v0.0.45 apps/web/src/components/chat/WorktreeSetupCard.tsx (MIT).
import {
  CheckIcon,
  CircleIcon,
  LoaderCircleIcon,
  XIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { WorktreeSetup } from "../ipc";
import { Button } from "../ui/controls";
import { cn } from "../lib/cn";

export function WorktreeSetupCard({
  snapshot,
  onRetry,
  retrying,
}: {
  snapshot: WorktreeSetup;
  onRetry: () => void;
  retrying: boolean;
}) {
  const state = snapshot.state;
  const [details, setDetails] = useState(false);
  const [now, setNow] = useState(Date.now);
  const active = state.kind === "running" || state.kind === "pending";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const failed = state.kind === "failed" || state.kind === "interrupted";
  const scriptFailed = state.kind === "failed" && snapshot.script !== null;
  const Icon = active
    ? LoaderCircleIcon
    : failed
      ? XIcon
      : state.kind === "succeeded"
        ? CheckIcon
        : CircleIcon;
  const label = active
    ? "Setting up worktree…"
    : scriptFailed
      ? "Worktree ready, setup script failed"
      : failed
        ? "Worktree setup " + state.kind
        : "Worktree ready";
  return (
    <section aria-label="Worktree setup" data-worktree-setup-phase={state.kind}>
      <div className="border-b border-border/60 pb-2 pt-1">
        <div
          className={cn(
            "flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed tabular-nums",
            scriptFailed
              ? "text-warning-foreground"
              : failed
                ? "text-destructive-foreground"
                : "text-muted-foreground",
          )}
        >
          <span>{label}</span>
          {snapshot.startedAtMs !== null ? (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {Math.floor(
                ((snapshot.completedAtMs ?? now) - snapshot.startedAtMs) / 1000,
              )}
              s
            </span>
          ) : null}
        </div>
      </div>
      <div
        className={cn(
          "relative flex min-h-6 min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-0.5 py-0.5 text-sm leading-relaxed",
          failed ? "text-destructive-foreground" : "text-secondary-label",
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          <Icon
            className={cn("size-4 shrink-0 stroke-2", active && "animate-spin")}
          />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {snapshot.script?.name ?? "Initialize submodules"}
        </span>
      </div>
      {active || failed ? (
        <pre
          className={cn(
            "mb-1 ml-8 overflow-hidden rounded-md border px-2.5 py-1.5 font-mono text-2xs leading-relaxed select-text",
            failed
              ? "border-destructive/20 bg-error-surface text-destructive-foreground"
              : "border-border bg-code text-muted-foreground",
          )}
        >
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="truncate whitespace-pre">
              {snapshot.output.slice(-4)[i] || "\u00a0"}
            </div>
          ))}
        </pre>
      ) : null}
      {failed ? (
        <p className="mt-1 ml-8 text-xs text-muted-foreground">
          {state.reason}
        </p>
      ) : null}
      {details ? (
        <dl className="mt-1 mb-1.5 ml-8 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <dt>Path</dt>
          <dd className="truncate font-mono">{snapshot.cwd}</dd>
          {snapshot.script ? (
            <>
              <dt>Setup</dt>
              <dd className="truncate font-mono">{snapshot.script.command}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <div className="mt-0.5 ml-[calc(--spacing(6)+2px-(--spacing(2)-1px))] flex flex-wrap items-center gap-0.5">
        <Button
          size="xs"
          variant="ghost-muted"
          aria-expanded={details}
          onClick={() => setDetails(!details)}
        >
          {details ? <ChevronDownIcon /> : <ChevronRightIcon />}Details
        </Button>
        {failed ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={retrying}
            onClick={onRetry}
          >
            Retry
          </Button>
        ) : null}
      </div>
    </section>
  );
}
