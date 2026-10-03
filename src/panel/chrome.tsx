// Class strings copied from pingdotgg/t3code v0.0.45 components/ui/kbd.tsx, ui/menu.tsx,
// ui/scroll-area.tsx, ui/panel-tab-close-button.tsx, ui/toggle-group.tsx, chat/DiffStatLabel.tsx
// and files/fileSurfaceChrome.tsx (MIT).
import { RefreshCwIcon, XIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { cn } from "../lib/cn";
import { Button, Toggle } from "../ui/controls";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-muted px-1 font-medium font-sans text-muted-foreground text-xs [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  );
}

export function MenuShortcut({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="menu-shortcut"
      className={cn(
        "ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest",
        className,
      )}
      {...props}
    />
  );
}

export function MenuRadioItem({
  checked,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { checked: boolean }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-checked={checked ? "" : undefined}
      data-slot="menu-radio-item"
      className={cn(
        "[&_svg]:-mx-0.5 flex min-h-8 w-full cursor-pointer items-center rounded-sm px-2 py-1 text-left text-base text-foreground outline-none data-checked:bg-foreground/[0.08] hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

export function ScrollRow({
  className,
  children,
  viewportRef,
  ...props
}: ComponentProps<"div"> & { viewportRef?: React.Ref<HTMLDivElement> }) {
  return (
    <div
      data-slot="scroll-area"
      className={cn(
        "relative size-full min-h-0 overflow-hidden rounded-none",
        className,
      )}
      {...props}
    >
      <div
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className="h-full max-h-[inherit] overflow-auto overscroll-contain rounded-[inherit] outline-none [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
    </div>
  );
}

export function PanelTabCloseButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="cursor-pointer group/close relative flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
        {children}
      </span>
      <XIcon className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
    </button>
  );
}

export function RefreshIcon({
  refreshing,
  className,
}: {
  refreshing: boolean;
  className?: string;
}) {
  return (
    <RefreshCwIcon
      aria-hidden
      className={cn(refreshing && "motion-safe:animate-spin", className)}
    />
  );
}

function formatCompactDiffCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  const m = value / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}m`;
}

export function DiffStatLabel({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span
      role="group"
      aria-label={`${additions} additions, ${deletions} deletions`}
      className={cn(
        "inline-flex items-center gap-1 tabular-nums align-middle",
        className,
      )}
    >
      <span aria-hidden="true" className="font-mono text-diff-addition">
        +{formatCompactDiffCount(additions)}
      </span>
      <span aria-hidden="true" className="font-mono text-diff-deletion">
        -{formatCompactDiffCount(deletions)}
      </span>
    </span>
  );
}

export function SurfaceAction({
  label,
  pressed,
  onPress,
  children,
}: {
  label: string;
  pressed?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return pressed === undefined ? (
    <Button
      className="shrink-0"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={onPress}
    >
      {children}
    </Button>
  ) : (
    <Toggle
      className="shrink-0"
      variant="ghost"
      size="sm"
      pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onPress}
    >
      {children}
    </Toggle>
  );
}

export function SegmentedGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="toggle-group"
      data-size="segmented"
      data-variant="segmented"
      className="flex w-fit *:focus-visible:z-10 *:pointer-coarse:after:min-w-auto gap-0.5 rounded-lg bg-input/40 p-0.5 shrink-0"
    >
      {children}
    </div>
  );
}

export function useStoredState<T extends string | boolean>(
  key: string,
  parse: (raw: string | null) => T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => parse(localStorage.getItem(key)));
  return [
    value,
    (next) => {
      localStorage.setItem(key, String(next));
      setValue(next);
    },
  ];
}

export const storedFlag = (fallback: boolean) => (raw: string | null) =>
  raw === null ? fallback : raw === "true";
