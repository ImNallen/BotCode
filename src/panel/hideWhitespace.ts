// Copied from pingdotgg/t3code v0.0.45 apps/web/src/lib/diffRendering.ts (MIT).
import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";

export function hideWhitespaceChanges(
  file: FileDiffMetadata,
): FileDiffMetadata {
  let splitDelta = 0;
  let unifiedDelta = 0;
  const hunks = file.hunks.map((hunk) => {
    const oldContents = file.deletionLines
      .slice(
        hunk.deletionLineIndex,
        hunk.deletionLineIndex + hunk.deletionCount,
      )
      .map((line) => `${line.replace(/\s/g, "")}\n`)
      .join("");
    const newContents = file.additionLines
      .slice(
        hunk.additionLineIndex,
        hunk.additionLineIndex + hunk.additionCount,
      )
      .map((line) => `${line.replace(/\s/g, "")}\n`)
      .join("");
    const filtered = parseDiffFromFile(
      { name: file.name, contents: oldContents },
      { name: file.name, contents: newContents },
      { context: Infinity },
    ).hunks[0];
    const next = {
      ...hunk,
      additionLines: filtered?.additionLines ?? 0,
      deletionLines: filtered?.deletionLines ?? 0,
      hunkContent: filtered
        ? filtered.hunkContent.map((content) => ({
            ...content,
            additionLineIndex:
              content.additionLineIndex + hunk.additionLineIndex,
            deletionLineIndex:
              content.deletionLineIndex + hunk.deletionLineIndex,
          }))
        : [
            {
              type: "context" as const,
              lines: hunk.additionCount,
              additionLineIndex: hunk.additionLineIndex,
              deletionLineIndex: hunk.deletionLineIndex,
            },
          ],
      splitLineStart: hunk.splitLineStart + splitDelta,
      unifiedLineStart: hunk.unifiedLineStart + unifiedDelta,
      splitLineCount: filtered?.splitLineCount ?? hunk.additionCount,
      unifiedLineCount: filtered?.unifiedLineCount ?? hunk.additionCount,
    };
    splitDelta += next.splitLineCount - hunk.splitLineCount;
    unifiedDelta += next.unifiedLineCount - hunk.unifiedLineCount;
    return next;
  });
  return {
    ...file,
    hunks,
    splitLineCount: file.splitLineCount + splitDelta,
    unifiedLineCount: file.unifiedLineCount + unifiedDelta,
    ...(file.cacheKey
      ? { cacheKey: `${file.cacheKey}:ignore-whitespace` }
      : {}),
  };
}
