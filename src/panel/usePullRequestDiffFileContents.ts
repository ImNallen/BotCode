import type { FileDiffContentsLoader } from "@pierre/diffs";
import { useMemo, useRef, useState } from "react";
import { createPullRequestDiffFileContentsLoader } from "./diffFileContents";
import type { PrFileContents, PrReviewDetail } from "./prReview";

export function usePullRequestDiffFileContents(
  load: ((sourceId: string) => Promise<PrFileContents>) | undefined,
  files: PrReviewDetail["files"],
  cacheKey: string,
) {
  const loader = useMemo(
    () =>
      load && createPullRequestDiffFileContentsLoader(load, files, cacheKey),
    [load, files, cacheKey],
  );
  const owner = useRef(loader);
  owner.current = loader;
  const [failure, setFailure] = useState<{
    owner: FileDiffContentsLoader | undefined;
    errors: ReadonlyMap<string, string>;
  }>({ owner: loader, errors: new Map() });
  const loadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(
    () =>
      loader &&
      (async (fileDiff) => {
        try {
          const contents = await loader(fileDiff);
          if (owner.current === loader) {
            setFailure((current) => {
              if (
                current.owner !== loader ||
                !current.errors.has(fileDiff.name)
              )
                return current;
              const errors = new Map(current.errors);
              errors.delete(fileDiff.name);
              return { owner: loader, errors };
            });
          }
          return contents;
        } catch (error) {
          if (owner.current === loader) {
            setFailure((current) => {
              const errors = new Map(
                current.owner === loader ? current.errors : [],
              );
              errors.set(
                fileDiff.name,
                error instanceof Error ? error.message : String(error),
              );
              return { owner: loader, errors };
            });
          }
          throw error;
        }
      }),
    [loader],
  );
  return {
    loadDiffFiles,
    errors:
      failure.owner === loader ? failure.errors : new Map<string, string>(),
  };
}
