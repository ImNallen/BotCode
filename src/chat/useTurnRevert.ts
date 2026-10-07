// Ported from T3 Code v0.0.45 apps/web/src/components/ChatView.tsx onRevertTimelineTurn (MIT).
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  invalidateCheckouts,
  ipc,
  setThreadSnapshot,
  type Thread,
} from "../ipc";

import { recoveryFit, type ComposerInput } from "./composerImages";

export function useTurnRevert({
  workspaceId,
  threadId,
  thread,
  composer,
  onReverted,
}: {
  workspaceId: string;
  threadId: string | undefined;
  thread: Thread | undefined;
  composer: ComposerInput;
  onReverted: () => void;
}) {
  const client = useQueryClient();
  const [editTarget, setEditTarget] = useState<{
    threadId: string;
    turnId: string;
  } | null>(null);
  const activeThreadId = useRef(threadId);
  activeThreadId.current = threadId;
  const activation = useRef(composer.activation);
  activation.current = composer.activation;
  const [preflightError, setPreflightError] = useState<string>();
  const revert = useMutation({
    mutationFn: (input: {
      threadId: string;
      turnId: string;
      requestId: string;
      files: boolean;
      activation: number;
    }) =>
      ipc.revert(input.threadId, input.requestId, input.turnId, input.files),
    onSuccess: (snapshot, input) => {
      setThreadSnapshot(client, snapshot);
      invalidateCheckouts(client, snapshot.workspaceId);
      if (
        activeThreadId.current !== input.threadId ||
        activation.current !== input.activation
      )
        return;
      setEditTarget(null);
      onReverted();
    },
    onSettled: (_data, _error, input) => {
      void client.invalidateQueries({ queryKey: ["thread", input.threadId] });
      invalidateCheckouts(client, workspaceId);
    },
  });
  const visibleEditTarget =
    editTarget?.threadId === threadId ? (editTarget?.turnId ?? null) : null;
  return {
    revert,
    preflightError,
    visibleEditTarget,
    reverting: revert.isPending || Boolean(thread?.pendingRevert),
    openEdit: (turnId: string) => {
      if (!thread) return;
      revert.reset();
      setPreflightError(undefined);
      setEditTarget({ threadId: thread.id, turnId });
    },
    closeEdit: () => setEditTarget(null),
    startRevert: (files: boolean) => {
      const turn = thread?.turns.find((turn) => turn.id === visibleEditTarget);
      if (!thread || !turn || revert.isPending) return;
      const refusal = thread.pendingRevert
        ? null
        : recoveryFit(composer.images, turn, composer.records);
      if (refusal) {
        setPreflightError(refusal);
        return;
      }
      setPreflightError(undefined);
      revert.mutate({
        threadId: thread.id,
        turnId: turn.id,
        activation: composer.activation,
        requestId: thread.pendingRevert?.requestId ?? crypto.randomUUID(),
        files,
      });
    },
  };
}
