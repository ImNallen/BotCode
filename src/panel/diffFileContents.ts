// Ported from pingdotgg/t3code v0.0.45 apps/web/src/lib/diffFileContents.ts (MIT).
import type { FileDiffContentsLoader } from "@pierre/diffs";
import type { PrFileContents, PrReviewDetail } from "./prReview";

export function createPullRequestDiffFileContentsLoader(
  load: (sourceId: string) => Promise<PrFileContents>,
  files: PrReviewDetail["files"],
  cacheKey: string,
): FileDiffContentsLoader {
  const sources = new Map(files.map((file) => [file.path, file]));
  return async (fileDiff) => {
    const file = sources.get(fileDiff.name);
    const source = file?.contentsSource;
    if (!file || !source)
      throw new Error(
        "Exact file revisions are unavailable. Refresh this pull request.",
      );
    const newPath = file.path;
    const oldPath = file.previousPath ?? newPath;
    const contents = await load(source.id);
    const comparison = `${cacheKey}:${source.oldOid ?? "root"}:${source.newOid}:${oldPath}:${newPath}`;
    const newFile = {
      name: newPath,
      contents: contents.newContents,
      cacheKey: `${comparison}:new:${newPath}`,
    };
    if (fileDiff.type === "rename-pure") return { oldFile: null, newFile };
    return {
      oldFile: {
        name: oldPath,
        contents: contents.oldContents,
        cacheKey: `${comparison}:old:${oldPath}`,
      },
      newFile,
    };
  };
}
