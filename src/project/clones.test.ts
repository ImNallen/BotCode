import assert from "node:assert/strict";
import { it } from "node:test";
import {
  cloneFolder,
  cloneName,
  cloneProgress,
  projectCloneSnapshot,
} from "./clones";

const clone = projectCloneSnapshot.parse({
  workspaceId: "11111111-1111-4111-8111-111111111111",
  remoteUrl: "git@github.com:owner/project.git",
  destinationPath: "/tmp/project",
  phase: "running",
  stage: "receiving",
  percent: 45,
  detail: "12.3 MiB | 5.0 MiB/s",
  error: null,
  startedAtMs: 1,
  endedAtMs: null,
  sequence: 1,
});
it("renders T3 clone stage labels and optional progress", () => {
  assert.equal(
    cloneProgress(clone),
    "Receiving objects · 45% · 12.3 MiB | 5.0 MiB/s",
  );
  assert.equal(
    cloneProgress({
      ...clone,
      stage: "connecting",
      percent: null,
      detail: null,
    }),
    "Connecting",
  );
  assert.equal(
    cloneProgress({ ...clone, stage: "checkout", percent: 100, detail: null }),
    "Checking out files · 100%",
  );
  assert.equal(cloneName(clone), "project");
  assert.equal(
    cloneName({ ...clone, destinationPath: "C:\\projects\\windows\\" }),
    "windows",
  );
});
it("infers clone folder names from Git URL forms without using path traversal", () => {
  assert.equal(cloneFolder("https://github.com/owner/name.git"), "name");
  assert.equal(cloneFolder("git@github.com:owner/name.git"), "name");
  assert.equal(cloneFolder("file:///tmp/local.git"), "local");
  assert.equal(cloneFolder("ssh://git@example.com/owner/name.git/"), "name");
  assert.equal(cloneFolder("https://example.com/.."), "repository");
});
it("rejects invalid native progress payloads", () => {
  assert.equal(
    projectCloneSnapshot.safeParse({ ...clone, percent: 101 }).success,
    false,
  );
  assert.equal(
    projectCloneSnapshot.safeParse({ ...clone, stage: "unknown" }).success,
    false,
  );
  assert.equal(
    projectCloneSnapshot.safeParse({ ...clone, detail: "a".repeat(201) })
      .success,
    false,
  );
});
