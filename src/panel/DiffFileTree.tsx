// Copied from pingdotgg/t3code v0.0.45 components/diffs/DiffFileTree.tsx (MIT).
import type {
  FileTreeDirectoryHandle,
  FileTreeSortComparator,
  GitStatus,
} from "@pierre/trees";
import {
  FileTree,
  useFileTree,
  useFileTreeSelector,
} from "@pierre/trees/react";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/controls";
import { T3_PIERRE_ICONS } from "./FileEntryIcon";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "./surfaceCss";
import { useResolvedTheme } from "./useResolvedTheme";

export type DiffFileTreeEntry = { path: string; status: GitStatus };

type TreeModel = ReturnType<typeof useFileTree>["model"];

function directoryPathsOf(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    let directory = "";
    for (const segment of path.split("/").slice(0, -1)) {
      directory += `${segment}/`;
      directories.add(directory);
    }
  }
  return [...directories];
}

function diffFileTreePositions(
  paths: readonly string[],
): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  paths.forEach((path, index) => {
    positions.set(path, index);
    let directory = "";
    for (const segment of path.split("/").slice(0, -1)) {
      directory += `${segment}/`;
      if (!positions.has(directory)) positions.set(directory, index);
    }
  });
  return positions;
}

const directoryItem = (
  model: TreeModel,
  path: string,
): FileTreeDirectoryHandle | null => {
  const item = model.getItem(path);
  return item && "expand" in item ? item : null;
};

export function DiffFileTree({
  entries,
  selectedPath,
  onSelectFile,
}: {
  entries: readonly DiffFileTreeEntry[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}) {
  const theme = useResolvedTheme();
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const directories = useMemo(() => directoryPathsOf(paths), [paths]);
  const pathsRef = useRef<ReadonlySet<string>>(new Set(paths));
  pathsRef.current = new Set(paths);
  const onSelectRef = useRef(onSelectFile);
  onSelectRef.current = onSelectFile;
  const syncing = useRef(false);
  const [ordering] = useState(() => {
    let positions: ReadonlyMap<string, number> = new Map();
    const sort: FileTreeSortComparator = (left, right) =>
      (positions.get(left.path) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(right.path) ?? Number.MAX_SAFE_INTEGER) ||
      left.depth - right.depth ||
      left.path.localeCompare(right.path);
    return {
      sort,
      update: (next: ReadonlyMap<string, number>) => {
        positions = next;
      },
    };
  });

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selected) => {
      if (syncing.current) return;
      const path = selected.at(-1)?.replace(/\/$/, "");
      if (path && pathsRef.current.has(path)) onSelectRef.current(path);
    },
    paths: [],
    search: false,
    sort: ordering.sort,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const allExpanded = useFileTreeSelector(model, (current) =>
    directories.every(
      (path) => directoryItem(current, path)?.isExpanded() !== false,
    ),
  );

  useEffect(() => {
    ordering.update(diffFileTreePositions(paths));
    syncing.current = true;
    model.resetPaths(paths);
    model.setGitStatus(
      entries.map((entry) => ({ path: entry.path, status: entry.status })),
    );
    syncing.current = false;
  }, [entries, model, ordering, paths]);

  useEffect(() => {
    if (!selectedPath) return;
    const item = model.getItem(selectedPath);
    if (!item || item.isDirectory() || item.isSelected()) return;
    syncing.current = true;
    for (const path of model.getSelectedPaths())
      if (path !== selectedPath) model.getItem(path)?.deselect();
    item.select();
    model.scrollToPath(selectedPath, { offset: "nearest" });
    queueMicrotask(() => {
      syncing.current = false;
    });
  }, [model, paths, selectedPath]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <span className="px-1 font-medium text-foreground">Files</span>
        <span className="ml-auto tabular-nums">{entries.length}</span>
        {directories.length > 0 ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={
              allExpanded ? "Collapse all folders" : "Expand all folders"
            }
            title={allExpanded ? "Collapse all folders" : "Expand all folders"}
            onClick={() => {
              for (const path of directories) {
                const item = directoryItem(model, path);
                if (allExpanded) item?.collapse();
                else item?.expand();
              }
            }}
          >
            {allExpanded ? (
              <ChevronsDownUpIcon className="size-3.5" />
            ) : (
              <ChevronsUpDownIcon className="size-3.5" />
            )}
          </Button>
        ) : null}
      </div>
      <FileTree
        model={model}
        aria-label="Changed files"
        onClickCapture={(event) => {
          if (
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          )
            return;
          // Pierre emits no selection change for its sole selected row; re-reveal on that click.
          const selected = model.getSelectedPaths();
          const path = selected.length === 1 ? selected[0] : undefined;
          if (!path || !pathsRef.current.has(path)) return;
          const onSelectedRow = event.nativeEvent
            .composedPath()
            .some(
              (node) =>
                node instanceof HTMLElement &&
                node.getAttribute("data-item-path") === path,
            );
          if (onSelectedRow) onSelectRef.current(path);
        }}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(theme)}
      />
    </div>
  );
}
