// Explorer copied from pingdotgg/t3code v0.0.45 components/files/FileBrowserPanel.tsx and
// components/ui/input-group.tsx (MIT).
import type { FileTreeDirectoryHandle } from "@pierre/trees";
import {
  FileTree,
  useFileTree,
  useFileTreeSearch,
  useFileTreeSelector,
} from "@pierre/trees/react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { checkoutKey, type CheckoutRef } from "../ipc";
import { Button } from "../ui/controls";
import { RefreshIcon } from "./chrome";
import { T3_PIERRE_ICONS } from "./FileEntryIcon";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "./surfaceCss";
import { useResolvedTheme } from "./useResolvedTheme";

function directoriesOf(files: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    for (
      let slash = file.indexOf("/");
      slash !== -1;
      slash = file.indexOf("/", slash + 1)
    )
      directories.add(file.slice(0, slash));
  }
  return [...directories];
}

type TreeModel = ReturnType<typeof useFileTree>["model"];

const directoryItem = (
  model: TreeModel,
  path: string,
): FileTreeDirectoryHandle | null => {
  const item = model.getItem(`${path}/`) ?? model.getItem(path);
  return item && "expand" in item ? item : null;
};

export function FileExplorer({
  checkout,
  projectName,
  files,
  selectedPath,
  onOpenFile,
}: {
  checkout: CheckoutRef;
  projectName: string;
  files: readonly string[];
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const theme = useResolvedTheme();
  const client = useQueryClient();
  const refreshing =
    useIsFetching({ queryKey: checkoutKey("workspace", checkout) }) > 0;
  const fileSet = useMemo(() => new Set(files), [files]);
  const fileSetRef = useRef(fileSet);
  fileSetRef.current = fileSet;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const syncingSelection = useRef(false);
  const directories = useMemo(() => directoriesOf(files), [files]);

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      if (syncingSelection.current) return;
      const path = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (path && fileSetRef.current.has(path)) onOpenFileRef.current(path);
    },
    paths: [],
    search: false,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const allExpanded = useFileTreeSelector(
    model,
    (current) =>
      directories.length > 0 &&
      directories.every(
        (path) => directoryItem(current, path)?.isExpanded() === true,
      ),
  );

  useEffect(() => {
    syncingSelection.current = true;
    model.resetPaths(files);
    syncingSelection.current = false;
  }, [files, model]);

  useEffect(() => {
    if (!selectedPath || !fileSet.has(selectedPath)) return;
    if (model.getSelectedPaths().some((path) => path === selectedPath)) return;
    syncingSelection.current = true;
    for (const path of model.getSelectedPaths())
      model.getItem(path)?.deselect();
    const segments = selectedPath.split("/");
    for (let index = 1; index < segments.length; index++)
      directoryItem(model, segments.slice(0, index).join("/"))?.expand();
    model.getItem(selectedPath)?.select();
    model.scrollToPath(selectedPath, { offset: "center" });
    queueMicrotask(() => {
      syncingSelection.current = false;
    });
  }, [fileSet, model, selectedPath]);

  const toggleAll = () => {
    for (const path of directories) {
      const item = directoryItem(model, path);
      if (allExpanded) item?.collapse();
      else item?.expand();
    }
  };
  const refresh = () => {
    void client.invalidateQueries({
      queryKey: checkoutKey("workspace", checkout),
    });
    void client.invalidateQueries({ queryKey: checkoutKey("file", checkout) });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh workspace files"
          title={refreshing ? "Refreshing…" : "Refresh files"}
          onClick={refresh}
        >
          <RefreshIcon refreshing={refreshing} />
        </Button>
        <div
          data-slot="input-group"
          role="group"
          className="relative inline-flex w-full min-w-0 items-center rounded-[var(--control-radius)] border text-base text-foreground ring-ring/24 transition-shadow has-[input:focus-visible,textarea:focus-visible]:has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/64 has-[input:focus-visible,textarea:focus-visible]:has-[input[aria-invalid],textarea[aria-invalid]]:ring-destructive/16 has-[textarea]:h-auto has-data-[align=block-end]:h-auto has-data-[align=block-start]:h-auto has-data-[align=block-end]:flex-col has-data-[align=block-start]:flex-col has-[input:focus-visible,textarea:focus-visible]:border-ring has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/36 has-autofill:bg-foreground/4 has-[input:disabled,textarea:disabled]:opacity-64 has-[input:disabled,textarea:disabled,input:focus-visible,textarea:focus-visible,input[aria-invalid],textarea[aria-invalid]]:shadow-none has-[input:focus-visible,textarea:focus-visible]:ring-[3px] sm:text-sm dark:has-autofill:bg-foreground/8 dark:has-[input[aria-invalid],textarea[aria-invalid]]:ring-destructive/24 has-data-[align=inline-start]:**:[[data-size=sm]_input]:ps-1.5 has-data-[align=inline-end]:**:[[data-size=sm]_input]:pe-1.5 *:[[data-slot=input-control],[data-slot=textarea-control]]:contents *:[[data-slot=input-control],[data-slot=textarea-control]]:before:hidden has-[[data-align=block-start],[data-align=block-end]]:**:[input]:h-auto has-data-[align=inline-start]:**:[input]:ps-2 has-data-[align=inline-end]:**:[input]:pe-2 has-data-[align=block-end]:**:[input]:pt-1.5 has-data-[align=block-start]:**:[input]:pb-1.5 **:[textarea]:min-h-20.5 **:[textarea]:resize-none **:[textarea]:py-[calc(--spacing(3)-1px)] **:[textarea]:max-sm:min-h-23.5 **:[textarea_button]:rounded-[calc(var(--control-radius)-1px)] border-transparent bg-transparent shadow-none hover:bg-muted/40 has-[input:focus-visible,textarea:focus-visible]:bg-background h-7 min-w-0 flex-1"
        >
          <span data-size="sm" data-slot="input-control">
            <input
              data-slot="input"
              type="search"
              name="project-files-search"
              aria-label={`Search ${projectName} files`}
              placeholder="Search files"
              spellCheck={false}
              value={search.value}
              onChange={(event) => {
                const value = event.target.value;
                if (value.trim().length === 0) search.close();
                else search.setValue(value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                search.close();
                event.currentTarget.blur();
              }}
              className="h-7.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(2.5)-1px)] leading-7.5 outline-none placeholder:text-placeholder sm:h-6.5 sm:leading-6.5 [transition:background-color_5000000s_ease-in-out_0s] [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none"
            />
          </span>
        </div>
        {directories.length > 0 ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={
              allExpanded ? "Collapse all folders" : "Expand all folders"
            }
            title={allExpanded ? "Collapse all folders" : "Expand all folders"}
            onClick={toggleAll}
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
        aria-label={`${projectName} files`}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(theme)}
      />
    </div>
  );
}
