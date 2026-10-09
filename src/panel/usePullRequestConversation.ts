import type { PrAccess } from "./prInbox";
import { useSyncExternalStore } from "react";
import { ipc } from "../ipc";
import { changeResultText } from "./prLifecycle";
import {
  conversationDrafts,
  draftKey,
  type ConversationDrafts,
} from "./reviewDrafts";
import type { PrObservation, PrReviewAction } from "./prReview";

export function usePullRequestConversation({
  target,
  findingId,
  threadId,
  refresh,
  store = conversationDrafts,
  draftId,
}: {
  target: PrObservation;
  findingId: string;
  threadId?: PrAccess;
  refresh?: () => void;
  store?: ConversationDrafts;
  draftId?: string;
}) {
  const key = draftId ?? `${draftKey(target)}:${findingId}`;
  const draft = useSyncExternalStore(
    store.subscribe,
    () => store.get(key),
    () => store.get(key),
  );
  const uncertain = draft.operation?.result?.kind === "uncertain";
  const pending = Boolean(draft.operation && !draft.operation.result);
  const change = async (action: PrReviewAction) => {
    const current = store.get(key);
    if (
      !threadId ||
      (current.operation &&
        (!current.operation.result ||
          current.operation.result.kind === "uncertain"))
    )
      return false;
    const input = { requestId: crypto.randomUUID(), target, action };
    const revision = store.start(key, input);
    if (store.get(key).persistenceError) {
      store.finish(key, revision, {
        kind: "refused",
        message:
          "The pending submission could not be saved on this device. Nothing was posted. Free storage and try again.",
      });
      return false;
    }
    try {
      const result = await ipc.changePullRequest(threadId, input);
      store.finish(key, revision, result);
      if (result.kind === "applied") refresh?.();
      return result.kind === "applied";
    } catch (error) {
      store.finish(key, revision, {
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
    persistenceError: draft.persistenceError,
    error:
      draft.operation?.result && draft.operation.result.kind !== "applied"
        ? changeResultText(draft.operation.result)
        : undefined,
    edit: (body: string) => store.edit(key, body),
    acknowledge: () => store.acknowledge(key),
  };
}
