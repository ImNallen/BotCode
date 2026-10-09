// Range selection ported from pingdotgg/t3code v0.0.45 PullRequestCodeTab.tsx (MIT).
// Commit scope toolbar ported from pingdotgg/t3code v0.0.45 PullRequestCodeTab.tsx (MIT).
// Code tab ported from pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/PullRequestCodeTab.tsx
// and PullRequestReviewAnnotation.tsx (MIT).
import type { CodeViewItem, SelectedLineRange } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MessageSquareOffIcon,
  MessageSquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Checkbox } from "../ui/checkbox";
import type { PullRequestFilesViewedView } from "./usePullRequestFilesViewed";
import { Button } from "../ui/controls";
import { Menu, MenuItem, MenuRadioItem } from "../ui/menu";
import { orderedPrCommits, type PrDiffScope } from "./pullRequestScope";
import { sectionProblemText } from "./prCoverage";
import { Textarea } from "../ui/textarea";
import { DiffFileTree } from "./DiffFileTree";
import {
  CollapseAllButton,
  DiffFileChevron,
  DiffLayoutToggle,
  FileTreeToggle,
  WhitespaceToggle,
  WordWrapToggle,
  diffViewOptions,
  hash,
  treeStatus,
  useDiffViewPreferences,
} from "./diffView";
import { hideWhitespaceChanges } from "./hideWhitespace";
import { DIFF_VIEW_UNSAFE_CSS } from "./surfaceCss";
import { usePullRequestDiffFileContents } from "./usePullRequestDiffFileContents";
import type { PrFileContents, PrReviewDetail } from "./prReview";
import {
  PullRequestDiffStat,
  PullRequestMetaLine,
} from "./pullRequestPresentation";
import {
  conversationAnnotations,
  commentLineLabel,
  resolveCommentSelection,
  pullRequestCodeFile,
  type DraftLine,
} from "./pullRequestDiff";
import { draftKey, reviewDrafts } from "./reviewDrafts";
import { PullRequestReviewThreadCard } from "./PullRequestReviewThreadCard";
import { useResolvedTheme } from "./useResolvedTheme";

// The header's own counts are hidden so the row reads "+a −d" like T3's pull request files.
const REPLACE_FILE_COUNTS_CSS = `
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none !important;
}`;

function useDrafts(key: string) {
  useSyncExternalStore(
    reviewDrafts.subscribe,
    reviewDrafts.snapshot,
    reviewDrafts.snapshot,
  );
  return reviewDrafts.get(key);
}

export function PullRequestCodeTab({
  detail,
  threadId,
  refresh,
  loadFileContents,
  filesViewed,
  scope,
  onScopeChange,
  files,
  problems,
  loading,
  error,
  onRetry,
  disabled,
  onViewFiles,
}: {
  detail: PrReviewDetail;
  threadId?: string;
  refresh?: () => void;
  loadFileContents?: (sourceId: string) => Promise<PrFileContents>;
  filesViewed: PullRequestFilesViewedView;
  scope: PrDiffScope;
  onScopeChange: (scope: PrDiffScope) => void;
  files: PrReviewDetail["files"];
  problems: PrReviewDetail["problems"];
  loading: boolean;
  error?: string;
  onRetry: () => void;
  disabled: boolean;
  onViewFiles: () => void;
}) {
  const theme = useResolvedTheme();
  const [orphansOpen, setOrphansOpen] = useState(false);
  const {
    split,
    setSplit,
    wordWrap,
    setWordWrap,
    ignoreWhitespace,
    setIgnoreWhitespace,
    fileTreeOpen,
    setFileTreeOpen,
  } = useDiffViewPreferences();
  const key = draftKey(detail.observation);
  const { comments } = useDrafts(key);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ path: string } | null>(null);
  const viewer = useRef<CodeViewHandle<DraftLine, undefined>>(null);
  const canComment =
    scope.kind === "all" && !disabled && detail.verdicts.length > 0;
  const orderedCommits = useMemo(
    () => orderedPrCommits(detail.timeline),
    [detail.timeline],
  );
  const [visibleCommitCount, setVisibleCommitCount] = useState(25);
  const selectedCommit =
    scope.kind === "commit"
      ? orderedCommits.find((entry) => entry.oid === scope.oid)
      : undefined;
  const scopeLabel = selectedCommit?.headline ?? "All commits";

  const codeFiles = useMemo(
    () => files.map((file) => pullRequestCodeFile(file, `pr-code:${theme}`)),
    [files, theme],
  );
  const unavailable = useMemo(
    () =>
      codeFiles.flatMap((entry) =>
        entry.kind === "unavailable" ? [entry] : [],
      ),
    [codeFiles],
  );
  const diffs = useMemo(
    () =>
      codeFiles.flatMap((entry) =>
        entry.kind === "diff"
          ? [
              {
                ...entry,
                fileDiff: ignoreWhitespace
                  ? hideWhitespaceChanges(entry.fileDiff)
                  : entry.fileDiff,
              },
            ]
          : [],
      ),
    [codeFiles, ignoreWhitespace],
  );
  const items = useMemo<CodeViewItem<DraftLine>[]>(
    () =>
      diffs.map(({ file, fileDiff }) => {
        const collapsed = !expanded.has(file.path);
        const annotations =
          scope.kind === "all" && !loading && !error
            ? conversationAnnotations(comments, detail.findings, {
                kind: "diff",
                file,
                fileDiff,
                targets: new Map(),
              })
            : [];
        const drafted = annotations.map((a) => JSON.stringify(a)).join("|");
        return {
          id: file.path,
          type: "diff",
          fileDiff,
          annotations,
          collapsed,
          version: hash(
            `${detail.observation.headOid}:${ignoreWhitespace}:${collapsed}:${filesViewed.isViewed(file.path)}:${filesViewed.isStale(file.path)}:${drafted}`,
          ),
        };
      }),
    [
      diffs,
      expanded,
      comments,
      detail.findings,
      loading,
      error,
      detail.observation.headOid,
      ignoreWhitespace,
      scope.kind,
      filesViewed,
    ],
  );
  const placedIds = new Set(
    items.flatMap((item) =>
      item.type === "diff"
        ? (item.annotations ?? []).flatMap((annotation) =>
            (annotation.metadata.threads ?? []).map(
              (entry) => entry.finding.observation.findingId,
            ),
          )
        : [],
    ),
  );
  const orphanThreads = detail.findings.filter(
    (entry) =>
      entry.finding.source.kind === "thread" &&
      !placedIds.has(entry.finding.observation.findingId),
  );
  const orphanFiles = new Map<string, typeof orphanThreads>();
  for (const entry of orphanThreads) {
    const path = entry.threadLocation?.path ?? "Location unavailable";
    orphanFiles.set(path, [...(orphanFiles.get(path) ?? []), entry]);
  }
  const renderThread = (entry: PrReviewDetail["findings"][number]) => (
    <PullRequestReviewThreadCard
      key={entry.finding.observation.findingId}
      entry={entry}
      detail={detail}
      threadId={threadId}
      refresh={refresh}
      disabled={disabled}
    />
  );
  const allCollapsed = diffs.every(({ file }) => !expanded.has(file.path));

  const togglePath = useCallback(
    (path: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
    [],
  );
  const revealFile = (path: string) => {
    setSelectedPath(path);
    setExpanded((current) => new Set(current).add(path));
    setReveal({ path });
  };
  useEffect(() => {
    if (!reveal || !viewer.current?.getInstance()) return;
    viewer.current.scrollTo({ type: "item", id: reveal.path, align: "start" });
  }, [reveal, items]);

  const [selectionError, setSelectionError] = useState<string | null>(null);
  const addComment = useCallback(
    (
      range: SelectedLineRange | null,
      { item }: { item: CodeViewItem<DraftLine> },
    ) => {
      if (!range || !canComment) return;
      const file = diffs.find(({ file }) => file.path === item.id);
      const target = file ? resolveCommentSelection(file, range) : null;
      if (!target) {
        setSelectionError(
          "This selection cannot be commented on. Select consecutive lines on one side within the original diff hunk.",
        );
        return;
      }
      setSelectionError(null);
      setFocusId(reviewDrafts.add(key, { path: item.id, ...target }));
      requestAnimationFrame(() => viewer.current?.clearSelectedLines());
    },
    [diffs, key, canComment],
  );
  const { loadDiffFiles, errors: contextErrors } =
    usePullRequestDiffFileContents(
      loadFileContents,
      files,
      `${key}:${scope.kind === "all" ? "all" : scope.oid}`,
    );
  const options = useMemo(
    () => ({
      ...diffViewOptions<DraftLine>({ split, wordWrap, theme }),
      loadDiffFiles,
      unsafeCSS: `${DIFF_VIEW_UNSAFE_CSS}${REPLACE_FILE_COUNTS_CSS}`,
      enableLineSelection: canComment,
      onLineSelectionEnd: canComment ? addComment : undefined,
      enableGutterUtility: canComment,
      // Pierre requires a gutter callback to enable +; selection end creates the draft.
      onGutterUtilityClick: canComment ? () => {} : undefined,
    }),
    [split, wordWrap, theme, canComment, addComment, loadDiffFiles],
  );

  const filesViewedRef = useRef(filesViewed);
  filesViewedRef.current = filesViewed;
  const unavailableFiles = useMemo(
    () =>
      unavailable.length > 0 ? (
        <div className="border-t border-border/60">
          {unavailable.map(({ file, reason }) => (
            <div
              key={file.path}
              className="border-b border-border/60 px-3 py-2 text-xs"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {file.path}
                </span>
                <PullRequestDiffStat
                  additions={file.additions}
                  deletions={file.deletions}
                  className="shrink-0 font-mono text-2xs"
                />
                {filesViewed.enabled ? (
                  <label
                    data-viewed-toggle=""
                    className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Checkbox
                      label={
                        filesViewed.isStale(file.path) ? "Changed" : "Viewed"
                      }
                      checked={filesViewed.isViewed(file.path)}
                      onCheckedChange={() =>
                        filesViewedRef.current.setViewed(
                          file.path,
                          !filesViewedRef.current.isViewed(file.path),
                        )
                      }
                    />
                    {filesViewed.isStale(file.path) ? (
                      <span
                        className="text-warning-foreground"
                        title="This file has been pushed to since you marked it viewed."
                      >
                        Changed
                      </span>
                    ) : (
                      "Viewed"
                    )}
                  </label>
                ) : null}
              </div>
              <p className="mt-1 text-muted-foreground">
                {reason}{" "}
                <button className="underline" onClick={onViewFiles}>
                  View on GitHub
                </button>
              </p>
            </div>
          ))}
        </div>
      ) : null,
    [unavailable, onViewFiles, filesViewed],
  );
  const renderFooter = useCallback(() => unavailableFiles, [unavailableFiles]);
  // Pierre memoizes each visible file's header and annotation portals on these callbacks, so
  // stable identities keep a keystroke in a drafted comment from rebuilding them.
  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem<DraftLine>) =>
      item.type === "diff" ? (
        <DiffFileChevron
          path={item.id}
          fileDiff={item.fileDiff}
          collapsed={item.collapsed === true}
          onToggle={() => togglePath(item.id)}
        />
      ) : null,
    [togglePath],
  );
  const setFileViewed = useCallback(
    (path: string, viewed: boolean) => {
      filesViewed.setViewed(path, viewed);
      setExpanded((current) => {
        const next = new Set(current);
        if (viewed) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    [filesViewed.setViewed],
  );
  const setFileViewedRef = useRef(setFileViewed);
  setFileViewedRef.current = setFileViewed;
  const renderHeaderMetadata = useCallback((item: CodeViewItem<DraftLine>) => {
    if (item.type !== "diff") return null;
    let additions = 0;
    let deletions = 0;
    for (const hunk of item.fileDiff.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
    const stat = (
      <PullRequestDiffStat
        additions={additions}
        deletions={deletions}
        className="font-mono text-2xs"
      />
    );
    const viewedFiles = filesViewedRef.current;
    if (!viewedFiles.enabled) return stat;
    const viewed = viewedFiles.isViewed(item.id);
    const stale = viewedFiles.isStale(item.id);
    return (
      <span className="flex items-center gap-3">
        {stat}
        <label
          data-viewed-toggle=""
          className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          <Checkbox
            label={stale ? "Changed" : "Viewed"}
            checked={viewed}
            onCheckedChange={() =>
              setFileViewedRef.current(
                item.id,
                !filesViewedRef.current.isViewed(item.id),
              )
            }
          />
          {stale ? (
            <span
              className="text-warning-foreground"
              title="This file has been pushed to since you marked it viewed."
            >
              Changed
            </span>
          ) : (
            "Viewed"
          )}
        </label>
      </span>
    );
  }, []);
  const renderAnnotation = useCallback(
    (annotation: { metadata: DraftLine }) => (
      <div className="py-1 font-sans text-foreground">
        {(annotation.metadata.threads ?? []).map((entry) => (
          <PullRequestReviewThreadCard
            key={entry.finding.observation.findingId}
            entry={entry}
            detail={detail}
            threadId={threadId}
            refresh={refresh}
            disabled={disabled}
          />
        ))}
        {annotation.metadata.ids.map((id) => (
          <DraftLineComment
            key={id}
            draftKey={key}
            id={id}
            autoFocus={id === focusId}
            onFocused={() => setFocusId(null)}
          />
        ))}
      </div>
    ),
    [key, focusId, detail, threadId, refresh, disabled],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {orderedCommits.length > 0 ? (
            <Menu
              trigger={(props) => (
                <Button
                  {...props}
                  size="xs"
                  variant="secondary"
                  className="min-w-0 max-w-64"
                  aria-label={`Diff scope: ${scopeLabel}`}
                >
                  <span className="truncate">{scopeLabel}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
                </Button>
              )}
            >
              <MenuRadioItem
                checked={scope.kind === "all"}
                onClick={() => onScopeChange({ kind: "all" })}
              >
                <span>All commits</span>
              </MenuRadioItem>
              {orderedCommits.slice(0, visibleCommitCount).map((entry) => (
                <MenuRadioItem
                  key={entry.oid}
                  checked={scope.kind === "commit" && scope.oid === entry.oid}
                  onClick={() =>
                    onScopeChange({ kind: "commit", oid: entry.oid })
                  }
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 truncate" title={entry.headline}>
                      {entry.headline}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                      {entry.oid.slice(0, 7)}
                    </span>
                  </span>
                </MenuRadioItem>
              ))}
              {orderedCommits.length > visibleCommitCount ? (
                <MenuItem
                  data-keep-open
                  onClick={() => setVisibleCommitCount((count) => count + 25)}
                >
                  <span className="text-muted-foreground">
                    Show more ({orderedCommits.length - visibleCommitCount}{" "}
                    left)
                  </span>
                </MenuItem>
              ) : null}
            </Menu>
          ) : null}
          <PullRequestMetaLine className="shrink-0">
            <span className="shrink-0 tabular-nums">
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
            {filesViewed.enabled && files.length > 0 ? (
              <span className="flex min-w-0 items-center gap-1 tabular-nums">
                <span className="shrink-0">
                  {filesViewed.viewedCount} / {files.length}
                </span>
                <span className="truncate">viewed</span>
                {filesViewed.error !== null ? (
                  <span
                    className="flex shrink-0 items-center"
                    title={`The boxes below are whatever was last read, and empty if nothing has been read yet. ${filesViewed.error}`}
                  >
                    <TriangleAlertIcon
                      aria-label="Your ticks could not be read"
                      className="size-3.5 text-warning-foreground"
                    />
                  </span>
                ) : null}
                {filesViewed.truncated ? (
                  <span
                    className="flex shrink-0 items-center"
                    title="This change has more files than the host will report ticks for in one read, so the count is short and some boxes below start empty."
                  >
                    <TriangleAlertIcon
                      aria-label="This count covers only part of the change"
                      className="size-3.5 text-warning-foreground"
                    />
                  </span>
                ) : null}
              </span>
            ) : null}
            {scope.kind === "commit" && detail.verdicts.length > 0 ? (
              <span
                className="flex shrink-0 items-center"
                title="A comment is anchored to the whole change, so switch to All commits to write one."
              >
                <MessageSquareOffIcon
                  aria-label="Line comments are written from the whole change"
                  className="size-3.5"
                />
              </span>
            ) : null}
          </PullRequestMetaLine>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <WhitespaceToggle
            ignoreWhitespace={ignoreWhitespace}
            onChange={setIgnoreWhitespace}
          />
          {items.length > 0 ? (
            <CollapseAllButton
              allCollapsed={allCollapsed}
              onToggle={() =>
                setExpanded(
                  allCollapsed
                    ? new Set(diffs.map(({ file }) => file.path))
                    : new Set(),
                )
              }
            />
          ) : null}
          <DiffLayoutToggle split={split} onChange={setSplit} />
          <WordWrapToggle wordWrap={wordWrap} onChange={setWordWrap} />
          {items.length > 0 ? (
            <FileTreeToggle open={fileTreeOpen} onChange={setFileTreeOpen} />
          ) : null}
        </div>
      </div>
      {orphanThreads.length > 0 ? (
        <div className="shrink-0 border-b border-border/60">
          <h2>
            <button
              type="button"
              aria-expanded={orphansOpen}
              className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground"
              onClick={() => setOrphansOpen((open) => !open)}
            >
              <span>Conversations not on the current diff</span>
              <ChevronRightIcon
                aria-hidden
                className={`size-3.5 transition-transform${orphansOpen ? " rotate-90" : ""}`}
              />
              <span aria-hidden className="tabular-nums">
                {orphanThreads.length}
              </span>
              <span className="sr-only">
                {orphanThreads.length}{" "}
                {orphanThreads.length === 1 ? "conversation" : "conversations"}
              </span>
            </button>
          </h2>
          {orphansOpen ? (
            <div className="max-h-64 space-y-3 overflow-auto px-4 pb-3">
              {[...orphanFiles].map(([path, entries]) => (
                <div key={path}>
                  <p
                    title={path}
                    className="truncate px-3 text-xs text-muted-foreground"
                  >
                    {path}
                  </p>
                  <div className="mt-1 space-y-2">
                    {entries.map((entry) => (
                      <div key={entry.finding.observation.findingId}>
                        {entry.threadLocation?.line ? (
                          <p className="px-3 text-xs text-muted-foreground">
                            Line {entry.threadLocation.line}
                          </p>
                        ) : null}
                        {renderThread(entry)}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {detail.problems
        .filter((problem) => problem.section === "threads")
        .map((problem) => (
          <p
            key={problem.section}
            role="status"
            className="px-4 py-2 text-xs text-muted-foreground"
          >
            {sectionProblemText(problem)}
          </p>
        ))}
      {problems
        .filter((problem) => problem.section === "files")
        .map((problem) => (
          <p
            key={problem.section}
            role="status"
            className="px-4 py-2 text-xs text-muted-foreground"
          >
            {sectionProblemText(problem)}
          </p>
        ))}
      {selectionError ? (
        <div role="alert" className="px-4 py-2 text-xs text-muted-foreground">
          {selectionError}
        </div>
      ) : null}
      {Array.from(contextErrors, ([path, message]) => (
        <p
          key={path}
          role="alert"
          className="px-4 py-2 text-xs text-muted-foreground"
        >
          <span className="text-warning-foreground">
            Could not expand unchanged context for {path}.
          </span>{" "}
          {message} Click the unchanged-lines separator again to retry.
        </p>
      ))}
      {loading ? (
        <p role="status" className="px-4 py-5 text-sm text-muted-foreground">
          Loading file changes...
        </p>
      ) : error ? (
        <div role="alert" className="px-4 py-5 text-sm text-muted-foreground">
          {error}{" "}
          <Button size="xs" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {unavailableFiles ?? (
            <p className="px-4 py-5 text-sm text-muted-foreground">
              {scope.kind === "all"
                ? "This pull request has no file changes."
                : "This commit has no file changes."}
            </p>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            className="min-h-0 min-w-0 flex-1"
            onClickCapture={(event) => {
              for (const node of event.nativeEvent.composedPath()) {
                if (!(node instanceof HTMLElement)) continue;
                if (node.hasAttribute("data-viewed-toggle")) return;
                if (node instanceof HTMLButtonElement) return;
                if (node.hasAttribute("data-diffs-header")) {
                  const path = node.querySelector("[data-title]")?.textContent;
                  if (path && items.some((item) => item.id === path))
                    togglePath(path);
                  return;
                }
              }
            }}
          >
            <CodeView<DraftLine>
              ref={viewer}
              className="diff-render-surface [--code-background:var(--background)] outline-none h-full min-h-0 overflow-auto"
              items={items}
              disableWorkerPool
              options={options}
              renderHeaderPrefix={renderHeaderPrefix}
              renderHeaderMetadata={renderHeaderMetadata}
              renderAnnotation={renderAnnotation}
              renderCodeViewFooter={renderFooter}
            />
          </div>
          {fileTreeOpen ? (
            <aside className="flex w-[min(16rem,40%)] min-w-40 shrink-0 border-l border-border/60">
              <DiffFileTree
                entries={diffs.map(({ file, fileDiff }) => ({
                  path: file.path,
                  status: treeStatus(fileDiff),
                }))}
                selectedPath={selectedPath}
                onSelectFile={revealFile}
              />
            </aside>
          ) : null}
        </div>
      )}
    </div>
  );
}

function DraftLineComment({
  draftKey: key,
  id,
  autoFocus,
  onFocused,
}: {
  draftKey: string;
  id: string;
  autoFocus: boolean;
  onFocused: () => void;
}) {
  const comment = useDrafts(key).comments.find((c) => c.id === id);
  if (!comment) return null;
  return (
    <div
      className="mx-3 my-2 rounded-xl border border-dashed border-border/70 bg-background p-3 text-sm shadow-sm"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageSquareIcon className="size-3.5" />
        <span>
          Pending — sent when you submit the review
          {comment.startLine === undefined
            ? ""
            : ` Lines ${commentLineLabel(comment)} (${comment.side.toLowerCase()}).`}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label="Discard this comment"
          title="Discard this comment"
          onClick={() => reviewDrafts.remove(key, id)}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      <Textarea
        size="sm"
        className="mt-2"
        rows={2}
        placeholder="Leave a comment"
        aria-label={`Comment on ${comment.path} ${comment.startLine === undefined ? "line" : "lines"} ${commentLineLabel(comment)} (${comment.side.toLowerCase()})`}
        value={comment.body}
        autoFocus={autoFocus}
        onFocus={onFocused}
        onChange={(event) => reviewDrafts.edit(key, id, event.target.value)}
      />
    </div>
  );
}
