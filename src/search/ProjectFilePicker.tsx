// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/files/ProjectFilePicker.tsx (MIT).
import { useEffect, useState, type ReactNode } from "react";
import { CommandPaletteContent } from "../command/CommandPaletteContent";
import {
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
} from "../ui/command";
import { FileEntryIcon } from "../panel/FileEntryIcon";
import { useProjectSearch } from "../lib/projectSearch";
import type { CheckoutRef } from "../ipc";
import {
  getProjectFilePickerMatches,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
} from "./ProjectFilePicker.logic";

function HighlightedFuzzyText({
  value,
  indices,
}: {
  value: string;
  indices: readonly number[];
}) {
  const parts: ReactNode[] = [];
  let start = 0;
  for (const index of indices) {
    if (start < index) parts.push(value.slice(start, index));
    parts.push(
      <strong className="font-semibold text-foreground" key={index}>
        {value[index]}
      </strong>,
    );
    start = index + 1;
  }
  if (start < value.length) parts.push(value.slice(start));
  return <span className="text-muted-foreground">{parts}</span>;
}
export function ProjectFilePicker({
  checkout,
  projectName,
  onOpenFile,
  imageOnly = false,
  onPickExternal,
  externalPending,
}: {
  checkout: CheckoutRef;
  projectName: string;
  onOpenFile: (path: string) => void;
  imageOnly?: boolean;
  onPickExternal?: () => void;
  externalPending?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const search = useProjectSearch(checkout, {
    kind: "paths",
    query,
    limit: PROJECT_FILE_PICKER_RESULT_LIMIT,
    imageOnly,
  });
  const result =
    search.response?.kind === "paths" ? search.response.value : null;
  const matches = getProjectFilePickerMatches(result?.paths ?? [], query);
  useEffect(() => {
    document
      .getElementById(`project-file-${selected}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const open = (path: string) => {
    if (result?.paths.includes(path)) onOpenFile(path);
  };
  return (
    <CommandPaletteContent
      escapeLabel={imageOnly ? "Close" : "Back"}
      panelSize="tall-list"
      testId={imageOnly ? "project-favicon-picker" : "project-file-picker"}
      footerActionLabel={imageOnly ? "Select icon" : "Open file"}
      footerTrailing={
        <button
          className="text-xs text-muted-foreground hover:text-foreground"
          disabled={externalPending}
          onClick={onPickExternal ?? search.refresh}
        >
          {onPickExternal ? "Open in Finder" : "Refresh"}
        </button>
      }
      inputProps={{
        value: query,
        placeholder: imageOnly ? "Search image files…" : "Search files…",
        "aria-label": imageOnly ? "Search image files" : "Search files",
        role: "combobox",
        "aria-expanded": true,
        "aria-controls": "project-file-results",
        "aria-activedescendant": matches[selected]
          ? `project-file-${selected}`
          : undefined,
        onChange: (event) => {
          setQuery(event.target.value);
          setSelected(0);
        },
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((index) =>
              matches.length
                ? (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    matches.length) %
                  matches.length
                : 0,
            );
          } else if (event.key === "Enter") {
            event.preventDefault();
            const match = matches[selected];
            if (!event.repeat && match) open(match.path);
          }
        },
      }}
    >
      {matches.length ? (
        <CommandList
          id="project-file-results"
          role="listbox"
          aria-label="Project files"
        >
          <CommandGroup role="group" aria-label={projectName}>
            <CommandGroupLabel>{projectName}</CommandGroupLabel>
            {matches.map((match, index) => (
              <CommandItem
                id={`project-file-${index}`}
                key={match.path}
                role="option"
                aria-selected={index === selected}
                active={index === selected}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setSelected(index)}
                onClick={() => open(match.path)}
              >
                <FileEntryIcon
                  path={match.path}
                  kind="file"
                  className="size-4"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">
                    <HighlightedFuzzyText
                      value={match.name}
                      indices={match.nameMatchIndices}
                    />
                  </span>
                  <span className="truncate text-xs">
                    <HighlightedFuzzyText
                      value={match.path}
                      indices={match.pathMatchIndices}
                    />
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      ) : (
        <div
          role="status"
          className="py-10 text-center text-sm text-muted-foreground"
        >
          {search.error ??
            (search.pending
              ? query.trim()
                ? imageOnly
                  ? "Searching project files…"
                  : "Searching workspace files…"
                : imageOnly
                  ? "Indexing project files…"
                  : "Indexing workspace files…"
              : query.trim()
                ? imageOnly
                  ? "No matching image files."
                  : "No matching files."
                : imageOnly
                  ? "No image files found."
                  : "No files found.")}
        </div>
      )}
      {result?.indexCoverage.kind === "limited" ? (
        <p role="status" className="px-4 pb-2 text-xs text-muted-foreground">
          {result.indexCoverage.reason}
        </p>
      ) : null}
      {result && !imageOnly ? (
        <p className="px-4 pb-2 text-xs text-muted-foreground">
          {result.indexedFiles.toLocaleString()} indexed files
          {result.truncated ? ". Showing the first 200 matches." : "."}
        </p>
      ) : null}
    </CommandPaletteContent>
  );
}
