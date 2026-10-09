// File surface copied from pingdotgg/t3code v0.0.45 components/files/FilePreviewPanel.tsx, files/FileBreadcrumbs.tsx, files/ReadOnlySourcePreview.tsx and files/fileSurfaceChrome.tsx (MIT).
import { Editor } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  Code2Icon,
  EyeIcon,
  FolderTreeIcon,
  Table2Icon,
  WrapTextIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  workspaceFileUrl,
  workspaceTarget,
  type CheckoutRef,
  type WorkspaceView,
} from "../ipc";
import type { FileLinks } from "../chat/ChatMarkdown";
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
  fileContentRevision,
  fileEditorCacheKey,
  type EditorFileIdentity,
} from "./fileContentRevision";
import { fileQuery, setFileDraft, useFileDraft } from "./fileDrafts";
import { FileEntryIcon } from "./FileEntryIcon";
import {
  fileContent,
  fileKind,
  fileSurfaceView,
  isRevealPending,
  RENDER_PREFERENCES,
  renderedMode,
  type FileBody as FileBodyKind,
  type HandledReveal,
  type RenderToggle,
} from "./filePreview";
import {
  BrowserDocumentFrame,
  DelimitedTable,
  FileSurfaceFailure,
  FileSurfaceLoading,
  RenderedMarkdown,
  WorkspaceAudio,
  WorkspaceImage,
} from "./FileRenderedViews";
import { clampFileLine, useFileLineReveal } from "./fileLineReveal";
import { FileExplorer } from "./FileExplorer";
import { pathBasename } from "../chat/composer-logic";
import { FILE_VIEW_UNSAFE_CSS } from "./surfaceCss";
import {
  claimFileEditState,
  fileEditStateKey,
  isFileEditor,
} from "./retainedEditState";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";
import type { SelectedLineRange } from "@pierre/diffs";
import { useComposerContext } from "../chat/ComposerContextProvider";
import { buildFileReviewContext } from "./composerReviewContext";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import {
  applyMovedAnnotations,
  fileCommentAnnotations,
  formatFileCommentRange,
  movedFileCommentDraft,
  nextFileCommentId,
  normalizeFileCommentRange,
  savedFileComments,
  type FileCommentAnnotationGroup,
  type FileCommentDraftAnchor,
} from "./fileComments";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import { useResolvedTheme, type ResolvedTheme } from "./useResolvedTheme";

const FILE_SURFACE_SUBHEADER_CLASS =
  "flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent";

export const WORD_WRAP_KEY = "z1.wordWrap";

const TOGGLE_ICONS: Record<RenderToggle["icon"], React.ReactNode> = {
  code: <Code2Icon className="size-3.5" />,
  table: <Table2Icon className="size-3.5" />,
  eye: <EyeIcon className="size-3.5" />,
};

export function FilesSurface({
  checkout,
  view,
  path,
  line,
  revealSequence,
  onOpenFile,
  fileLinks,
}: {
  checkout: CheckoutRef;
  view: WorkspaceView | undefined;
  path: string | null;
  line: number | null;
  revealSequence: number;
  onOpenFile: (path: string) => void;
  fileLinks: FileLinks;
}) {
  const [explorerOpen, setExplorerOpen] = useStoredState(
    "z1.fileExplorerOpen",
    storedFlag(true),
  );
  const [wordWrap, setWordWrap] = useStoredState(
    WORD_WRAP_KEY,
    storedFlag(true),
  );
  const preferences = {
    markdown: useStoredState(
      RENDER_PREFERENCES.markdown.key,
      storedFlag(RENDER_PREFERENCES.markdown.fallback),
    ),
    table: useStoredState(
      RENDER_PREFERENCES.table.key,
      storedFlag(RENDER_PREFERENCES.table.fallback),
    ),
    html: useStoredState(
      RENDER_PREFERENCES.html.key,
      storedFlag(RENDER_PREFERENCES.html.fallback),
    ),
  };
  const [handledReveal, setHandledReveal] = useState<HandledReveal | null>(
    null,
  );
  const draft = useFileDraft(checkout, path ?? "");
  const read = useCachedFileRead(checkout, path ?? "");
  const kind = path === null ? null : fileKind(path);
  const mode = kind && renderedMode(kind);
  const surface =
    path === null || kind === null
      ? null
      : fileSurfaceView(kind, {
          preferred: mode ? preferences[mode][0] : false,
          revealPending: isRevealPending(
            line,
            handledReveal,
            path,
            revealSequence,
          ),
          textShown: fileContent(draft, read).kind === "text",
        });
  const toggle = surface?.toggle;
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
          {toggle ? (
            <SurfaceAction
              label={toggle.label}
              pressed={toggle.rendered}
              onPress={() => {
                const pressed = !toggle.rendered;
                preferences[toggle.mode][1](pressed);
                setHandledReveal(
                  pressed ? { path, sequence: revealSequence } : null,
                );
              }}
            >
              {TOGGLE_ICONS[toggle.icon]}
            </SurfaceAction>
          ) : null}
          {surface?.wordWrap ? (
            <SurfaceAction
              label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
              pressed={wordWrap}
              onPress={() => setWordWrap(!wordWrap)}
            >
              <WrapTextIcon className="size-3.5" />
            </SurfaceAction>
          ) : null}
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
          {path && surface ? (
            <FileBody
              key={`${checkout.workspaceId}:${checkout.threadId}:${path}`}
              checkout={checkout}
              path={path}
              body={surface.body}
              line={line}
              revealSequence={revealSequence}
              wordWrap={wordWrap}
              fileLinks={fileLinks}
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

function useCachedFileRead(checkout: CheckoutRef, path: string) {
  return useQuery({ ...fileQuery(checkout, path), enabled: false });
}

function useStableByContent<T>(value: T): T {
  const key = JSON.stringify(value);
  const stable = useRef({ key, value });
  if (stable.current.key !== key) stable.current = { key, value };
  return stable.current.value;
}

function FileBody({
  checkout,
  path,
  body,
  line,
  revealSequence,
  wordWrap,
  fileLinks,
}: {
  checkout: CheckoutRef;
  path: string;
  body: FileBodyKind;
  line: number | null;
  revealSequence: number;
  wordWrap: boolean;
  fileLinks: FileLinks;
}): React.ReactElement {
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
  const content = fileContent(draft, file);
  const retry = () => void file.refetch();
  if (body.kind === "frame")
    return content.kind === "pending" ? (
      <FileSurfaceLoading />
    ) : (
      <BrowserDocumentFrame
        src={workspaceFileUrl(
          checkout,
          path,
          content.kind === "text" && content.confirmedDisk !== null
            ? fileContentRevision(content.confirmedDisk)
            : undefined,
        )}
        title={path}
      />
    );
  switch (content.kind) {
    case "pending":
      return <FileSurfaceLoading />;
    case "failure":
      return <FileSurfaceFailure message={content.reason} onRetry={retry} />;
    case "media": {
      const src = workspaceFileUrl(checkout, path, content.revision);
      return body.kind === "audio" ? (
        <WorkspaceAudio src={src} name={path} onRetry={retry} />
      ) : (
        <WorkspaceImage src={src} alt={path} />
      );
    }
    case "text":
      if (body.kind === "markdown")
        return (
          <RenderedMarkdown
            checkout={checkout}
            path={path}
            contents={content.contents}
            fileLinks={fileLinks}
          />
        );
      if (body.kind === "table")
        return (
          <DelimitedTable
            name={path}
            text={content.contents}
            delimiter={body.delimiter}
          />
        );
      return (
        <EditableSource
          key={`${path}:${theme}`}
          checkout={checkout}
          path={path}
          contents={content.contents}
          line={
            file.isFetching || readSequence !== revealSequence ? null : line
          }
          revealSequence={revealSequence}
          theme={theme}
          wordWrap={wordWrap}
        />
      );
  }
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
  const composer = useComposerContext();
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
  const onPostRender = useFileLineReveal<FileCommentAnnotationGroup>(
    path,
    line,
    revealSequence,
  );
  const editorRef =
    useRef<Pick<Editor<"file">, "setSelections" | "blur">>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    revealSequence: number;
    range: SelectedLineRange | null;
  } | null>(null);
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) =>
      setSelection({ revealSequence, range }),
    [revealSequence],
  );
  const [draft, setDraft] = useState<FileCommentDraftAnchor | null>(null);
  const [draftText, setDraftText] = useState("");
  const saved = useStableByContent(
    savedFileComments(composer?.records ?? [], path),
  );
  const lineAnnotations = useMemo(
    () => fileCommentAnnotations(saved, draft),
    [saved, draft],
  );
  const commenting = draft === null && composer !== null;
  const beginComment = useCallback((range: SelectedLineRange) => {
    editorRef.current?.setSelections([]);
    editorRef.current?.blur();
    setDraft({ id: nextFileCommentId(), ...normalizeFileCommentRange(range) });
    setDraftText("");
  }, []);
  const onLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectedRange(range);
      if (range) beginComment(range);
    },
    [beginComment, setSelectedRange],
  );
  const drafting = draft !== null;
  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    return installFileEditorDismissal({
      root,
      editor: {
        setSelections: (selections) =>
          editorRef.current?.setSelections(selections),
      },
      isBlocked: () => drafting,
      onDismiss: () => setSelectedRange(null),
    });
  }, [drafting, setSelectedRange]);
  return (
    <EditProvider<FileCommentAnnotationGroup>
      createEditor={(type, options, key) => {
        let editor = new Editor(type, options, key);
        if (key !== undefined && isFileEditor(editor)) {
          const claim = claimFileEditState(
            editor,
            key,
            editorFile.current?.contents ?? contents,
          );
          if (claim === "busy" || claim === "failed")
            editor = new Editor(type, options);
        }
        editorRef.current = editor;
        return editor;
      }}
    >
      <div ref={surfaceRef} className="flex min-h-0 flex-1">
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
        >
          <File<FileCommentAnnotationGroup>
            file={sourceFile}
            editStateKey={fileEditStateKey(checkout, path)}
            selectedLines={
              selection?.revealSequence === revealSequence
                ? selection.range
                : line === null
                  ? null
                  : {
                      start: clampFileLine(contents, line),
                      end: clampFileLine(contents, line),
                    }
            }
            edit
            onEditChange={({ file, lineAnnotations: moved }) => {
              if (moved) {
                for (const record of applyMovedAnnotations(
                  saved,
                  moved,
                  file.contents,
                ))
                  composer?.replace(record);
                setDraft((current) => movedFileCommentDraft(current, moved));
              }
              const current = editorFile.current;
              if (!current || file.contents === current.contents) return;
              editorFile.current = { ...current, contents: file.contents };
              setFileDraft(checkout, path, file.contents);
              saveCoordinator.change(file.contents);
            }}
            options={{
              disableFileHeader: true,
              enableGutterUtility: commenting,
              enableLineSelection: commenting,
              onGutterUtilityClick: setSelectedRange,
              onLineSelectionChange: setSelectedRange,
              onLineSelectionEnd,
              onPostRender,
              overflow: wordWrap ? "wrap" : "scroll",
              theme: theme === "dark" ? "pierre-dark" : "pierre-light",
              themeType: theme,
              unsafeCSS: FILE_VIEW_UNSAFE_CSS,
            }}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <div className="py-1">
                {annotation.metadata.entries.map((entry) =>
                  entry.kind === "draft" ? (
                    <DiffCommentAnnotation
                      key={entry.id}
                      kind="draft"
                      rangeLabel={formatFileCommentRange(
                        entry.startLine,
                        entry.endLine,
                      )}
                      text={draftText}
                      onTextChange={setDraftText}
                      pending={composer === null}
                      onCancel={() => {
                        setSelectedRange(null);
                        setDraft(null);
                      }}
                      onComment={(text) => {
                        setSelectedRange(null);
                        if (
                          composer?.upsert(
                            buildFileReviewContext({
                              contextId: entry.id,
                              filePath: path,
                              startLine: entry.startLine,
                              endLine: entry.endLine,
                              text,
                              contents:
                                editorFile.current?.contents ?? contents,
                            }),
                          )
                        )
                          setDraft(null);
                      }}
                    />
                  ) : (
                    <DiffCommentAnnotation
                      key={entry.id}
                      kind="comment"
                      text={entry.text}
                      onDelete={() => {
                        setSelectedRange(null);
                        composer?.remove(entry.id);
                      }}
                    />
                  ),
                )}
              </div>
            )}
            className="min-h-full"
          />
        </Virtualizer>
      </div>
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
