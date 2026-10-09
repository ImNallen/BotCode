// Ported from T3 Code v0.0.45 apps/web/src/components/pullRequest/pullRequestList.logic.ts (MIT).
import type {
  PullRequestListEntry,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestInvolvement,
  PullRequestActor,
  PullRequestLabel,
  PullRequestListSort,
} from "./prInbox";
const resolvePullRequestAuthorFilter = (
  author: string,
  viewer?: string | null,
) => (/^@?me$/i.test(author) ? (viewer ?? author) : author);
const toSortableTimestamp = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};
export type PullRequestGroupKey = "reviewRequested" | "authored" | "others";

export interface PullRequestGroup<
  Entry extends PullRequestListEntry = PullRequestListEntry,
> {
  readonly key: PullRequestGroupKey;
  readonly label: string;
  readonly entries: ReadonlyArray<Entry>;
}

export interface PullRequestAuthorFacet {
  readonly actor: PullRequestActor;
  readonly count: number;
  readonly mergedCount: number;
}

export interface PullRequestLabelFacet extends PullRequestLabel {
  readonly count: number;
}

export type PullRequestViewers = Record<string, string>;

type ScopedEntry = PullRequestListEntry & { readonly environmentId?: string };

const pullRequestViewerKey = (entry: ScopedEntry): string =>
  `${entry.environmentId ?? ""} ${entry.host}`;

const GROUP_LABELS: Record<PullRequestGroupKey, string> = {
  reviewRequested: "Review requested",
  authored: "Authored",
  others: "Others",
};

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function pullRequestLabelColor(color: string | null): string | null {
  const hex = color?.trim().replace(/^#/, "") ?? "";
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

export function collectPullRequestListFacets(
  entries: ReadonlyArray<PullRequestListEntry>,
  state: PullRequestListState,
) {
  const authors = new Map<string, PullRequestAuthorFacet>();
  const labels = new Map<string, PullRequestLabelFacet>();
  const uniqueEntries = new Map(
    entries.map((entry) => [pullRequestEntryKey(entry), entry]),
  );
  for (const entry of uniqueEntries.values()) {
    const inState = state === "all" || entry.state === state;
    if (entry.author !== null) {
      const key = normalize(entry.author.login);
      if (key !== null) {
        const held = authors.get(key);
        authors.set(key, {
          actor: held?.actor ?? entry.author,
          count: (held?.count ?? 0) + Number(inState),
          mergedCount:
            (held?.mergedCount ?? 0) + Number(entry.state === "merged"),
        });
      }
    }
    if (!inState) continue;
    for (const label of entry.labels) {
      const key = normalize(label.name);
      if (key === null) continue;
      const held = labels.get(key);
      labels.set(key, {
        ...label,
        name: held?.name ?? label.name,
        color: held?.color ?? label.color,
        count: (held?.count ?? 0) + 1,
      });
    }
  }
  return {
    authors: [...authors.values()]
      .filter((author) => author.count > 0)
      .toSorted(
        (left, right) =>
          right.mergedCount - left.mergedCount ||
          right.count - left.count ||
          left.actor.login.localeCompare(right.actor.login),
      ),
    labels: [...labels.values()].toSorted(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    ),
  };
}

export function pullRequestEntryViewer(
  entry: ScopedEntry,
  viewers: PullRequestViewers,
): string | null {
  return normalize(viewers[pullRequestViewerKey(entry)] ?? viewers[entry.host]);
}

function isAuthoredByViewer(
  entry: ScopedEntry,
  viewers: PullRequestViewers,
): boolean {
  const viewer = pullRequestEntryViewer(entry, viewers);
  return viewer !== null && normalize(entry.author?.login) === viewer;
}

const REVIEW_VALUES: Record<string, PullRequestListFilters["review"]> = {
  approved: "approved",
  changes_requested: "changes-requested",
  "changes-requested": "changes-requested",
  required: "review-required",
  "review-required": "review-required",
  none: "none",
};
const CHECKS_VALUES: Record<string, PullRequestListFilters["checks"]> = {
  success: "passing",
  passing: "passing",
  failure: "failing",
  failing: "failing",
};

const QUERY_TOKEN = /(?:[^\s"]|"[^"]*")+/g;

const MAX_QUALIFIER_VALUES = 10;
const MAX_QUALIFIER_LENGTH = 200;

function qualifierValue(raw: string): string {
  return raw.replaceAll('"', "").trim();
}

function splitQualifierList(raw: string): string[] {
  if (/^\s*"[^"]*"\s*$/.test(raw)) {
    const whole = qualifierValue(raw);
    return whole.length === 0 ? [] : [whole];
  }
  return raw
    .split(",")
    .map((part) => qualifierValue(part))
    .filter((part) => part.length > 0);
}

function boundedNames(names: ReadonlyArray<string>): string[] {
  return names
    .slice(0, MAX_QUALIFIER_VALUES)
    .map((name) => name.slice(0, MAX_QUALIFIER_LENGTH).trim())
    .filter((name) => name.length > 0);
}

export function parsePullRequestQuery(raw: string): {
  readonly text: string;
  readonly filters: PullRequestListFilters;
} {
  const text: string[] = [];
  const labels: string[][] = [];
  const excludedLabels: string[] = [];
  let author: string | undefined;
  let draft: PullRequestListFilters["draft"];
  let review: PullRequestListFilters["review"];
  let checks: PullRequestListFilters["checks"];
  for (const [token] of raw.matchAll(QUERY_TOKEN)) {
    const qualifier = /^(-?)([A-Za-z][A-Za-z0-9_-]*):(.*)$/.exec(token);
    const value = qualifier === null ? "" : qualifierValue(qualifier[3] ?? "");
    const negated = qualifier?.[1] === "-";
    switch (value.length === 0 ? "" : (qualifier?.[2]?.toLowerCase() ?? "")) {
      case "label": {
        const names = boundedNames(splitQualifierList(qualifier?.[3] ?? ""));
        if (names.length === 0) break;
        if (negated) excludedLabels.push(...names);
        else labels.push(names);
        continue;
      }
      case "author":
        if (negated) break;
        author = value.slice(0, MAX_QUALIFIER_LENGTH).trim();
        continue;
      case "draft":
        if (
          negated ||
          (value.toLowerCase() !== "true" && value.toLowerCase() !== "false")
        )
          break;
        draft = value.toLowerCase() === "true" ? "only" : "hide";
        continue;
      case "review": {
        const decision = negated
          ? undefined
          : REVIEW_VALUES[value.toLowerCase()];
        if (decision === undefined) break;
        review = decision;
        continue;
      }
      case "status":
      case "checks": {
        const state = negated ? undefined : CHECKS_VALUES[value.toLowerCase()];
        if (state === undefined) break;
        checks = state;
        continue;
      }
      case "":
        break;
      default:
        if (!value.startsWith("/")) {
          const names = boundedNames(
            splitQualifierList(qualifier?.[3] ?? "").map((name) =>
              name.includes(":") ? name : `${qualifier?.[2] ?? ""}:${name}`,
            ),
          );
          if (names.length === 0) break;
          if (negated) excludedLabels.push(...names);
          else labels.push(names);
          continue;
        }
    }
    text.push(token);
  }
  return {
    text: text.join(" "),
    filters: {
      ...(labels.length === 0
        ? {}
        : { labels: labels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(excludedLabels.length === 0
        ? {}
        : { excludedLabels: excludedLabels.slice(0, MAX_QUALIFIER_VALUES) }),
      ...(author === undefined ? {} : { author }),
      ...(draft === undefined ? {} : { draft }),
      ...(review === undefined ? {} : { review }),
      ...(checks === undefined ? {} : { checks }),
    },
  };
}

export function matchesPullRequestQuery(
  entry: PullRequestListEntry,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return true;
  return `#${entry.number} ${entry.title} ${entry.repository} ${entry.headBranch} ${entry.author?.login ?? ""}`
    .toLowerCase()
    .includes(normalizedQuery);
}

export function filterPullRequestsByInvolvement<Entry extends ScopedEntry>(
  entries: ReadonlyArray<Entry>,
  viewers: PullRequestViewers,
  involvement: PullRequestInvolvement,
): ReadonlyArray<Entry> {
  if (involvement === "reviewing") {
    return entries.filter((entry) => entry.viewerReviewRequested);
  }
  if (involvement === "authored") {
    return entries.filter((entry) => isAuthoredByViewer(entry, viewers));
  }
  return entries;
}

export function narrowPullRequestsToFilters<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  filters: {
    readonly state: PullRequestListState;
    readonly projectId: string | undefined;
    readonly host: string | undefined;
  },
): ReadonlyArray<Entry> {
  return entries.filter(
    (entry) =>
      (filters.state === "all" || entry.state === filters.state) &&
      (filters.projectId === undefined ||
        entry.projectId === filters.projectId) &&
      (filters.host === undefined || entry.host === filters.host),
  );
}

export function matchesPullRequestFilters(
  entry: PullRequestListEntry,
  filters: PullRequestListFilters,
  viewer?: string | null,
): boolean {
  const labels = entry.labels.map((label) => label.name.trim().toLowerCase());
  const holds = (label: string) => labels.includes(label.trim().toLowerCase());
  return (
    (filters.draft === undefined ||
      entry.isDraft === (filters.draft === "only")) &&
    (filters.review === undefined ||
      (filters.review === "none"
        ? entry.reviewDecision === undefined
        : entry.reviewDecision === filters.review)) &&
    (filters.labels === undefined ||
      filters.labels.every((group) => group.some(holds))) &&
    (filters.excludedLabels === undefined ||
      !filters.excludedLabels.some(holds)) &&
    (filters.author === undefined ||
      entry.author?.login.toLowerCase() ===
        resolvePullRequestAuthorFilter(filters.author, viewer).toLowerCase())
  );
}

export function groupPullRequestsByInvolvement<Entry extends ScopedEntry>(
  entries: ReadonlyArray<Entry>,
  viewers: PullRequestViewers,
): ReadonlyArray<PullRequestGroup<Entry>> {
  const buckets: Record<PullRequestGroupKey, Entry[]> = {
    reviewRequested: [],
    authored: [],
    others: [],
  };
  for (const entry of entries) {
    if (isAuthoredByViewer(entry, viewers)) {
      buckets.authored.push(entry);
    } else if (entry.viewerReviewRequested) {
      buckets.reviewRequested.push(entry);
    } else {
      buckets.others.push(entry);
    }
  }
  return (["authored", "reviewRequested", "others"] as const)
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], entries: buckets[key] }));
}

export function pullRequestEntryKey(entry: ScopedEntry): string {
  const scope =
    entry.environmentId === undefined ? "" : `${entry.environmentId}:`;
  return `${scope}${entry.host}:${entry.repository}#${entry.number}`;
}

export function scorePullRequestMatch(
  entry: PullRequestListEntry,
  query: string,
): number {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;
  const number = needle.replace(/^#/u, "");
  if (/^\d+$/u.test(number)) return String(entry.number) === number ? 100 : 0;

  const title = entry.title.toLowerCase();
  const terms = needle.split(/\s+/u).filter((term) => term.length > 0);
  if (title === needle) return 90;
  if (title.includes(needle)) return 80;
  if (terms.length > 1 && terms.every((term) => title.includes(term)))
    return 70;
  if (entry.headBranch.toLowerCase().includes(needle)) return 60;
  if ((entry.author?.login ?? "").toLowerCase().includes(needle)) return 50;
  if (entry.repository.toLowerCase().includes(needle)) return 40;
  if (terms.some((term) => title.includes(term))) return 30;
  return 10;
}

export function rankPullRequestMatches<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  query: string,
): ReadonlyArray<Entry> {
  if (query.trim().length === 0) return entries;
  return entries.toSorted((left, right) => {
    const byScore =
      scorePullRequestMatch(right, query) - scorePullRequestMatch(left, query);
    return byScore !== 0
      ? byScore
      : right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function rankPullRequestsByMergeReadiness<
  Entry extends PullRequestListEntry,
>(
  entries: ReadonlyArray<Entry>,
  hasMeasuredSize: (entry: Entry) => boolean = (entry) =>
    entry.additions + entry.deletions > 0,
): ReadonlyArray<Entry> {
  const tier = (entry: Entry) => {
    if (entry.mergeability === "conflicting") return 4;
    if (entry.state !== "open") return 3;
    if (entry.isDraft) return 2;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved")
      return 0;
    if (entry.checksState === "passing") return 1;
    return 2;
  };
  return entries.toSorted((left, right) => {
    const byTier = tier(left) - tier(right);
    if (byTier !== 0) return byTier;
    const measured =
      Number(hasMeasuredSize(right)) - Number(hasMeasuredSize(left));
    const sized =
      left.additions + left.deletions - (right.additions + right.deletions);
    return measured || sized || right.updatedAt.localeCompare(left.updatedAt);
  });
}

function rankByTierThenRecency<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  tier: (entry: Entry) => number,
): ReadonlyArray<Entry> {
  const timestamp = (entry: Entry) => toSortableTimestamp(entry.updatedAt);
  return entries.toSorted((left, right) => {
    const byTier = tier(left) - tier(right);
    if (byTier !== 0) return byTier;
    const leftUpdated = timestamp(left);
    const rightUpdated = timestamp(right);
    const measured =
      Number(leftUpdated === null) - Number(rightUpdated === null);
    if (measured !== 0) return measured;
    if (leftUpdated === null || rightUpdated === null) return 0;
    return rightUpdated - leftUpdated;
  });
}

export function rankPullRequestsBlockedOnAuthor<
  Entry extends PullRequestListEntry,
>(entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> {
  return rankByTierThenRecency(entries, (entry) => {
    if (entry.state !== "open") return 6;
    if (entry.mergeability === "conflicting") return 0;
    if (entry.reviewDecision === "changes-requested") return 1;
    if (entry.checksState === "failing") return 2;
    if (entry.isDraft) return 3;
    if (entry.checksState === "passing" && entry.reviewDecision === "approved")
      return 5;
    return 4;
  });
}

export function rankPullRequestsBlockedOnReviewer<
  Entry extends PullRequestListEntry,
>(entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> {
  return rankByTierThenRecency(entries, (entry) =>
    entry.state === "open" ? 0 : 1,
  );
}

export function sortPullRequestGroups<Entry extends PullRequestListEntry>(
  groups: ReadonlyArray<PullRequestGroup<Entry>>,
  sort: PullRequestListSort,
  searchText: string,
  hasMeasuredSize: (entry: Entry) => boolean = (entry) =>
    entry.additions + entry.deletions > 0,
  involvement: PullRequestInvolvement = "all",
): ReadonlyArray<PullRequestGroup<Entry>> {
  const sortWithinGroups = (
    rank: (entries: ReadonlyArray<Entry>) => ReadonlyArray<Entry>,
  ) => groups.map((group) => ({ ...group, entries: rank(group.entries) }));

  if (sort === "ready") {
    return searchText.trim().length === 0
      ? sortWithinGroups((entries) =>
          rankPullRequestsByMergeReadiness(entries, hasMeasuredSize),
        )
      : groups;
  }
  if (sort === "blocked") {
    if (searchText.trim().length > 0) return groups;
    const role = (key: PullRequestGroupKey) =>
      key === "others"
        ? involvement
        : key === "authored"
          ? "authored"
          : "reviewing";
    return groups.map((group) => {
      const groupRole = role(group.key);
      if (groupRole === "all") return group;
      const rank =
        groupRole === "authored"
          ? rankPullRequestsBlockedOnAuthor
          : rankPullRequestsBlockedOnReviewer;
      return { ...group, entries: rank(group.entries) };
    });
  }
  if (sort === "updated") return groups;

  const timestamp = (entry: Entry) =>
    toSortableTimestamp(entry.updatedAt) ??
    toSortableTimestamp(entry.createdAt) ??
    0;
  return sortWithinGroups((entries) =>
    entries.toSorted((left, right) => {
      if (sort === "newest" || sort === "oldest") {
        const leftCreated = toSortableTimestamp(left.createdAt);
        const rightCreated = toSortableTimestamp(right.createdAt);
        const measured =
          Number(rightCreated !== null) - Number(leftCreated !== null);
        const dated = (leftCreated ?? 0) - (rightCreated ?? 0);
        return (
          measured ||
          (sort === "newest" ? -dated : dated) ||
          timestamp(right) - timestamp(left)
        );
      }
      const measured =
        Number(hasMeasuredSize(right)) - Number(hasMeasuredSize(left));
      const sized =
        left.additions + left.deletions - (right.additions + right.deletions);
      return (
        measured ||
        (sort === "largest" ? -sized : sized) ||
        timestamp(right) - timestamp(left)
      );
    }),
  );
}

export function visiblePullRequestSearchEntries(
  entries: readonly PullRequestListEntry[],
  query: string,
  carried: boolean,
): readonly PullRequestListEntry[] {
  return carried
    ? entries.filter((entry) => matchesPullRequestQuery(entry, query))
    : entries;
}
