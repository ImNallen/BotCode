import { z } from "zod";
import { cachedPr, pullRequestKey } from "./pullRequests";
import { prSectionProblem } from "./prCoverage";
import { reviewFinding } from "./reviews";
import { prObservation, mergeMethod } from "./prIdentity";
export { prObservation, mergeMethod } from "./prIdentity";
export type MergeMethod = z.infer<typeof mergeMethod>;
const prActor = z.object({
  login: z.string().min(1),
  avatarUrl: z.string().nullable(),
});
export type PrActor = z.infer<typeof prActor>;
export const reviewVerdict = z.enum(["comment", "approve", "request_changes"]);
export const prSide = z.enum(["LEFT", "RIGHT"]);
export const draftComment = z
  .object({
    id: z.string(),
    revision: z.number().int().nonnegative(),
    path: z.string(),
    side: prSide,
    line: z.number().int().positive(),
    startLine: z.number().int().positive().optional(),
    body: z.string(),
  })
  .refine(
    (comment) =>
      comment.startLine === undefined || comment.startLine < comment.line,
    { message: "A comment range must start before its final line." },
  );
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
export const prReactionContent = z.enum([
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);
export const prReaction = z.object({
  content: prReactionContent,
  count: z.number().int().nonnegative(),
  actors: z.array(z.string()).max(10),
  viewerHasReacted: z.boolean(),
});
export const prReactionSubject = z.object({
  subjectId: z.string(),
  reactions: z.array(prReaction),
});
export type PrReactionContent = z.infer<typeof prReactionContent>;
export type PrReaction = z.infer<typeof prReaction>;
export const prReviewAction = z.discriminatedUnion("kind", [
  ...lifecycleAction.options,
  z.object({
    kind: z.literal("add_comment"),
    body: z.string().trim().min(1).max(64000),
  }),
  z.object({
    kind: z.literal("set_reaction"),
    subjectId: z.string().nullable().optional(),
    content: prReactionContent,
    reacted: z.boolean(),
  }),
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
  z.object({ kind: z.literal("edit_title"), title: z.string() }),
  z.object({ kind: z.literal("edit_body"), body: z.string() }),
  z.object({
    kind: z.literal("set_label"),
    name: z.string(),
    applied: z.boolean(),
  }),
  z.object({
    kind: z.literal("request_reviewer"),
    id: z.string(),
    reviewerKind: z.enum(["user", "team"]),
    requested: z.boolean(),
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
export const prFileContentsRequest = z.object({
  target: prObservation,
  sourceId: z.uuid(),
});
export const prFileContents = z.object({
  oldContents: z.string(),
  newContents: z.string(),
});
export type PrFileContents = z.infer<typeof prFileContents>;
export type PrFileContentsRequest = z.infer<typeof prFileContentsRequest>;
const prFile = z.object({
  previousPath: z.string().nullable().optional(),
  contentsSource: z
    .object({
      id: z.uuid(),
      oldOid: prObservation.shape.headOid.nullable(),
      newOid: prObservation.shape.headOid,
    })
    .nullable()
    .optional(),
  path: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().nullable(),
  unavailable: z.string().nullable(),
  anchors: z.array(
    z.object({ side: prSide, line: z.number(), text: z.string() }),
  ),
});
export const prCommitFilesRequest = z.object({
  target: prObservation,
  commitOid: prObservation.shape.headOid,
});
export const prCommitFiles = prCommitFilesRequest.extend({
  files: z.array(prFile),
  problems: z.array(prSectionProblem).max(6),
});
export type PrCommitFilesRequest = z.infer<typeof prCommitFilesRequest>;
export type PrCommitFiles = z.infer<typeof prCommitFiles>;
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
    edit: z.boolean(),
    labels: z.boolean().default(false),
    requestReviewers: z.boolean().default(false),
    comment: z.boolean().default(false),
    react: z.boolean().default(false),
  }),
  operations: z.array(prOperation),
  observation: prObservation,
  snapshot: cachedPr.shape.snapshot.unwrap(),
  body: z.string(),
  reactions: z.array(prReaction).default([]),
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
      reactionSubjects: z.array(prReactionSubject).default([]),
      finding: reviewFinding,
      threadLocation: z
        .object({
          path: z.string(),
          side: z.enum(["LEFT", "RIGHT"]),
          line: z.number().int().positive().nullable(),
        })
        .nullable()
        .optional(),
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
  files: z.array(prFile),
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

// Viewed contracts ported from pingdotgg/t3code v0.0.45 (MIT).
export const prFileViewedState = z.enum(["viewed", "unviewed", "dismissed"]);
export type PrFileViewedState = z.infer<typeof prFileViewedState>;
export const prFilesViewed = z.object({
  target: prObservation,
  files: z.array(z.object({ path: z.string(), state: prFileViewedState })),
  truncated: z.boolean(),
});
export type PrFilesViewed = z.infer<typeof prFilesViewed>;
export const prSetFilesViewed = z.object({
  target: prObservation,
  files: z
    .array(z.object({ path: z.string().min(1).max(4096), viewed: z.boolean() }))
    .max(100),
});
export type PrSetFilesViewed = z.infer<typeof prSetFilesViewed>;

export const prLabelCandidate = z.object({
  name: z.string(),
  color: z.string().nullable(),
  description: z.string().nullable(),
  isApplied: z.boolean(),
});
export const prReviewerCandidate = z.object({
  id: z.string(),
  kind: z.enum(["user", "team"]),
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  isRequested: z.boolean(),
});
export const prCandidates = z.object({
  labels: z.array(prLabelCandidate),
  reviewers: z.array(prReviewerCandidate),
  truncated: z.boolean(),
});
export type PrLabelCandidate = z.infer<typeof prLabelCandidate>;
export type PrReviewerCandidate = z.infer<typeof prReviewerCandidate>;
