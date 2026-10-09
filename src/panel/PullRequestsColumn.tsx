// Ported from T3 Code v0.0.45 routes/_chat.pull-requests.tsx (MIT).
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ChevronDownIcon,
  SearchIcon,
  Plug2Icon,
  LayersIcon,
} from "lucide-react";
import { Button } from "../ui/controls";
import { Menu, MenuRadioItem } from "../ui/menu";
import { RefreshIcon } from "./chrome";
import { cn } from "../lib/cn";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import {
  INVOLVEMENT_TABS,
  STATE_TABS,
  type PullRequestFilterOption,
} from "./PullRequestInboxFilters";
import type { PullRequestInvolvement, PullRequestListState } from "./prInbox";
function CompactFilterMenu<Value extends string>({
  label,
  triggerIcon,
  triggerLabel,
  outlined = false,
  iconOnly = false,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  triggerIcon?: ReactNode;
  triggerLabel?: string;
  outlined?: boolean;
  iconOnly?: boolean;
  value: Value;
  options: ReadonlyArray<PullRequestFilterOption<Value>>;
  onChange: (value: Value) => void;
  className?: string;
}) {
  const current =
    options.find((option) => option.value === value) ?? options[0];
  if (!current) return null;
  return (
    <Menu
      trigger={(props) => (
        <Button
          {...props}
          variant={outlined ? "outline" : "ghost-muted"}
          size={iconOnly ? "icon" : "sm"}
          aria-label={
            triggerLabel || iconOnly ? `${label}: ${current.label}` : label
          }
          className={cn("min-w-0", className)}
        >
          {iconOnly ? (
            <current.Icon aria-hidden className="size-4" />
          ) : triggerLabel ? (
            <>
              {triggerIcon}
              <span>{triggerLabel}</span>
            </>
          ) : (
            <>
              <span className="truncate">{current.label}</span>
              <ChevronDownIcon
                aria-hidden
                className="size-3 shrink-0 text-muted-foreground/70"
              />
            </>
          )}
        </Button>
      )}
    >
      <div role="group" aria-label={label}>
        {options.map((option) => (
          <MenuRadioItem
            key={option.value}
            checked={option.value === value}
            onClick={() => onChange(option.value)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <option.Icon aria-hidden className="size-3.5" />
              {option.label}
            </span>
          </MenuRadioItem>
        ))}
      </div>
    </Menu>
  );
}
function ExpandableSearch({
  searchInput,
  searchValue,
  open,
  onOpenChange,
  focusToken,
  onFocusWithin,
}: {
  searchInput: ReactNode;
  searchValue: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;

  focusToken: number;

  onFocusWithin?: (focused: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    containerRef.current?.querySelector("input")?.focus();
  }, [open]);
  const appliedFocusToken = useRef(focusToken);
  useEffect(() => {
    if (appliedFocusToken.current === focusToken) return;
    appliedFocusToken.current = focusToken;
    const input = containerRef.current?.querySelector("input");
    input?.focus();
    input?.select();
  }, [focusToken]);
  if (open || searchValue.length > 0) {
    return (
      <div
        ref={containerRef}
        className="w-56 min-w-24 shrink"
        onFocus={() => onFocusWithin?.(true)}
        onBlur={() => {
          onFocusWithin?.(false);
          if (searchValue.length === 0) onOpenChange(false);
        }}
      >
        {searchInput}
      </div>
    );
  }
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="Search pull requests"
      onClick={() => onOpenChange(true)}
    >
      <SearchIcon className="size-4" />
    </Button>
  );
}

export function PullRequestsColumn({
  refreshing,
  onRefresh,
  searchValue,
  involvement,
  state,
  host,
  hostMenuOptions,
  onInvolvement,
  onState,
  onHost,
  searchInput,
  sortMenu,
  filtersMenu,
  rightPanelControl,
  titlebarControls,
  rightPanelOpen,
  listBody,
  scrollRef,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  searchValue: string;
  involvement: PullRequestInvolvement;
  state: PullRequestListState;
  host: string | undefined;
  hostMenuOptions: ReadonlyArray<PullRequestFilterOption<string>>;
  onInvolvement: (involvement: PullRequestInvolvement) => void;
  onState: (state: PullRequestListState) => void;
  onHost: (host: string | undefined) => void;
  searchInput: ReactNode;
  sortMenu: ReactNode;
  filtersMenu: ReactNode;
  rightPanelControl: ReactNode;
  titlebarControls: ReactNode;
  rightPanelOpen: boolean;
  listBody: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const markerRef = useRef<HTMLDivElement | null>(null);
  const [condensed, setCondensed] = useState(false);
  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const observer = new IntersectionObserver(
      ([entry]) => setCondensed(entry ? !entry.isIntersecting : false),
      { root: scrollRef.current },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, []);
  const topbarSearchFocusedRef = useRef(false);
  const inFlowSearchRef = useRef<HTMLDivElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchExpanded = searchOpen || searchValue.length > 0;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey))
        return;
      if (event.altKey || event.shiftKey) return;
      event.preventDefault();
      if (condensed) {
        setSearchOpen(true);
        setSearchFocusToken((token) => token + 1);
        return;
      }
      const input = inFlowSearchRef.current?.querySelector("input");
      input?.focus();
      input?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [condensed]);
  useEffect(() => {
    if (condensed) return;
    setSearchOpen(false);
    if (!topbarSearchFocusedRef.current) return;
    topbarSearchFocusedRef.current = false;
    const input = inFlowSearchRef.current?.querySelector("input");
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [condensed]);

  return (
    <div className="@container/pr-list flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader
        electron={true}
        reserveNativeControls={!rightPanelOpen}
        className="relative bg-background"
      >
        {titlebarControls}
        {condensed ? (
          <WorkspaceBreadcrumb
            ariaLabel="Pull request scope"
            className="overflow-hidden"
          >
            <WorkspaceBreadcrumbItem
              current
              className={cn(searchExpanded && "sr-only")}
            >
              <h1 className="truncate">Pull Requests</h1>
            </WorkspaceBreadcrumbItem>
            {searchExpanded ? null : <WorkspaceBreadcrumbSeparator />}
            <WorkspaceBreadcrumbItem className="shrink gap-1.5">
              <CompactFilterMenu
                label="Filter by state"
                value={state}
                options={STATE_TABS}
                onChange={onState}
                className="shrink-0"
              />
              <CompactFilterMenu
                label="Filter by involvement"
                value={involvement}
                options={INVOLVEMENT_TABS}
                onChange={onInvolvement}
              />
              {hostMenuOptions.length > 2 ? (
                <CompactFilterMenu
                  label="Filter by host"
                  value={host ?? ""}
                  options={hostMenuOptions}
                  onChange={(next) => onHost(next === "" ? undefined : next)}
                />
              ) : null}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        ) : (
          <WorkspaceBreadcrumb ariaLabel="Pull requests breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Pull Requests</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        )}
        <div className="min-w-0 flex-1" />
        {condensed ? (
          <div className="flex shrink items-center gap-1.5">
            <ExpandableSearch
              searchInput={searchInput}
              searchValue={searchValue}
              open={searchOpen}
              onOpenChange={setSearchOpen}
              focusToken={searchFocusToken}
              onFocusWithin={(focused) => {
                topbarSearchFocusedRef.current = focused;
              }}
            />
            <PullRequestRefreshControl
              compact
              refreshing={refreshing}
              onRefresh={onRefresh}
            />
          </div>
        ) : null}
        {rightPanelControl}
      </WorkspacePageHeader>

      <div
        ref={scrollRef}
        className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
      >
        <WorkspacePageContainer width="expanded" className="min-h-full gap-4">
          <div className="flex flex-col gap-3">
            <div
              ref={inFlowSearchRef}
              className="flex flex-wrap items-center gap-2"
            >
              <div className="min-w-0 basis-full @lg/pr-list:basis-0 @lg/pr-list:flex-1">
                {searchInput}
              </div>
              {sortMenu}
              {filtersMenu}
              {!condensed ? (
                <PullRequestRefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                />
              ) : null}
            </div>

            <div ref={markerRef} aria-hidden className="-mt-3 h-px w-full" />
          </div>

          {listBody}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}

function PullRequestRefreshControl({
  compact = false,
  refreshing,
  onRefresh,
}: {
  compact?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <Button
      size={compact ? "icon-sm" : "icon"}
      variant={compact ? "ghost" : "outline"}
      aria-label="Refresh pull requests"
      onClick={onRefresh}
      disabled={refreshing}
    >
      <RefreshIcon refreshing={refreshing} />
    </Button>
  );
}
