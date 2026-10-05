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
export const prReviewDetail = z.object({
  observation: prObservation,
  snapshot: cachedPr.shape.snapshot.unwrap(),
  body: z.string(),
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
export const prReviewAction = z.discriminatedUnion("kind", [
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
export const prChangeResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("applied"), hostId: z.string() }),
  z.object({ kind: z.literal("refused"), message: z.string() }),
  z.object({ kind: z.literal("uncertain"), message: z.string() }),
]);
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
