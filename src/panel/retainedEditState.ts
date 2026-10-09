import {
  EditStateManager,
  type Editor,
  type EditorType,
} from "@pierre/diffs/edit";
import type { CheckoutRef } from "../ipc";

export function fileEditStateKey(
  { workspaceId, threadId }: CheckoutRef,
  path: string,
): string {
  return JSON.stringify(["file", workspaceId, threadId ?? null, path]);
}

export const isFileEditor = <LAnnotation, Caret>(
  editor: Editor<EditorType, LAnnotation, Caret>,
): editor is Editor<"file", LAnnotation, Caret> => editor.type === "file";

export type EditStateClaim =
  /** No retained document: the editor starts from `contents`. */
  | "fresh"
  /** The retained document already matched `contents`. */
  | "kept"
  /** The retained document changed while hidden. It now shows `contents`, and one undo returns it. */
  | "replaced"
  /** Another editor holds the key. Mount without it. */
  | "busy"
  /** Reconciling threw. The retained session is discarded. Mount without the key. */
  | "failed";

/**
 * Claims `key` for `owner` before it attaches, from the EditProvider factory.
 * Pierre would otherwise show a retained document over newer contents, and the
 * next keystroke would save the stale text. A changed document gets the same
 * undoable whole-document replace pierre applies when a mounted editor receives
 * new contents. Pierre's `edit` then re-activates the key for the same owner and
 * reuses the session.
 */
export function claimFileEditState<LAnnotation, Caret>(
  owner: Editor<"file", LAnnotation, Caret>,
  key: string,
  contents: string,
): EditStateClaim {
  let session;
  try {
    session = EditStateManager.activate("file", key, owner);
  } catch {
    return "busy";
  }
  const document = session.document;
  if (document === undefined) return "fresh";
  const text = document.getText();
  if (text === contents) return "kept";
  try {
    document.applyResolvedEdits(
      [{ start: 0, end: text.length, text: contents }],
      true,
      session.editor?.selections,
      undefined,
      true,
    );
  } catch {
    EditStateManager.releaseFile(key, owner, true);
    return "failed";
  }
  if (session.editor) session.editor.selections = undefined;
  return "replaced";
}
