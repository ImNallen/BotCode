// Ported from pingdotgg/t3code v0.0.45 pullRequestDetail.logic.ts and uiStateStore.ts (MIT).
import { mergeMethod, type MergeMethod, type PrReviewDetail } from "./prReview";

export function readPullRequestMergeMethod(): MergeMethod {
  try {
    return mergeMethod.parse(
      JSON.parse(
        localStorage.getItem("bot.pullRequests.mergeMethod") ?? '"merge"',
      ),
    );
  } catch {
    return "merge";
  }
}

export function savePullRequestMergeMethod(method: MergeMethod) {
  try {
    localStorage.setItem(
      "bot.pullRequests.mergeMethod",
      JSON.stringify(method),
    );
  } catch {}
}

export function resolvePullRequestMergeMethod(
  allowed: readonly MergeMethod[],
  current: MergeMethod | null,
  lastSelected: MergeMethod,
  configured: MergeMethod | null = null,
): MergeMethod {
  for (const method of [current, configured, lastSelected]) {
    if (method && allowed.includes(method)) return method;
  }
  return allowed[0] ?? "merge";
}

export function showsPullRequestMergeMethods(
  detail: Pick<PrReviewDetail, "snapshot" | "capabilities"> | undefined,
  allowed: readonly MergeMethod[],
): boolean {
  return (
    detail?.snapshot.lifecycle.kind === "open" &&
    !detail.snapshot.lifecycle.draft &&
    detail.capabilities.primary !== "resolve_conflicts" &&
    allowed.length > 1
  );
}
