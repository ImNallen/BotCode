import { z } from "zod";

export const publishReadiness = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), account: z.string() }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["missing", "unauthenticated", "failed"]),
    hint: z.string(),
  }),
]);
export const publishInput = z.object({
  repository: z.string(),
  visibility: z.enum(["private", "public"]),
  remoteName: z.string(),
  protocol: z.enum(["ssh", "https"]),
});
const repository = z.object({ nameWithOwner: z.string(), url: z.url() });
const remote = z.object({
  repository,
  remoteName: z.string(),
  remoteUrl: z.string(),
});
const result = z.discriminatedUnion("status", [
  remote.extend({
    status: z.literal("pushed"),
    branch: z.string(),
    upstreamBranch: z.string(),
  }),
  remote.extend({ status: z.literal("remote_added"), branch: z.string() }),
]);
export const publishOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("succeeded"), result }),
  z.object({
    kind: z.literal("failed"),
    message: z.string(),
    completed: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("nothing") }),
      z.object({ kind: z.literal("repository_created"), repository }),
      z.object({ kind: z.literal("remote_added"), remote }),
    ]),
  }),
  z.object({
    kind: z.literal("creation_uncertain"),
    repository: z.string(),
    message: z.string(),
  }),
]);
export type PublishInput = z.infer<typeof publishInput>;
export type PublishOutcome = z.infer<typeof publishOutcome>;
export type PublishReadiness = z.infer<typeof publishReadiness>;
export const publishDefaults: PublishInput = {
  repository: "",
  visibility: "private",
  remoteName: "origin",
  protocol: "ssh",
};
export type PublishAttempt =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "finished"; outcome: PublishOutcome }
  | { kind: "refused"; message: string };
export function canPublish(
  attempt: PublishAttempt,
  ready: boolean,
  repository: string,
) {
  const [owner, name, extra] = repository.trim().split("/");
  return (
    ready &&
    (attempt.kind === "idle" ||
      attempt.kind === "refused" ||
      (attempt.kind === "finished" &&
        attempt.outcome.kind === "failed" &&
        attempt.outcome.completed.kind === "nothing")) &&
    Boolean(owner?.trim() && name?.trim()) &&
    extra === undefined
  );
}
export function publishFailure(attempt: PublishAttempt): string | null {
  if (attempt.kind === "refused") return attempt.message;
  if (attempt.kind === "finished" && attempt.outcome.kind !== "succeeded")
    return attempt.outcome.message;
  return null;
}
