// Classes and icons copied from pingdotgg/t3code v0.0.45 components/ui/checkbox.tsx (MIT).
export function Checkbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onCheckedChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-label={label}
      aria-checked={indeterminate ? "mixed" : checked}
      data-checked={checked ? "" : undefined}
      data-slot="checkbox"
      className="relative inline-flex size-4.5 shrink-0 items-center justify-center rounded-[.25rem] border border-input bg-background not-dark:bg-clip-padding shadow-xs/5 outline-none ring-ring transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[3px] not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/48 data-disabled:opacity-64 sm:size-4 dark:not-data-checked:bg-input/32 dark:aria-invalid:ring-destructive/24 dark:not-data-disabled:not-data-checked:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] [[data-disabled],[data-checked],[aria-invalid]]:shadow-none"
      onClick={(event) => {
        event.preventDefault();
        onCheckedChange();
      }}
    >
      {checked || indeterminate ? (
        <span
          className="-inset-px absolute flex items-center justify-center rounded-[.25rem] text-primary-foreground data-unchecked:hidden data-checked:bg-primary data-indeterminate:text-foreground"
          data-checked={checked ? "" : undefined}
          data-indeterminate={indeterminate ? "" : undefined}
          data-slot="checkbox-indicator"
        >
          <svg
            className="size-3.5 sm:size-3"
            fill="none"
            height="24"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
            viewBox="0 0 24 24"
            width="24"
            aria-hidden="true"
          >
            <path
              d={
                indeterminate
                  ? "M5.252 12h13.496"
                  : "M5.252 12.7 10.2 18.63 18.748 5.37"
              }
            />
          </svg>
        </span>
      ) : null}
    </button>
  );
}
