import { z } from "zod";
import { cachedPr, pullRequestKey } from "./pullRequests";
import { prSectionProblem } from "./prCoverage";
import { reviewFinding } from "./reviews";
export const prObservation = z.object({
  key: pullRequestKey,
  nodeId: z.string().min(1),
  headOid: z.string().regex(/^[a-fA-F0-9]{40}$/),
  viewer: z.string().min(1),
});
export const mergeMethod = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof mergeMethod>;
const prActor = z.object({
  login: z.string().min(1),
  avatarUrl: z.string().nullable(),
});
export type PrActor = z.infer<typeof prActor>;
export const reviewVerdict = z.enum(["comment", "approve", "request_changes"]);
export const prSide = z.enum(["LEFT", "RIGHT"]);
export const draftComment = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  path: z.string(),
  side: prSide,
  line: z.number().int().positive(),
  body: z.string(),
});
export const lifecycleAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("merge"),
    method: mergeMethod,
  }),
  z.object({ kind: z.literal("enqueue") }),
  z.object({
    kind: z.literal("enable_auto_merge"),
    method: mergeMethod,
  }),
  z.object({ kind: z.literal("disable_auto_merge") }),
  z.object({ kind: z.literal("set_draft"), draft: z.boolean() }),
  z.object({ kind: z.literal("set_closed"), closed: z.boolean() }),
  z.object({
    kind: z.literal("update_branch"),
    method: z.enum(["merge", "rebase"]),
  }),
]);
export type LifecycleAction = z.infer<typeof lifecycleAction>;
export const prReviewAction = z.discriminatedUnion("kind", [
  ...lifecycleAction.options,
  z.object({
    kind: z.literal("submit_review"),
    verdict: reviewVerdict,
    body: z.string(),
    comments: z.array(draftComment),
  }),
  z.object({
    kind: z.literal("reply"),
    threadId: z.string(),
    body: z.string(),
  }),
  z.object({
    kind: z.literal("set_resolved"),
    threadId: z.string(),
    resolved: z.boolean(),
  }),
]);
export const acknowledgeUncertainUpdate = z.object({
  key: pullRequestKey,
  requestId: z.string(),
  inspected: prObservation,
});
export type AcknowledgeUncertainUpdate = z.infer<
  typeof acknowledgeUncertainUpdate
>;
export const prChangeResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("applied"), hostId: z.string() }),
  z.object({
    kind: z.literal("confirmed"),
    state: z.enum([
      "merged",
      "auto_merge_disabled",
      "draft",
      "ready",
      "closed",
      "reopened",
      "branch_updated",
    ]),
  }),
  z.object({
    kind: z.literal("accepted"),
    progress: z.enum(["queued", "auto_merge_enabled", "awaiting_confirmation"]),
  }),
  z.object({ kind: z.literal("refused"), message: z.string() }),
  z.object({ kind: z.literal("uncertain"), message: z.string() }),
  z.object({
    kind: z.literal("superseded"),
    evidence: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("pull_request_merged"),
        key: pullRequestKey,
        nodeId: z.string(),
        observedHeadOid: prObservation.shape.headOid,
      }),
      z.object({
        kind: z.literal("continued_from_observed_head"),
        observation: prObservation,
      }),
    ]),
    message: z.string(),
  }),
]);
export const prOperation = z.object({
  input: z.object({
    requestId: z.string(),
    target: prObservation,
    action: prReviewAction,
  }),
  result: prChangeResult,
});
export type PrOperation = z.infer<typeof prOperation>;
export const prReviewDetail = z.object({
  capabilities: z.object({
    primary: z.enum([
      "resolve_conflicts",
      "ready",
      "queued",
      "auto_merge_armed",
      "merge",
      "enable_auto_merge",
      "closed",
      "merged",
      "unavailable",
    ]),
    actions: z.array(lifecycleAction),
    explanation: z.string().nullable(),
  }),
  operations: z.array(prOperation),
  observation: prObservation,
  snapshot: cachedPr.shape.snapshot.unwrap(),
  body: z.string(),
  author: prActor.nullable(),
  labels: z.array(z.object({ name: z.string(), color: z.string() })),
  reviewers: z.array(prActor.extend({ outcome: z.string().nullable() })),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  autoMergeMethod: mergeMethod.nullable(),
  reviewDecision: z.string().nullable(),
  verdicts: z.array(reviewVerdict),
  findings: z.array(
    z.object({
      finding: reviewFinding,
      outcome: z.string().nullable(),
      canReply: z.boolean(),
      canResolve: z.boolean(),
      canUnresolve: z.boolean(),
    }),
  ),
  checks: z.array(
    z.object({
      name: z.string(),
      state: z.string(),
      url: z.string().nullable(),
    }),
  ),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.string(),
      additions: z.number(),
      deletions: z.number(),
      patch: z.string().nullable(),
      unavailable: z.string().nullable(),
      anchors: z.array(
        z.object({ side: prSide, line: z.number(), text: z.string() }),
      ),
    }),
  ),
  problems: z.array(prSectionProblem).max(6),
  timeline: z.array(
    z.object({
      at: z.string().nullable(),
      event: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("opened"), author: z.string().nullable() }),
        z.object({
          kind: z.literal("commit"),
          oid: z.string(),
          headline: z.string(),
          author: z.string().nullable(),
        }),
        z.object({ kind: z.literal("comment"), findingId: z.string() }),
        z.object({ kind: z.literal("review"), findingId: z.string() }),
        z.object({ kind: z.literal("merged") }),
        z.object({ kind: z.literal("closed") }),
      ]),
    }),
  ),
});
export type PrObservation = z.infer<typeof prObservation>;
export type PrReviewDetail = z.infer<typeof prReviewDetail>;
export type PrReviewAction = z.infer<typeof prReviewAction>;
export type PrChangeResult = z.infer<typeof prChangeResult>;
export type DraftComment = z.infer<typeof draftComment>;
export type ReviewVerdict = z.infer<typeof reviewVerdict>;
export type PrReviewChange = {
  requestId: string;
  target: PrObservation;
  action: PrReviewAction;
};
