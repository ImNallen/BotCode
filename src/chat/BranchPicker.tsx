// Structure, labels and classes follow pingdotgg/t3code v0.0.45 components/BranchToolbarBranchSelector.tsx,
// BranchToolbar.logic.ts, ui/combobox.tsx and packages/shared/src/git.ts (MIT).
import { useId, useLayoutEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  GitBranchIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import {
  checkoutKey,
  invalidateCheckouts,
  ipc,
  type Branches,
  type CheckoutRef,
} from "../ipc";
import { cn } from "../lib/cn";
import { Switch } from "../ui/controls";
import { Menu } from "../ui/menu";

const trigger =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-(--control-radius) border border-transparent text-base outline-none hover:bg-accent data-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5 [&_svg[data-composer-control-icon]]:mx-0 h-7 gap-1 px-1.75 font-normal text-muted-foreground/70 text-sm hover:text-foreground/80 sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5 [&_svg[data-composer-control-chevron]]:ms-0 [&_svg[data-composer-control-chevron]]:-me-1 aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-accent/80 min-w-0 max-w-full active:scale-100";

const item =
  "flex min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-pointer items-center rounded-sm px-2 py-1 text-base outline-none not-data-disabled:hover:bg-accent data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-selected:bg-foreground/[0.08] data-selected:text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-accent [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

export function sanitizeNewRefName(rawName: string): string {
  return rawName.trim().replace(/[ \t\n\r\f\v]+/g, "-");
}

function shouldIncludeBranchPickerItem(
  itemValue: string,
  normalizedQuery: string,
  createBranchItemValue: string | null,
): boolean {
  if (normalizedQuery.length === 0) return true;
  if (createBranchItemValue && itemValue === createBranchItemValue) return true;
  const lowerItemValue = itemValue.toLowerCase();
  if (lowerItemValue.includes(normalizedQuery)) return true;
  // A query with whitespace can only match a ref under its sanitized name.
  const sanitizedQuery = sanitizeNewRefName(normalizedQuery);
  return (
    sanitizedQuery.length > 0 &&
    sanitizedQuery !== normalizedQuery &&
    lowerItemValue.includes(sanitizedQuery)
  );
}

export function startsFromOrigin(
  branches: Branches | undefined,
  base: string | null,
  fromOrigin: boolean,
): boolean {
  return (
    fromOrigin &&
    Boolean(branches?.origin) &&
    branches?.branches.find((branch) => branch.name === base)?.remote === false
  );
}

export function BranchPicker({
  checkout,
  branches,
  value,
  worktreeBase,
  disabled,
  onError,
}: {
  checkout: CheckoutRef;
  branches: Branches | undefined;
  value: string | null;
  worktreeBase:
    | {
        fromOrigin: boolean;
        onSelect: (name: string) => void;
        onFromOriginChange: (fromOrigin: boolean) => void;
      }
    | undefined;
  disabled: boolean;
  onError: (message: string | undefined) => void;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const listId = useId();
  const switchId = useId();
  const switchBranch = useMutation({
    mutationFn: (input: { name: string; create: boolean }) =>
      ipc.switchBranch(checkout, input.name, input.create),
    onSuccess: () => onError(undefined),
    onError: (error) => onError(error.message),
    onSettled: () => {
      invalidateCheckouts(client, checkout.workspaceId);
      if (checkout.threadId)
        void client.invalidateQueries({
          queryKey: ["thread", checkout.threadId],
        });
    },
  });
  const refs = branches?.branches ?? [];
  const byName = new Map(refs.map((branch) => [branch.name, branch]));
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();
  const newRefName = sanitizeNewRefName(trimmedQuery);
  const createBranchItemValue =
    !worktreeBase && trimmedQuery.length > 0
      ? `__create_new_branch__:${trimmedQuery}`
      : null;
  const items = [
    ...refs.map((branch) => branch.name),
    ...(createBranchItemValue && !byName.has(newRefName)
      ? [createBranchItemValue]
      : []),
  ].filter((itemValue) =>
    shouldIncludeBranchPickerItem(
      itemValue,
      normalizedQuery,
      createBranchItemValue,
    ),
  );
  const unavailable = (itemValue: string) => {
    const branch = byName.get(itemValue);
    return Boolean(!worktreeBase && branch?.worktree && !branch.current);
  };
  const enabled = items.filter((itemValue) => !unavailable(itemValue));
  const active =
    enabled.find((itemValue) => itemValue === highlighted) ?? enabled[0];
  const optionId = (itemValue: string) =>
    `${listId}-${encodeURIComponent(itemValue)}`;
  useLayoutEffect(() => {
    if (open && active)
      document
        .getElementById(optionId(active))
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  const select = (itemValue: string) => {
    if (unavailable(itemValue)) return;
    setOpen(false);
    if (worktreeBase) {
      worktreeBase.onSelect(itemValue);
      return;
    }
    if (itemValue === createBranchItemValue)
      switchBranch.mutate({ name: newRefName, create: true });
    else if (itemValue !== value)
      switchBranch.mutate({ name: itemValue, create: false });
  };
  const label = !value
    ? "Select ref"
    : worktreeBase
      ? `From ${startsFromOrigin(branches, value, worktreeBase.fromOrigin) ? `origin/${value}` : value}`
      : value;
  return (
    <Menu
      side="top"
      align="end"
      open={open}
      onOpenChange={(next) => {
        if (next)
          void client.invalidateQueries({
            queryKey: checkoutKey("branches", checkout),
          });
        setOpen(next);
        setQuery("");
        setHighlighted(null);
      }}
      popupKind={{ kind: "dialog", label: "Choose ref" }}
      className="flex w-80 flex-col overflow-hidden"
      contentClassName="flex min-w-0 max-h-[23rem] flex-1 flex-col overflow-hidden p-0 text-foreground"
      trigger={(props) => (
        <div
          className="flex min-w-0 items-center gap-1"
          data-composer-context-control
        >
          <span className="flex min-w-0">
            <button
              type="button"
              {...props}
              data-composer-shortcut="composer.branch"
              className={trigger}
              disabled={disabled || !branches || switchBranch.isPending}
            >
              <GitBranchIcon className="size-3 shrink-0 opacity-70" />
              <span data-composer-label className="min-w-0 max-w-[240px]">
                <span className="flex w-full max-w-[240px]">
                  <span className="min-w-0 truncate" title={label}>
                    {label}
                  </span>
                </span>
              </span>
              <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
            </button>
          </span>
        </div>
      )}
    >
      <div className="min-w-0 shrink-0 px-3 pt-2.5">
        <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
          />
          <div className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5">
            <input
              role="combobox"
              aria-label="Search refs"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={active ? optionId(active) : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder="Search refs..."
              value={query}
              className="w-full rounded-none bg-transparent text-sm outline-none"
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlighted(null);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (active) select(active);
                } else if (
                  event.key === "ArrowDown" ||
                  event.key === "ArrowUp"
                ) {
                  event.preventDefault();
                  const index = active ? enabled.indexOf(active) : -1;
                  const next =
                    enabled[
                      (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        enabled.length) %
                        enabled.length
                    ];
                  if (next) setHighlighted(next);
                }
              }}
            />
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!items.length ? (
          <div className="not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm">
            No refs found.
          </div>
        ) : null}
        <div className="relative min-h-0 w-full max-h-56 flex-1 overflow-hidden">
          <div
            id={listId}
            role="listbox"
            aria-label="Refs"
            className="scrollbar-gutter-stable size-full min-w-0 overflow-x-hidden overflow-y-auto overscroll-y-contain not-empty:px-1 not-empty:py-1 ps-1 pe-0 pt-2 pb-1"
            style={{ maxHeight: "14rem" }}
          >
            {items.map((itemValue) => {
              const branch = byName.get(itemValue);
              const blocked = unavailable(itemValue);
              const badge = !branch
                ? null
                : branch.current
                  ? "current"
                  : branch.worktree
                    ? "worktree"
                    : branch.remote
                      ? "remote"
                      : branch.default
                        ? "default"
                        : null;
              return (
                <div
                  key={itemValue}
                  id={optionId(itemValue)}
                  role="option"
                  aria-selected={itemValue === value}
                  aria-disabled={blocked || undefined}
                  title={
                    blocked && branch?.worktree
                      ? `Checked out in ${branch.worktree}`
                      : undefined
                  }
                  data-selected={itemValue === value ? "" : undefined}
                  data-highlighted={itemValue === active ? "" : undefined}
                  data-disabled={blocked ? "" : undefined}
                  className={item}
                  onMouseMove={() => !blocked && setHighlighted(itemValue)}
                  onClick={() => select(itemValue)}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground">
                    {branch ? (
                      <div className="flex w-full min-w-0 items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate">
                          {itemValue}
                        </span>
                        {badge && (
                          <span className="shrink-0 text-3xs text-muted-foreground/45">
                            {badge}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="truncate">
                        Create new ref &quot;{newRefName}&quot;
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {worktreeBase ? (
          <label
            htmlFor={switchId}
            title="Creates the worktree from the latest matching branch on origin instead of your local branch."
            className="flex cursor-pointer items-center justify-between gap-3 border-t border-border/60 px-3 py-2 text-xs"
          >
            <span className="flex min-w-0 items-center gap-1.5 font-medium text-muted-foreground">
              <RefreshCwIcon aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate">Start from origin</span>
            </span>
            <Switch
              id={switchId}
              checked={worktreeBase.fromOrigin}
              size="sm"
              aria-label="Start worktree from origin"
              onCheckedChange={worktreeBase.onFromOriginChange}
            />
          </label>
        ) : null}
      </div>
    </Menu>
  );
}
