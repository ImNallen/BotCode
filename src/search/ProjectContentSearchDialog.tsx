// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/search/ProjectContentSearchDialog.tsx (MIT).
import { useCallback, useEffect, useMemo, useState } from "react";
import { CommandPaletteContent } from "../command/CommandPaletteContent";
import { useProjectSearch } from "../lib/projectSearch";
import { cn } from "../lib/cn";
import { FileEntryIcon } from "../panel/FileEntryIcon";
import { Toggle } from "../ui/controls";
import { RenderErrorBoundary } from "../errors/RenderErrorBoundary";
import type { CheckoutRef, ContentSearchResult } from "../ipc";

type Match = ContentSearchResult["matches"][number];
function HighlightedSearchLine({ match }: { match: Match }) {
  const pieces = [];
  let start = 0;
  for (const [from, to] of match.ranges) {
    if (from < start) continue;
    pieces.push(match.line.slice(start, from));
    pieces.push(
      <mark key={from} className="rounded-xs bg-primary/25 text-inherit">
        {match.line.slice(from, to)}
      </mark>,
    );
    start = to;
  }
  pieces.push(match.line.slice(start));
  return pieces;
}
export function ProjectContentSearchDialog({
  checkout,
  projectName,
  onOpenFile,
}: {
  checkout: CheckoutRef;
  projectName: string;
  onOpenFile: (path: string, line: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [visibleCount, setVisibleCount] = useState(100);
  const search = useProjectSearch(
    checkout,
    query.trim()
      ? { kind: "content", query, caseSensitive, wholeWord, useRegex }
      : null,
  );
  const result =
    search.response?.kind === "content" ? search.response.value : null;
  const matches = result?.matches ?? [];
  const groups = useMemo(() => {
    const groups = new Map<string, Array<Match & { resultIndex: number }>>();
    matches.slice(0, visibleCount).forEach((match, resultIndex) => {
      const group = groups.get(match.path) ?? [];
      group.push({ ...match, resultIndex });
      groups.set(match.path, group);
    });
    return [...groups].map(([path, matches]) => ({ path, matches }));
  }, [result, visibleCount]);
  useEffect(() => {
    setSelectedIndex(0);
    setVisibleCount(100);
  }, [result]);
  useEffect(() => {
    if (selectedIndex >= visibleCount) setVisibleCount(selectedIndex + 100);
    else
      document
        .querySelector<HTMLElement>(
          `[data-content-search-result="${selectedIndex}"]`,
        )
        ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, visibleCount]);
  const observeSentinel = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting))
        setVisibleCount((count) => count + 100);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const open = (match: Match) => {
    if (result && !search.pending) onOpenFile(match.path, match.lineNumber);
  };
  const fileCount = new Set(matches.map((match) => match.path)).size;
  return (
    <CommandPaletteContent
      escapeLabel="Back"
      panelSize="fill"
      testId="project-content-search"
      footerActionLabel="Open file"
      footerTrailing={
        <button
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={search.refresh}
        >
          Refresh
        </button>
      }
      inputAccessory={
        <div className="absolute inset-e-2.5 top-1/2 flex shrink-0 -translate-y-1/2 items-center gap-0.5 rounded-md border bg-muted/30 p-0.5">
          <Toggle
            size="segmented"
            variant="segmented"
            pressed={caseSensitive}
            aria-label="Match case"
            title="Match case"
            onClick={() => setCaseSensitive((value) => !value)}
          >
            <span className="font-mono">Aa</span>
          </Toggle>
          <Toggle
            size="segmented"
            variant="segmented"
            pressed={wholeWord}
            aria-label="Match whole word"
            title="Match whole word"
            onClick={() => setWholeWord((value) => !value)}
          >
            <span className="font-mono underline decoration-2 underline-offset-2">
              ab
            </span>
          </Toggle>
          <Toggle
            size="segmented"
            variant="segmented"
            pressed={useRegex}
            aria-label="Use regular expression"
            title="Use regular expression"
            onClick={() => setUseRegex((value) => !value)}
          >
            <span className="font-mono">.*</span>
          </Toggle>
        </div>
      }
      inputProps={{
        className: "pe-30",
        value: query,
        placeholder: `Search in ${projectName}`,
        "aria-label": `Search file contents in ${projectName}`,
        onChange: (event) => setQuery(event.target.value),
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedIndex((index) =>
              matches.length
                ? (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    matches.length) %
                  matches.length
                : 0,
            );
          } else if (event.key === "Enter") {
            event.preventDefault();
            const match = matches[selectedIndex];
            if (!event.repeat && match) open(match);
          }
        },
      }}
    >
      {query.trim() || search.pending || search.error ? (
        <div
          role="status"
          className="flex min-h-9 shrink-0 flex-col justify-center border-b px-3 py-1 text-xs text-muted-foreground"
        >
          {search.pending ? (
            "Searching…"
          ) : search.error ? (
            <span className="text-destructive">{search.error}</span>
          ) : (
            `${matches.length.toLocaleString()} results in ${fileCount.toLocaleString()} files`
          )}
          {result?.indexCoverage.kind === "limited" ? (
            <span>{result.indexCoverage.reason}</span>
          ) : null}
          {result?.coverage.kind === "limited" ? (
            <span>{result.coverage.reason}</span>
          ) : null}
          {result?.skippedFiles ? (
            <span>
              {result.skippedFiles.toLocaleString()} binary, oversized,
              unreadable or non-UTF-8 files skipped.
            </span>
          ) : null}
        </div>
      ) : null}
      {!matches.length ? (
        <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
          {query.trim() && !search.pending && !search.error
            ? "No results found."
            : "Type to search across your project."}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="py-2">
            {groups.map((group) => {
              const split = group.path.lastIndexOf("/");
              return (
                <section className="pb-2" key={group.path}>
                  <div className="sticky top-0 z-10 flex h-8 items-center gap-2 bg-popover/95 px-3 text-xs backdrop-blur-sm">
                    <FileEntryIcon
                      path={group.path}
                      kind="file"
                      className="size-3.5"
                    />
                    <span className="font-medium text-foreground">
                      {group.path.slice(split + 1)}
                    </span>
                    {split >= 0 ? (
                      <span className="min-w-0 truncate text-muted-foreground">
                        {group.path.slice(0, split)}
                      </span>
                    ) : null}
                    <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 tabular-nums text-3xs text-muted-foreground">
                      {group.matches.length}
                    </span>
                  </div>
                  {group.matches.map((match) => (
                    <button
                      type="button"
                      key={`${match.path}:${match.lineNumber}`}
                      data-content-search-result={match.resultIndex}
                      className={cn(
                        "flex h-7 w-full min-w-0 items-center gap-3 px-3 text-left font-mono text-xs hover:bg-accent/60 disabled:pointer-events-none",
                        match.resultIndex === selectedIndex &&
                          "bg-accent text-accent-foreground",
                      )}
                      disabled={search.pending}
                      onMouseEnter={() => setSelectedIndex(match.resultIndex)}
                      onClick={() => open(match)}
                    >
                      <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground/70">
                        {match.lineNumber}
                      </span>
                      <span className="min-w-0 flex-1 truncate whitespace-pre">
                        <RenderErrorBoundary
                          fallback={match.line}
                          resetKeys={[match]}
                        >
                          <HighlightedSearchLine match={match} />
                        </RenderErrorBoundary>
                      </span>
                    </button>
                  ))}
                </section>
              );
            })}
            {matches.length > visibleCount ? (
              <div ref={observeSentinel} className="h-8" aria-hidden="true" />
            ) : null}
          </div>
        </div>
      )}
    </CommandPaletteContent>
  );
}
