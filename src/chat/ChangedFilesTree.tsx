// Ported from T3 Code v0.0.45 apps/web/src/components/chat/ChangedFilesTree.tsx (MIT).
import { memo, useCallback, useMemo, useState, type MouseEvent } from "react";
import type { TurnDiffFile } from "../ipc";
import {
  buildTurnDiffTree,
  summarizeTurnDiffStats,
  type TurnDiffTreeNode,
} from "../lib/turnDiffTree";
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderIcon,
  FolderClosedIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import { DiffStatLabel } from "../panel/chrome";
import { FileEntryIcon } from "../panel/FileEntryIcon";
import { Button } from "../ui/controls";

const hasNonZeroStat = (stat: { additions: number; deletions: number }) =>
  stat.additions > 0 || stat.deletions > 0;

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

export type FileContextMenuHandler = (
  path: string,
  event: MouseEvent<HTMLElement>,
) => void;

export const ChangedFilesCard = memo(function ChangedFilesCard(props: {
  turnId: string;
  files: ReadonlyArray<TurnDiffFile>;
  allDirectoriesExpanded: boolean;
  onToggleAllDirectories: () => void;
  onOpenTurnDiff: (turnId: string, filePath?: string) => void;
  onFileContextMenu?: FileContextMenuHandler;
}) {
  const {
    turnId,
    files,
    allDirectoriesExpanded,
    onToggleAllDirectories,
    onOpenTurnDiff,
    onFileContextMenu,
  } = props;
  const summaryStat = useMemo(() => summarizeTurnDiffStats(files), [files]);
  const hasDirectories = files.some((file) => /[/\\]/.test(file.path));

  return (
    <div
      className="@container/changed-files mt-4 rounded-lg bg-secondary dark:bg-input/20"
      data-changed-files-state="tree"
    >
      <div
        data-changed-files-header=""
        className="sticky top-2 z-10 flex items-center justify-between gap-2 rounded-t-lg bg-secondary px-3 py-2 dark:bg-background dark:bg-linear-to-b dark:from-input/20 dark:to-input/20"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-foreground">
          <span>
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          {hasNonZeroStat(summaryStat) && (
            <DiffStatLabel
              additions={summaryStat.additions}
              deletions={summaryStat.deletions}
              className="text-xs leading-4"
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasDirectories && (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-muted"
              aria-label={
                allDirectoriesExpanded
                  ? "Collapse all folders"
                  : "Expand all folders"
              }
              data-scroll-anchor-ignore
              onClick={onToggleAllDirectories}
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3" />
              ) : (
                <ChevronsUpDownIcon className="size-3" />
              )}
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label="Open diff"
            onClick={() => onOpenTurnDiff(turnId, files[0]?.path)}
          >
            <FileDiffIcon className="size-3" />
            <span className="hidden @[24rem]/changed-files:inline">
              Open diff
            </span>
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`${turnId}:${allDirectoriesExpanded}`}
        turnId={turnId}
        files={files}
        allDirectoriesExpanded={allDirectoriesExpanded}
        onOpenTurnDiff={onOpenTurnDiff}
        onFileContextMenu={onFileContextMenu}
      />
    </div>
  );
});

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  turnId: string;
  files: ReadonlyArray<TurnDiffFile>;
  allDirectoriesExpanded: boolean;
  onOpenTurnDiff: (turnId: string, filePath?: string) => void;
  onFileContextMenu?: FileContextMenuHandler;
}) {
  const {
    files,
    allDirectoriesExpanded,
    onOpenTurnDiff,
    onFileContextMenu,
    turnId,
  } = props;
  const treeNodes = useMemo(() => buildTurnDiffTree(files), [files]);
  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\u0000"),
    [treeNodes],
  );
  const hasDirectoryNodes = directoryPathsKey.length > 0;
  const expansionStateKey = `${allDirectoriesExpanded ? "expanded" : "collapsed"}\u0000${directoryPathsKey}`;
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string;
    overrides: Record<string, boolean>;
  }>(() => ({
    key: expansionStateKey,
    overrides: {},
  }));
  const expandedDirectories =
    directoryExpansionState.key === expansionStateKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;

  const toggleDirectory = useCallback(
    (pathValue: string) => {
      setDirectoryExpansionState((current) => {
        const nextOverrides =
          current.key === expansionStateKey ? current.overrides : {};
        return {
          key: expansionStateKey,
          overrides: {
            ...nextOverrides,
            [pathValue]: !(nextOverrides[pathValue] ?? allDirectoriesExpanded),
          },
        };
      });
    },
    [allDirectoriesExpanded, expansionStateKey],
  );

  const renderTreeNode = (node: TurnDiffTreeNode, depth: number) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded =
        expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            data-scroll-anchor-ignore
            aria-expanded={isExpanded}
            className="group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
                isExpanded && "rotate-90",
              )}
            />
            {isExpanded ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            ) : (
              <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            )}
            <span className="truncate font-mono text-2xs text-muted-foreground/90 group-hover:text-foreground/90">
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) && (
              <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
                <DiffStatLabel
                  additions={node.stat.additions}
                  deletions={node.stat.deletions}
                />
              </span>
            )}
          </button>
          {isExpanded && (
            <div>
              {node.children.map((childNode) =>
                renderTreeNode(childNode, depth + 1),
              )}
            </div>
          )}
        </div>
      );
    }

    return (
      <button
        key={`file:${node.path}`}
        type="button"
        className="group flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenTurnDiff(turnId, node.path)}
        onContextMenu={
          onFileContextMenu
            ? (event) => onFileContextMenu(node.path, event)
            : undefined
        }
      >
        {hasDirectoryNodes || depth > 0 ? (
          <span aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        <FileEntryIcon
          path={node.path}
          kind="file"
          className="size-3.5 text-muted-foreground/70"
        />
        <span className="flex min-w-0 font-mono text-xs text-foreground/85 group-hover:text-foreground">
          <span className="truncate">{node.name}</span>
        </span>
        {node.stat && (
          <span className="ml-auto shrink-0 font-mono text-3xs tabular-nums">
            <DiffStatLabel
              additions={node.stat.additions}
              deletions={node.stat.deletions}
            />
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="p-2">
      {treeNodes.map((node) => renderTreeNode(node, 0))}
    </div>
  );
});

function collectDirectoryPaths(
  nodes: ReadonlyArray<TurnDiffTreeNode>,
): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}
