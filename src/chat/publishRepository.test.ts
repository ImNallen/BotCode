import assert from "node:assert/strict";
import { it } from "node:test";
import {
  canPublish,
  publishDefaults,
  publishFailure,
  publishOutcome,
} from "./publishRepository.ts";
import { gitControl } from "./gitActions.ts";
import { resolveQuickAction } from "./GitActionsControl.logic.ts";
import { categories } from "../settings/settingsCatalog.ts";

it("routes clean no-origin repositories to publish while keeping dirty commits and publish menu available", () => {
  const status = {
    branch: {
      name: "main",
      isDefault: true,
      base: "main",
      aheadOfBase: 0,
      upstream: null,
    },
    origin: false,
    files: [],
  };
  const clean = gitControl({ pr: undefined, status, busy: { kind: "idle" } });
  assert.equal(clean.quick.kind, "open_publish");
  const dirty = gitControl({
    pr: undefined,
    status: {
      ...status,
      files: [{ path: "README", insertions: 1, deletions: 0 }],
    },
    busy: { kind: "idle" },
  });
  assert.equal(dirty.quick.kind, "run_action");
  assert.equal(dirty.quick.action, "commit");
  assert.equal(
    dirty.menu.find((item) => item.kind === "open_publish")?.disabled,
    false,
  );
  const busy = gitControl({ pr: undefined, status, busy: { kind: "git" } });
  assert.equal(busy.quick.disabled, true);
  assert.equal(
    busy.menu.find((item) => item.kind === "open_publish")?.disabled,
    true,
  );
  const detached = gitControl({
    pr: undefined,
    status: { ...status, branch: null },
    busy: { kind: "idle" },
  });
  assert.equal(
    detached.menu.find((item) => item.kind === "open_publish")?.disabled,
    true,
  );
  assert.equal(
    resolveQuickAction(
      {
        ...clean.vcs,
        aheadCount: 0,
        pr: {
          number: 1,
          title: "Existing",
          url: "https://github.com/a/b/pull/1",
          baseRef: "main",
          headRef: "work",
          state: "open",
        },
      },
      false,
      false,
      false,
    ).kind,
    "open_pr",
  );
});
it("requires readiness and a complete name, defaults to private SSH, and blocks duplicate or uncertain creation", () => {
  assert.equal(publishDefaults.visibility, "private");
  assert.equal(publishDefaults.protocol, "ssh");
  assert.equal(publishDefaults.remoteName, "origin");
  assert.equal(canPublish({ kind: "idle" }, true, "octocat/new"), true);
  assert.equal(canPublish({ kind: "idle" }, false, "octocat/new"), false);
  assert.equal(canPublish({ kind: "idle" }, true, "octocat/"), false);
  assert.equal(canPublish({ kind: "idle" }, true, "octocat/new/extra"), false);
  assert.equal(canPublish({ kind: "running" }, true, "octocat/new"), false);
  const uncertain = publishOutcome.parse({
    kind: "creation_uncertain",
    repository: "octocat/new",
    message: "Check GitHub before retrying.",
  });
  assert.equal(
    canPublish({ kind: "finished", outcome: uncertain }, true, "octocat/new"),
    false,
  );
  assert.equal(
    publishFailure({ kind: "finished", outcome: uncertain }),
    "Check GitHub before retrying.",
  );
});
it("retains remote-specific recovery and permits a corrected request only after a known rejection", () => {
  const repository = {
    nameWithOwner: "octocat/new",
    url: "https://github.com/octocat/new",
  };
  const outcome = publishOutcome.parse({
    kind: "failed",
    message:
      "Created octocat/new and configured remote 'origin-1'. Run git push --set-upstream -- 'origin-1' 'refs/heads/main:refs/heads/main'. Git reported: POLICY123: commit rejected because the required ticket is missing",
    completed: {
      kind: "remote_added",
      remote: {
        repository,
        remoteName: "origin-1",
        remoteUrl: "git@github.com:octocat/new.git",
      },
    },
  });
  if (outcome.kind !== "failed") throw new Error("Expected failed publication");
  const attempt = { kind: "finished", outcome } as const;
  assert.equal(publishFailure(attempt), outcome.message);
  assert.match(
    publishFailure(attempt) ?? "",
    /POLICY123: commit rejected because the required ticket is missing/,
  );
  assert.match(
    publishFailure(attempt) ?? "",
    /'origin-1' 'refs\/heads\/main:refs\/heads\/main'/,
  );
  assert.equal(canPublish(attempt, true, "octocat/new"), false);
  assert.equal(
    canPublish(
      {
        kind: "finished",
        outcome: {
          kind: "failed",
          message: "Name exists",
          completed: { kind: "nothing" },
        },
      },
      true,
      "octocat/different",
    ),
    true,
  );
});
it("distinguishes an empty repository from a pushed branch at the IPC boundary", () => {
  const remote = {
    repository: { nameWithOwner: "a/b", url: "https://github.com/a/b" },
    remoteName: "origin",
    remoteUrl: "git@github.com:a/b.git",
    branch: "main",
  };
  assert.equal(
    publishOutcome.parse({
      kind: "succeeded",
      result: { ...remote, status: "remote_added" },
    }).kind,
    "succeeded",
  );
  assert.equal(
    publishOutcome.safeParse({
      kind: "succeeded",
      result: { ...remote, status: "pushed" },
    }).success,
    false,
  );
  assert.equal(
    publishOutcome.parse({
      kind: "succeeded",
      result: { ...remote, status: "pushed", upstreamBranch: "origin/main" },
    }).kind,
    "succeeded",
  );
});
it("registers GitHub provider setup in source-control settings search", () => {
  assert.ok(
    categories["source-control"].groups.some((group) =>
      group.rows.some((row) => row.id === "github-provider"),
    ),
  );
});

it("preserves actionable remote-write and creation failures through IPC parsing and dialog text", () => {
  const repository = {
    nameWithOwner: "octocat/new",
    url: "https://github.com/octocat/new",
  };
  for (const failed of [
    {
      kind: "failed",
      message:
        "Created octocat/new. Could not add a remote. Git reported: error: could not lock config file .git/config: File exists",
      completed: { kind: "repository_created", repository },
    },
    {
      kind: "failed",
      message:
        "GitHub denied permission to create this repository. Check the account's repository creation permissions.",
      completed: { kind: "nothing" },
    },
  ]) {
    const outcome = publishOutcome.parse(failed);
    assert.equal(publishFailure({ kind: "finished", outcome }), failed.message);
  }
});
