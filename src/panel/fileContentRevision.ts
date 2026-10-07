// Copied from pingdotgg/t3code v0.0.45 components/files/fileContentRevision.ts (MIT).
import type { CheckoutRef } from "../ipc";

function fileContentRevision(contents: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < contents.length; index += 1) {
    hash ^= contents.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${contents.length}:${(hash >>> 0).toString(36)}`;
}

export interface EditorFileIdentity {
  readonly cacheKey: string;
  readonly contents: string;
}

export function fileEditorCacheKey(
  { workspaceId, threadId }: CheckoutRef,
  path: string,
  contents: string,
  editorFile: EditorFileIdentity | undefined,
): string {
  if (editorFile?.contents === contents) return editorFile.cacheKey;
  return `editor:${workspaceId}:${threadId ?? ""}:${path}:${fileContentRevision(contents)}`;
}
