// Page behavior and classes ported from T3 Code v0.0.45 routes/_chat.pull-requests.tsx (MIT).
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  EyeIcon,
  PenLineIcon,
  UsersIcon,
  LayersIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  clearPrInboxFilters,
  savePrInboxPreferences,
  type PrInboxSearch,
} from "./prInboxSearch";
import { pullRequestKey } from "./pullRequests";
import { usePanelWidth } from "./usePanelWidth";
import { ipc } from "../ipc";
import { PanelTabCloseButton } from "./chrome";
import {
  PullRequestGlyph,
  PullRequestActorAvatar,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";
import { Button } from "../ui/controls";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/input-group";
import { PullRequestListGhost } from "./PullRequestListGhost";
import { PullRequestListEmptyState } from "./PullRequestListEmptyState";
import { openCommandPalette } from "../lib/commandPaletteBus";
import { cn } from "../lib/cn";
import { formatRelativeTimeLabel } from "../lib/time";
import { PullRequestsColumn } from "./PullRequestsColumn";
import {
  PullRequestInboxFilters,
  PullRequestSortMenu,
} from "./PullRequestInboxFilters";
import { PullRequestDetail } from "./PullRequestDetail";
import { PullRequestStackPopover } from "./PullRequestStackPopover";
import type { PullRequestStackReference } from "./pullRequestStack";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestLabelChip,
  PullRequestReviewDecisionGlyph,
  pullRequestState,
} from "./pullRequestPresentation";
import {
  collectPullRequestListFacets,
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  matchesPullRequestFilters,
  visiblePullRequestSearchEntries,
  narrowPullRequestsToFilters,
  parsePullRequestQuery,
  rankPullRequestMatches,
  scorePullRequestMatch,
  sortPullRequestGroups,
} from "./pullRequestList.logic";
import {
  inboxHostQuery,
  loadInboxPages,
  type PullRequestListEntry,
  type PullRequestListFilters,
  type PrAccess,
} from "./prInbox";
import { PullRequestCheckoutDialog } from "../chat/PullRequestCheckoutDialog";
import type { PrObservation } from "./prReview";
import type { PullRequestDestination, Thread } from "../ipc";
const GROUP_ICONS = {
  authored: PenLineIcon,
  reviewRequested: EyeIcon,
  others: UsersIcon,
};
export function InboxRow({
  entry,
  selected,
  search,
  onSelect,
  onSelectLayer,
}: {
  entry: PullRequestListEntry;
  selected: boolean;
  search: string;
  onSelect: () => void;
  onSelectLayer?: (target: PullRequestStackReference) => void;
}) {
  const checks = entry.checksState
    ? pullRequestChecksStatePresentation(entry.checksState)
    : undefined;
  const state = pullRequestState(
    entry.state === "open"
      ? { kind: "open", draft: entry.isDraft }
      : entry.state === "closed"
        ? { kind: "closed", closedAt: null }
        : { kind: "merged", mergedAt: null },
  );
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "group/pr-row flex w-full items-center gap-2 rounded-md py-1 pr-1 text-left",
        "px-3 py-2.5 [contain-intrinsic-block-size:36.5px]",
        "cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "[content-visibility:auto]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <span className="flex w-4 shrink-0 flex-col items-center gap-0.5 mt-0.75 self-start">
        <state.Icon
          aria-label={state.label}
          className={cn("size-4", state.toneClassName)}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            #{entry.number}
          </span>
          <span className="min-w-0 truncate text-sm">{entry.title}</span>
          <span className="flex shrink-0 items-center gap-1 text-2xs">
            {checks ? (
              <span title={checks.label} aria-label={checks.label}>
                <checks.Icon
                  aria-hidden
                  className={cn("size-3.5", checks.toneClassName)}
                />
              </span>
            ) : null}
            <PullRequestReviewDecisionGlyph
              decision={
                entry.reviewDecision?.toUpperCase().replaceAll("-", "_") ?? null
              }
            />
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs">
            {entry.stack && onSelectLayer ? (
              <PullRequestStackPopover
                workspaceId={entry.projectId}
                access={{ workspaceId: entry.projectId }}
                reference={{ key: entry.key, number: entry.number }}
                membership={entry.stack}
                onSelect={onSelectLayer}
              />
            ) : null}
            <PullRequestDiffStat
              additions={entry.additions}
              deletions={entry.deletions}
            />
          </span>
        </span>
        <span className="@container/pr-row-meta flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground">
          <span
            className="flex min-w-0 shrink max-w-40 items-center gap-1.5"
            title={entry.author?.login ?? "ghost"}
          >
            <PullRequestActorAvatar actor={entry.author} />
            <span className="sr-only @xs/pr-row-meta:not-sr-only @xs/pr-row-meta:truncate">
              {entry.author?.login ?? "ghost"}
            </span>
          </span>
          <span className="min-w-0 truncate">{entry.repository}</span>
          <span className="flex min-w-0 items-center gap-1">
            {entry.labels.slice(0, 3).map((label, index) => (
              <PullRequestLabelChip
                key={label.name}
                label={{ ...label, color: label.color ?? "" }}
                className={
                  index === 0
                    ? ""
                    : index === 1
                      ? "hidden @xl/pr-row-meta:inline-flex"
                      : "hidden @3xl/pr-row-meta:inline-flex"
                }
              >
                {entry.labels.length > index + 1 ? (
                  <span
                    className={
                      index === 0
                        ? "shrink-0 @xl/pr-row-meta:hidden"
                        : index === 1
                          ? "shrink-0 @3xl/pr-row-meta:hidden"
                          : "shrink-0"
                    }
                  >
                    +{entry.labels.length - index - 1}
                  </span>
                ) : null}
              </PullRequestLabelChip>
            ))}
          </span>
          {search && scorePullRequestMatch(entry, search) <= 10 ? (
            <span
              title="Matched in the description"
              className="flex min-w-6 items-center gap-1 overflow-hidden rounded-full border border-border/60 px-1 text-3xs"
            >
              <span className="sr-only">matched in the description</span>
              <SearchIcon aria-hidden className="size-3 shrink-0" />
              <span
                aria-hidden
                className="hidden truncate @xs/pr-row-meta:block"
              >
                matched in the description
              </span>
            </span>
          ) : null}
          <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">
            {formatRelativeTimeLabel(entry.updatedAt)}
          </span>
        </span>
      </span>
    </button>
  );
}
export function PullRequestInboxPage() {
  const navigate = useNavigate();
  const preferences = useSearch({ from: "/pull-requests" });
  const menuFilters: PullRequestListFilters = {
    draft: preferences.draft,
    review: preferences.review,
    checks: preferences.checks,
    author: preferences.author,
    labels: preferences.labels?.map((label) => [label]),
  };
  const [debounced, setDebounced] = useState(preferences.q);
  const [pagination, setPagination] = useState<{
    scope: string;
    pageCount: number;
  } | null>(null);
  const selected =
    preferences.repository &&
    preferences.number &&
    preferences.selectedProjectId
      ? {
          key: pullRequestKey.parse(
            `github.com/${preferences.repository.toLowerCase()}/${preferences.number}`,
          ),
          projectId: preferences.selectedProjectId,
        }
      : undefined;
  const setSelected = (
    entry:
      | Pick<PullRequestListEntry, "repository" | "number" | "projectId">
      | undefined,
  ) =>
    void navigate({
      to: "/pull-requests",
      search: (current) => ({
        ...current,
        ...preferences,
        repository: entry?.repository,
        number: entry?.number,
        selectedProjectId: entry?.projectId,
      }),
      resetScroll: false,
    });
  const panelHost = useRef<HTMLElement>(null);
  const { width: panelWidth, handlers: panelResize } = usePanelWidth(
    panelHost,
    !!selected,
  );
  const [checkout, setCheckout] = useState<PrObservation>();
  const [prepared, setPrepared] = useState<Thread>();
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const projects = useQuery({
    queryKey: ["workspaces"],
    queryFn: ipc.workspaces,
  });
  const repositories = (projects.data ?? []).filter(
    (p) => p.kind === "repository",
  );
  const projectId =
    projects.isPending ||
    repositories.some((p) => p.id === preferences.projectId)
      ? preferences.projectId
      : undefined;
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(preferences.q), 250);
    return () => clearTimeout(timer);
  }, [preferences.q]);
  useEffect(() => savePrInboxPreferences(preferences), [preferences]);
  const parsed = parsePullRequestQuery(debounced);
  const filters: PullRequestListFilters = {
    ...menuFilters,
    ...parsed.filters,
  };
  const hostQuery = inboxHostQuery(parsed.text, filters, undefined);
  const listScope = JSON.stringify([projectId, preferences.state, hostQuery]);
  const page = pagination?.scope === listScope ? pagination : null;
  const query = useQuery({
    queryKey: [
      "pr-inbox",
      projectId,
      preferences.state,
      hostQuery,
      page?.pageCount,
    ],
    queryFn: () =>
      loadInboxPages(
        (cursors) =>
          ipc.pullRequestInbox({
            workspaceId: projectId,
            state: preferences.state,
            query: hostQuery,
            limit: 99,
            cursors,
            continuation: cursors !== undefined,
          }),
        page?.pageCount ?? 1,
      ),
    enabled: repositories.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: 60_000,
  });
  const typedParsed = parsePullRequestQuery(preferences.q);
  const typedFilters = { ...menuFilters, ...typedParsed.filters };
  const viewers = { "github.com": query.data?.viewer ?? "" };
  const entries = narrowPullRequestsToFilters(query.data?.entries ?? [], {
    state: preferences.state,
    projectId,
    host: undefined,
  }).filter(
    (entry) =>
      matchesPullRequestFilters(entry, typedFilters, query.data?.viewer) &&
      (typedFilters.checks === undefined ||
        entry.checksState === typedFilters.checks),
  );
  const involved = filterPullRequestsByInvolvement(
    entries,
    viewers,
    preferences.involvement,
  );
  const ranked = rankPullRequestMatches(
    visiblePullRequestSearchEntries(
      involved,
      typedParsed.text,
      preferences.q !== debounced || query.isPlaceholderData,
    ),
    typedParsed.text,
  );
  const groups = sortPullRequestGroups(
    groupPullRequestsByInvolvement(ranked, viewers),
    preferences.sort,
    typedParsed.text,
    () => true,
    preferences.involvement,
  );
  const facets = collectPullRequestListFacets(
    query.data?.entries ?? [],
    preferences.state,
  );
  const update = (patch: Partial<PrInboxSearch>) => {
    setPagination(null);
    void navigate({
      to: "/pull-requests",
      search: (current) => ({ ...current, ...preferences, ...patch }),
      resetScroll: false,
    });
  };
  const worktrees = useQuery({
    queryKey: ["worktrees", selected?.projectId],
    queryFn: () =>
      selected ? ipc.listWorktrees(selected.projectId) : Promise.resolve([]),
    enabled: !!checkout && !!selected,
    retry: false,
  });
  const access = useMemo<PrAccess | undefined>(
    () => (selected ? { workspaceId: selected.projectId } : undefined),
    [selected?.projectId],
  );
  const prepare = async (destination: PullRequestDestination) => {
    if (!checkout || !access) return;
    setCheckoutBusy(true);
    setCheckoutError(undefined);
    try {
      setPrepared(
        await ipc.preparePullRequestThread({
          sourceThreadId: access,
          target: checkout,
          destination,
        }),
      );
    } catch (error) {
      setCheckoutError(String(error));
    } finally {
      setCheckoutBusy(false);
    }
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (checkout) return;
      if (selected) {
        setSelected(undefined);
        return;
      }
      void navigate({ to: "/" });
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [checkout, selected, navigate]);
  const listBody = (
    <>
      <div className="space-y-3">
        {groups.map((group) => {
          const Icon = GROUP_ICONS[group.key];
          return (
            <div key={group.key} className="space-y-0.5">
              <div className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground/70">
                <Icon aria-hidden className="size-3.5 shrink-0" />
                <h2 className="shrink-0">{group.label}</h2>
                <span className="shrink-0 tabular-nums text-muted-foreground/50">
                  {group.entries.length}
                </span>
                <div
                  role="separator"
                  className="min-w-2 flex-1 bg-border h-px"
                />
              </div>
              {group.entries.map((entry) => (
                <InboxRow
                  key={entry.key}
                  entry={entry}
                  selected={selected?.key === entry.key}
                  search={typedParsed.text}
                  onSelect={() => setSelected(entry)}
                  onSelectLayer={(target) =>
                    setSelected({
                      projectId: entry.projectId,
                      repository: entry.repository,
                      number: target.number,
                    })
                  }
                />
              ))}
            </div>
          );
        })}
      </div>
      {query.isPending && (projects.isPending || repositories.length > 0) ? (
        <PullRequestListGhost />
      ) : groups.length === 0 ? (
        <PullRequestListEmptyState
          query={preferences.q}
          filtered={
            preferences.state !== "open" ||
            preferences.involvement !== "all" ||
            !!projectId ||
            Object.values(menuFilters).some(Boolean)
          }
          searching={
            !!preferences.q && (preferences.q !== debounced || query.isFetching)
          }
          hasProjects={projects.isPending || repositories.length > 0}
          refreshing={query.isFetching}
          canLoadMore={query.data?.limited ?? false}
          loadingMore={!!page && query.isFetching}
          onClearQuery={() => update({ q: "" })}
          onLoadMore={() =>
            query.data &&
            setPagination({
              scope: listScope,
              pageCount: (page?.pageCount ?? 1) + 1,
            })
          }
          onRefresh={() => void query.refetch()}
          onAddProject={() => openCommandPalette("add-project")}
        />
      ) : null}
      {query.error ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs"
        >
          <span>
            {String(query.error)}{" "}
            {entries.length ? "Showing the last pull requests loaded." : ""}
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {(query.data?.errors ?? []).map((error) => (
        <div
          key={error.projectId}
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-xs"
        >
          {error.projectTitle}: {error.message}
        </div>
      ))}
      {query.data?.limited ? (
        <div className="flex justify-center py-3 text-xs text-muted-foreground">
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() =>
              query.data &&
              setPagination({
                scope: listScope,
                pageCount: (page?.pageCount ?? 1) + 1,
              })
            }
          >
            Load more pull requests
          </Button>
        </div>
      ) : null}
    </>
  );
  return (
    <div className="relative flex min-h-0 flex-1">
      <PullRequestsColumn
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
        searchValue={preferences.q}
        involvement={preferences.involvement}
        state={preferences.state}
        host={undefined}
        hostMenuOptions={[{ value: "", label: "All", Icon: LayersIcon }]}
        onInvolvement={(involvement) => update({ involvement })}
        onState={(state) => update({ state })}
        onHost={() => {}}
        searchInput={
          <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={preferences.q}
              onChange={(event) =>
                update({ q: event.target.value.slice(0, 200) })
              }
              placeholder="Search pull requests, or label:bug"
              aria-label="Search pull requests"
            />
          </InputGroup>
        }
        sortMenu={
          <PullRequestSortMenu
            value={preferences.sort}
            onChange={(sort) => update({ sort })}
          />
        }
        filtersMenu={
          <PullRequestInboxFilters
            state={preferences.state}
            involvement={preferences.involvement}
            filters={menuFilters}
            projectId={projectId}
            projects={repositories}
            authors={facets.authors}
            labels={facets.labels}
            errors={query.data?.errors ?? []}
            onState={(state) => update({ state })}
            onInvolvement={(involvement) => update({ involvement })}
            onFilters={(filters) =>
              update({
                draft: filters.draft,
                review: filters.review,
                checks: filters.checks,
                author: filters.author,
                labels: filters.labels?.flatMap((group) => [...group]),
              })
            }
            onProject={(projectId) => update({ projectId })}
            onClear={() => update(clearPrInboxFilters(preferences))}
          />
        }
        rightPanelControl={
          selected ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close right panel"
              onClick={() => setSelected(undefined)}
            >
              <XIcon className="size-4" />
            </Button>
          ) : null
        }
        titlebarControls={null}
        rightPanelOpen={!!selected}
        listBody={listBody}
        scrollRef={scrollRef}
      />
      {selected && access ? (
        <aside
          aria-label="Pull request details"
          ref={panelHost}
          className="relative flex h-full min-h-0 min-w-0 max-w-full shrink-0 flex-col border-l border-border bg-background"
          style={{ width: panelWidth }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none"
            {...panelResize}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
            />
          </div>
          <div
            data-right-panel-tabbar
            data-tauri-drag-region="deep"
            className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2 pr-28 drag-region"
          >
            <div
              data-active-tab="true"
              className="cursor-pointer group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs [-webkit-app-region:no-drag] bg-accent text-foreground"
            >
              <PanelTabCloseButton
                label={`Close #${preferences.number}`}
                onClick={() => setSelected(undefined)}
              >
                <PullRequestGlyph.pullRequest className="size-3.5" />
              </PanelTabCloseButton>
              <span className="truncate">#{preferences.number}</span>
            </div>
          </div>
          <PullRequestDetail
            key={selected.key}
            prKey={selected.key}
            onSelectPullRequest={(key) =>
              setSelected({
                projectId: selected.projectId,
                repository: key.split("/").slice(1, 3).join("/"),
                number: Number(key.split("/").at(-1)),
              })
            }
            workspaceId={selected.projectId}
            threadId={access}
            canAskCodex={false}
            onAskCodex={() => {}}
            onBack={() => setSelected(undefined)}
            onActed={() => {
              setPagination(null);
              void query.refetch();
            }}
            onCheckout={(target) => {
              setCheckout(target);
              setPrepared(undefined);
              setCheckoutError(undefined);
            }}
          />
        </aside>
      ) : null}
      {checkout ? (
        <PullRequestCheckoutDialog
          target={checkout}
          worktrees={worktrees.data ?? []}
          loading={worktrees.isPending}
          discoveryError={worktrees.error ? String(worktrees.error) : undefined}
          busy={checkoutBusy}
          prepared={prepared ?? null}
          error={checkoutError}
          repair={false}
          onClose={() => setCheckout(undefined)}
          onPrepare={(destination) => void prepare(destination)}
          onOpen={() =>
            prepared &&
            void navigate({
              to: "/",
              search: { workspace: prepared.workspaceId, thread: prepared.id },
            })
          }
        />
      ) : null}
    </div>
  );
}
