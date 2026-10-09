// Labels and class strings ported from T3 Code v0.0.45 PullRequestListFilters.tsx and _chat.pull-requests.tsx (MIT).
import { useState } from "react";
import {
  ArrowDownUpIcon,
  CalendarArrowDownIcon,
  CalendarArrowUpIcon,
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  LayersIcon,
  ListChecksIcon,
  ListFilterIcon,
  Maximize2Icon,
  Minimize2Icon,
  PenLineIcon,
  UserLockIcon,
  CircleCheckIcon,
  CircleXIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  UserRoundIcon,
  TagIcon,
  FolderGit2Icon,
  SearchIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../ui/controls";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/input-group";
import { PullRequestActorAvatar } from "./pullRequestPresentation";
import {
  Menu,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuItem,
} from "../ui/menu";
import { PullRequestGlyph } from "./pullRequestPresentation";
import type {
  PullRequestInvolvement,
  PullRequestListState,
  PullRequestListSort,
  PullRequestListFilters,
} from "./prInbox";
import type {
  PullRequestAuthorFacet,
  PullRequestLabelFacet,
} from "./pullRequestList.logic";
export type PullRequestFilterOption<Value extends string> = {
  value: Value;
  label: string;
  Icon: LucideIcon;
};
export const INVOLVEMENT_TABS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "reviewing", label: "Reviewing", Icon: EyeIcon },
  { value: "authored", label: "Authored", Icon: PenLineIcon },
] satisfies PullRequestFilterOption<PullRequestInvolvement>[];
export const STATE_TABS = [
  { value: "all", label: "All", Icon: LayersIcon },
  { value: "open", label: "Open", Icon: PullRequestGlyph.pullRequest },
  { value: "closed", label: "Closed", Icon: PullRequestGlyph.closed },
  { value: "merged", label: "Merged", Icon: PullRequestGlyph.merged },
] satisfies PullRequestFilterOption<PullRequestListState>[];
export const SORT_OPTIONS = [
  { value: "ready", label: "Merge readiness", Icon: ListChecksIcon },
  { value: "blocked", label: "Blocked on me", Icon: UserLockIcon },
  { value: "updated", label: "Recently updated", Icon: ClockIcon },
  { value: "newest", label: "Newest shown", Icon: CalendarArrowDownIcon },
  { value: "oldest", label: "Oldest shown", Icon: CalendarArrowUpIcon },
  { value: "largest", label: "Largest shown", Icon: Maximize2Icon },
  { value: "smallest", label: "Smallest shown", Icon: Minimize2Icon },
] satisfies PullRequestFilterOption<PullRequestListSort>[];
function RadioGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: readonly PullRequestFilterOption<Value>[];
  onChange: (value: Value) => void;
}) {
  return (
    <div role="group" aria-label={label}>
      {options.map((option) => (
        <MenuRadioItem
          key={option.value}
          checked={value === option.value}
          onClick={() => onChange(option.value)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <option.Icon aria-hidden className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
          </span>
        </MenuRadioItem>
      ))}
    </div>
  );
}
function RadioSub<Value extends string>(
  props: Parameters<typeof RadioGroup<Value>>[0],
) {
  return (
    <MenuSub
      label={
        <>
          <span className="flex-1">{props.label}</span>
          <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
            {props.options.find((o) => o.value === props.value)?.label}
          </span>
        </>
      }
    >
      <RadioGroup {...props} />
    </MenuSub>
  );
}
export function PullRequestSortMenu({
  value,
  onChange,
}: {
  value: PullRequestListSort;
  onChange: (value: PullRequestListSort) => void;
}) {
  return (
    <Menu
      trigger={(props) => (
        <Button {...props} variant="outline" aria-label="Sort pull requests">
          <ArrowDownUpIcon className="size-4" />
          <span>Sort</span>
        </Button>
      )}
    >
      <RadioGroup
        label="Sort pull requests"
        value={value}
        options={SORT_OPTIONS}
        onChange={onChange}
      />
    </Menu>
  );
}
export function PullRequestInboxFilters({
  state,
  involvement,
  filters,
  projectId,
  projects,
  authors,
  labels,
  errors,
  onState,
  onInvolvement,
  onFilters,
  onProject,
  onClear,
}: {
  state: PullRequestListState;
  involvement: PullRequestInvolvement;
  filters: PullRequestListFilters;
  projectId: string | undefined;
  projects: readonly { id: string; label: string }[];
  authors: readonly PullRequestAuthorFacet[];
  labels: readonly PullRequestLabelFacet[];
  errors: readonly { projectId: string; message: string }[];
  onState: (state: PullRequestListState) => void;
  onInvolvement: (involvement: PullRequestInvolvement) => void;
  onFilters: (filters: PullRequestListFilters) => void;
  onProject: (id: string | undefined) => void;
  onClear: () => void;
}) {
  const [authorQuery, setAuthorQuery] = useState("");
  const selectedLabels = (filters.labels ?? []).flat();
  const visibleLabels = [
    ...selectedLabels
      .filter(
        (name) =>
          !labels.some(
            (label) => label.name.toLowerCase() === name.toLowerCase(),
          ),
      )
      .map((name) => ({ name, color: null, count: 0 })),
    ...labels,
  ];
  const count = [
    state !== "open",
    involvement !== "all",
    projectId,
    filters.draft,
    filters.review,
    filters.checks,
    filters.author,
    ...selectedLabels,
  ].filter(Boolean).length;
  const update = (next: Partial<PullRequestListFilters>) =>
    onFilters({ ...filters, ...next });
  return (
    <Menu
      align="end"
      trigger={(props) => (
        <Button {...props} variant="outline">
          <ListFilterIcon className="size-4" />
          <span>Filters</span>
          {count > 0 ? (
            <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </Button>
      )}
    >
      <RadioSub
        label="State"
        value={state}
        options={STATE_TABS}
        onChange={onState}
      />
      <RadioSub
        label="Involvement"
        value={involvement}
        options={INVOLVEMENT_TABS}
        onChange={onInvolvement}
      />
      <MenuSeparator />
      <MenuSub
        icon={<UserRoundIcon className="size-3.5" />}
        label={
          <>
            <span className="flex-1">Author</span>
            <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
              {filters.author ?? "Anyone"}
            </span>
          </>
        }
      >
        <div className="p-1 pb-2">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              size="compact"
              placeholder="Search authors"
              aria-label="Search authors"
              value={authorQuery}
              onChange={(event) => setAuthorQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "Escape")
                  event.stopPropagation();
              }}
            />
          </InputGroup>
        </div>
        <MenuRadioItem
          checked={!filters.author}
          onClick={() => update({ author: undefined })}
        >
          Anyone
        </MenuRadioItem>
        {authors
          .filter(
            (a) =>
              a.actor.login.toLowerCase() === filters.author?.toLowerCase() ||
              a.actor.login.toLowerCase().includes(authorQuery.toLowerCase()),
          )
          .slice(0, 10)
          .map((a) => (
            <MenuRadioItem
              key={a.actor.login}
              checked={filters.author === a.actor.login}
              onClick={() => update({ author: a.actor.login })}
            >
              <span className="flex min-w-0 items-center gap-2">
                <PullRequestActorAvatar actor={a.actor} />
                <span className="min-w-0 flex-1 truncate">{a.actor.login}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {a.mergedCount} merges loaded
                </span>
              </span>
            </MenuRadioItem>
          ))}
      </MenuSub>
      <MenuSub
        icon={<TagIcon className="size-3.5" />}
        label={
          <>
            <span className="flex-1">Labels</span>
            <span className="text-xs text-muted-foreground">
              {selectedLabels.length === 0
                ? "Any"
                : `${selectedLabels.length} selected`}
            </span>
          </>
        }
      >
        {visibleLabels.length === 0 ? (
          <MenuItem disabled>No labels in this view</MenuItem>
        ) : null}
        {visibleLabels.map((label) => (
          <MenuRadioItem
            data-keep-open
            key={label.name}
            checked={selectedLabels.some(
              (name) => name.toLowerCase() === label.name.toLowerCase(),
            )}
            onClick={() => {
              const next = selectedLabels.some(
                (name) => name.toLowerCase() === label.name.toLowerCase(),
              )
                ? selectedLabels.filter(
                    (name) => name.toLowerCase() !== label.name.toLowerCase(),
                  )
                : [...selectedLabels, label.name].slice(0, 10);
              update({
                labels: next.length ? next.map((name) => [name]) : undefined,
              });
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-full bg-muted-foreground"
                style={{
                  backgroundColor: label.color
                    ? `#${label.color.replace(/^#/, "")}`
                    : undefined,
                }}
              />
              <span className="min-w-0 flex-1 truncate">{label.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {label.count}
              </span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuSub>
      <RadioSub
        label="Draft"
        value={filters.draft ?? "all"}
        options={[
          { value: "all", label: "All", Icon: LayersIcon },
          { value: "only", label: "Drafts only", Icon: PullRequestGlyph.draft },
          { value: "hide", label: "Hide drafts", Icon: EyeOffIcon },
        ]}
        onChange={(value) =>
          update({ draft: value === "all" ? undefined : value })
        }
      />
      <RadioSub
        label="Review"
        value={filters.review ?? "all"}
        options={[
          { value: "all", label: "All", Icon: LayersIcon },
          { value: "approved", label: "Approved", Icon: CircleCheckIcon },
          {
            value: "changes-requested",
            label: "Changes requested",
            Icon: CircleXIcon,
          },
          {
            value: "review-required",
            label: "Review required",
            Icon: CircleDashedIcon,
          },
          { value: "none", label: "No reviews", Icon: CircleSlashIcon },
        ]}
        onChange={(value) =>
          update({ review: value === "all" ? undefined : value })
        }
      />
      <RadioSub
        label="Checks"
        value={filters.checks ?? "all"}
        options={[
          { value: "all", label: "All", Icon: LayersIcon },
          { value: "passing", label: "Passing", Icon: CircleCheckIcon },
          { value: "failing", label: "Failing", Icon: CircleXIcon },
        ]}
        onChange={(value) =>
          update({ checks: value === "all" ? undefined : value })
        }
      />
      <MenuSeparator />
      <MenuSub
        icon={<FolderGit2Icon className="size-3.5" />}
        label={
          <>
            <span className="flex-1">Project</span>
            <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
              {projects.find((p) => p.id === projectId)?.label ??
                "All projects"}
            </span>
          </>
        }
      >
        <MenuRadioItem
          checked={!projectId}
          onClick={() => onProject(undefined)}
        >
          All projects
        </MenuRadioItem>
        {projects.map((project) => (
          <MenuRadioItem
            key={project.id}
            checked={projectId === project.id}
            onClick={() => onProject(project.id)}
            title={errors.find((e) => e.projectId === project.id)?.message}
          >
            {project.label}
            {errors.some((e) => e.projectId === project.id)
              ? " · Unavailable"
              : ""}
          </MenuRadioItem>
        ))}
      </MenuSub>
      {count > 0 ? (
        <>
          <MenuSeparator />
          <MenuRadioItem checked={false} onClick={onClear}>
            Clear filters
          </MenuRadioItem>
        </>
      ) : null}
    </Menu>
  );
}
