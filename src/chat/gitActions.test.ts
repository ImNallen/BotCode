import { initialGitProgress } from "./gitProgress.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commitRequest,
  type GitOutcome,
  type GitStatus,
  type PrLookup,
  type ThreadSummary,
} from "../ipc";
import {
  codexBusy,
  commitButtonLabel,
  gitControl,
  nextStep,
  outcomeToast,
  phaseLabel,
  runToast,
  toVcsStatus,
} from "./gitActions.ts";

type Branch = NonNullable<GitStatus["branch"]>;

const INSTALL_GH = "Install GitHub CLI (gh) to create pull requests.";
const LOGIN_GH = "Run `gh auth login` to create pull requests.";
const request = (message: string | null = null) =>
  commitRequest.parse({
    message: message?.trim() || null,
    selection: { kind: "all" },
    destination: { kind: "current" },
  });

const SHA = "abc1234def567890";

function status(
  branch: Partial<Branch> = {},
  rest: Partial<GitStatus> = {},
): GitStatus {
  return {
    branch: {
      name: "feature",
      isDefault: false,
      base: "main",
      aheadOfBase: 0,
      upstream: { remote: "origin", branch: "feature", ahead: 0, behind: 0 },
      ...branch,
    },
    origin: true,
    files: [],
    ...rest,
  };
}

const onMain = { name: "main", isDefault: true };
const dirty = { files: [{ path: "src/a.ts", insertions: 3, deletions: 1 }] };
const tracking = (ahead: number, behind = 0) => ({
  remote: "origin",
  branch: "feature",
  ahead,
  behind,
});

function unavailable(
  reason: "missing" | "unauthenticated" | "failed",
): PrLookup {
  return { kind: "unavailable", reason, message: "gh said no" };
}

const pr = {
  number: 7,
  title: "Add Git actions",
  url: "https://github.com/bot-code/bot-code/pull/7",
  base: "main",
  head: "feature",
};
const openPr: PrLookup = { kind: "open", pr };

describe("gitControl", () => {
  it("downgrades a stacked PR action to commit & push when gh is missing", () => {
    const model = gitControl({
      status: status({}, dirty),
      pr: unavailable("missing"),
      busy: { kind: "idle" },
    });
    assert.deepEqual(model.quick, {
      label: "Commit & push",
      disabled: false,
      kind: "run_action",
      action: "commit_push",
    });
    assert.deepEqual(
      model.menu.map(({ label, disabled, reason }) => ({
        label,
        disabled,
        reason,
      })),
      [
        { label: "Commit", disabled: false, reason: null },
        {
          label: "Push",
          disabled: true,
          reason: "Commit or stash local changes before pushing.",
        },
        { label: "Create PR", disabled: true, reason: INSTALL_GH },
      ],
    );
    assert.deepEqual(model.notes, [{ tone: "warning", text: INSTALL_GH }]);
  });

  it("downgrades push & create PR to push when gh is signed out", () => {
    const model = gitControl({
      status: status({ aheadOfBase: 2, upstream: null }),
      pr: unavailable("unauthenticated"),
      busy: { kind: "idle" },
    });
    assert.deepEqual(model.quick, {
      label: "Push",
      disabled: false,
      kind: "run_action",
      action: "push",
    });
    assert.deepEqual(
      model.menu.map(({ label, disabled, reason }) => ({
        label,
        disabled,
        reason,
      })),
      [
        {
          label: "Commit",
          disabled: true,
          reason: "Worktree is clean. Make changes before committing.",
        },
        { label: "Push", disabled: false, reason: null },
        { label: "Create PR", disabled: true, reason: LOGIN_GH },
      ],
    );
  });

  it("turns create PR into the install hint when there is nothing to push", () => {
    const model = gitControl({
      status: status({ aheadOfBase: 3 }),
      pr: unavailable("missing"),
      busy: { kind: "idle" },
    });
    assert.deepEqual(model.quick, {
      label: "Create PR",
      disabled: true,
      kind: "show_hint",
      hint: INSTALL_GH,
    });
  });

  it("reads a failed lookup as no open PR and keeps Create PR enabled", () => {
    const model = gitControl({
      status: status({ aheadOfBase: 2, upstream: tracking(2) }),
      pr: unavailable("failed"),
      busy: { kind: "idle" },
    });
    assert.deepEqual(model.quick, {
      label: "Push & create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });
    assert.deepEqual(model.menu[2], {
      id: "pr",
      label: "Create PR",
      disabled: false,
      icon: "pr",
      kind: "open_dialog",
      dialogAction: "create_pr",
      reason: null,
    });
    assert.deepEqual(model.notes, []);
  });

  it("reads a pending lookup as no open PR", () => {
    const model = gitControl({
      status: status({ aheadOfBase: 2, upstream: tracking(2) }),
      pr: undefined,
      busy: { kind: "idle" },
    });
    assert.deepEqual(model.quick, {
      label: "Push & create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });
  });

  it("disables everything with the Codex hint while a turn holds the checkout", () => {
    const model = gitControl({
      status: status({}, dirty),
      pr: { kind: "none" },
      busy: { kind: "codex" },
    });
    assert.deepEqual(model.quick, {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Codex is working in this checkout.",
    });
    assert.deepEqual(
      model.menu.map((item) => item.reason),
      [
        "Codex is working in this checkout.",
        "Codex is working in this checkout.",
        "Codex is working in this checkout.",
      ],
    );
  });

  it("keeps T3's hint while this window's own Git run is in flight", () => {
    const model = gitControl({
      status: status({}, dirty),
      pr: unavailable("missing"),
      busy: { kind: "git" },
    });
    assert.deepEqual(model.quick, {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git action in progress.",
    });
    assert.deepEqual(
      model.menu.map((item) => item.reason),
      [
        "Git action in progress.",
        "Git action in progress.",
        "Git action in progress.",
      ],
    );
  });
});

describe("toVcsStatus", () => {
  it("counts ahead against the base and nothing behind without an upstream", () => {
    assert.deepEqual(
      toVcsStatus(status({ aheadOfBase: 4, upstream: null }), openPr),
      {
        refName: "feature",
        isDefaultRef: false,
        hasPrimaryRemote: true,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: false,
        aheadCount: 4,
        behindCount: 0,
        aheadOfDefaultCount: 4,
        pr: {
          number: 7,
          title: "Add Git actions",
          url: "https://github.com/bot-code/bot-code/pull/7",
          baseRef: "main",
          headRef: "feature",
          state: "open",
        },
      },
    );
  });

  it("reports nothing ahead of default on the default branch", () => {
    const vcs = toVcsStatus(
      status({
        ...onMain,
        aheadOfBase: 2,
        upstream: { ...tracking(1, 3), branch: "main" },
      }),
      undefined,
    );
    assert.equal(
      vcs.aheadOfDefaultCount,
      0,
      "default branch has no delta to itself",
    );
    assert.equal(vcs.aheadCount, 1, "ahead comes from the upstream");
    assert.equal(vcs.behindCount, 3, "behind comes from the upstream");
  });

  it("sums the working tree totals from the files", () => {
    const files = [
      { path: "a.ts", insertions: 3, deletions: 1 },
      { path: "b.ts", insertions: 10, deletions: 4 },
    ];
    const vcs = toVcsStatus(status({}, { files }), undefined);
    assert.deepEqual(vcs.workingTree, { files, insertions: 13, deletions: 5 });
    assert.equal(vcs.hasWorkingTreeChanges, true);
  });
});

describe("codexBusy", () => {
  function summary(
    id: string,
    checkout: ThreadSummary["checkout"],
    session: ThreadSummary["session"]["kind"],
  ): ThreadSummary {
    return {
      revision: 0,
      latestTurn: null,
      pendingApprovalIds: [],
      pendingUserQuestionIds: [],
      id,
      title: id,
      pullRequests: {
        sequence: 0,
        links: [],
        discovering: false,
        discoveryError: null,
      },
      session:
        session === "unavailable"
          ? { kind: session, reason: "gone" }
          : { kind: session },
      checkout,
      createdAtMs: null,
      archivedAtMs: null,
      updatedAtMs: null,
      awaitingApproval: false,
      pinnedAtMs: null,
      snoozedUntilMs: null,
      settledAtMs: null,
    };
  }
  const local = { kind: "local" } as const;
  const worktree = {
    kind: "worktree",
    path: "/tmp/wt-a",
    branch: "a",
  } as const;
  const running = summary("running-local", local, "running");

  it("blocks a local thread while another local thread is running", () => {
    assert.equal(codexBusy(summary("me", local, "ready"), [running]), true);
  });

  it("does not block a worktree thread for a running local thread", () => {
    assert.equal(codexBusy(summary("me", worktree, "ready"), [running]), false);
  });

  it("blocks a thread whose own session is connecting", () => {
    assert.equal(codexBusy(summary("me", worktree, "connecting"), []), true);
  });

  it("ignores idle threads on the same checkout", () => {
    assert.equal(
      codexBusy(summary("me", local, "ready"), [
        summary("other", local, "dormant"),
      ]),
      false,
    );
  });
});

describe("nextStep", () => {
  const feature = toVcsStatus(status({}, dirty), undefined);
  const main = toVcsStatus(status(onMain, dirty), undefined);
  const cleanMain = toVcsStatus(
    status({ ...onMain, upstream: tracking(2) }),
    undefined,
  );
  const clean = toVcsStatus(
    status({ aheadOfBase: 1, upstream: tracking(1) }),
    undefined,
  );

  it("asks for a message before a stacked commit", () => {
    assert.deepEqual(nextStep({ target: "commit_push_pr" }, feature), {
      kind: "compose",
    });
    assert.deepEqual(nextStep({ target: "commit_push_pr" }, feature), {
      kind: "compose",
    });
  });

  it("submitting an empty message advances to an automatic commit without reopening the dialog", () => {
    assert.deepEqual(
      nextStep({ target: "commit_push_pr", request: request() }, feature),
      {
        kind: "run",
        action: { kind: "commit_push_pr", request: request() },
      },
    );
    assert.equal(
      nextStep({ target: "commit_push", request: request() }, main).kind,
      "confirm",
    );
  });

  it("runs the stacked commit with the trimmed message on a feature branch", () => {
    assert.deepEqual(
      nextStep(
        { target: "commit_push_pr", request: request("  feat: x\n") },
        feature,
      ),
      {
        kind: "run",
        action: { kind: "commit_push_pr", request: request("feat: x") },
      },
    );
  });

  it("confirms a commit & push on the default branch after the message", () => {
    assert.deepEqual(
      nextStep({ target: "commit_push", request: request("fix: y") }, main),
      {
        kind: "confirm",
        copy: {
          title: "Commit & push to default ref?",
          description: 'This action will commit and push changes on "main".',
          continueLabel: "Commit & push to main",
        },
      },
    );
  });

  it("runs a confirmed push on the default branch", () => {
    assert.deepEqual(nextStep({ target: "push", confirmed: true }, cleanMain), {
      kind: "run",
      action: { kind: "push" },
    });
  });

  it("turns commit & push on a clean default branch into a confirmed push", () => {
    assert.deepEqual(nextStep({ target: "commit_push" }, cleanMain), {
      kind: "confirm",
      copy: {
        title: "Push to default ref?",
        description: 'This action will push local commits on "main".',
        continueLabel: "Push to main",
      },
    });
    assert.deepEqual(
      nextStep({ target: "commit_push", confirmed: true }, cleanMain),
      {
        kind: "run",
        action: { kind: "push" },
      },
    );
  });

  it("turns commit, push & PR on a clean branch into create PR", () => {
    assert.deepEqual(nextStep({ target: "commit_push_pr" }, clean), {
      kind: "run",
      action: { kind: "create_pr" },
    });
  });

  it("runs pull without confirmation, even on the default branch", () => {
    assert.deepEqual(nextStep({ target: "pull" }, cleanMain), {
      kind: "run",
      action: { kind: "pull" },
    });
  });
});

describe("commitButtonLabel", () => {
  it("names the action the commit dialog starts", () => {
    assert.deepEqual(
      (["commit", "commit_push", "commit_push_pr"] as const).map(
        commitButtonLabel,
      ),
      ["Commit", "Commit & push", "Commit, push & PR"],
    );
  });
});

describe("phaseLabel", () => {
  it("names each phase as T3 does", () => {
    assert.deepEqual(
      [
        phaseLabel({ kind: "commit" }),
        phaseLabel({ kind: "push", remote: "origin" }),
        phaseLabel({ kind: "pr" }),
        phaseLabel({ kind: "pull" }),
      ],
      [
        "Committing...",
        "Pushing to origin...",
        "Creating pull request...",
        "Pulling...",
      ],
    );
  });
});

describe("outcomeToast", () => {
  function outcome(fields: Partial<GitOutcome>): GitOutcome {
    return {
      warnings: [],
      branch: null,
      commit: null,
      push: null,
      pr: null,
      pull: null,
      failure: null,
      ...fields,
    };
  }
  it("shows a pull request generation fallback even if PR creation then fails", () => {
    const warning =
      "Could not generate pull request text. Used GitHub CLI's commit-based title and body.";
    const toast = outcomeToast(
      outcome({
        warnings: [warning],
        failure: {
          phase: { kind: "pr" },
          error: { code: "gh", message: "Creation refused" },
        },
      }),
      toVcsStatus(status({}, dirty), undefined),
      undefined,
    );
    assert.equal(toast.description, `Creation refused ${warning}`);
  });

  it("offers a commit dialog retry when an automatic message fails", () => {
    const toast = outcomeToast(
      outcome({
        failure: {
          phase: { kind: "commit" },
          error: {
            code: "commit_generation",
            message: "Enter a commit message",
          },
        },
      }),
      toVcsStatus(status({}, dirty), undefined),
      undefined,
    );
    assert.deepEqual(toast.cta, {
      kind: "run",
      label: "Commit",
      target: "commit",
    });
  });

  const feature = toVcsStatus(
    status({ aheadOfBase: 1, upstream: tracking(1) }),
    undefined,
  );
  const commit = { sha: SHA, subject: "feat: add Git actions" };
  const pushed = { sha: SHA, upstream: "origin/feature", setUpstream: false };

  it("links a created PR", () => {
    assert.deepEqual(
      outcomeToast(
        outcome({ commit, push: pushed, pr: { pr, created: true } }),
        feature,
        openPr,
      ),
      {
        type: "success",
        title: "Created PR #7",
        description: "Add Git actions",
        cta: {
          kind: "open_pr",
          label: "View PR",
          url: "https://github.com/bot-code/bot-code/pull/7",
        },
      },
    );
  });

  it("omits an unknown title after successful creation", () => {
    const toast = outcomeToast(
      outcome({ pr: { pr: { ...pr, title: null }, created: true } }),
      feature,
      undefined,
    );
    assert.equal(toast.title, "Created PR #7");
    assert.equal(toast.description, undefined);
    assert.equal(toast.cta.kind, "open_pr");
  });

  it("says Opened for a PR the lookup found", () => {
    assert.equal(
      outcomeToast(outcome({ pr: { pr, created: false } }), feature, openPr)
        .title,
      "Opened PR #7",
    );
  });

  it("offers Push after a commit only when origin exists", () => {
    assert.deepEqual(outcomeToast(outcome({ commit }), feature, undefined), {
      type: "success",
      title: "Committed abc1234",
      description: "feat: add Git actions",
      cta: { kind: "run", label: "Push", target: "push" },
    });
    const noOrigin = toVcsStatus(
      status({ upstream: null }, { origin: false }),
      undefined,
    );
    assert.deepEqual(
      outcomeToast(outcome({ commit }), noOrigin, undefined).cta,
      {
        kind: "none",
      },
    );
  });

  it("offers Create PR after a push on a feature branch without a PR", () => {
    assert.deepEqual(
      outcomeToast(outcome({ commit, push: pushed }), feature, {
        kind: "none",
      }),
      {
        type: "success",
        title: "Pushed abc1234 to origin/feature",
        description: "feat: add Git actions",
        cta: { kind: "run", label: "Create PR", target: "create_pr" },
      },
    );
    assert.deepEqual(
      outcomeToast(outcome({ push: pushed }), feature, unavailable("missing"))
        .cta,
      { kind: "none" },
      "no Create PR without gh",
    );
  });

  it("links the open PR after a push to its branch", () => {
    const withPr = toVcsStatus(
      status({ aheadOfBase: 1, upstream: tracking(1) }),
      openPr,
    );
    assert.deepEqual(
      outcomeToast(outcome({ push: pushed }), withPr, openPr).cta,
      {
        kind: "open_pr",
        label: "View PR",
        url: "https://github.com/bot-code/bot-code/pull/7",
      },
    );
  });

  it("offers nothing after a push to the default branch", () => {
    const main = toVcsStatus(
      status({ ...onMain, upstream: tracking(1) }),
      undefined,
    );
    const toMain = { ...pushed, upstream: "origin/main" };
    assert.deepEqual(
      outcomeToast(outcome({ push: toMain }), main, { kind: "none" }),
      {
        type: "success",
        title: "Pushed abc1234 to origin/main",
        cta: { kind: "none" },
      },
    );
  });

  it("keeps a landed commit in the title when the push fails", () => {
    const failure = {
      phase: { kind: "push", remote: "origin" } as const,
      error: { code: "git", message: "rejected (non-fast-forward)" },
    };
    assert.deepEqual(
      outcomeToast(outcome({ commit, failure }), feature, undefined),
      {
        type: "error",
        title: "Committed abc1234",
        description: "Push failed: rejected (non-fast-forward)",
        cta: { kind: "none" },
      },
    );
  });

  it("reports Action failed when nothing landed, and Pull failed for a pull", () => {
    const error = { code: "git", message: "index.lock exists" };
    assert.deepEqual(
      outcomeToast(
        outcome({ failure: { phase: { kind: "commit" }, error } }),
        feature,
        undefined,
      ),
      {
        type: "error",
        title: "Action failed",
        description: "index.lock exists",
        cta: { kind: "none" },
      },
    );
    assert.equal(
      outcomeToast(
        outcome({ failure: { phase: { kind: "pull" }, error } }),
        feature,
        undefined,
      ).title,
      "Pull failed",
    );
  });

  it("reports a pull that updated and one that did not", () => {
    assert.deepEqual(
      outcomeToast(
        outcome({ pull: { upstream: "origin/feature", updated: true } }),
        feature,
        undefined,
      ),
      {
        type: "success",
        title: "Pulled",
        description: "Updated feature from origin/feature",
        cta: { kind: "none" },
      },
    );
    assert.deepEqual(
      outcomeToast(
        outcome({ pull: { upstream: "origin/feature", updated: false } }),
        feature,
        undefined,
      ),
      {
        type: "success",
        title: "Already up to date",
        description: "feature is already synchronized.",
        cta: { kind: "none" },
      },
    );
  });

  it("truncates descriptions at 72 characters", () => {
    const long = { sha: SHA, subject: `feat: ${"x".repeat(80)}` };
    assert.equal(
      outcomeToast(outcome({ commit: long }), feature, undefined).description,
      `feat: ${"x".repeat(63)}...`,
    );
  });
});

describe("runToast", () => {
  const started = 1_000_000;

  it("waits for Git until the core reports the first phase", () => {
    assert.deepEqual(
      runToast(
        {
          state: "running",
          action: { kind: "push" },
          progress: { ...initialGitProgress, phaseStartedAtMs: started },
        },
        started + 400,
      ),
      {
        type: "loading",
        title: "Running git action...",
        description: "Waiting for Git...",
        cta: { kind: "none" },
      },
    );
  });

  it("labels the current phase with the time spent in it", () => {
    const pushing = {
      state: "running" as const,
      action: { kind: "push" as const },
      progress: {
        ...initialGitProgress,
        phase: { kind: "push" as const, remote: "origin" },
        phaseStartedAtMs: started,
      },
    };
    assert.deepEqual(runToast(pushing, started + 4_900), {
      type: "loading",
      title: "Pushing to origin...",
      description: "Running for 4s",
      cta: { kind: "none" },
    });
    assert.equal(
      runToast(pushing, started + 125_000).description,
      "Running for 2m 5s",
    );
  });

  it("shows a busy checkout as information, in the core's words", () => {
    assert.deepEqual(
      runToast(
        {
          state: "refused",
          progress: initialGitProgress,
          action: { kind: "commit", request: request("wip") },
          error: {
            code: "checkout_busy",
            message:
              "Codex is working in this checkout. Git actions return when the turn finishes.",
          },
        },
        started,
      ),
      {
        type: "info",
        title:
          "Codex is working in this checkout. Git actions return when the turn finishes.",
        cta: { kind: "none" },
      },
    );
  });

  it("reports any other refusal as a failed action, or a failed pull", () => {
    const error = { code: "not_repository", message: "Not a Git repository." };
    assert.deepEqual(
      runToast(
        {
          state: "refused",
          progress: initialGitProgress,
          action: { kind: "create_pr" },
          error,
        },
        started,
      ),
      {
        type: "error",
        title: "Action failed",
        description: "Not a Git repository.",
        cta: { kind: "none" },
      },
    );
    assert.equal(
      runToast(
        {
          state: "refused",
          progress: initialGitProgress,
          action: { kind: "pull" },
          error,
        },
        started,
      ).title,
      "Pull failed",
    );
  });
});

it("Commit on new branch stays commit-only even from a stacked action or a refreshed clean status", () => {
  const commit = commitRequest.parse({
    message: "New feature",
    selection: { kind: "paths", paths: ["literal*.txt"] },
    destination: { kind: "new_branch" },
  });
  for (const changes of [dirty, {}]) {
    const vcs = toVcsStatus(status(onMain, changes), undefined);
    assert.deepEqual(
      nextStep({ target: "commit_push_pr", request: commit }, vcs),
      { kind: "run", action: { kind: "commit", request: commit } },
    );
  }
});

it("a post-commit warning keeps the landed commit visible without saying the commit failed", () => {
  const toast = outcomeToast(
    {
      branch: null,
      commit: { sha: SHA, subject: "Commit selected files" },
      push: null,
      pr: null,
      pull: null,
      failure: null,
      warnings: ["post-commit hook failed (exit 9)."],
    },
    toVcsStatus(status({}, dirty), undefined),
    undefined,
  );
  assert.equal(toast.type, "warning");
  assert.ok(toast.title.startsWith("Committed "));
  assert.equal(toast.description, "post-commit hook failed (exit 9).");
});
