// File surface copied from pingdotgg/t3code v0.0.45 components/files/FilePreviewPanel.tsx, files/FileBreadcrumbs.tsx, files/ReadOnlySourcePreview.tsx and files/fileSurfaceChrome.tsx (MIT).
import { Editor } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FolderTreeIcon,
  LoaderCircleIcon,
  WrapTextIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { workspaceTarget, type CheckoutRef, type WorkspaceView } from "../ipc";
import { OpenInPicker } from "../chat/OpenInPicker";
import { cn } from "../lib/cn";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import {
  MenuRadioItem,
  ScrollRow,
  storedFlag,
  SurfaceAction,
  useStoredState,
} from "./chrome";
import {
  fileEditorCacheKey,
  type EditorFileIdentity,
} from "./fileContentRevision";
import { fileQuery, setFileDraft, useFileDraft } from "./fileDrafts";
import { FileEntryIcon } from "./FileEntryIcon";
import { clampFileLine, useFileLineReveal } from "./fileLineReveal";
import { FileExplorer } from "./FileExplorer";
import { pathBasename } from "../chat/composer-logic";
import { FILE_VIEW_UNSAFE_CSS } from "./surfaceCss";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";
import { useResolvedTheme, type ResolvedTheme } from "./useResolvedTheme";

const FILE_SURFACE_SUBHEADER_CLASS =
  "flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent";

export const WORD_WRAP_KEY = "z1.wordWrap";

export function FilesSurface({
  checkout,
  view,
  path,
  line,
  revealSequence,
  onOpenFile,
}: {
  checkout: CheckoutRef;
  view: WorkspaceView | undefined;
  path: string | null;
  line: number | null;
  revealSequence: number;
  onOpenFile: (path: string) => void;
}) {
  const [explorerOpen, setExplorerOpen] = useStoredState(
    "z1.fileExplorerOpen",
    storedFlag(true),
  );
  const [wordWrap, setWordWrap] = useStoredState(
    WORD_WRAP_KEY,
    storedFlag(true),
  );
  const files = view?.files ?? [];
  const projectName = view?.workspace.label ?? "";
  const showExplorer = explorerOpen || path === null;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {view?.fileCoverage.kind === "limited" ? (
        <p
          role="status"
          className="border-b px-3 py-2 text-xs text-muted-foreground"
        >
          {view.fileCoverage.reason}
        </p>
      ) : null}
      {path ? (
        <div className={FILE_SURFACE_SUBHEADER_CLASS} data-surface-subheader>
          <ScrollRow className="min-w-0 flex-1" data-file-breadcrumbs>
            <div className="flex h-full w-max min-w-full items-center text-xs">
              <FileBreadcrumbs
                files={files}
                projectName={projectName}
                path={path}
                onOpenFile={onOpenFile}
              />
            </div>
          </ScrollRow>
          <OpenInPicker target={workspaceTarget(checkout, path)} compact />
          <SurfaceAction
            label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
            pressed={wordWrap}
            onPress={() => setWordWrap(!wordWrap)}
          >
            <WrapTextIcon className="size-3.5" />
          </SurfaceAction>
          <SurfaceAction
            label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
            pressed={explorerOpen}
            onPress={() => setExplorerOpen(!explorerOpen)}
          >
            <FolderTreeIcon className="size-3.5" />
          </SurfaceAction>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden",
            path ? "flex" : "hidden",
          )}
        >
          {path ? (
            <SourceView
              key={`${checkout.workspaceId}:${checkout.threadId}:${path}`}
              checkout={checkout}
              path={path}
              line={line}
              revealSequence={revealSequence}
              wordWrap={wordWrap}
            />
          ) : null}
        </div>
        {showExplorer ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-background",
              path
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <FileExplorer
              checkout={checkout}
              projectName={projectName}
              files={files}
              selectedPath={path}
              onOpenFile={onOpenFile}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function SourceView({
  checkout,
  path,
  line,
  revealSequence,
  wordWrap,
}: {
  checkout: CheckoutRef;
  path: string;
  line: number | null;
  revealSequence: number;
  wordWrap: boolean;
}) {
  const theme = useResolvedTheme();
  const draft = useFileDraft(checkout, path);
  const file = useQuery({
    ...fileQuery(checkout, path),
    refetchOnMount: "always",
  });
  const [readSequence, setReadSequence] = useState(revealSequence);
  useEffect(() => {
    if (readSequence === revealSequence) return;
    let active = true;
    void file.refetch().then(() => {
      if (active) setReadSequence(revealSequence);
    });
    return () => {
      active = false;
    };
  }, [revealSequence]);
  const contents =
    draft?.contents ??
    (!file.error && file.data?.kind === "text" ? file.data.contents : null);
  if (contents !== null)
    return (
      <EditableSource
        key={`${path}:${theme}`}
        checkout={checkout}
        path={path}
        contents={contents}
        line={file.isFetching || readSequence !== revealSequence ? null : line}
        revealSequence={revealSequence}
        theme={theme}
        wordWrap={wordWrap}
      />
    );
  if (file.isPending)
    return (
      <div
        role="status"
        aria-label="Loading file"
        className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"
      >
        <LoaderCircleIcon className="size-5 motion-safe:animate-spin" />
      </div>
    );
  const failure = file.error
    ? file.error.message
    : file.data.kind === "unavailable"
      ? file.data.reason
      : null;
  return (
    <div
      role="alert"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs leading-relaxed"
    >
      <p className="text-destructive">{failure}</p>
      <button
        type="button"
        onClick={() => void file.refetch()}
        className="rounded-md border border-input px-2.5 py-1 text-xs text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        Try again
      </button>
    </div>
  );
}

function EditableSource({
  checkout,
  path,
  contents,
  line,
  revealSequence,
  theme,
  wordWrap,
}: {
  checkout: CheckoutRef;
  path: string;
  contents: string;
  line: number | null;
  revealSequence: number;
  theme: ResolvedTheme;
  wordWrap: boolean;
}) {
  const saveCoordinator = useFileSaveCoordinator(checkout, path);
  // Written during render because the editor adopts a changed file, and
  // reports that adoption as an edit, in File's layout effect, which runs
  // before this component's effects.
  const editorFile = useRef<EditorFileIdentity | undefined>(undefined);
  const cacheKey = fileEditorCacheKey(
    checkout,
    path,
    contents,
    editorFile.current,
  );
  editorFile.current = { cacheKey, contents };
  const sourceFile = useMemo(
    () => ({ name: path, contents, cacheKey }),
    [path, contents, cacheKey],
  );
  const onPostRender = useFileLineReveal(path, line, revealSequence);
  return (
    <EditProvider createEditor={(type, options) => new Editor(type, options)}>
      <Virtualizer
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        <File
          file={sourceFile}
          selectedLines={
            line === null
              ? null
              : {
                  start: clampFileLine(contents, line),
                  end: clampFileLine(contents, line),
                }
          }
          edit
          onEditChange={({ file }) => {
            const current = editorFile.current;
            if (!current || file.contents === current.contents) return;
            editorFile.current = { ...current, contents: file.contents };
            setFileDraft(checkout, path, file.contents);
            saveCoordinator.change(file.contents);
          }}
          options={{
            disableFileHeader: true,
            onPostRender,
            overflow: wordWrap ? "wrap" : "scroll",
            theme: theme === "dark" ? "pierre-dark" : "pierre-light",
            themeType: theme,
            unsafeCSS: FILE_VIEW_UNSAFE_CSS,
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </EditProvider>
  );
}

type Entry = { path: string; label: string; kind: "file" | "directory" };

function childrenOf(files: readonly string[], directory: string): Entry[] {
  const prefix = directory ? `${directory}/` : "";
  const entries = new Map<string, Entry>();
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf("/");
    const label = slash === -1 ? rest : rest.slice(0, slash);
    entries.set(label, {
      path: prefix + label,
      label,
      kind: slash === -1 ? "file" : "directory",
    });
  }
  return [...entries.values()].sort((a, b) =>
    a.kind === b.kind
      ? a.label.localeCompare(b.label)
      : a.kind === "directory"
        ? -1
        : 1,
  );
}

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

function FileBreadcrumbs({
  files,
  projectName,
  path,
  onOpenFile,
}: {
  files: readonly string[];
  projectName: string;
  path: string;
  onOpenFile: (path: string) => void;
}) {
  const segments = path.split("/");
  const crumbs = [
    { path: "", label: projectName },
    ...segments.slice(0, -1).map((label, index) => ({
      path: segments.slice(0, index + 1).join("/"),
      label,
    })),
  ];
  return (
    <>
      {crumbs.map((crumb, index) => (
        <div
          key={crumb.path || "project"}
          className="flex min-w-0 shrink-0 items-center"
        >
          {index > 0 ? (
            <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
          ) : null}
          <DirectoryCrumb
            files={files}
            projectName={projectName}
            crumb={crumb}
            currentFile={path}
            onOpenFile={onOpenFile}
          />
        </div>
      ))}
      <div
        className="flex min-w-0 shrink-0 items-center"
        data-current-file-crumb
      >
        <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
        <span aria-current="page">
          <span
            title={path}
            className="block max-w-40 truncate rounded-sm px-0.5 font-medium text-foreground"
          >
            {pathBasename(path)}
          </span>
        </span>
      </div>
    </>
  );
}

function DirectoryCrumb({
  files,
  projectName,
  crumb,
  currentFile,
  onOpenFile,
}: {
  files: readonly string[];
  projectName: string;
  crumb: { path: string; label: string };
  currentFile: string;
  onOpenFile: (path: string) => void;
}) {
  const [directory, setDirectory] = useState(crumb.path);
  const children = useMemo(
    () => childrenOf(files, directory),
    [files, directory],
  );
  const canGoBack = directory !== crumb.path;
  const parent = parentOf(directory);
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) setDirectory(crumb.path);
      }}
      trigger={({ ref, ...props }) => (
        <button
          ref={ref}
          type="button"
          aria-label={`Browse ${crumb.label}`}
          title={crumb.path || projectName}
          className="relative block max-w-40 cursor-pointer rounded-sm px-0.5 text-left text-muted-foreground outline-none pointer-coarse:after:-inset-y-3 pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
          {...props}
        >
          <span className="block truncate">{crumb.label}</span>
        </button>
      )}
    >
      {canGoBack ? (
        <>
          <MenuItem data-keep-open onClick={() => setDirectory(parent)}>
            <ArrowLeftIcon />
            <span className="truncate">
              Back to {parent ? pathBasename(parent) : projectName}
            </span>
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      {children.length === 0 ? (
        <MenuItem disabled>This folder is empty.</MenuItem>
      ) : (
        children.map((entry) =>
          entry.kind === "directory" ? (
            <MenuItem
              key={entry.path}
              data-keep-open
              onClick={() => setDirectory(entry.path)}
            >
              <FileEntryIcon path={entry.path} kind="directory" />
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              <ChevronRightIcon />
            </MenuItem>
          ) : (
            <MenuRadioItem
              key={entry.path}
              checked={entry.path === currentFile}
              aria-current={entry.path === currentFile ? "page" : undefined}
              title={entry.path}
              onClick={() => onOpenFile(entry.path)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileEntryIcon path={entry.path} />
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              </span>
            </MenuRadioItem>
          ),
        )
      )}
    </Menu>
  );
}
