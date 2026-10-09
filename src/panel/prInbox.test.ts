import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement, isValidElement, Children, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  inboxHostQuery,
  mergeInboxPages,
  loadInboxPages,
  prInboxResult,
  pullRequestListEntry,
} from "./prInbox";
import {
  collectPullRequestListFacets,
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  matchesPullRequestFilters,
  visiblePullRequestSearchEntries,
  parsePullRequestQuery,
  rankPullRequestMatches,
  sortPullRequestGroups,
} from "./pullRequestList.logic";
import { InboxRow } from "./PullRequestInboxPage";
import { PullRequestInboxFilters } from "./PullRequestInboxFilters";
import { clearPrInboxFilters, validatePrInboxSearch } from "./prInboxSearch";
const projectId = "11111111-1111-4111-8111-111111111111";
function entry(
  number: number,
  patch: Partial<ReturnType<typeof pullRequestListEntry.parse>> = {},
) {
  return pullRequestListEntry.parse({
    key: `github.com/test/repo/${number}`,
    provider: "github",
    host: "github.com",
    projectId,
    projectTitle: "Repo",
    repository: "test/repo",
    number,
    title: `Change ${number}`,
    url: `https://github.com/test/repo/pull/${number}`,
    author: { login: "other", avatarUrl: null },
    headBranch: "feature",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    ...patch,
  });
}
it("keeps T3 authored priority, reviewer requests and Others without inferring review history", () => {
  const rows = [
    entry(1, {
      author: { login: "Viewer", avatarUrl: null },
      viewerReviewRequested: true,
    }),
    entry(2, { viewerReviewRequested: true }),
    entry(3),
  ];
  const viewers = { "github.com": "viewer" };
  const groups = groupPullRequestsByInvolvement(rows, viewers);
  assert.deepEqual(
    groups.map((group) => [
      group.label,
      group.entries.map((entry) => entry.number),
    ]),
    [
      ["Authored", [1]],
      ["Review requested", [2]],
      ["Others", [3]],
    ],
  );
  assert.deepEqual(
    filterPullRequestsByInvolvement(rows, viewers, "reviewing").map(
      (entry) => entry.number,
    ),
    [1, 2],
  );
  assert.deepEqual(
    filterPullRequestsByInvolvement(rows, viewers, "authored").map(
      (entry) => entry.number,
    ),
    [1],
  );
});
it("ports structured search OR labels, exclusions, author me and exact host qualifiers", () => {
  const query = parsePullRequestQuery(
    'welcome size:S,XS -label:"needs design" author:me draft:false review:required checks:success',
  );
  assert.equal(query.text, "welcome");
  assert.deepEqual(query.filters.labels, [["size:S", "size:XS"]]);
  assert.equal(
    inboxHostQuery(query.text, query.filters, "viewer"),
    'welcome draft:false review:required status:success author:viewer label:"size:S","size:XS" -label:"needs design"',
  );
  const matching = entry(1, {
    author: { login: "viewer", avatarUrl: null },
    labels: [{ name: "size:XS", color: null }],
    reviewDecision: "review-required",
  });
  assert.equal(
    matchesPullRequestFilters(matching, query.filters, "viewer"),
    true,
  );
  assert.equal(
    matchesPullRequestFilters(
      {
        ...matching,
        labels: [...matching.labels, { name: "needs design", color: null }],
      },
      query.filters,
      "viewer",
    ),
    false,
  );
  assert.equal(
    matchesPullRequestFilters(matching, query.filters, "other"),
    false,
  );
});
it("orders every T3 sort by its behavior and ranks host-only search hits last", () => {
  const rows = [
    entry(1, {
      additions: 100,
      isDraft: true,
      createdAt: "2026-03-01T00:00:00Z",
    }),
    entry(2, {
      additions: 3,
      checksState: "passing",
      reviewDecision: "approved",
      createdAt: "2026-02-01T00:00:00Z",
    }),
    entry(3, {
      additions: 10,
      mergeability: "conflicting",
      createdAt: "2026-01-01T00:00:00Z",
    }),
  ];
  const groups = groupPullRequestsByInvolvement(rows, {
    "github.com": "other",
  });
  const numbers = (sort: Parameters<typeof sortPullRequestGroups>[1]) =>
    sortPullRequestGroups(groups, sort, "", () => true)[0]?.entries.map(
      (entry) => entry.number,
    );
  assert.deepEqual(numbers("ready"), [2, 1, 3]);
  assert.deepEqual(numbers("blocked"), [3, 1, 2]);
  assert.deepEqual(numbers("newest"), [1, 2, 3]);
  assert.deepEqual(numbers("oldest"), [3, 2, 1]);
  assert.deepEqual(numbers("largest"), [1, 3, 2]);
  assert.deepEqual(numbers("smallest"), [2, 3, 1]);
  assert.deepEqual(numbers("updated"), [1, 2, 3]);
  assert.deepEqual(
    rankPullRequestMatches(
      [entry(1), entry(2, { title: "Welcome wizard" })],
      "welcome",
    ).map((entry) => entry.number),
    [2, 1],
  );
});
it("accumulates cursor pages without duplicating a request or losing reviewer involvement", () => {
  const rows = mergeInboxPages(
    [entry(1, { viewerReviewRequested: true }), entry(2)],
    [entry(1, { title: "New title" }), entry(3)],
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.title, "New title");
  assert.equal(rows[0]?.viewerReviewRequested, true);
  const facets = collectPullRequestListFacets([...rows, entry(1)], "open");
  assert.equal(facets.authors[0]?.count, 3);
});
it("restores URL selected details independently of list scope and renders source row labels", () => {
  const search = validatePrInboxSearch({
    projectId,
    involvement: "authored",
    repository: "test/repo",
    number: 42,
    selectedProjectId: projectId,
  });
  assert.equal(search.state, "open");
  assert.equal(search.sort, "ready");
  assert.equal(search.number, 42);
  const restored = validatePrInboxSearch({
    repository: "test/repo",
    number: "42",
    selectedProjectId: projectId,
    state: "merged",
    q: "hello",
    sort: "invalid",
  });
  assert.equal(restored.number, 42);
  assert.equal(restored.state, "merged");
  assert.equal(restored.q, "hello");
  assert.equal(restored.sort, "ready");
  const html = renderToStaticMarkup(
    createElement(InboxRow, {
      entry: entry(42),
      selected: true,
      search: "",
      onSelect: () => {},
    }),
  );
  assert.match(html, /#42/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /test\/repo/);
  assert.match(html, /group\/pr-row/);
});

it("clears combined menu filters in one action and keeps search, sort and selected detail", () => {
  let search = validatePrInboxSearch({
    state: "closed",
    involvement: "reviewing",
    projectId,
    draft: "only",
    review: "approved",
    checks: "passing",
    author: "viewer",
    labels: ["bug"],
    q: "welcome",
    sort: "newest",
    repository: "test/repo",
    number: 42,
    selectedProjectId: projectId,
  });
  let navigations = 0;
  const unexpected = () => {
    throw new Error("clear must use one atomic navigation");
  };
  function Capture() {
    const tree = PullRequestInboxFilters({
      state: search.state,
      involvement: search.involvement,
      projectId,
      filters: {
        draft: search.draft,
        author: search.author,
        labels: [["bug"]],
      },
      projects: [],
      authors: [],
      labels: [],
      errors: [],
      onState: unexpected,
      onInvolvement: unexpected,
      onFilters: unexpected,
      onProject: unexpected,
      onClear: () => {
        navigations++;
        search = clearPrInboxFilters(search);
      },
    });
    const visit = (node: ReactNode): void => {
      Children.forEach(node, (child) => {
        if (
          !isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)
        )
          return;
        if (
          typeof child.props.children === "string" &&
          child.props.children.trim() === "Clear filters"
        )
          child.props.onClick?.();
        else visit(child.props.children);
      });
    };
    visit(tree);
    return null;
  }
  renderToStaticMarkup(createElement(Capture));
  assert.equal(navigations, 1);
  assert.deepEqual(
    search,
    validatePrInboxSearch({
      q: "welcome",
      sort: "newest",
      repository: "test/repo",
      number: 42,
      selectedProjectId: projectId,
    }),
  );
});
it("polls all visible pages with fresh cursors and removes stale first-page rows", async () => {
  let revision = 0;
  const calls: (Record<string, string> | undefined)[] = [];
  const read = async (cursors: Record<string, string> | undefined) => {
    calls.push(cursors);
    return prInboxResult.parse({
      viewer: "viewer",
      errors: [],
      limited: !cursors,
      cursors: cursors ? {} : { all: `fresh-${revision}` },
      entries: cursors
        ? [entry(3)]
        : revision
          ? [entry(1, { title: "Updated title" }), entry(4)]
          : [entry(1), entry(2)],
    });
  };
  assert.deepEqual(
    (await loadInboxPages(read, 2)).entries.map((row) => row.number),
    [1, 2, 3],
  );
  revision = 1;
  const fresh = await loadInboxPages(read, 2);
  assert.equal(fresh.entries[0]?.title, "Updated title");
  assert.deepEqual(
    fresh.entries.map((row) => row.number),
    [1, 4, 3],
  );
  assert.deepEqual(calls, [
    undefined,
    { all: "fresh-0" },
    undefined,
    { all: "fresh-1" },
  ]);
});
it("hides irrelevant carried search rows and retains settled host-only description hits", () => {
  const rows = [entry(1), entry(2, { title: "Welcome wizard" })];
  assert.deepEqual(
    visiblePullRequestSearchEntries(rows, "welcome", true).map(
      (row) => row.number,
    ),
    [2],
  );
  assert.deepEqual(
    visiblePullRequestSearchEntries(rows, "welcome", false).map(
      (row) => row.number,
    ),
    [1, 2],
  );
  assert.equal(
    matchesPullRequestFilters(
      entry(1, { author: { login: "viewer", avatarUrl: null } }),
      { author: "@ME" },
      "viewer",
    ),
    true,
  );
  assert.equal(
    inboxHostQuery("", { author: "@ME" }, "viewer"),
    " author:viewer",
  );
});
