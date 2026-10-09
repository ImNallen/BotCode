// Annotation sides follow pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/PullRequestCodeTab.tsx (MIT).
import {
  processFile,
  type AnnotationSide,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import type { DraftComment, PrReviewDetail } from "./prReview";

type PrFile = PrReviewDetail["files"][number];
export type CommentTarget = Pick<DraftComment, "side" | "line">;
export type DraftLine = {
  ids: readonly string[];
  threads?: readonly PrReviewDetail["findings"][number][];
};

export type PullRequestCodeFile =
  | {
      kind: "diff";
      file: PrFile;
      fileDiff: FileDiffMetadata;
      targets: ReadonlyMap<string, CommentTarget>;
    }
  | { kind: "unavailable"; file: PrFile; reason: string };

export const lineKey = (side: AnnotationSide, line: number) =>
  `${side}:${line}`;

const viewerSide = (side: DraftComment["side"]): AnnotationSide =>
  side === "LEFT" ? "deletions" : "additions";

function quoteGitPath(path: string): string {
  const escapes: Record<string, string> = {
    '"': '\\"',
    "\\": "\\\\",
    "\t": "\\t",
    "\n": "\\n",
    "\r": "\\r",
    "\b": "\\b",
    "\f": "\\f",
    "\v": "\\v",
    "\u0007": "\\a",
  };
  const body = path.replace(
    /["\\\x00-\x1f\x7f]/g,
    (character) =>
      escapes[character] ??
      `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
  return body === path ? path : `"${body}"`;
}

// Ported from T3's diffRendering.ts patch identity.
function patchCacheKey(patch: string): string {
  const hash = (seed: number, multiplier: number) => {
    let value = seed;
    for (let index = 0; index < patch.length; index += 1) {
      value = Math.imul(value ^ patch.charCodeAt(index), multiplier) >>> 0;
    }
    return value.toString(36);
  };
  return `${patch.length}:${hash(0x811c9dc5, 0x01000193)}:${hash(0x9e3779b9, 0x85ebca6b)}`;
}

function gitHeader({
  path,
  previousPath,
  status,
  additions,
  deletions,
}: PrFile): string {
  const [from, to] = [
    quoteGitPath(`a/${previousPath ?? path}`),
    quoteGitPath(`b/${path}`),
  ];
  switch (status) {
    case "added":
      return `diff --git ${from} ${to}\nnew file mode 100644\n--- /dev/null\n+++ ${to}\n`;
    case "renamed":
      return `diff --git ${from} ${to}\n${additions === 0 && deletions === 0 ? "similarity index 100%\n" : ""}rename from ${quoteGitPath(previousPath ?? path)}\nrename to ${quoteGitPath(path)}\n--- ${from}\n+++ ${to}\n`;
    case "removed":
      return `diff --git ${from} ${to}\ndeleted file mode 100644\n--- ${from}\n+++ /dev/null\n`;
    default:
      return `diff --git ${from} ${to}\n--- ${from}\n+++ ${to}\n`;
  }
}

// GitHub accepts a review comment only on a line it returned as an anchor. A context row in the
// old column is the same source line as its new-side anchor, so it comments there.
function commentTargets(
  file: PrFile,
  patch: string,
): Map<string, CommentTarget> {
  const anchors = new Set(file.anchors.map((a) => `${a.side}:${a.line}`));
  const targets = new Map<string, CommentTarget>();
  const offer = (side: AnnotationSide, line: number, target: CommentTarget) => {
    if (anchors.has(`${target.side}:${target.line}`))
      targets.set(lineKey(side, line), target);
  };
  let position: { left: number; right: number } | null = null;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      position = { left: Number(hunk[1]), right: Number(hunk[2]) };
      continue;
    }
    if (!position) continue;
    switch (text[0]) {
      case "-":
        offer("deletions", position.left, {
          side: "LEFT",
          line: position.left,
        });
        position.left += 1;
        break;
      case "+":
        offer("additions", position.right, {
          side: "RIGHT",
          line: position.right,
        });
        position.right += 1;
        break;
      case " ": {
        const target = { side: "RIGHT", line: position.right } as const;
        offer("additions", position.right, target);
        offer("deletions", position.left, target);
        position.left += 1;
        position.right += 1;
        break;
      }
    }
  }
  return targets;
}

export function pullRequestCodeFile(
  file: PrFile,
  cacheScope = "pr-code",
): PullRequestCodeFile {
  if (file.unavailable)
    return { kind: "unavailable", file, reason: file.unavailable };
  if (file.patch === null)
    return { kind: "unavailable", file, reason: "Patch unavailable." };
  let fileDiff: FileDiffMetadata | undefined;
  try {
    const patch = `${gitHeader(file)}${file.patch}\n`;
    const source = file.contentsSource;
    fileDiff = processFile(patch, {
      cacheKey: `${cacheScope}:${source?.oldOid ?? "root"}:${source?.newOid ?? "unknown"}:${patchCacheKey(patch)}`,
      isGitDiff: true,
      throwOnError: true,
    });
  } catch {
    fileDiff = undefined;
  }
  if (!fileDiff || (!fileDiff.hunks.length && fileDiff.type !== "rename-pure"))
    return {
      kind: "unavailable",
      file,
      reason:
        "This patch could not be displayed. Line comments are unavailable.",
    };
  // Pierre keeps Git escapes on some parsed names. PR metadata owns the literal paths.
  fileDiff = {
    ...fileDiff,
    name: file.path,
    prevName: file.previousPath ?? file.path,
  };
  if (file.status === "renamed" && file.previousPath && fileDiff.hunks.length) {
    fileDiff = {
      ...fileDiff,
      type: "rename-changed",
      prevName: file.previousPath,
    };
  }
  return {
    kind: "diff",
    file,
    fileDiff,
    targets: commentTargets(file, file.patch),
  };
}

export function draftAnnotations(
  comments: readonly DraftComment[],
  path: string,
): DiffLineAnnotation<DraftLine>[] {
  const lines = new Map<string, DiffLineAnnotation<DraftLine>>();
  for (const comment of comments) {
    if (comment.path !== path) continue;
    const side = viewerSide(comment.side);
    const key = lineKey(side, comment.line);
    const existing = lines.get(key);
    lines.set(key, {
      side,
      lineNumber: comment.line,
      metadata: { ids: [...(existing?.metadata.ids ?? []), comment.id] },
    });
  }
  return [...lines.values()];
}

// Ported from pingdotgg/t3code v0.0.45 pullRequestDiff.logic.ts (MIT).
export function isLineInFileDiff(
  file: FileDiffMetadata,
  side: "LEFT" | "RIGHT",
  line: number,
) {
  return file.hunks.some((hunk) =>
    side === "LEFT"
      ? line >= hunk.deletionStart &&
        line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart &&
        line < hunk.additionStart + hunk.additionCount,
  );
}
export function conversationAnnotations(
  comments: readonly DraftComment[],
  entries: PrReviewDetail["findings"],
  file: PullRequestCodeFile & { kind: "diff" },
) {
  const groups = new Map(
    draftAnnotations(comments, file.file.path).map((annotation) => [
      lineKey(annotation.side ?? "additions", annotation.lineNumber),
      annotation,
    ]),
  );
  for (const entry of entries) {
    const location = entry.threadLocation;
    if (
      entry.finding.source.kind !== "thread" ||
      !location ||
      location.line === null ||
      location.path !== file.file.path ||
      !isLineInFileDiff(file.fileDiff, location.side, location.line)
    )
      continue;
    const side = viewerSide(location.side);
    const key = lineKey(side, location.line);
    const existing = groups.get(key);
    groups.set(key, {
      side,
      lineNumber: location.line,
      metadata: {
        ids: existing?.metadata.ids ?? [],
        threads: [...(existing?.metadata.threads ?? []), entry],
      },
    });
  }
  return [...groups.values()];
}

export function resolveCommentSelection(
  file: PullRequestCodeFile & { kind: "diff" },
  range: SelectedLineRange,
): (CommentTarget & { startLine?: number }) | null {
  const side = range.side;
  if (!side || (range.endSide !== undefined && range.endSide !== side))
    return null;
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0)
    return null;
  const original = pullRequestCodeFile(file.file);
  if (original.kind !== "diff") return null;
  const hunk = original.fileDiff.hunks.find((h) => {
    const first = side === "deletions" ? h.deletionStart : h.additionStart;
    const count = side === "deletions" ? h.deletionCount : h.additionCount;
    return start >= first && end < first + count;
  });
  if (!hunk) return null;
  let first: CommentTarget | undefined;
  for (let line = start; line <= end; line += 1) {
    const target = original.targets.get(lineKey(side, line));
    if (!target) return null;
    first ??= target;
    if (target.side !== first.side || target.line !== first.line + line - start)
      return null;
  }
  return first
    ? {
        side: first.side,
        line: first.line + end - start,
        ...(start < end ? { startLine: first.line } : {}),
      }
    : null;
}

export const commentLineLabel = (
  comment: Pick<DraftComment, "line" | "startLine">,
) =>
  comment.startLine === undefined
    ? `${comment.line}`
    : `${comment.startLine}-${comment.line}`;
