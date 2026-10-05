import type {
  LifecycleAction,
  MergeMethod,
  PrChangeResult,
  PrObservation,
  PrReviewChange,
  PrOperation,
  PrReviewDetail,
  AcknowledgeUncertainUpdate,
} from "./prReview";
// Labels copied from pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/pullRequestDetail.logic.ts (MIT).
export const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
  merge: "Merge",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};
export function lifecycleLabel(action: LifecycleAction): string {
  switch (action.kind) {
    case "merge":
      return MERGE_METHOD_LABELS[action.method];
    case "enqueue":
      return "Add to merge queue";
    case "enable_auto_merge":
      return `Enable auto-merge (${MERGE_METHOD_LABELS[action.method].toLowerCase()})`;
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
export function autoMergeLabel(method: MergeMethod | null): string {
  return method
    ? `Auto-merge (${MERGE_METHOD_LABELS[method].toLowerCase()})`
    : "Auto-merge";
}

// Ported from resolvePullRequestPrimaryControl in pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/pullRequestDetail.logic.ts (MIT).
export type PrimaryControl =
  | { kind: "resolve_conflicts" }
  | { kind: "action"; action: LifecycleAction; label: string }
  | { kind: "auto_merge_armed"; label: string }
  | { kind: "queued" }
  | { kind: "state"; state: "merged" | "closed" }
  | { kind: "none" };
export type HeaderControls = {
  primary: PrimaryControl;
  // Conflicts take the slot while they need a person; the armed badge stays beside them.
  armedBadge: string | null;
};
export function primaryControl(
  detail: Pick<PrReviewDetail, "capabilities" | "autoMergeMethod" | "snapshot">,
): HeaderControls {
  const { primary: kind, actions } = detail.capabilities;
  const armedLabel = autoMergeLabel(detail.autoMergeMethod);
  const primary = ((): PrimaryControl => {
    switch (kind) {
      case "resolve_conflicts":
        return { kind };
      case "ready": {
        const action = actions.find(
          (item) => item.kind === "set_draft" && !item.draft,
        );
        return action
          ? { kind: "action", action, label: "Ready for review" }
          : { kind: "none" };
      }
      case "enable_auto_merge": {
        const action = actions.find(
          (item) => item.kind === "enable_auto_merge",
        );
        return action?.kind === "enable_auto_merge"
          ? { kind: "action", action, label: autoMergeLabel(action.method) }
          : { kind: "none" };
      }
      case "merge": {
        const action = actions.find(
          (item) => item.kind === "merge" || item.kind === "enqueue",
        );
        return action
          ? { kind: "action", action, label: lifecycleLabel(action) }
          : { kind: "none" };
      }
      case "auto_merge_armed":
        return { kind, label: armedLabel };
      case "queued":
        return { kind };
      case "merged":
      case "closed":
        return { kind: "state", state: kind };
      case "unavailable":
        return { kind: "none" };
      default: {
        const _exhaustive: never = kind;
        return _exhaustive;
      }
    }
  })();
  const armed =
    detail.snapshot.lifecycle.kind === "open" &&
    (detail.autoMergeMethod !== null ||
      actions.some((action) => action.kind === "disable_auto_merge"));
  return {
    primary,
    armedBadge:
      armed && primary.kind !== "auto_merge_armed" ? armedLabel : null,
  };
}

// Every lifecycle action the header button does not already offer, with
// close and reopen held back for the menu's last group.
export function menuActions(
  actions: ReadonlyArray<LifecycleAction>,
  primary: PrimaryControl,
): { lifecycle: LifecycleAction[]; closing: LifecycleAction[] } {
  const rest = actions.filter(
    (action) => primary.kind !== "action" || action !== primary.action,
  );
  return {
    lifecycle: rest.filter((action) => action.kind !== "set_closed"),
    closing: rest.filter((action) => action.kind === "set_closed"),
  };
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
