// Ported from T3 Code v0.0.45 apps/web/src/browser/BrowserDeviceToolbar.tsx (MIT).
import { ChevronDownIcon, RotateCwIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button, selectTrigger } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import { cn } from "../lib/cn";
import {
  parseViewport,
  viewportLabel,
  viewportPresets,
  type ViewportSize,
} from "./model";

export function DeviceToolbar({
  viewport,
  measured,
  pending,
  onChange,
}: {
  viewport: ViewportSize | null;
  measured: ViewportSize | null;
  pending: boolean;
  onChange: (size: ViewportSize | null) => Promise<boolean>;
}) {
  const [custom, setCustom] = useState<{
    width: string;
    height: string;
  } | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const shown = custom ?? {
    width: String(viewport?.width ?? Math.round(measured?.width ?? 1280)),
    height: String(viewport?.height ?? Math.round(measured?.height ?? 720)),
  };
  const valid = parseViewport(shown.width, shown.height);
  const rotated = valid
    ? parseViewport(String(valid.height), String(valid.width))
    : null;
  const apply = async (size: ViewportSize | null) => {
    if (await onChange(size)) setCustom(null);
  };
  const applyCustom = () => {
    if (custom && valid) void apply(valid);
  };
  return (
    <div
      ref={toolbar}
      className="sticky left-0 top-0 z-50 flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/70 bg-background/95 px-1.5 shadow-xs backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ height: 32 }}
      role="toolbar"
      aria-label="Browser device toolbar"
      data-browser-device-toolbar
    >
      <Menu
        trigger={({ ref, ...props }) => (
          <button
            ref={ref}
            type="button"
            className={selectTrigger({
              size: "xs",
              variant: "ghost",
              className: "w-24 shrink-0 justify-between",
            })}
            aria-label="Browser device preset"
            disabled={pending}
            {...props}
          >
            {viewportLabel(viewport)}
            <ChevronDownIcon />
          </button>
        )}
      >
        <MenuItem
          onClick={() => {
            void apply(null);
          }}
        >
          Fit panel
        </MenuItem>
        {viewportPresets.map(({ id, label, width, height }) => (
          <MenuItem
            key={id}
            onClick={() => {
              void apply({ width, height });
            }}
          >
            <span className="flex w-full items-center justify-between gap-5">
              <span>{label}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {width} × {height}
              </span>
            </span>
          </MenuItem>
        ))}
      </Menu>
      <form
        className="m-0 flex min-w-0 shrink-0 items-center gap-0.5 border-0 p-0"
        aria-label="Viewport dimensions"
        onSubmit={(event) => {
          event.preventDefault();
          applyCustom();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          applyCustom();
        }}
        onBlur={(event) => {
          const target = event.relatedTarget;
          if (
            target instanceof Element &&
            (toolbar.current?.contains(target) ||
              target.closest('[data-slot="menu-popup"]'))
          )
            return;
          applyCustom();
        }}
      >
        <Dimension
          label="Viewport width"
          value={shown.width}
          min={240}
          max={3840}
          pending={pending}
          valid={valid !== null}
          onChange={(width) => setCustom({ width, height: shown.height })}
        />
        <span className="text-xs text-muted-foreground">×</span>
        <Dimension
          label="Viewport height"
          value={shown.height}
          min={160}
          max={2160}
          pending={pending}
          valid={valid !== null}
          onChange={(height) => setCustom({ width: shown.width, height })}
        />
      </form>
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        aria-label="Rotate viewport"
        title="Rotate viewport"
        disabled={pending || !rotated}
        onClick={() => {
          if (rotated) void apply(rotated);
        }}
      >
        <RotateCwIcon />
      </Button>
      {measured ? (
        <span
          className="ml-auto shrink-0 px-1 text-2xs tabular-nums text-muted-foreground"
          aria-label="Measured viewport"
        >
          {Math.round(measured.width)} × {Math.round(measured.height)}
        </span>
      ) : null}
    </div>
  );
}
function Dimension({
  label,
  value,
  min,
  max,
  pending,
  valid,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  pending: boolean;
  valid: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <span
      data-slot="input-control"
      data-size="compact"
      className={cn(
        "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] rounded-md before:rounded-[calc(var(--radius-md)-1px)] font-mono tabular-nums",
        "w-14",
      )}
    >
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        disabled={pending}
        aria-label={label}
        aria-invalid={!valid}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s]",
          "h-7 px-[calc(--spacing(2.5)-1px)] text-xs leading-7 sm:h-7 sm:leading-7",
          "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        )}
      />
    </span>
  );
}
