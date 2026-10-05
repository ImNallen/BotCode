// Code tab ported from pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/PullRequestCodeTab.tsx
// and PullRequestReviewAnnotation.tsx (MIT).
import type { CodeViewItem, SelectedLineRange } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { MessageSquareIcon, Trash2Icon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../ui/controls";
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
import type { PrReviewDetail } from "./prReview";
import { PullRequestDiffStat } from "./pullRequestPresentation";
import {
  draftAnnotations,
  lineKey,
  pullRequestCodeFile,
  type DraftLine,
} from "./pullRequestDiff";
import { draftKey, reviewDrafts } from "./reviewDrafts";
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
  disabled,
  onViewFiles,
}: {
  detail: PrReviewDetail;
  disabled: boolean;
  onViewFiles: () => void;
}) {
  const theme = useResolvedTheme();
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
  const canComment = !disabled && detail.verdicts.length > 0;

  const codeFiles = useMemo(
    () => detail.files.map(pullRequestCodeFile),
    [detail.files],
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
        const annotations = draftAnnotations(comments, file.path);
        const drafted = annotations
          .map((a) => `${a.side}:${a.lineNumber}:${a.metadata.ids.join(",")}`)
          .join("|");
        return {
          id: file.path,
          type: "diff",
          fileDiff,
          annotations,
          collapsed,
          version: hash(
            `${detail.observation.headOid}:${ignoreWhitespace}:${collapsed}:${drafted}`,
          ),
        };
      }),
    [diffs, expanded, comments, detail.observation.headOid, ignoreWhitespace],
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

  const addComment = useCallback(
    (range: SelectedLineRange, { item }: { item: CodeViewItem<DraftLine> }) => {
      const side = range.endSide ?? range.side;
      const target = side
        ? diffs
            .find(({ file }) => file.path === item.id)
            ?.targets.get(lineKey(side, range.end))
        : undefined;
      if (!target) return;
      setFocusId(reviewDrafts.add(key, { path: item.id, ...target }));
      requestAnimationFrame(() => viewer.current?.clearSelectedLines());
    },
    [diffs, key],
  );
  const options = useMemo(
    () => ({
      ...diffViewOptions<DraftLine>({ split, wordWrap, theme }),
      unsafeCSS: `${DIFF_VIEW_UNSAFE_CSS}${REPLACE_FILE_COUNTS_CSS}`,
      enableGutterUtility: canComment,
      onGutterUtilityClick: addComment,
    }),
    [split, wordWrap, theme, canComment, addComment],
  );

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
    [unavailable, onViewFiles],
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
  const renderHeaderMetadata = useCallback((item: CodeViewItem<DraftLine>) => {
    if (item.type !== "diff") return null;
    let additions = 0;
    let deletions = 0;
    for (const hunk of item.fileDiff.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
    return (
      <PullRequestDiffStat
        additions={additions}
        deletions={deletions}
        className="font-mono text-2xs"
      />
    );
  }, []);
  const renderAnnotation = useCallback(
    (annotation: { metadata: DraftLine }) => (
      <div className="py-1 font-sans text-foreground">
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
    [key, focusId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4 text-xs text-muted-foreground">
        <span className="shrink-0 tabular-nums">
          {detail.files.length} {detail.files.length === 1 ? "file" : "files"}
        </span>
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
      {items.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {unavailableFiles ?? (
            <p className="px-4 py-5 text-sm text-muted-foreground">
              This pull request has no file changes.
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
        <span>Pending. Sent when you submit the review.</span>
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
        aria-label={`Comment on ${comment.path} line ${comment.line}`}
        value={comment.body}
        autoFocus={autoFocus}
        onFocus={onFocused}
        onChange={(event) => reviewDrafts.edit(key, id, event.target.value)}
      />
    </div>
  );
}
