// List contracts adapted from T3 Code v0.0.45 packages/contracts/src/pullRequest.ts (MIT).
import { z } from "zod";
import { pullRequestKey } from "./pullRequests";
import { pullRequestStackMembership } from "./pullRequestStack";
export type PrAccess = string | { workspaceId: string };
export const pullRequestListEntry = z.object({
  key: pullRequestKey,
  provider: z.literal("github"),
  host: z.literal("github.com"),
  projectId: z.uuid(),
  projectTitle: z.string(),
  repository: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.url(),
  author: z
    .object({ login: z.string(), avatarUrl: z.string().nullable() })
    .nullable(),
  headBranch: z.string(),
  baseBranch: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  isDraft: z.boolean(),
  mergeability: z.enum(["mergeable", "conflicting", "unknown"]),
  additions: z.number().nonnegative(),
  deletions: z.number().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  viewerReviewRequested: z.boolean(),
  labels: z.array(z.object({ name: z.string(), color: z.string().nullable() })),
  reviewDecision: z
    .enum(["approved", "changes-requested", "review-required"])
    .optional(),
  checksState: z.enum(["passing", "failing", "pending"]).optional(),
  stack: pullRequestStackMembership.optional(),
});
export type PullRequestListEntry = z.infer<typeof pullRequestListEntry>;
export type PullRequestActor = NonNullable<PullRequestListEntry["author"]>;
export type PullRequestLabel = PullRequestListEntry["labels"][number];
export type PullRequestListState = "all" | PullRequestListEntry["state"];
export type PullRequestInvolvement = "all" | "reviewing" | "authored";
export type PullRequestListSort =
  | "ready"
  | "blocked"
  | "updated"
  | "newest"
  | "oldest"
  | "largest"
  | "smallest";
export type PullRequestListFilters = {
  draft?: "only" | "hide";
  review?: "approved" | "changes-requested" | "review-required" | "none";
  checks?: "passing" | "failing";
  labels?: readonly (readonly string[])[];
  excludedLabels?: readonly string[];
  author?: string;
};
export const prInboxResult = z.object({
  entries: z.array(pullRequestListEntry),
  viewer: z.string(),
  errors: z.array(
    z.object({
      projectId: z.uuid(),
      projectTitle: z.string(),
      message: z.string(),
    }),
  ),
  limited: z.boolean(),
  cursors: z.record(z.string(), z.string()),
});
export function inboxHostQuery(
  text: string,
  filters: PullRequestListFilters,
  viewer: string | undefined,
) {
  const words = [text];
  if (filters.draft) words.push(`draft:${filters.draft === "only"}`);
  if (filters.review)
    words.push(
      `review:${filters.review === "none" ? "none" : filters.review === "review-required" ? "required" : filters.review.replaceAll("-", "_")}`,
    );
  if (filters.checks)
    words.push(
      `status:${filters.checks === "passing" ? "success" : "failure"}`,
    );
  if (filters.author)
    words.push(
      `author:${/^@?me$/i.test(filters.author) ? (viewer ?? "@me") : filters.author}`,
    );
  for (const group of filters.labels ?? [])
    words.push(
      `label:${group.map((label) => JSON.stringify(label)).join(",")}`,
    );
  for (const label of filters.excludedLabels ?? [])
    words.push(`-label:${JSON.stringify(label)}`);
  return words.join(" ");
}
export function mergeInboxPages(
  previous: readonly PullRequestListEntry[],
  page: readonly PullRequestListEntry[],
) {
  const entries = new Map(previous.map((entry) => [entry.key, entry]));
  for (const entry of page) {
    const held = entries.get(entry.key);
    entries.set(entry.key, {
      ...entry,
      viewerReviewRequested:
        entry.viewerReviewRequested || held?.viewerReviewRequested === true,
    });
  }
  return [...entries.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export async function loadInboxPages(
  read: (
    cursors: Record<string, string> | undefined,
  ) => Promise<z.infer<typeof prInboxResult>>,
  pageCount: number,
): Promise<z.infer<typeof prInboxResult>> {
  let result = await read(undefined);
  for (let page = 1; page < pageCount && result.limited; page++) {
    const next = await read(result.cursors);
    result = {
      ...next,
      entries: mergeInboxPages(result.entries, next.entries),
      errors: [
        ...new Map(
          [...result.errors, ...next.errors].map((error) => [
            error.projectId + error.message,
            error,
          ]),
        ).values(),
      ],
    };
  }
  return result;
}
