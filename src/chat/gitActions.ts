import type {
  Checkout,
  GitAction,
  GitOutcome,
  GitPhase,
  GitStatus,
  PrLookup,
  ThreadSummary,
} from "../ipc";
import {
  buildMenuItems,
  getMenuActionDisabledReason,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
  type DefaultBranchActionDialogCopy,
  type GitActionMenuItem,
  type GitQuickAction,
  type GitStackedAction,
  type VcsStatus,
} from "./GitActionsControl.logic.ts";

/** Everything the control can start: T3's stacked actions plus pull. */
export type GitTarget = GitStackedAction | "pull";

export type Busy =
  | { kind: "idle" }
  /** A run from this window is in flight on this checkout. */
  | { kind: "git" }
  /** A Codex turn holds the checkout's lease. */
  | { kind: "codex" };

export interface GitControlModel {
  vcs: VcsStatus;
  quick: GitQuickAction;
  menu: (GitActionMenuItem & { reason: string | null })[];
  /** T3's notes under the menu items. */
  notes: { tone: "warning" | "destructive"; text: string }[];
}

const CODEX_BUSY = "Codex is working in this checkout.";

type GhReason = Extract<PrLookup, { kind: "unavailable" }>["reason"];

/** Why gh cannot create a pull request. A failed lookup still allows one, because the PR step looks up again before it creates. */
const ghBlocks: Record<GhReason, string | null> = {
  missing: "Install GitHub CLI (gh) to create pull requests.",
  unauthenticated: "Run `gh auth login` to create pull requests.",
  failed: null,
};

function ghHint(pr: PrLookup | undefined): string | null {
  return pr?.kind === "unavailable" ? ghBlocks[pr.reason] : null;
}

/** Domain status plus PR lookup, flattened into the fields the ported rules read. */
export function toVcsStatus(
  status: GitStatus,
  pr: PrLookup | undefined,
): VcsStatus {
  const { branch, files } = status;
  const upstream = branch?.upstream ?? null;
  return {
    refName: branch?.name ?? null,
    isDefaultRef: branch?.isDefault ?? false,
    hasPrimaryRemote: status.origin,
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      files,
      insertions: files.reduce((sum, file) => sum + file.insertions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
    hasUpstream: upstream !== null,
    aheadCount: upstream?.ahead ?? branch?.aheadOfBase ?? 0,
    behindCount: upstream?.behind ?? 0,
    aheadOfDefaultCount: branch?.isDefault ? 0 : branch?.aheadOfBase,
    pr:
      pr?.kind === "open"
        ? {
            number: pr.pr.number,
            title: pr.pr.title,
            url: pr.pr.url,
            baseRef: pr.pr.base,
            headRef: pr.pr.head,
            state: "open",
          }
        : null,
  };
}

/**
 * T3's rules with Z1's overlays. A pending or failed PR lookup reads as "no open PR", as T3
 * reads it before its remote status arrives.
 */
export function gitControl(input: {
  status: GitStatus;
  pr: PrLookup | undefined;
  busy: Busy;
}): GitControlModel {
  const { busy } = input;
  const vcs = toVcsStatus(input.status, input.pr);
  const gh = ghHint(input.pr);
  const isBusy = busy.kind !== "idle";

  let quick = resolveQuickAction(
    vcs,
    isBusy,
    vcs.isDefaultRef,
    vcs.hasPrimaryRemote,
  );
  if (busy.kind === "codex") quick = { ...quick, hint: CODEX_BUSY };
  if (gh !== null) quick = withoutPr(quick, vcs, gh);

  const menu = buildMenuItems(vcs, isBusy, vcs.hasPrimaryRemote).map(
    (built) => {
      const item = {
        ...built,
        disabled:
          built.disabled || (gh !== null && built.dialogAction === "create_pr"),
      };
      return { ...item, reason: menuReason(item, vcs, busy, gh) };
    },
  );

  const notes: GitControlModel["notes"] = [];
  if (vcs.refName === null) {
    notes.push({
      tone: "warning",
      text: "Detached HEAD: create and check out a branch to enable push and pull request actions.",
    });
  } else if (
    !vcs.hasWorkingTreeChanges &&
    vcs.behindCount > 0 &&
    vcs.aheadCount === 0
  ) {
    notes.push({
      tone: "warning",
      text: "Behind upstream. Pull/rebase first.",
    });
  }
  if (gh !== null) notes.push({ tone: "warning", text: gh });

  return { vcs, quick, menu, notes };
}

/** Without gh, a quick action that would end in a pull request stops before it. */
function withoutPr(
  quick: GitQuickAction,
  vcs: VcsStatus,
  gh: string,
): GitQuickAction {
  if (quick.action === "commit_push_pr") {
    return {
      label: "Commit & push",
      disabled: false,
      kind: "run_action",
      action: "commit_push",
    };
  }
  if (quick.action !== "create_pr") return quick;
  if (vcs.aheadCount > 0) {
    return {
      label: "Push",
      disabled: false,
      kind: "run_action",
      action: "push",
    };
  }
  return { label: quick.label, disabled: true, kind: "show_hint", hint: gh };
}

function menuReason(
  item: GitActionMenuItem,
  vcs: VcsStatus,
  busy: Busy,
  gh: string | null,
): string | null {
  if (!item.disabled) return null;
  if (busy.kind === "codex") return CODEX_BUSY;
  if (busy.kind === "idle" && gh !== null && item.dialogAction === "create_pr")
    return gh;
  return getMenuActionDisabledReason({
    item,
    gitStatus: vcs,
    isBusy: busy.kind !== "idle",
    hasPrimaryRemote: vcs.hasPrimaryRemote,
  });
}

// ipc.ts `workingSessions`, repeated because ipc.ts loads Tauri at runtime and node cannot.
const leaseHolding = new Set<ThreadSummary["session"]["kind"]>([
  "connecting",
  "running",
  "interrupting",
]);

// The core keys the lease by checkout root: the repository root for local threads, the
// checkout's own path otherwise.
function leaseRoot(checkout: Checkout): string | null {
  return checkout.kind === "local" ? null : checkout.path;
}

/**
 * Whether a Codex turn holds the lease on this thread's checkout. The core still refuses
 * authoritatively (checkout_busy); this only disables the control early.
 */
export function codexBusy(
  thread: Pick<ThreadSummary, "id" | "checkout" | "session">,
  threads: ThreadSummary[],
): boolean {
  const root = leaseRoot(thread.checkout);
  return (
    leaseHolding.has(thread.session.kind) ||
    threads.some(
      (other) =>
        other.id !== thread.id &&
        leaseRoot(other.checkout) === root &&
        leaseHolding.has(other.session.kind),
    )
  );
}

/** What the user has supplied so far for one started action. */
export interface Pending {
  target: GitTarget;
  message?: string;
  confirmed?: boolean;
}

export type Step =
  /** Open the commit dialog; the action continues with the typed message. */
  | { kind: "compose" }
  /** Open the default-branch dialog (Abort / Continue). */
  | { kind: "confirm"; copy: DefaultBranchActionDialogCopy }
  | { kind: "run"; action: GitAction };

/**
 * Compose, then confirm, then run. The message comes first so the confirmation copy can say
 * whether a commit is included.
 */
export function nextStep(pending: Pending, vcs: VcsStatus): Step {
  const action = toAction(pending, vcs);
  if (action === null) return { kind: "compose" };
  const { target } = pending;
  if (
    target !== "pull" &&
    target !== "commit" &&
    vcs.refName !== null &&
    !pending.confirmed &&
    requiresDefaultBranchConfirmation(target, vcs.isDefaultRef)
  ) {
    return {
      kind: "confirm",
      copy: resolveDefaultBranchActionDialogCopy({
        action: target,
        branchName: vcs.refName,
        includesCommit: "message" in action,
      }),
    };
  }
  return { kind: "run", action };
}

/**
 * `null` while a commit still needs its message. A stacked commit on a clean tree runs the
 * rest of its stack, as T3's server skips the empty commit step.
 */
function toAction(
  { target, message }: Pending,
  vcs: VcsStatus,
): GitAction | null {
  switch (target) {
    case "pull":
    case "push":
    case "create_pr":
      return { kind: target };
    case "commit_push":
      if (!vcs.hasWorkingTreeChanges) return { kind: "push" };
      break;
    case "commit_push_pr":
      if (!vcs.hasWorkingTreeChanges) return { kind: "create_pr" };
      break;
  }
  const text = message?.trim();
  return text ? { kind: target, message: text } : null;
}

export function phaseLabel(phase: GitPhase): string {
  switch (phase.kind) {
    case "commit":
      return "Committing...";
    case "push":
      return `Pushing to ${phase.remote}...`;
    case "pr":
      return "Creating pull request...";
    case "pull":
      return "Pulling...";
  }
}

export type ToastCta =
  | { kind: "none" }
  | { kind: "open_pr"; label: "View PR"; url: string }
  | { kind: "run"; label: "Push" | "Create PR"; target: GitTarget };

export interface GitToast {
  type: "loading" | "success" | "error" | "info";
  title: string;
  description?: string;
  cta: ToastCta;
}

const SHORT_SHA_LENGTH = 7;
const TOAST_DESCRIPTION_MAX = 72;

function shortenSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

function truncateText(
  value: string | undefined,
  maxLength = TOAST_DESCRIPTION_MAX,
): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return "...".slice(0, maxLength);
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function withDescription(title: string, description: string | undefined) {
  return description ? { title, description } : { title };
}

const failedStep: Record<GitPhase["kind"], string> = {
  commit: "Commit",
  push: "Push",
  pr: "Create PR",
  pull: "Pull",
};

/**
 * T3's completion toast (GitManager buildCompletionToast), moved client-side. Unlike T3, a
 * failure after a landed step keeps what landed in the title instead of a bare "Action failed".
 * `before` is the status the action started from.
 */
export function outcomeToast(
  outcome: GitOutcome,
  before: VcsStatus,
  gh: PrLookup | undefined,
): GitToast {
  const landed = summarize(outcome, before);
  const { failure } = outcome;
  if (failure) {
    if (landed === null) {
      return {
        type: "error",
        title: failure.phase.kind === "pull" ? "Pull failed" : "Action failed",
        description: failure.error.message,
        cta: { kind: "none" },
      };
    }
    return {
      type: "error",
      title: landed.title,
      description: `${failedStep[failure.phase.kind]} failed: ${failure.error.message}`,
      cta: { kind: "none" },
    };
  }
  return {
    type: "success",
    ...(landed ?? { title: "Done" }),
    cta: completionCta(outcome, before, gh),
  };
}

function summarize(
  outcome: GitOutcome,
  before: VcsStatus,
): { title: string; description?: string } | null {
  if (outcome.pr) {
    const verb = outcome.pr.created ? "Created" : "Opened";
    return withDescription(
      `${verb} PR #${outcome.pr.pr.number}`,
      truncateText(outcome.pr.pr.title),
    );
  }
  if (outcome.push) {
    return withDescription(
      `Pushed ${shortenSha(outcome.push.sha)} to ${outcome.push.upstream}`,
      truncateText(outcome.commit?.subject),
    );
  }
  if (outcome.commit) {
    return withDescription(
      `Committed ${shortenSha(outcome.commit.sha)}`,
      truncateText(outcome.commit.subject),
    );
  }
  if (outcome.pull) {
    const ref = before.refName ?? "HEAD";
    return outcome.pull.updated
      ? {
          title: "Pulled",
          description: `Updated ${ref} from ${outcome.pull.upstream}`,
        }
      : {
          title: "Already up to date",
          description: `${ref} is already synchronized.`,
        };
  }
  return null;
}

function completionCta(
  outcome: GitOutcome,
  before: VcsStatus,
  gh: PrLookup | undefined,
): ToastCta {
  if (outcome.pr)
    return { kind: "open_pr", label: "View PR", url: outcome.pr.pr.url };
  if (outcome.push) {
    if (before.isDefaultRef) return { kind: "none" };
    if (before.pr)
      return { kind: "open_pr", label: "View PR", url: before.pr.url };
    if (ghHint(gh) === null)
      return { kind: "run", label: "Create PR", target: "create_pr" };
    return { kind: "none" };
  }
  if (outcome.commit && before.hasPrimaryRemote) {
    return { kind: "run", label: "Push", target: "push" };
  }
  return { kind: "none" };
}
