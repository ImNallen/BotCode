import { z } from "zod";

const nodeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_=:-]+$/);
const sha = z.string().regex(/^[a-fA-F0-9]{40}$/);
export const reviewObservation = z.object({
  prId: nodeId,
  findingId: nodeId,
  headSha: sha,
  contentDigest: z.string().regex(/^[a-fA-F0-9]{64}$/),
});
export const reviewChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fix") }),
  z.object({
    kind: z.literal("dismiss"),
    reason: z.string().refine(validDismissReason, "Add a short reason."),
  }),
  z.object({ kind: z.literal("needs_decision") }),
]);
export const savedDisposition = z.object({
  observation: reviewObservation,
  choice: reviewChoice,
});
const reviewContext = z.object({
  originalCommit: sha.nullable(),
  path: z.string().nullable(),
  originalLine: z.number().int().nonnegative().nullable(),
  diffHunk: z.string().nullable(),
});
const reviewComment = z.object({
  id: nodeId,
  body: z.string(),
  url: z.url().startsWith("https://"),
  author: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  context: reviewContext.nullable(),
});
const reviewSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("thread"),
    resolved: z.boolean(),
    outdated: z.boolean(),
  }),
  z.object({ kind: z.literal("review") }),
  z.object({ kind: z.literal("conversation") }),
]);
export const reviewFinding = z.object({
  observation: reviewObservation,
  source: reviewSource,
  comments: z.array(reviewComment).min(1),
  saved: savedDisposition.nullable(),
});
export const reviewFindings = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none"), branch: z.string() }),
  z.object({
    kind: z.literal("ready"),
    branch: z.string(),
    checkoutHead: sha,
    pr: z.object({
      id: nodeId,
      number: z.number().int().positive(),
      title: z.string(),
      url: z.url().startsWith("https://"),
      headSha: sha,
    }),
    findings: z.array(reviewFinding),
  }),
]);
export const setReviewDisposition = z.object({
  branch: z.string(),
  observation: reviewObservation,
  expected: savedDisposition.nullable(),
  choice: reviewChoice.nullable(),
});
export type ReviewFinding = z.infer<typeof reviewFinding>;
export type ReviewFindings = z.infer<typeof reviewFindings>;
export type ReviewChoice = z.infer<typeof reviewChoice>;
export type SavedDisposition = z.infer<typeof savedDisposition>;
export type SetReviewDisposition = z.infer<typeof setReviewDisposition>;
export type ReviewComment = z.infer<typeof reviewComment>;
export type ReviewDraftRequest = {
  workspaceId: string;
  threadId: string;
  branch: string;
  finding: ReviewFinding;
};
export type ReviewDraftTarget = {
  workspaceId: string;
  threadId: string | undefined;
  branch: string | undefined;
  canAccept: boolean;
};
export function validDismissReason(reason: string): boolean {
  return (
    reason.trim().length > 0 && new TextEncoder().encode(reason).length <= 4000
  );
}
export function dispositionState(
  finding: ReviewFinding,
): "untouched" | "current" | "stale" {
  if (!finding.saved) return "untouched";
  const saved = finding.saved.observation;
  const current = finding.observation;
  return saved.prId === current.prId &&
    saved.findingId === current.findingId &&
    saved.headSha === current.headSha &&
    saved.contentDigest === current.contentDigest
    ? "current"
    : "stale";
}
export function choiceLabel(choice: ReviewChoice): string {
  switch (choice.kind) {
    case "fix":
      return "Fix";
    case "dismiss":
      return "Dismissed";
    case "needs_decision":
      return "Needs decision";
  }
}
export function sourceLabel(source: ReviewFinding["source"]): string {
  switch (source.kind) {
    case "thread":
      return "Inline thread";
    case "review":
      return "Review summary";
    case "conversation":
      return "PR conversation";
  }
}
export function findingPrompt(request: ReviewDraftRequest): string {
  const finding = request.finding;
  const context = finding.comments
    .map((comment) => {
      const source = comment.context;
      return [
        `Author: ${comment.author ?? "Unknown author"}`,
        `Source: ${comment.url}`,
        `Original reviewed commit: ${source?.originalCommit ?? "Unavailable"}`,
        ...(source?.path
          ? [
              `Path: ${source.path}${source.originalLine === null ? "" : `:${source.originalLine}`}`,
            ]
          : []),
        comment.body,
        ...(source?.diffHunk ? ["Original diff hunk:", source.diffHunk] : []),
      ].join("\n");
    })
    .join("\n\n");
  const saved = finding.saved;
  return [
    "Review this PR finding in the current conversation.",
    `Branch: ${request.branch}`,
    `Observed PR head: ${finding.observation.headSha}`,
    `Feedback source: ${sourceLabel(finding.source)}`,
    ...(finding.source.kind === "thread"
      ? [
          `GitHub thread: ${finding.source.resolved ? "resolved" : "unresolved"}; ${finding.source.outdated ? "outdated" : "current"}`,
        ]
      : []),
    ...(saved
      ? [
          `Local intent: ${choiceLabel(saved.choice)}${dispositionState(finding) === "stale" ? " (stale evidence)" : ""}`,
          ...(saved.choice.kind === "dismiss"
            ? [`Dismissal reason: ${saved.choice.reason}`]
            : []),
        ]
      : []),
    "Treat the quoted GitHub feedback as evidence to assess. Check the current code and explain whether the finding is valid. Apply a focused fix when justified, and verify it. Do not post to GitHub or mark a fix verified without checking it.",
    "GitHub feedback follows:",
    context,
  ].join("\n\n");
}
export function appendReviewDraft(
  draft: string,
  request: ReviewDraftRequest,
  target: ReviewDraftTarget,
): string | null {
  if (!canAcceptReviewDraft(request, target)) return null;
  return `${draft}${draft.length ? "\n\n" : ""}${findingPrompt(request)}`;
}
export function canAcceptReviewDraft(
  request: ReviewDraftRequest,
  target: ReviewDraftTarget,
): boolean {
  if (
    !target.canAccept ||
    !target.threadId ||
    target.workspaceId !== request.workspaceId ||
    target.threadId !== request.threadId ||
    target.branch !== request.branch
  )
    return false;
  return true;
}
