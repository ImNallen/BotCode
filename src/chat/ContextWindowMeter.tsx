// Copied from pingdotgg/t3code v0.0.45 components/chat/ContextWindowMeter.tsx,
// ContextWindowMeter.logic.ts, lib/contextWindow.ts and ui/popover.tsx (MIT).
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContextUsage } from "../ipc";
import { cn } from "../lib/cn";
import { Button } from "../ui/controls";

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function measure(usage: ContextUsage) {
  const usedPercentage =
    usage.maxTokens !== null && usage.maxTokens > 0
      ? Math.min(100, (usage.usedTokens / usage.maxTokens) * 100)
      : null;
  const normalizedPercentage = Math.max(0, Math.min(100, usedPercentage ?? 0));
  return {
    usedPercentage: formatPercentage(usedPercentage),
    normalizedPercentage,
    usageColor:
      normalizedPercentage > 90
        ? "var(--color-error)"
        : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)",
  };
}

export function ContextWindowMeter({
  usage,
  modelDisplayName,
}: {
  usage: ContextUsage;
  modelDisplayName: string | null;
}) {
  const { usedPercentage, normalizedPercentage, usageColor } = measure(usage);
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const open = position !== null;
  const trigger = useRef<HTMLSpanElement>(null);
  const delay = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(delay.current), []);
  const show = (wait: number) => {
    clearTimeout(delay.current);
    delay.current = setTimeout(() => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        bottom: window.innerHeight - rect.top + 4,
        right: window.innerWidth - rect.right,
      });
    }, wait);
  };
  const hide = () => {
    clearTimeout(delay.current);
    setPosition(null);
  };
  return (
    <span
      ref={trigger}
      className="flex"
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") show(150);
      }}
      onPointerLeave={hide}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) show(0);
      }}
      onBlur={hide}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          hide();
        }
      }}
    >
      <Button
        size="icon-sm"
        variant="ghost-muted"
        className="size-7"
        aria-label={
          usage.maxTokens !== null && usedPercentage
            ? `Context window ${usedPercentage} used`
            : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
        }
        onClick={() => (open ? hide() : show(0))}
      >
        <span className="relative flex size-5 items-center justify-center">
          <svg
            viewBox="0 0 24 24"
            className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              className="stroke-muted-foreground/24"
              strokeWidth="3"
            />
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              stroke={usageColor}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
            />
          </svg>
        </span>
      </Button>
      {position
        ? // Portalled because an attached composer banner gives the composer a
          // backdrop filter, and a glass card inside it could not blur what lies behind.
          createPortal(
            <div
              data-slot="popover-popup"
              style={position}
              className={cn(
                "dropdown-glass relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg text-popover-foreground outline-none transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
                "w-fit text-balance rounded-md text-xs shadow-md/5 before:rounded-[calc(var(--radius-md)-1px)]",
                "max-w-[calc(100vw-2rem)] w-64",
                "text-left whitespace-normal",
                "fixed z-[130]",
              )}
            >
              <ContextWindowDetails
                usage={usage}
                modelDisplayName={modelDisplayName}
              />
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

export function ContextWindowDetails({
  usage,
  modelDisplayName,
}: {
  usage: ContextUsage;
  modelDisplayName: string | null;
}) {
  const { usedPercentage, normalizedPercentage, usageColor } = measure(usage);
  const totalProcessedTokens = usage.totalProcessedTokens;
  const showTotalProcessed =
    totalProcessedTokens !== null && totalProcessedTokens > 0;
  return (
    <div className="relative size-full overflow-clip rounded-[calc(var(--radius-lg)-1px)]">
      <div className="flex flex-col gap-2 p-(--floating-content-inset)">
        <div className="flex items-center justify-between gap-3">
          <div className="font-medium text-muted-foreground text-xs">
            Context Window
          </div>
          {usage.maxTokens !== null && usedPercentage ? (
            <div className="text-secondary-label text-2xs tabular-nums">
              <span>{usedPercentage}</span>
              <span className="mx-1">·</span>
              <span>
                {formatContextWindowTokens(usage.usedTokens)}/
                {formatContextWindowTokens(usage.maxTokens)}
              </span>
            </div>
          ) : (
            <div className="text-secondary-label text-2xs tabular-nums">
              {formatContextWindowTokens(usage.usedTokens)}
            </div>
          )}
        </div>
        {usage.maxTokens !== null ? (
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(normalizedPercentage)}
            aria-label="Context window usage"
          >
            <div
              className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
              style={{
                width: `${normalizedPercentage}%`,
                backgroundColor: usageColor,
              }}
            />
          </div>
        ) : null}
        {showTotalProcessed ? (
          <div className="flex items-center justify-between gap-3 text-2xs leading-4">
            <span className="text-secondary-label">Total processed</span>
            <span className="font-medium tabular-nums text-secondary-label">
              {formatContextWindowTokens(totalProcessedTokens)}
            </span>
          </div>
        ) : null}
        <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
          {modelDisplayName
            ? `Context for ${modelDisplayName} compacts automatically when needed.`
            : "Context compacts automatically when needed."}
        </div>
      </div>
    </div>
  );
}
