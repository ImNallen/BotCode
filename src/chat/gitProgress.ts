import type { GitPhase, GitProgress } from "../ipc";

export type GitRunProgress = {
  phase: GitPhase | null;
  phaseStartedAtMs: number;
  hooks: string[];
  lines: string[];
};
export const initialGitProgress: GitRunProgress = {
  phase: null,
  phaseStartedAtMs: 0,
  hooks: [],
  lines: [],
};
export function updateGitProgress(
  progress: GitRunProgress,
  event: GitProgress,
  now: number,
): GitRunProgress {
  const append = (line: string) =>
    [...progress.lines, line.slice(0, 2000)].slice(-200);
  switch (event.kind) {
    case "phase":
      return { ...progress, phase: event.phase, phaseStartedAtMs: now };
    case "hook_started":
      return {
        ...progress,
        hooks: [...progress.hooks, event.name],
        lines: append(`Running ${event.name} hook...`),
      };
    case "hook_finished": {
      const index = progress.hooks.indexOf(event.name);
      return {
        ...progress,
        hooks: progress.hooks.filter((_, i) => i !== index),
        lines: append(
          `${event.name} hook ${event.code === 0 ? "finished" : `failed (exit ${event.code ?? "unknown"})`}.`,
        ),
      };
    }
    case "output":
      return { ...progress, lines: append(event.line) };
  }
}
