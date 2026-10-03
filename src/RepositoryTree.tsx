import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
export function RepositoryTree({
  paths,
  onSelect,
}: {
  paths: string[];
  onSelect: (path: string) => void;
}) {
  const latest = useRef({ paths, onSelect });
  useLayoutEffect(() => {
    latest.current = { paths, onSelect };
  }, [paths, onSelect]);
  const initial = useMemo(
    () => ({
      paths,
      initialExpansion: 1,
      onSelectionChange: (selected: readonly string[]) => {
        const path = selected.at(-1);
        if (path && latest.current.paths.includes(path))
          latest.current.onSelect(path);
      },
    }),
    [],
  );
  const { model } = useFileTree(initial);
  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);
  return (
    <FileTree
      model={model}
      aria-label="Repository files"
      className="file-tree"
    />
  );
}
