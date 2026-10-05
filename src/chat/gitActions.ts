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
import { workingSessions } from "../lib/sessions.ts";

export type GitTarget = GitStackedAction | "pull";

export type Busy = { kind: "idle" } | { kind: "git" } | { kind: "codex" };

export interface GitControlModel {
  vcs: VcsStatus;
  quick: GitQuickAction;
  menu: (GitActionMenuItem & { reason: string | null })[];
  notes: { tone: "warning" | "destructive"; text: string }[];
}

const CODEX_BUSY = "Codex is working in this checkout.";

type GhReason = Extract<PrLookup, { kind: "unavailable" }>["reason"];

const ghBlocks: Record<GhReason, string | null> = {
  missing: "Install GitHub CLI (gh) to create pull requests.",
  unauthenticated: "Run `gh auth login` to create pull requests.",
  failed: null,
};

function ghHint(pr: PrLookup | undefined): string | null {
  return pr?.kind === "unavailable" ? ghBlocks[pr.reason] : null;
}

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

function leaseRoot(checkout: Checkout): string | null {
  return checkout.kind === "local" ? null : checkout.path;
}

export function codexBusy(
  thread: Pick<ThreadSummary, "id" | "checkout" | "session">,
  threads: ThreadSummary[],
): boolean {
  const root = leaseRoot(thread.checkout);
  return (
    workingSessions.has(thread.session.kind) ||
    threads.some(
      (other) =>
        other.id !== thread.id &&
        leaseRoot(other.checkout) === root &&
        workingSessions.has(other.session.kind),
    )
  );
}

export interface Pending {
  target: GitTarget;
  message?: string;
  confirmed?: boolean;
}

export type Step =
  | { kind: "compose" }
  | { kind: "confirm"; copy: DefaultBranchActionDialogCopy }
  | { kind: "run"; action: GitAction };

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

const commitLabels: Partial<Record<GitTarget, string>> = {
  commit: "Commit",
  commit_push: "Commit & push",
  commit_push_pr: "Commit, push & PR",
};

export function commitButtonLabel(target: GitTarget): string {
  return commitLabels[target] ?? "Commit";
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
      outcome.pr.pr.title ? truncateText(outcome.pr.pr.title) : undefined,
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

export type GitRun =
  | {
      state: "running";
      action: GitAction;
      phase: GitPhase | null;
      phaseStartedAtMs: number;
    }
  | {
      state: "done";
      outcome: GitOutcome;
      before: VcsStatus;
      pr: PrLookup | undefined;
    }
  | {
      state: "refused";
      action: GitAction;
      error: { code: string; message: string };
    };

function formatElapsed(startedAtMs: number, nowMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) return `Running for ${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Running for ${minutes}m ${seconds}s`;
}

export function runToast(run: GitRun, nowMs: number): GitToast {
  switch (run.state) {
    case "running":
      return run.phase
        ? {
            type: "loading",
            title: phaseLabel(run.phase),
            description: formatElapsed(run.phaseStartedAtMs, nowMs),
            cta: { kind: "none" },
          }
        : {
            type: "loading",
            title: "Running git action...",
            description: "Waiting for Git...",
            cta: { kind: "none" },
          };
    case "done":
      return outcomeToast(run.outcome, run.before, run.pr);
    case "refused":
      if (run.error.code === "checkout_busy") {
        return {
          type: "info",
          title: run.error.message,
          cta: { kind: "none" },
        };
      }
      return {
        type: "error",
        title: run.action.kind === "pull" ? "Pull failed" : "Action failed",
        description: run.error.message,
        cta: { kind: "none" },
      };
  }
}
