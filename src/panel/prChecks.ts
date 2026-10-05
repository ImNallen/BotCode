// Rollup and summary copied from pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/pullRequestPresentation.tsx and pullRequestDetail.logic.ts (MIT).
import type { PrReviewDetail } from "./prReview";

export type CheckStatus =
  | "pending"
  | "action-required"
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "neutral";
export type ChecksRollup = "passing" | "failing" | "pending";
export type PrCheck = {
  name: string;
  status: CheckStatus;
  url: string | null;
};

const STATUS_BY_GITHUB_STATE = new Map<string, CheckStatus>([
  ["SUCCESS", "success"],
  ["FAILURE", "failure"],
  ["ERROR", "failure"],
  ["TIMED_OUT", "failure"],
  ["STARTUP_FAILURE", "failure"],
  ["CANCELLED", "cancelled"],
  ["SKIPPED", "skipped"],
  ["NEUTRAL", "neutral"],
  ["STALE", "neutral"],
  ["ACTION_REQUIRED", "action-required"],
  ["QUEUED", "pending"],
  ["IN_PROGRESS", "pending"],
  ["PENDING", "pending"],
  ["WAITING", "pending"],
  ["REQUESTED", "pending"],
  ["EXPECTED", "pending"],
]);

// GitHub reports a CheckRun conclusion or status, or a StatusContext state.
export function checkStatus(state: string): CheckStatus {
  return STATUS_BY_GITHUB_STATE.get(state) ?? "neutral";
}

export function prChecks(checks: PrReviewDetail["checks"]): PrCheck[] {
  return checks.map((check) => ({
    name: check.name,
    status: checkStatus(check.state),
    url: check.url,
  }));
}

export function isFailingCheck(check: Pick<PrCheck, "status">): boolean {
  return check.status === "failure" || check.status === "cancelled";
}

export function isWorkflowApprovalCheck(
  check: Pick<PrCheck, "status" | "url">,
): boolean {
  return (
    check.status === "action-required" &&
    check.url !== null &&
    /\/actions\/runs\/\d+(?:\/|$)/u.test(check.url)
  );
}

export function checksRollup(
  checks: ReadonlyArray<Pick<PrCheck, "status">>,
): ChecksRollup | null {
  if (checks.length === 0) return null;
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing";
  if (statuses.has("pending") || statuses.has("action-required"))
    return "pending";
  return statuses.has("success") ? "passing" : null;
}

export function summarizeChecks(
  checks: ReadonlyArray<Pick<PrCheck, "status" | "url">>,
): string {
  if (checks.length === 0) return "No checks reported";
  const actionRequired = checks.filter(
    (check) => check.status === "action-required",
  );
  const workflowApprovalRequired = actionRequired.filter(
    isWorkflowApprovalCheck,
  ).length;
  const otherActionRequired = actionRequired.length - workflowApprovalRequired;
  const failed = checks.filter(isFailingCheck).length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const passed = checks.filter((check) => check.status === "success").length;
  if (failed > 0) return `${failed} of ${checks.length} failing`;
  if (workflowApprovalRequired > 0 && otherActionRequired > 0) {
    return `${workflowApprovalRequired} ${workflowApprovalRequired === 1 ? "workflow" : "workflows"} and ${otherActionRequired} ${otherActionRequired === 1 ? "check" : "checks"} awaiting action`;
  }
  if (workflowApprovalRequired > 0) {
    return `${workflowApprovalRequired} ${workflowApprovalRequired === 1 ? "workflow" : "workflows"} awaiting approval`;
  }
  if (otherActionRequired > 0) {
    return `${otherActionRequired} ${otherActionRequired === 1 ? "check" : "checks"} awaiting action`;
  }
  if (pending > 0) return `${pending} of ${checks.length} running`;
  return passed === checks.length
    ? "All checks passed"
    : `${passed} of ${checks.length} passing`;
}

export function groupChecks<T extends Pick<PrCheck, "status">>(
  checks: ReadonlyArray<T>,
) {
  return {
    attention: checks.filter((check) =>
      ["failure", "cancelled", "action-required"].includes(check.status),
    ),
    running: checks.filter((check) => check.status === "pending"),
    completed: checks.filter((check) =>
      ["success", "skipped", "neutral"].includes(check.status),
    ),
  };
}
