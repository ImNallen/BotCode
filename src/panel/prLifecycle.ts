import type {
  LifecycleAction,
  PrChangeResult,
  PrObservation,
  PrReviewChange,
  PrOperation,
  PrReviewDetail,
  AcknowledgeUncertainUpdate,
} from "./prReview";
export function lifecycleLabel(action: LifecycleAction): string {
  switch (action.kind) {
    case "merge":
      return `${action.method.charAt(0).toUpperCase()}${action.method.slice(1)} merge`;
    case "enqueue":
      return "Add to merge queue";
    case "enable_auto_merge":
      return `Enable auto-merge (${action.method})`;
    case "disable_auto_merge":
      return "Disable auto-merge";
    case "set_draft":
      return action.draft ? "Convert to draft" : "Mark ready for review";
    case "set_closed":
      return action.closed ? "Close pull request" : "Reopen pull request";
    case "update_branch":
      return `Update branch (${action.method})`;
  }
}
export function changeResultText(result: PrChangeResult): string {
  switch (result.kind) {
    case "applied":
      return "Submitted to GitHub.";
    case "refused":
      return result.message;
    case "uncertain":
      return `Outcome uncertain. ${result.message}`;
    case "superseded":
      return `${result.evidence.kind === "pull_request_merged" ? "GitHub now reports this pull request merged." : "Continued from the inspected head."} The earlier operation outcome remains unknown. ${result.message}`;
    case "accepted":
      return {
        queued: "Queued. Waiting for GitHub to merge.",
        auto_merge_enabled: "Auto-merge enabled. Waiting for GitHub to merge.",
        awaiting_confirmation: "Accepted. Awaiting GitHub confirmation.",
      }[result.progress];
    case "confirmed":
      return {
        merged: "Merged. Confirmed by GitHub.",
        auto_merge_disabled: "Auto-merge disabled.",
        draft: "Converted to draft.",
        ready: "Ready for review.",
        closed: "Pull request closed.",
        reopened: "Pull request reopened.",
        branch_updated: "Branch updated.",
      }[result.state];
  }
}

export type LifecycleConfirmation = Omit<PrReviewChange, "action"> & {
  action: LifecycleAction;
};
export function captureLifecycle(
  target: PrObservation,
  action: LifecycleAction,
  requestId: string,
): LifecycleConfirmation {
  return { requestId, target: { ...target }, action: { ...action } };
}

export type UpdateContinuation = {
  input: AcknowledgeUncertainUpdate;
  original: LifecycleConfirmation;
};
export function captureUpdateContinuation(
  operation: PrOperation,
  detail: PrReviewDetail | undefined,
): UpdateContinuation | undefined {
  if (
    !detail ||
    operation.result.kind !== "uncertain" ||
    operation.input.action.kind !== "update_branch" ||
    detail.snapshot.lifecycle.kind !== "open" ||
    operation.input.target.key !== detail.observation.key ||
    operation.input.target.nodeId !== detail.observation.nodeId ||
    operation.input.target.headOid === detail.observation.headOid
  )
    return undefined;
  return {
    original: captureLifecycle(
      operation.input.target,
      operation.input.action,
      operation.input.requestId,
    ),
    input: {
      key: operation.input.target.key,
      requestId: operation.input.requestId,
      inspected: { ...detail.observation },
    },
  };
}
export const updateContinuationWarning =
  "The earlier update outcome is unknown. GitHub may still apply it. Continuing does not cancel that operation.";
