// Ported from pingdotgg/t3code v0.0.45 settings/StorageSettings.tsx and ui/number-field.tsx (MIT).
import { MinusIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn";
import { Switch } from "../ui/controls";

const minDays = 1;
const maxDays = 3650;
const clampDays = (days: number) =>
  Math.min(maxDays, Math.max(minDays, Math.round(days)));

// base-ui shows the locale-formatted value, so typed text is parsed back with
// the same separators.
const numberFormat = new Intl.NumberFormat();
const formatParts = numberFormat.formatToParts(1234.5);
const groupSeparator =
  formatParts.find((part) => part.type === "group")?.value ?? ",";
const decimalSeparator =
  formatParts.find((part) => part.type === "decimal")?.value ?? ".";
function parseDays(text: string): number | null {
  const normalized = text
    .trim()
    .split(groupSeparator)
    .join("")
    .replace(decimalSeparator, ".");
  if (normalized === "") return null;
  const days = Number(normalized);
  return Number.isFinite(days) ? days : null;
}

function DaysField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(numberFormat.format(value));
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(numberFormat.format(value));
  }
  const current = parseDays(draft) ?? value;
  const commit = (days: number) => {
    const next = clampDays(days);
    setDraft(numberFormat.format(next));
    if (next !== value) onChange(next);
  };
  const commitDraft = () => {
    const typed = parseDays(draft);
    if (typed === null) setDraft(numberFormat.format(value));
    else commit(typed);
  };
  return (
    <div
      data-size="sm"
      data-slot="number-field"
      className={cn("flex w-full flex-col items-start gap-2", "w-auto")}
    >
      <div
        data-slot="number-field-group"
        className="relative flex w-full justify-between rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-data-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-within:border-ring focus-within:ring-[3px] has-aria-invalid:border-destructive/36 has-autofill:bg-foreground/4 focus-within:has-aria-invalid:border-destructive/64 focus-within:has-aria-invalid:ring-destructive/48 data-disabled:pointer-events-none data-disabled:opacity-64 sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-data-disabled:not-focus-within:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [[data-disabled],:focus-within,[aria-invalid]]:shadow-none"
      >
        <button
          type="button"
          data-slot="number-field-decrement"
          aria-label={`Decrease ${label}`}
          disabled={current <= minDays}
          onClick={() => commit(current - 1)}
          className="relative flex shrink-0 cursor-pointer items-center justify-center rounded-s-[calc(var(--radius-lg)-1px)] in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent"
        >
          <MinusIcon />
        </button>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          data-slot="number-field-input"
          aria-label={`${label} in days`}
          size={draft.length || 1}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitDraft();
            else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              commit(current + (event.key === "ArrowUp" ? 1 : -1));
            }
          }}
          className={cn(
            "h-8.5 in-data-[size=lg]:h-9.5 in-data-[size=sm]:h-7.5 w-full min-w-0 grow bg-transparent in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] text-center tabular-nums in-data-[size=lg]:leading-9.5 in-data-[size=sm]:leading-7.5 leading-8.5 outline-none [transition:background-color_5000000s_ease-in-out_0s] sm:h-7.5 sm:in-data-[size=lg]:h-8.5 sm:in-data-[size=sm]:h-6.5 sm:in-data-[size=lg]:leading-8.5 sm:in-data-[size=sm]:leading-8.5 sm:leading-7.5",
            "field-sizing-content w-auto min-w-[1ch] grow-0 text-right",
          )}
        />
        <span aria-hidden="true" className="self-center pr-2 text-xs">
          days
        </span>
        <button
          type="button"
          data-slot="number-field-increment"
          aria-label={`Increase ${label}`}
          disabled={current >= maxDays}
          onClick={() => commit(current + 1)}
          className="relative flex shrink-0 cursor-pointer items-center justify-center rounded-e-[calc(var(--radius-lg)-1px)] in-data-[size=sm]:px-[calc(--spacing(2.5)-1px)] px-[calc(--spacing(3)-1px)] transition-colors pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent"
        >
          <PlusIcon />
        </button>
      </div>
    </div>
  );
}

export function RetentionControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      {value !== null ? (
        <DaysField label={label} value={value} onChange={onChange} />
      ) : (
        <span className="text-xs text-muted-foreground">Off</span>
      )}
      <Switch
        aria-label={label}
        checked={value !== null}
        onCheckedChange={(enabled) => onChange(enabled ? 8 : null)}
      />
    </div>
  );
}
