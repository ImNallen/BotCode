import { useSyncExternalStore } from "react";
import { ipc } from "../ipc";
import { changeResultText } from "./prLifecycle";
import { conversationDrafts, draftKey } from "./reviewDrafts";
import type { PrObservation, PrReviewAction } from "./prReview";

export function usePullRequestConversation({
  target,
  findingId,
  threadId,
  refresh,
}: {
  target: PrObservation;
  findingId: string;
  threadId?: string;
  refresh?: () => void;
}) {
  const key = `${draftKey(target)}:${findingId}`;
  const draft = useSyncExternalStore(
    conversationDrafts.subscribe,
    () => conversationDrafts.get(key),
    () => conversationDrafts.get(key),
  );
  const uncertain = draft.operation?.result?.kind === "uncertain";
  const pending = Boolean(draft.operation && !draft.operation.result);
  const change = async (action: PrReviewAction) => {
    const current = conversationDrafts.get(key);
    if (
      !threadId ||
      (current.operation &&
        (!current.operation.result ||
          current.operation.result.kind === "uncertain"))
    )
      return false;
    const input = { requestId: crypto.randomUUID(), target, action };
    const revision = conversationDrafts.start(key, input);
    try {
      const result = await ipc.changePullRequest(threadId, input);
      conversationDrafts.finish(key, revision, result);
      if (result.kind === "applied") refresh?.();
      return result.kind === "applied";
    } catch (error) {
      conversationDrafts.finish(key, revision, {
        kind: "uncertain",
        message: String(error),
      });
      return false;
    }
  };
  return {
    reply: draft.body,
    pending,
    uncertain,
    change,
    error:
      draft.operation?.result && draft.operation.result.kind !== "applied"
        ? changeResultText(draft.operation.result)
        : undefined,
    edit: (body: string) => conversationDrafts.edit(key, body),
    acknowledge: () => conversationDrafts.acknowledge(key),
  };
}
