// Commit preview adapts pingdotgg/t3code v0.0.45 components/GitActionsControl.tsx (MIT).
import { commitSelection, type CommitSelection, type GitStatus } from "../ipc";

export function selectedCommitFiles(
  files: GitStatus["files"],
  excluded: ReadonlySet<string>,
): CommitSelection | null {
  const selected = files.filter((file) => !excluded.has(file.path));
  if (selected.length === 0) return null;
  return selected.length === files.length
    ? { kind: "all" }
    : commitSelection.parse({
        kind: "paths",
        paths: selected.map((file) => file.path),
      });
}

export type CommitDraft = {
  message: string;
  edited: boolean;
  generation: "running" | "generated" | "failed";
};
export type CommitDraftEvent =
  | { kind: "edit"; message: string }
  | { kind: "generated"; message: string }
  | { kind: "failed" }
  | { kind: "selection_changed" };
export const initialCommitDraft: CommitDraft = {
  message: "",
  edited: false,
  generation: "running",
};
export function updateCommitDraft(
  draft: CommitDraft,
  event: CommitDraftEvent,
): CommitDraft {
  switch (event.kind) {
    case "selection_changed":
      return {
        ...draft,
        message: draft.edited ? draft.message : "",
        generation: "running",
      };
    case "edit":
      return { ...draft, edited: true, message: event.message };
    case "generated":
      return {
        ...draft,
        message: draft.edited ? draft.message : event.message,
        generation: "generated",
      };
    case "failed":
      return { ...draft, generation: "failed" };
  }
}
export function startCommitPreview({
  threadId,
  selection,
  api,
  onGenerated,
  onFailed,
}: {
  threadId: string;
  selection: CommitSelection;
  api: {
    beginCommitMessage: (
      threadId: string,
      selection: CommitSelection,
    ) => Promise<string>;
    awaitCommitMessage: (job: string) => Promise<string>;
    cancelCommitMessage: (job: string) => Promise<unknown>;
  };
  onGenerated: (message: string) => void;
  onFailed: () => void;
}): () => void {
  let stopped = false;
  let job: string | undefined;
  const cancel = () => {
    if (job) void api.cancelCommitMessage(job).catch(() => {});
  };
  void api
    .beginCommitMessage(threadId, selection)
    .then(async (id) => {
      job = id;
      if (stopped) {
        cancel();
        return;
      }
      const message = await api.awaitCommitMessage(id);
      if (!stopped) onGenerated(message);
    })
    .catch(() => {
      if (!stopped) onFailed();
    });
  return () => {
    stopped = true;
    cancel();
  };
}
