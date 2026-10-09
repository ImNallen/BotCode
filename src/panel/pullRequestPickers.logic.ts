// Ported from T3 Code v0.0.45 PullRequestLabelPicker.tsx and PullRequestReviewerPicker.tsx (MIT).
import type {
  PrLabelCandidate,
  PrReviewerCandidate,
  PrReviewAction,
} from "./prReview";
export function matchesLabelCandidate(
  candidate: PrLabelCandidate,
  query: string,
) {
  const needle = query.toLowerCase();
  return (
    candidate.name.toLowerCase().includes(needle) ||
    (candidate.description ?? "").toLowerCase().includes(needle)
  );
}
export function matchesReviewerCandidate(
  candidate: PrReviewerCandidate,
  query: string,
) {
  const needle = query.toLowerCase();
  return (
    candidate.login.toLowerCase().includes(needle) ||
    (candidate.name ?? "").toLowerCase().includes(needle)
  );
}
export function candidateKeyboardIndex(
  key: string,
  active: number,
  count: number,
): number | undefined {
  if (count === 0) return undefined;
  if (key === "ArrowDown") return (active + 1) % count;
  if (key === "ArrowUp") return (active - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}
export function toggleLabel(
  candidate: PrLabelCandidate,
): Extract<PrReviewAction, { kind: "set_label" }> {
  return {
    kind: "set_label",
    name: candidate.name,
    applied: !candidate.isApplied,
  };
}
export function toggleReviewer(
  candidate: PrReviewerCandidate,
): Extract<PrReviewAction, { kind: "request_reviewer" }> {
  return {
    kind: "request_reviewer",
    id: candidate.id,
    reviewerKind: candidate.kind,
    requested: !candidate.isRequested,
  };
}

export function pickerFailureTitle(action: PrReviewAction): string {
  if (action.kind === "set_label")
    return action.applied
      ? `Could not put ${action.name} on`
      : `Could not take ${action.name} off`;
  if (action.kind === "request_reviewer")
    return action.requested
      ? `Could not ask ${action.id} for a review`
      : `Could not take back the review request to ${action.id}`;
  return "The pull request could not be changed";
}
export function pickerSuccessTitle(action: PrReviewAction): string | undefined {
  if (action.kind !== "request_reviewer") return undefined;
  return action.requested
    ? `Review requested from ${action.id}`
    : `Review request to ${action.id} taken back`;
}

export function candidateReadState(query: {
  isError: boolean;
  isFetching: boolean;
  error: unknown;
}) {
  return {
    locked: query.isError || query.isFetching,
    error: query.isError
      ? query.error instanceof Error
        ? query.error.message
        : String(query.error)
      : null,
  };
}
