// Ported from T3 Code v0.0.45 apps/web/src/components/files/fileCommentAnnotations.ts (MIT).
import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type { ComposerContextRecord } from "../chat/composerContext";
import {
  buildFileReviewContext,
  type ComposerReviewContext,
} from "./composerReviewContext";

export interface FileCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  startLine: number;
  endLine: number;
  text: string;
}

export interface FileCommentAnnotationGroup {
  entries: FileCommentAnnotationEntry[];
}

export type FileCommentLineAnnotation =
  LineAnnotation<FileCommentAnnotationGroup>;

export type FileCommentDraftAnchor = {
  readonly id: string;
  readonly startLine: number;
  readonly endLine: number;
};

let fileCommentSequence = 0;

export function nextFileCommentId(): string {
  fileCommentSequence += 1;
  return `file-comment-${Date.now()}-${fileCommentSequence}`;
}

export function normalizeFileCommentRange(range: SelectedLineRange): {
  startLine: number;
  endLine: number;
} {
  return {
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}

export function formatFileCommentRange(
  startLine: number,
  endLine: number,
): string {
  return startLine === endLine
    ? `L${startLine}`
    : `L${startLine} to L${endLine}`;
}

export function remapFileCommentAnnotations(
  annotations: ReadonlyArray<FileCommentLineAnnotation>,
): FileCommentLineAnnotation[] {
  return annotations.map((annotation) => ({
    ...annotation,
    metadata: {
      entries: annotation.metadata.entries.map((entry) => {
        const lineCount = entry.endLine - entry.startLine;
        return {
          ...entry,
          endLine: annotation.lineNumber,
          startLine: Math.max(1, annotation.lineNumber - lineCount),
        };
      }),
    },
  }));
}

export function savedFileComments(
  records: readonly ComposerContextRecord[],
  path: string,
): ComposerReviewContext[] {
  return records.filter(
    (record): record is ComposerReviewContext =>
      record.kind === "review-comment" && record.sectionId === `file:${path}`,
  );
}

export function fileCommentAnnotations(
  saved: readonly ComposerReviewContext[],
  draft: FileCommentDraftAnchor | null,
): FileCommentLineAnnotation[] {
  const entries: FileCommentAnnotationEntry[] = saved.map((record) => ({
    id: record.contextId,
    kind: "comment",
    startLine: record.startIndex + 1,
    endLine: record.endIndex + 1,
    text: record.text,
  }));
  if (draft) entries.push({ ...draft, kind: "draft", text: "" });
  const groups = new Map<number, FileCommentAnnotationEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.endLine);
    if (group) group.push(entry);
    else groups.set(entry.endLine, [entry]);
  }
  return Array.from(groups, ([lineNumber, group]) => ({
    lineNumber,
    metadata: { entries: group },
  }));
}

/**
 * The saved comments an edit moved, rebuilt at their new lines with the excerpt
 * from `contents`. Ids without a saved record are ignored, so an undo that
 * restores the annotations of a sent or deleted comment cannot bring it back.
 * A comment whose anchor line was deleted is absent from `moved` and stays as saved.
 */
export function applyMovedAnnotations(
  saved: readonly ComposerReviewContext[],
  moved: ReadonlyArray<FileCommentLineAnnotation>,
  contents: string,
): ComposerReviewContext[] {
  const records = new Map(saved.map((record) => [record.contextId, record]));
  const changed: ComposerReviewContext[] = [];
  for (const annotation of remapFileCommentAnnotations(moved))
    for (const entry of annotation.metadata.entries) {
      const record = entry.kind === "comment" && records.get(entry.id);
      if (
        !record ||
        (record.startIndex === entry.startLine - 1 &&
          record.endIndex === entry.endLine - 1)
      )
        continue;
      records.delete(entry.id);
      changed.push(
        buildFileReviewContext({
          contextId: record.contextId,
          filePath: record.filePath,
          startLine: entry.startLine,
          endLine: entry.endLine,
          text: record.text,
          contents,
        }),
      );
    }
  return changed;
}

export function movedFileCommentDraft(
  draft: FileCommentDraftAnchor | null,
  moved: ReadonlyArray<FileCommentLineAnnotation>,
): FileCommentDraftAnchor | null {
  if (!draft) return null;
  const entry = remapFileCommentAnnotations(moved)
    .flatMap((annotation) => annotation.metadata.entries)
    .find(
      (candidate) => candidate.kind === "draft" && candidate.id === draft.id,
    );
  if (!entry) return null;
  return entry.startLine === draft.startLine && entry.endLine === draft.endLine
    ? draft
    : { id: draft.id, startLine: entry.startLine, endLine: entry.endLine };
}
