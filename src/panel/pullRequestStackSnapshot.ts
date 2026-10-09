// Ported from pingdotgg/t3code v0.0.45 pullRequestStackSnapshot.ts (MIT).
import type { ThreadPrSummary } from "./pullRequests";
import type {
  PullRequestStack,
  PullRequestStackReference,
} from "./pullRequestStack";

type Link = ThreadPrSummary["links"][number];

function syncedAt(link: Link): number {
  if (link.pr.snapshot) {
    switch (link.pr.freshness.kind) {
      case "current":
        return link.pr.freshness.fetchedAt;
      case "stale":
        return link.pr.freshness.lastSuccess ?? link.linkedAt;
      case "never_loaded":
        break;
    }
  }
  return link.linkedAt;
}

function newest(links: readonly Link[]): Link | undefined {
  return links.toSorted((a, b) => syncedAt(b) - syncedAt(a))[0];
}

export function savedPullRequestStack(
  links: readonly Link[],
  reference: PullRequestStackReference,
): PullRequestStack | null {
  const repository = reference.key
    .slice(0, reference.key.lastIndexOf("/"))
    .toLowerCase();
  const matching = links.filter(
    (link) =>
      link.pr.key.slice(0, link.pr.key.lastIndexOf("/")).toLowerCase() ===
      repository,
  );
  const numberOf = (link: Link) => Number(link.pr.key.split("/").at(-1));
  const exact = matching.filter((link) => numberOf(link) === reference.number);
  const candidates = exact.length
    ? exact
    : matching.filter((link) =>
        link.pr.stack?.layers.some(
          (layer) => layer.number === reference.number,
        ),
      );
  const stack = newest(candidates)?.pr.stack;
  if (
    !stack ||
    !stack.layers.some((layer) => layer.number === reference.number)
  )
    return null;
  return {
    id: stack.id,
    number: stack.number,
    url: stack.url,
    base: stack.base,
    capabilities: { mergeMethods: [], canRebase: false },
    layers: stack.layers.map((layer) => {
      const snapshot = newest(
        matching.filter((link) => numberOf(link) === layer.number),
      )?.pr.snapshot;
      return {
        ...layer,
        ...(snapshot ? { title: snapshot.title } : {}),
        ...(snapshot?.lifecycle.kind === "open"
          ? { isDraft: snapshot.lifecycle.draft }
          : {}),
      };
    }),
  };
}

export function pullRequestStackView(
  query: {
    data: PullRequestStack | null;
    isSuccess: boolean;
    isPending: boolean;
    error: string | null;
  },
  saved: PullRequestStack | null,
) {
  const data = query.isSuccess ? query.data : (query.data ?? saved);
  return {
    data,
    isFresh: query.isSuccess && !query.isPending,
    notice:
      data === null
        ? null
        : query.error
          ? "Stack data may be stale. We couldn’t refresh it."
          : !query.isSuccess || query.isPending
            ? "Refreshing stack… Showing saved data."
            : null,
  };
}
