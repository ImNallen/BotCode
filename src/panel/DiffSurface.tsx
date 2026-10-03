// Diff surface copied from pingdotgg/t3code v0.0.45 components/DiffPanel.tsx, DiffPanelShell.tsx,
// diffs/StyledDiffCodeView.tsx, DiffFilePathCopyButton.tsx and lib/diffRendering.ts (MIT).
import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewItem,
} from "@pierre/diffs/react";
import {
  useIsFetching,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  CopyIcon,
  FolderTreeIcon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { checkoutKey, ipc, type CheckoutRef, type WorkspaceView } from "../ipc";
import { cn } from "../lib/cn";
import { Menu } from "../ui/menu";
import { Button, Toggle } from "../ui/controls";
import {
  DiffStatLabel,
  MenuRadioItem,
  RefreshIcon,
  SegmentedGroup,
  storedFlag,
  useStoredState,
} from "./chrome";
import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";
import { WORD_WRAP_KEY } from "./FilesSurface";
import { hideWhitespaceChanges } from "./hideWhitespace";
import { DIFF_VIEW_UNSAFE_CSS } from "./surfaceCss";
import { useResolvedTheme } from "./useResolvedTheme";

type Change = WorkspaceView["changes"][number];
type Basis = "staged" | "unstaged";

const SCOPES = {
  working: { label: "Working tree" },
  unstaged: { label: "Unstaged" },
  staged: { label: "Staged" },
} as const;
type Scope = keyof typeof SCOPES;
const parseScope = (raw: string | null): Scope =>
  raw === "unstaged" || raw === "staged" ? raw : "working";

type DiffSide = { name: string; contents: string } | null;
type DiffFile = { path: string; fileDiff: FileDiffMetadata; version: number };

function plan(scope: Scope, change: Change): Basis[] {
  if (scope === "staged") return change.staged ? ["staged"] : [];
  if (scope === "unstaged") return change.unstaged ? ["unstaged"] : [];
  return change.status === "??" ? ["unstaged"] : ["staged", "unstaged"];
}

type DiffText = Extract<Awaited<ReturnType<typeof ipc.diff>>, { kind: "text" }>;

function sides(
  scope: Scope,
  change: Change,
  texts: Partial<Record<Basis, DiffText>>,
): { old: DiffSide; next: DiffSide } | null {
  const [x, y] = [change.status[0], change.status[1]];
  const untracked = change.status === "??";
  const from =
    scope === "unstaged" ? texts.unstaged : untracked ? null : texts.staged;
  const to = scope === "staged" ? texts.staged : texts.unstaged;
  if (from === undefined || to === undefined) return null;
  const added =
    scope === "staged"
      ? x === "A"
      : scope === "unstaged"
        ? untracked
        : x === "A" || untracked;
  const deleted =
    scope === "staged"
      ? x === "D"
      : scope === "unstaged"
        ? y === "D"
        : x === "D" || y === "D";
  return {
    old:
      added || !from
        ? null
        : { name: from.old_name, contents: from.old_contents },
    next: deleted ? null : { name: to.new_name, contents: to.new_contents },
  };
}

function hash(input: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

function lineStat(files: readonly DiffFile[]) {
  let additions = 0;
  let deletions = 0;
  for (const { fileDiff } of files)
    for (const hunk of fileDiff.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
  return { additions, deletions };
}

function collapseIconClass(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-[var(--diffs-addition-base)]";
    case "deleted":
      return "text-[var(--diffs-deletion-base)]";
    case "change":
    case "rename-pure":
    case "rename-changed":
      return "text-[var(--diffs-modified-base)]";
    default:
      return "text-muted-foreground/80";
  }
}

function treeStatus(fileDiff: FileDiffMetadata): DiffFileTreeEntry["status"] {
  switch (fileDiff.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}

function useDiffFiles(
  checkout: CheckoutRef,
  view: WorkspaceView | undefined,
  scope: Scope,
  ignoreWhitespace: boolean,
) {
  const requests = useMemo(
    () =>
      (view?.changes ?? [])
        .toSorted((a, b) => a.path.localeCompare(b.path))
        .flatMap((change) =>
          plan(scope, change).map((basis) => ({ change, basis })),
        ),
    [view, scope],
  );
  const reads = useQueries({
    queries: requests.map(({ change, basis }) => ({
      queryKey: [...checkoutKey("diff", checkout), change.path, basis],
      queryFn: () => ipc.diff(checkout, change.path, basis),
    })),
    combine: (results) => ({
      pending: results.some((result) => result.isPending),
      outcomes: results.map((result) => result.error?.message ?? result.data),
    }),
  });
  const pending = view === undefined || reads.pending;
  return useMemo(() => {
    const files: DiffFile[] = [];
    const problems: string[] = [];
    if (pending) return { pending, files, problems };
    const byChange = new Map<Change, Partial<Record<Basis, DiffText>>>();
    requests.forEach(({ change, basis }, index) => {
      const outcome = reads.outcomes[index];
      if (typeof outcome === "string")
        problems.push(`${change.path}: ${outcome}`);
      else if (outcome?.kind === "unavailable")
        problems.push(`${change.path}: ${outcome.reason}`);
      else if (outcome)
        byChange.set(change, { ...byChange.get(change), [basis]: outcome });
    });
    for (const [change, texts] of byChange) {
      const joined = sides(scope, change, texts);
      if (!joined) continue;
      const { old, next } = joined;
      if (old?.contents === next?.contents && old?.name === next?.name)
        continue;
      let fileDiff: FileDiffMetadata;
      try {
        fileDiff = parseDiffFromFile(old, next);
      } catch {
        // Pierre throws when the two sides yield no hunks, such as an empty file being added.
        continue;
      }
      files.push({
        path: change.path,
        fileDiff: ignoreWhitespace ? hideWhitespaceChanges(fileDiff) : fileDiff,
        version: hash(`${old?.contents ?? ""}\u0000${next?.contents ?? ""}`),
      });
    }
    return { pending, files, problems };
  }, [pending, requests, scope, reads.outcomes, ignoreWhitespace]);
}

const NONE_EXPANDED: ReadonlySet<string> = new Set();

export function DiffSurface({
  checkout,
  view,
  onOpenFile,
}: {
  checkout: CheckoutRef;
  view: WorkspaceView | undefined;
  onOpenFile: (path: string) => void;
}) {
  const theme = useResolvedTheme();
  const client = useQueryClient();
  const [scope, setScope] = useStoredState<Scope>("z1.diffScope", parseScope);
  const [split, setSplit] = useStoredState("z1.diffSplit", storedFlag(false));
  const [wordWrap, setWordWrap] = useState(() =>
    storedFlag(true)(localStorage.getItem(WORD_WRAP_KEY)),
  );
  const [ignoreWhitespace, setIgnoreWhitespace] = useStoredState(
    "z1.diffIgnoreWhitespace",
    storedFlag(true),
  );
  const [fileTreeOpen, setFileTreeOpen] = useStoredState(
    "z1.diffFileTreeOpen",
    storedFlag(false),
  );
  const [expanded, setExpanded] = useState<{
    scope: Scope;
    paths: ReadonlySet<string>;
  }>({
    scope,
    paths: new Set(),
  });
  const expandedPaths =
    expanded.scope === scope ? expanded.paths : NONE_EXPANDED;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ path: string } | null>(null);
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const refreshing =
    useIsFetching({ queryKey: checkoutKey("diff", checkout) }) > 0;
  const { pending, files, problems } = useDiffFiles(
    checkout,
    view,
    scope,
    ignoreWhitespace,
  );
  const stat = useMemo(() => lineStat(files), [files]);
  const allCollapsed = files.every((file) => !expandedPaths.has(file.path));
  const filesByPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );

  const items = useMemo<CodeViewItem<undefined>[]>(
    () =>
      files.map((file) => {
        const collapsed = !expandedPaths.has(file.path);
        return {
          id: file.path,
          type: "diff",
          fileDiff: file.fileDiff,
          collapsed,
          version: hash(`${file.version}:${collapsed ? 1 : 0}`),
        };
      }),
    [files, expandedPaths],
  );
  const treeEntries = useMemo(
    () =>
      files.map((file) => ({
        path: file.path,
        status: treeStatus(file.fileDiff),
      })),
    [files],
  );

  const setPathExpanded = (path: string, value: boolean) => {
    const next = new Set(expandedPaths);
    if (value) next.add(path);
    else next.delete(path);
    setExpanded({ scope, paths: next });
  };
  const toggleAll = () =>
    setExpanded({
      scope,
      paths: allCollapsed ? new Set(files.map((file) => file.path)) : new Set(),
    });
  const revealFile = (path: string) => {
    setSelectedPath(path);
    setPathExpanded(path, true);
    setReveal({ path });
  };
  useEffect(() => {
    if (!reveal || !viewer.current?.getInstance()) return;
    viewer.current.scrollTo({ type: "item", id: reveal.path, align: "start" });
  }, [reveal, items]);

  const refresh = () => {
    void client.invalidateQueries({
      queryKey: checkoutKey("workspace", checkout),
    });
    void client.invalidateQueries({ queryKey: checkoutKey("diff", checkout) });
    void client.invalidateQueries({ queryKey: checkoutKey("file", checkout) });
  };

  const header = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        <Menu
          trigger={({ ref, ...props }) => (
            <Button
              ref={ref}
              size="xs"
              variant="secondary"
              className="max-w-full"
              aria-label={`Diff scope: ${SCOPES[scope].label}`}
              {...props}
            >
              <span className="truncate">{SCOPES[scope].label}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </Button>
          )}
        >
          {(Object.keys(SCOPES) as Scope[]).map((value) => (
            <MenuRadioItem
              key={value}
              checked={value === scope}
              onClick={() => setScope(value)}
            >
              <span>{SCOPES[value].label}</span>
            </MenuRadioItem>
          ))}
        </Menu>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {files.length > 0 ? (
          <DiffStatLabel
            additions={stat.additions}
            deletions={stat.deletions}
            className="mr-1 text-2xs"
          />
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={refreshing ? "Refreshing diff" : "Refresh diff"}
          title={refreshing ? "Refreshing diff…" : "Refresh diff"}
          onClick={refresh}
        >
          <RefreshIcon refreshing={refreshing} className="size-3.5" />
        </Button>
        {files.length > 0 ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={
              allCollapsed ? "Expand all files" : "Collapse all files"
            }
            title={allCollapsed ? "Expand all files" : "Collapse all files"}
            onClick={toggleAll}
          >
            {allCollapsed ? (
              <ChevronsUpDownIcon className="size-3.5" />
            ) : (
              <ChevronsDownUpIcon className="size-3.5" />
            )}
          </Button>
        ) : null}
        <SegmentedGroup label="Diff layout">
          <Toggle
            variant="segmented"
            size="segmented"
            data-size="segmented"
            data-variant="segmented"
            pressed={!split}
            aria-label="Stacked diff view"
            title="Stacked diff view"
            onClick={() => setSplit(false)}
          >
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle
            variant="segmented"
            size="segmented"
            data-size="segmented"
            data-variant="segmented"
            pressed={split}
            aria-label="Split diff view"
            title="Split diff view"
            onClick={() => setSplit(true)}
          >
            <Columns2Icon className="size-3.5" />
          </Toggle>
        </SegmentedGroup>
        <Toggle
          variant="ghost"
          size="sm"
          pressed={wordWrap}
          aria-label={
            wordWrap
              ? "Disable diff line wrapping"
              : "Enable diff line wrapping"
          }
          title={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          onClick={() => setWordWrap(!wordWrap)}
        >
          <TextWrapIcon className="size-3.5" />
        </Toggle>
        <Toggle
          variant="ghost"
          size="sm"
          pressed={ignoreWhitespace}
          aria-label={
            ignoreWhitespace
              ? "Show whitespace changes"
              : "Hide whitespace changes"
          }
          title={
            ignoreWhitespace
              ? "Show whitespace changes"
              : "Hide whitespace changes"
          }
          onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}
        >
          <PilcrowIcon className="size-3.5" />
        </Toggle>
        {files.length > 0 ? (
          <Toggle
            variant="ghost"
            size="sm"
            pressed={fileTreeOpen}
            aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
            title={fileTreeOpen ? "Hide file tree" : "Show file tree"}
            onClick={() => setFileTreeOpen(!fileTreeOpen)}
          >
            <FolderTreeIcon className="size-3.5" />
          </Toggle>
        ) : null}
      </div>
    </>
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-background w-full">
      <div
        data-surface-subheader
        className="flex items-center justify-between gap-2 px-2 h-10 min-h-10 shrink-0 border-b border-border/60 bg-background in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
      >
        {header}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {problems.length > 0 ? (
          <div className="px-3">
            {problems.map((problem) => (
              <p key={problem} className="mb-2 text-2xs text-error/80">
                {problem}
              </p>
            ))}
          </div>
        ) : null}
        {pending ? (
          <DiffLoadingState
            label={
              scope === "working"
                ? "Loading working tree diff..."
                : scope === "staged"
                  ? "Loading staged diff..."
                  : "Loading unstaged diff..."
            }
          />
        ) : files.length === 0 ? (
          <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
            <p>No net changes in this selection.</p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div
              className="min-h-0 min-w-0 flex-1"
              onClickCapture={(event) => {
                const path = event.nativeEvent.composedPath();
                if (path.some((node) => node instanceof HTMLButtonElement))
                  return;
                const title = path.find(
                  (node): node is HTMLElement =>
                    node instanceof HTMLElement &&
                    node.hasAttribute("data-title"),
                );
                const titled = title?.textContent
                  ? filesByPath.get(title.textContent)
                  : undefined;
                if (titled && titled.fileDiff.type !== "deleted") {
                  onOpenFile(titled.path);
                  return;
                }
                const header = path.find(
                  (node): node is HTMLElement =>
                    node instanceof HTMLElement &&
                    node.hasAttribute("data-diffs-header"),
                );
                const name = header?.querySelector("[data-title]")?.textContent;
                if (name && filesByPath.has(name))
                  setPathExpanded(name, !expandedPaths.has(name));
              }}
            >
              <CodeView<undefined>
                key={scope}
                ref={viewer}
                className="diff-render-surface [--code-background:var(--background)] outline-none h-full min-h-0 overflow-auto"
                items={items}
                disableWorkerPool
                options={{
                  diffStyle: split ? "split" : "unified",
                  overflow: wordWrap ? "wrap" : "scroll",
                  theme: theme === "dark" ? "pierre-dark" : "pierre-light",
                  themeType: theme,
                  stickyHeaders: true,
                  unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
                  itemMetrics: {
                    diffHeaderHeight: 32,
                    hunkSeparatorHeight: 24,
                    spacing: 0,
                    paddingTop: 0,
                    paddingBottom: 8,
                  },
                  layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
                }}
                renderHeaderPrefix={(item) => {
                  if (item.type !== "diff") return null;
                  const collapsed = !expandedPaths.has(item.id);
                  const Chevron = collapsed
                    ? ChevronRightIcon
                    : ChevronDownIcon;
                  return (
                    <Button
                      size="icon-micro"
                      variant="ghost"
                      className="-ms-0.5"
                      aria-label={
                        collapsed ? `Expand ${item.id}` : `Collapse ${item.id}`
                      }
                      aria-expanded={!collapsed}
                      title={collapsed ? "Expand diff" : "Collapse diff"}
                      onClick={(event) => {
                        event.stopPropagation();
                        setPathExpanded(item.id, collapsed);
                      }}
                    >
                      <Chevron
                        className={cn(
                          "size-4",
                          collapseIconClass(item.fileDiff),
                        )}
                      />
                    </Button>
                  );
                }}
                renderHeaderFilenameSuffix={(item) => (
                  <CopyPathButton path={item.id} />
                )}
              />
            </div>
            {fileTreeOpen ? (
              <aside className="flex w-[min(16rem,40%)] min-w-40 shrink-0 border-l border-border/60">
                <DiffFileTree
                  entries={treeEntries}
                  selectedPath={selectedPath}
                  onSelectFile={revealFile}
                />
              </aside>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size="icon-micro"
      variant="ghost-muted"
      aria-label="Copy file path"
      title={copied ? "Copied" : "Copy path"}
      onClick={() => {
        void navigator.clipboard.writeText(path).then(() => setCopied(true));
      }}
    >
      {copied ? (
        <CheckIcon className="size-3 text-success" />
      ) : (
        <CopyIcon className="size-3" />
      )}
    </Button>
  );
}

function Skeleton({ className }: { className: string }) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "bg-muted-foreground/15 motion-safe:animate-skeleton rounded-full",
        className,
      )}
    />
  );
}

function FileHeaderSkeleton({ width }: { width: string }) {
  return (
    <div className="flex h-8 items-center gap-2 px-2 pr-3">
      <div className="flex size-5 shrink-0 items-center justify-center">
        <Skeleton className="size-2.5 rounded-sm" />
      </div>
      <Skeleton className="size-5 shrink-0 rounded-sm" />
      <Skeleton className={width} />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Skeleton className="h-3 w-5" />
        <Skeleton className="h-3 w-5" />
      </div>
    </div>
  );
}

function DiffLoadingState({ label }: { label: string }) {
  return (
    <div
      className="min-h-0 flex-1 overflow-hidden bg-background"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <FileHeaderSkeleton width="h-3 w-1/2 max-w-64" />
      <div className="flex h-6 items-center gap-2 px-2 pr-3">
        <div className="h-px flex-1 bg-border/40" />
        <Skeleton className="h-2.5 w-24" />
        <div className="h-px flex-1 bg-border/40" />
      </div>
      <div className="space-y-2 px-3 py-2">
        {["w-2/3", "w-4/5", "w-3/5"].map((width) => (
          <div key={width} className="flex items-center gap-3">
            <Skeleton className="h-2.5 w-5 shrink-0" />
            <Skeleton className={cn("h-2.5", width)} />
          </div>
        ))}
      </div>
      <FileHeaderSkeleton width="h-3 w-2/5 max-w-52" />
      <FileHeaderSkeleton width="h-3 w-3/5 max-w-72" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
