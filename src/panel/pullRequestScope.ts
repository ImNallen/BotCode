// Commit ordering and missing selection follow T3 Code v0.0.45 PullRequestCodeTab.tsx (MIT).
import type { PrReviewDetail } from "./prReview";
export type PrDiffScope = { kind: "all" } | { kind: "commit"; oid: string };
export function orderedPrCommits(timeline: PrReviewDetail["timeline"]) {
  return timeline
    .flatMap((entry) =>
      entry.event.kind === "commit" ? [{ ...entry.event, at: entry.at }] : [],
    )
    .sort(
      (left, right) =>
        (Date.parse(right.at ?? "") || 0) - (Date.parse(left.at ?? "") || 0),
    );
}
export function currentPrScope(
  scope: PrDiffScope,
  timeline: PrReviewDetail["timeline"],
): PrDiffScope {
  return scope.kind === "commit" &&
    !orderedPrCommits(timeline).some((entry) => entry.oid === scope.oid)
    ? { kind: "all" }
    : scope;
}
export function prScopeIdentity(detail: PrReviewDetail, scope: PrDiffScope) {
  return JSON.stringify([detail.observation, scope]);
}
