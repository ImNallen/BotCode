// Adapted from pingdotgg/t3code v0.0.45 components/ChatView.tsx (MIT).
import type { Thread } from "../ipc";

export function composerTasks(turn: Thread["turns"][number] | undefined) {
  if (
    !turn ||
    (turn.execution.kind !== "running" && turn.execution.kind !== "not_started")
  )
    return null;
  const steps = turn.tasks?.steps;
  if (!steps?.length) return null;
  const current =
    steps.find((step) => step.status === "inProgress") ??
    steps.find((step) => step.status === "pending");
  if (!current) return null;
  return {
    steps,
    progress: {
      step: current.step,
      completedSteps: steps.filter((step) => step.status === "completed")
        .length,
      totalSteps: steps.length,
    },
  };
}
