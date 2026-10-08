// Ported from T3 Code v0.0.45 apps/web/src/projectScripts.ts (MIT).
import type { ProjectScript } from "../ipc";
export const commandForProjectScript = (id: string) => `script.${id}.run`;
export function primaryProjectScript(scripts: readonly ProjectScript[]) {
  return (
    scripts.find((script) => !script.runOnWorktreeCreate) ?? scripts[0] ?? null
  );
}
export function resolveThreadEnvMode({
  preference,
  configured,
  overridden,
  projectDefault,
}: {
  preference: "local" | "worktree";
  configured: boolean;
  overridden: boolean;
  projectDefault: "local" | "worktree" | null | undefined;
}) {
  return configured || overridden || preference === "worktree"
    ? preference
    : (projectDefault ?? preference);
}
