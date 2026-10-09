// Ported from T3 Code v0.0.45 PullRequestCandidatePicker.tsx and ui/combobox.tsx (MIT).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SearchIcon } from "lucide-react";
import { Menu } from "../ui/menu";
import { Button } from "../ui/controls";
import { cn } from "../lib/cn";
import { candidateKeyboardIndex } from "./pullRequestPickers.logic";

export function PullRequestCandidatePicker<T>({
  icon,
  label,
  allowed,
  disabledReason,
  open,
  onOpenChange,
  query,
  onQueryChange,
  searchLabel,
  isPending,
  error,
  onRetry,
  candidates,
  emptyLabel,
  noMatchLabel,
  errorLabel,
  truncated,
  truncatedLabel,
  candidateKey,
  disabled,
  onSelect,
  children,
}: {
  icon: ReactNode;
  label: string;
  allowed: boolean;
  disabledReason: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  isPending: boolean;
  error: string | null;
  onRetry?: () => void;
  candidates: readonly T[];
  emptyLabel: string;
  noMatchLabel: string;
  errorLabel: string;
  truncated: boolean;
  truncatedLabel: string;
  candidateKey: (candidate: T) => string;
  disabled: boolean;
  onSelect: (candidate: T) => void;
  children: (candidate: T) => ReactNode;
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const keys = candidates.map(candidateKey);
  const activeIndex = Math.min(active, Math.max(0, keys.length - 1));
  useEffect(() => {
    setActive(0);
  }, [query, open]);
  useEffect(() => {
    document
      .getElementById(`${id}-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id]);
  if (!allowed)
    return (
      <span title={disabledReason}>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled
          aria-label={label}
          aria-describedby={`${id}-reason`}
        >
          {icon}
        </Button>
        <span id={`${id}-reason`} className="sr-only">
          {disabledReason}
        </span>
      </span>
    );
  return (
    <Menu
      open={open}
      onOpenChange={onOpenChange}
      popupKind={{ kind: "dialog", label }}
      className="w-72"
      contentClassName="flex min-w-0 max-h-[min(var(--available-height),23rem)] flex-1 flex-col overflow-hidden text-foreground p-0"
      trigger={(props) => (
        <Button {...props} size="icon-xs" variant="ghost" aria-label={label}>
          {icon}
        </Button>
      )}
    >
      <div className="min-w-0 shrink-0 px-3 pt-2.5">
        <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
          />
          <input
            ref={input}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-activedescendant={
              keys.length ? `${id}-${activeIndex}` : undefined
            }
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            className="h-6.5 w-full bg-transparent ps-5 font-sans text-sm leading-6.5 outline-none"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              const next = candidateKeyboardIndex(
                event.key,
                activeIndex,
                keys.length,
              );
              if (next !== undefined) {
                event.preventDefault();
                setActive(next);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const candidate = candidates[activeIndex];
                if (candidate && !disabled) onSelect(candidate);
              }
            }}
          />
        </div>
      </div>
      <div
        role="listbox"
        id={`${id}-list`}
        aria-label={searchLabel}
        className="max-h-72 overflow-y-auto not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1"
      >
        {error !== null ? (
          <div role="alert" className="p-2 text-xs text-muted-foreground">
            <p>
              {errorLabel} {error}
            </p>
            {onRetry ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  onRetry();
                  input.current?.focus();
                }}
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}
        {isPending ? (
          <div
            role="status"
            aria-label="Loading people"
            className="motion-safe:animate-skeleton space-y-1 p-1"
          >
            {Array.from({ length: 4 }, (_, index) => (
              <div
                key={index}
                className="flex h-7 items-center gap-2 rounded-md px-2"
              >
                <div
                  aria-hidden
                  className="size-4 rounded-full bg-muted-foreground/15"
                />
                <div
                  aria-hidden
                  className="h-3 w-2/5 rounded bg-muted-foreground/15"
                />
              </div>
            ))}
          </div>
        ) : candidates.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">
            {error === null
              ? query.length > 0
                ? noMatchLabel
                : emptyLabel
              : null}
          </p>
        ) : (
          candidates.map((candidate, index) => (
            <button
              type="button"
              role="option"
              id={`${id}-${index}`}
              key={keys[index]}
              aria-selected={false}
              disabled={disabled}
              data-disabled={disabled ? "" : undefined}
              tabIndex={-1}
              onPointerMove={() => setActive(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (!disabled) onSelect(candidate);
                input.current?.focus();
              }}
              data-highlighted={index === activeIndex ? "" : undefined}
              className={cn(
                "flex min-h-8 w-full cursor-pointer items-center rounded-sm px-2 py-1 text-left text-base outline-none not-data-disabled:hover:bg-accent data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-selected:bg-foreground/[0.08] data-selected:text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-accent [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
              )}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground">
                {children(candidate)}
              </div>
            </button>
          ))
        )}
        {truncated ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {truncatedLabel}
          </p>
        ) : null}
      </div>
    </Menu>
  );
}
