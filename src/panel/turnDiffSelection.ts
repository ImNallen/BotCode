// Ported from T3 Code v0.0.45 apps/web/src/components/DiffPanel.tsx and diffPanelStore.ts (MIT).
import type { Thread } from "../ipc";

export type TurnDiffSelection = {
  threadId: string;
  turnId: string;
  filePath: string | null;
  request: number;
};

export function completedCheckpointTurns(thread: Thread | undefined) {
  return (thread?.turns ?? [])
    .map((turn, index) => ({ turn, number: index + 1 }))
    .filter(({ turn }) => turn.checkpoint.kind === "complete")
    .toReversed();
}

export function selectedCheckpointTurn(
  thread: Thread | undefined,
  selection: TurnDiffSelection | null,
) {
  if (!thread || thread.id !== selection?.threadId) return undefined;
  return completedCheckpointTurns(thread).find(
    ({ turn }) => turn.id === selection.turnId,
  );
}
