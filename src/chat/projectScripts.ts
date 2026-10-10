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

const MAX_SCRIPT_ID_LENGTH = 24;
function normalizeScriptId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    return "script";
  }
  if (cleaned.length <= MAX_SCRIPT_ID_LENGTH) {
    return cleaned;
  }
  return cleaned.slice(0, MAX_SCRIPT_ID_LENGTH).replace(/-+$/g, "") || "script";
}

export function nextProjectScriptId(
  name: string,
  existingIds: Iterable<string>,
): string {
  const taken = new Set(Array.from(existingIds));
  const baseId = normalizeScriptId(name);
  if (!taken.has(baseId)) return baseId;

  let suffix = 2;
  while (suffix < 10_000) {
    const candidate = `${baseId}-${suffix}`;
    const safeCandidate =
      candidate.length <= MAX_SCRIPT_ID_LENGTH
        ? candidate
        : `${baseId.slice(0, Math.max(1, MAX_SCRIPT_ID_LENGTH - String(suffix).length - 1))}-${suffix}`;
    if (!taken.has(safeCandidate)) {
      return safeCandidate;
    }
    suffix += 1;
  }

  return `${baseId}-${Date.now()}`.slice(0, MAX_SCRIPT_ID_LENGTH);
}
