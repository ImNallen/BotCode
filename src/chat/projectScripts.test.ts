import assert from "node:assert/strict";
import { it } from "node:test";
import { projectConfig, worktreeSetup } from "../ipc.ts";
import {
  resolveThreadEnvMode,
  primaryProjectScript,
  commandForProjectScript,
} from "./projectScripts.ts";
const setup = {
  id: "setup",
  name: "Setup",
  command: "pnpm install",
  icon: "configure",
  runOnWorktreeCreate: true,
  async: false,
  previewUrl: null,
  autoOpenPreview: false,
};
const start = {
  ...setup,
  id: "dev",
  name: "Dev",
  runOnWorktreeCreate: false,
  previewUrl: "http://localhost:3000",
  autoOpenPreview: true,
};
it("selects the first normal script ahead of setup and preserves preview metadata", () => {
  const config = projectConfig.parse({
    scripts: [setup, start],
    defaultThreadEnvMode: "worktree",
    worktreeSubmodules: "recursive",
    iconPath: null,
  });
  assert.deepEqual(primaryProjectScript(config.scripts), start);
  assert.equal(primaryProjectScript([setup]), setup);
  assert.equal(primaryProjectScript([]), null);
  assert.equal(commandForProjectScript("dev"), "script.dev.run");
  assert.equal(
    projectConfig.safeParse({ ...config, worktreeSubmodules: "all" }).success,
    false,
  );
});
it("accepts submodule-only setup and requires failed setup diagnostics", () => {
  const snapshot = {
    id: "setup-1",
    script: null,
    cwd: "/repo",
    state: { kind: "failed", reason: "install failed", exitCode: 2 },
    output: ["failure"],
    startedAtMs: 1,
    completedAtMs: 2,
  };
  assert.deepEqual(worktreeSetup.parse(snapshot), snapshot);
  assert.equal(
    worktreeSetup.safeParse({ ...snapshot, state: { kind: "failed" } }).success,
    false,
  );
  assert.equal(
    worktreeSetup.safeParse({ ...snapshot, state: { kind: "suspended" } })
      .success,
    false,
  );
});
it("respects a deliberately saved local choice ahead of the project default", () => {
  const options = {
    preference: "local",
    configured: false,
    overridden: false,
    projectDefault: "worktree",
  } satisfies Parameters<typeof resolveThreadEnvMode>[0];
  assert.equal(resolveThreadEnvMode(options), "worktree");
  assert.equal(resolveThreadEnvMode({ ...options, configured: true }), "local");
  assert.equal(resolveThreadEnvMode({ ...options, overridden: true }), "local");
  assert.equal(
    resolveThreadEnvMode({
      ...options,
      preference: "worktree",
      projectDefault: "local",
    }),
    "worktree",
  );
});
