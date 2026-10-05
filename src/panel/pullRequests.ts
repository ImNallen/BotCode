import { z } from "zod";
export const pullRequestKey = z
  .string()
  .regex(/^github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/[1-9][0-9]*$/)
  .brand<"PullRequestKey">();
export type PullRequestKey = z.infer<typeof pullRequestKey>;
const lifecycle = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), draft: z.boolean() }),
  z.object({ kind: z.literal("closed"), closedAt: z.string().nullable() }),
  z.object({ kind: z.literal("merged"), mergedAt: z.string().nullable() }),
]);
export const cachedPr = z.object({
  key: pullRequestKey,
  revision: z.number(),
  snapshot: z
    .object({
      nodeId: z.string(),
      title: z.string(),
      lifecycle,
      base: z.string(),
      head: z.string(),
      headRepository: z.string(),
      headOid: z.string(),
      hostUpdatedAt: z.string(),
    })
    .nullable(),
  freshness: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("never_loaded") }),
    z.object({ kind: z.literal("current"), fetchedAt: z.number() }),
    z.object({
      kind: z.literal("stale"),
      lastSuccess: z.number().nullable(),
      message: z.string(),
    }),
  ]),
});
export const threadPrSummary = z.object({
  sequence: z.number().int().nonnegative(),
  links: z.array(
    z.object({
      pr: cachedPr,
      source: z.enum([
        "manual",
        "git_created",
        "git_reused",
        "agent_discovered",
        "branch_discovery",
      ]),
      linkedAt: z.number(),
    }),
  ),
  discovering: z.boolean(),
  discoveryError: z.string().nullable(),
});
export type ThreadPrSummary = z.infer<typeof threadPrSummary>;
export function prUrl(key: PullRequestKey): string {
  const [host, owner, repository, number] = key.split("/");
  return `https://${host}/${owner}/${repository}/pull/${number}`;
}
export function prLabel(pr: z.infer<typeof cachedPr>): string {
  const state = pr.snapshot?.lifecycle;
  if (!state)
    return pr.freshness.kind === "stale"
      ? "Status unavailable"
      : "Loading status";
  switch (state.kind) {
    case "open":
      return state.draft ? "Draft" : "Open";
    case "closed":
      return "Closed";
    case "merged":
      return "Merged";
  }
}
