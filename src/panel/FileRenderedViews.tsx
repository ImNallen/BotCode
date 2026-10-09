// Copied from pingdotgg/t3code v0.0.45 components/files/FilePreviewPanel.tsx (WorkspaceImagePreview,
// WorkspaceAudioPreview, RenderedMarkdownSurface), files/FileMarkdownPreview.tsx, files/DelimitedTablePreview.tsx,
// files/BrowserDocumentFrame.tsx, files/AudioPreview.tsx and files/fileSurfaceChrome.tsx (MIT).
import { LoaderCircleIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  ChatMarkdown,
  FileLinkProvider,
  type FileLinks,
} from "../chat/ChatMarkdown";
import { setMarkdownTaskChecked } from "../chat/markdownTasks";
import { workspaceFileUrl, type CheckoutRef } from "../ipc";
import { ScrollRow } from "./chrome";
import { readFileDraft, setFileDraft } from "./fileDrafts";
import {
  parseDelimitedPreview,
  rebaseDocumentLink,
  resolveDocumentPath,
  type Delimiter,
} from "./filePreview";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

export function FileSurfaceNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-2xs text-warning-foreground"
    >
      {children}
    </div>
  );
}

export function FileSurfaceLoading() {
  return (
    <div
      role="status"
      aria-label="Loading file"
      className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"
    >
      <LoaderCircleIcon className="size-5 motion-safe:animate-spin" />
    </div>
  );
}

export function FileSurfaceFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs leading-relaxed"
    >
      <p className="text-destructive">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-input px-2.5 py-1 text-xs text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function WorkspaceImage({ src, alt }: { src: string; alt: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === src)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load workspace image.
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        className="max-h-full max-w-full object-contain"
        src={src}
        alt={alt}
        onError={() => setFailedUrl(src)}
      />
    </div>
  );
}

export function WorkspaceAudio({
  src,
  name,
  onRetry,
}: {
  src: string;
  name: string;
  onRetry: () => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (failedUrl === src)
    return (
      <FileSurfaceFailure
        message="Unable to load audio."
        onRetry={() => {
          setFailedUrl(null);
          onRetry();
        }}
      />
    );
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <audio
        controls
        preload="metadata"
        src={src}
        aria-label={name}
        className="w-full max-w-xl"
        onError={() => setFailedUrl(src)}
      />
    </div>
  );
}

/** An opaque-origin sandbox: the page runs scripts but cannot reach the app's session or storage. */
export function BrowserDocumentFrame({
  src,
  title,
}: {
  src: string;
  title: string;
}) {
  return (
    <iframe
      key={src}
      src={src}
      title={title}
      className="min-h-0 flex-1 border-0 bg-white"
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
    />
  );
}

export function DelimitedTable({
  name,
  text,
  delimiter,
}: {
  name: string;
  text: string;
  delimiter: Delimiter;
}) {
  const table = useMemo(
    () => parseDelimitedPreview(text, delimiter),
    [text, delimiter],
  );
  const [header, ...body] = table.rows;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {table.truncated ? (
        <FileSurfaceNotice>
          Table limited to the first 100 rows and 30 columns. Switch to source
          for the rest.
        </FileSurfaceNotice>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className="min-w-full border-separate border-spacing-0 text-xs"
          aria-label={name}
        >
          {header ? (
            <thead className="sticky top-0 z-10">
              <tr>
                {header.map((cell, columnIndex) => (
                  <th
                    key={columnIndex}
                    scope="col"
                    className="max-w-80 border-b border-border bg-muted/60 px-3 py-1.5 text-left align-bottom font-medium whitespace-pre-wrap break-words backdrop-blur"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex} className="even:bg-muted/30">
                {row.map((cell, columnIndex) => (
                  <td
                    key={columnIndex}
                    className="max-w-80 border-b border-border/60 px-3 py-1.5 align-top whitespace-pre-wrap break-words tabular-nums"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RenderedMarkdown({
  checkout,
  path,
  contents,
  fileLinks,
}: {
  checkout: CheckoutRef;
  path: string;
  contents: string;
  fileLinks: FileLinks;
}) {
  const saveCoordinator = useFileSaveCoordinator(checkout, path);
  const documentLinks = useMemo<FileLinks>(
    () => ({
      ...fileLinks,
      resolve: (target, source) => {
        const rebased = rebaseDocumentLink(path, target);
        return rebased === null ? null : fileLinks.resolve(rebased, source);
      },
    }),
    [fileLinks, path],
  );
  return (
    <ScrollRow className="min-h-0 flex-1" hideScrollbars={false}>
      <FileLinkProvider value={documentLinks}>
        <ChatMarkdown
          text={contents}
          className="mx-auto max-w-4xl px-6 py-5"
          imageSrc={(src) => {
            const image = resolveDocumentPath(path, src);
            return image === null
              ? undefined
              : workspaceFileUrl(checkout, image);
          }}
          onTaskListChange={({ markerOffset, checked }) => {
            const current = readFileDraft(checkout, path)?.contents ?? contents;
            const next = setMarkdownTaskChecked(current, markerOffset, checked);
            if (next === current) return;
            setFileDraft(checkout, path, next);
            saveCoordinator.change(next);
          }}
        />
      </FileLinkProvider>
    </ScrollRow>
  );
}
