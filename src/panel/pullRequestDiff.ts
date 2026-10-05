// Annotation sides follow pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/PullRequestCodeTab.tsx (MIT).
import {
  processFile,
  type AnnotationSide,
  type DiffLineAnnotation,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { DraftComment, PrReviewDetail } from "./prReview";

type PrFile = PrReviewDetail["files"][number];
export type CommentTarget = Pick<DraftComment, "side" | "line">;
export type DraftLine = { ids: readonly string[] };

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

function gitHeader({ path, status }: PrFile): string {
  const [from, to] = [`a/${path}`, `b/${path}`];
  switch (status) {
    case "added":
      return `diff --git ${from} ${to}\nnew file mode 100644\n--- /dev/null\n+++ ${to}\n`;
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

export function pullRequestCodeFile(file: PrFile): PullRequestCodeFile {
  if (file.unavailable)
    return { kind: "unavailable", file, reason: file.unavailable };
  if (file.patch === null)
    return { kind: "unavailable", file, reason: "Patch unavailable." };
  let fileDiff: FileDiffMetadata | undefined;
  try {
    fileDiff = processFile(`${gitHeader(file)}${file.patch}\n`, {
      isGitDiff: true,
      throwOnError: true,
    });
  } catch {
    fileDiff = undefined;
  }
  if (!fileDiff?.hunks.length)
    return {
      kind: "unavailable",
      file,
      reason:
        "This patch could not be displayed. Line comments are unavailable.",
    };
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
