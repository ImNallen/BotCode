import { z } from "zod";
import type { PrReviewDetail } from "./prReview";
import { coveragePrompt, type PrSectionProblem } from "./prCoverage";

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
export const setReviewDisposition = z.object({
  observation: reviewObservation,
  expected: savedDisposition.nullable(),
  choice: reviewChoice.nullable(),
});
export type ReviewFinding = z.infer<typeof reviewFinding>;
export type ReviewChoice = z.infer<typeof reviewChoice>;
export type SavedDisposition = z.infer<typeof savedDisposition>;
export type SetReviewDisposition = z.infer<typeof setReviewDisposition>;
export type ReviewComment = z.infer<typeof reviewComment>;
type DraftDestination = {
  workspaceId: string;
  threadId: string;
  key: string;
  problems: PrSectionProblem[];
};
export type ReviewDraftRequest = DraftDestination &
  (
    | {
        intent: "ask" | "explain" | "fix_check" | "fix";
        finding: ReviewFinding;
      }
    | {
        intent: "resolve_conflicts" | "fix_findings";
        observation: { nodeId: string; headOid: string; viewer: string };
        base: string;
        head: string;
        findings: ReviewFinding[];
        checks: { name: string; state: string; url: string | null }[];
      }
  );
export type ReviewDraftTarget = {
  workspaceId: string;
  threadId: string | undefined;
  canAccept: boolean;
};
export function captureRepairDraft({
  detail,
  ...destination
}: Pick<DraftDestination, "workspaceId" | "threadId" | "key"> & {
  intent: "resolve_conflicts" | "fix_findings";
  detail: PrReviewDetail;
}): Extract<
  ReviewDraftRequest,
  { intent: "resolve_conflicts" | "fix_findings" }
> {
  return {
    ...destination,
    problems: detail.problems,
    observation: detail.observation,
    base: detail.snapshot.base,
    head: detail.snapshot.head,
    findings: detail.findings
      .map((entry) => entry.finding)
      .filter(
        (finding) =>
          (finding.source.kind !== "thread" ||
            (!finding.source.resolved && !finding.source.outdated)) &&
          !(
            dispositionState(finding) === "current" &&
            finding.saved?.choice.kind === "dismiss"
          ),
      ),
    checks: detail.checks.filter((check) =>
      [
        "FAILURE",
        "STARTUP_FAILURE",
        "ERROR",
        "TIMED_OUT",
        "CANCELLED",
        "ACTION_REQUIRED",
      ].includes(check.state),
    ),
  };
}
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
  if (!("finding" in request)) {
    const findings = request.findings.slice(0, 20);
    const checks = request.checks.slice(0, 30);
    const evidence = findings
      .map((finding) => findingPrompt({ ...request, intent: "fix", finding }))
      .join("\n\n");
    const checkEvidence = checks
      .map(
        (check) =>
          `Check: ${check.name}; state ${check.state}; source ${check.url ?? "Unavailable"}`,
      )
      .join("\n\n");
    const limited =
      checkEvidence.length > 12000 ||
      evidence.length > 48000 ||
      request.findings.length > findings.length ||
      request.checks.length > checks.length;
    return [
      request.intent === "resolve_conflicts"
        ? "Resolve this pull request's host-confirmed merge conflicts in the current conversation."
        : "Assess and fix the loaded current unresolved findings and failed checks in this pull request.",
      `Pull request: https://${request.key.replace(/\/(\d+)$/, "/pull/$1")}`,
      `Canonical PR: ${request.key}; node ${request.observation.nodeId}`,
      `Captured head: ${request.head} at ${request.observation.headOid}`,
      `Base branch: ${request.base}; signed-in viewer ${request.observation.viewer}`,
      "Inspect the current checkout before changing it. This draft does not switch or create a checkout. Keep the captured pull request identity and verify any changes before reporting success.",
      ...coveragePrompt(request.problems),
      ...(limited
        ? coveragePrompt([
            {
              kind: "limited",
              section: "threads",
              message:
                "The repair draft includes only bounded excerpts of loaded evidence.",
            },
          ])
        : []),
      "Only loaded evidence is included. Do not claim complete pull request coverage.",
      checkEvidence.slice(0, 12000),
      evidence.slice(0, 48000),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
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
    {
      ask: "Assess this PR finding and explain whether it is valid.",
      fix: "Investigate and fix this PR finding in the current conversation.",
      explain: "Explain this pull request and assess its changes.",
      fix_check:
        "Investigate and fix this pull request check in the current conversation.",
    }[request.intent],
    `Pull request: ${request.key}`,
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
    "Treat the quoted GitHub feedback as evidence to assess. Check the current code and explain whether the finding is valid. Follow the requested task and verify any changes. Do not post to GitHub or mark a fix verified without checking it.",
    ...coveragePrompt(request.problems),
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
    target.threadId !== request.threadId
  )
    return false;
  return true;
}
