// Ported from pingdotgg/t3code v0.0.45 packages/shared/src/filePreview.ts, packages/shared/src/delimitedPreview.ts,
// apps/web/src/components/files/filePreviewMode.ts and files/FilePreviewPanel.tsx (MIT).
import type { FileRead } from "../ipc";
import type { FileDraft } from "./fileDrafts";

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
] as const;
export const WORKSPACE_AUDIO_PREVIEW_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".ogg",
  ".oga",
  ".flac",
  ".aac",
  ".m4a",
  ".opus",
  ".aiff",
] as const;

export type Delimiter = "," | "\t";
export type RenderedMode = "markdown" | "table" | "html";

export type FileKind =
  | { readonly kind: "image" }
  | { readonly kind: "audio" }
  | { readonly kind: "markdown" }
  | { readonly kind: "table"; readonly delimiter: Delimiter }
  | { readonly kind: "html" }
  | { readonly kind: "source" };

export type FileBody =
  | { readonly kind: "image" }
  | { readonly kind: "audio" }
  | { readonly kind: "markdown" }
  | { readonly kind: "table"; readonly delimiter: Delimiter }
  | { readonly kind: "frame" }
  | { readonly kind: "editor" };

export type RenderToggle = {
  readonly mode: RenderedMode;
  readonly rendered: boolean;
  readonly label: string;
  readonly icon: "code" | "table" | "eye";
};

export type FileSurfaceView = {
  readonly body: FileBody;
  readonly toggle: RenderToggle | null;
  readonly wordWrap: boolean;
};

export const RENDER_PREFERENCES: Record<
  RenderedMode,
  { readonly key: string; readonly fallback: boolean }
> = {
  markdown: { key: "z1.renderMarkdown", fallback: false },
  table: { key: "z1.renderTable", fallback: true },
  html: { key: "z1.renderBrowserFile", fallback: true },
};

const hasExtension = (path: string, extensions: readonly string[]) => {
  const lower = path.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
};

export function fileKind(path: string): FileKind {
  if (hasExtension(path, WORKSPACE_AUDIO_PREVIEW_EXTENSIONS))
    return { kind: "audio" };
  if (hasExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS))
    return { kind: "image" };
  if (/\.(?:md|mdx)$/i.test(path)) return { kind: "markdown" };
  if (/\.csv$/i.test(path)) return { kind: "table", delimiter: "," };
  if (/\.tsv$/i.test(path)) return { kind: "table", delimiter: "\t" };
  if (/\.html?$/i.test(path)) return { kind: "html" };
  return { kind: "source" };
}

export function renderedMode(kind: FileKind): RenderedMode | null {
  return kind.kind === "markdown" ||
    kind.kind === "table" ||
    kind.kind === "html"
    ? kind.kind
    : null;
}

function renderedToggleLabel(mode: RenderedMode, rendered: boolean): string {
  if (mode === "markdown")
    return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

export type HandledReveal = {
  readonly path: string;
  readonly sequence: number;
};

export const isRevealPending = (
  line: number | null,
  handled: HandledReveal | null,
  path: string,
  sequence: number,
) =>
  line !== null && !(handled?.path === path && handled.sequence === sequence);

export function fileSurfaceView(
  kind: FileKind,
  state: {
    readonly preferred: boolean;
    readonly revealPending: boolean;
    readonly textShown: boolean;
  },
): FileSurfaceView {
  if (kind.kind === "image" || kind.kind === "audio")
    return { body: kind, toggle: null, wordWrap: false };
  const source: FileSurfaceView = {
    body: { kind: "editor" },
    toggle: null,
    wordWrap: state.textShown,
  };
  if (kind.kind === "source") return source;
  const mode = kind.kind;
  const rendered = state.preferred && !state.revealPending;
  const toggle: RenderToggle = {
    mode,
    rendered,
    label: renderedToggleLabel(mode, rendered),
    icon: rendered ? "code" : mode === "table" ? "table" : "eye",
  };
  if (!rendered) return { ...source, toggle };
  return {
    body: kind.kind === "html" ? { kind: "frame" } : kind,
    toggle,
    wordWrap: false,
  };
}

export function parseDelimitedPreview(text: string, delimiter: Delimiter) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let truncated = false;
  let rowStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endCell = () => {
    if (row.length < 30) row.push(cell);
    else truncated = true;
    cell = "";
  };
  for (let index = rowStart; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        if (cell.length < 2000) cell += '"';
        else truncated = true;
        index++;
        continue;
      }
      if (quoted || cell === "") {
        quoted = !quoted;
        continue;
      }
    }
    if (!quoted && (char === delimiter || char === "\n" || char === "\r")) {
      endCell();
      if (char !== delimiter) {
        rows.push(row);
        row = [];
        if (char === "\r" && text[index + 1] === "\n") index++;
        rowStart = index + 1;
        if (rows.length === 100)
          return { rows, truncated: truncated || index < text.length - 1 };
      }
    } else if (cell.length < 2000) cell += char;
    else truncated = true;
  }
  if (rowStart < text.length) {
    endCell();
    rows.push(row);
  }
  return { rows, truncated: truncated || quoted };
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function joinDocumentPath(documentPath: string, target: string): string | null {
  const segments = target.startsWith("/")
    ? []
    : documentPath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return null;
  }
  return segments.length > 0 ? segments.join("/") : null;
}

export function resolveDocumentPath(
  documentPath: string,
  target: string,
): string | null {
  const source = target.trim();
  if (source === "" || SCHEME.test(source) || /^(?:\/\/|#)/.test(source))
    return null;
  const path = source.split(/[?#]/, 1)[0] ?? "";
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {}
  return joinDocumentPath(documentPath, decoded);
}

export function rebaseDocumentLink(
  documentPath: string,
  target: string,
): string | null {
  const trimmed = target.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("#") ||
    SCHEME.test(trimmed)
  )
    return target;
  const hash = trimmed.indexOf("#");
  const path = hash === -1 ? trimmed : trimmed.slice(0, hash);
  const joined = joinDocumentPath(documentPath, path.replaceAll("\\", "/"));
  return joined === null
    ? null
    : joined + (hash === -1 ? "" : trimmed.slice(hash));
}

export type FileContent =
  | { readonly kind: "pending" }
  | { readonly kind: "failure"; readonly reason: string }
  | {
      readonly kind: "text";
      readonly contents: string;
      readonly confirmedDisk: string | null;
    }
  | { readonly kind: "media"; readonly revision: string };

export function fileContent(
  draft: FileDraft | undefined,
  query: {
    readonly data: FileRead | undefined;
    readonly error: Error | null;
    readonly isPending: boolean;
  },
): FileContent {
  const data = query.error ? undefined : query.data;
  const confirmedDisk = data?.kind === "text" ? data.contents : null;
  if (draft) return { kind: "text", contents: draft.contents, confirmedDisk };
  if (confirmedDisk !== null)
    return { kind: "text", contents: confirmedDisk, confirmedDisk };
  if (data?.kind === "media") return { kind: "media", revision: data.revision };
  if (query.error) return { kind: "failure", reason: query.error.message };
  if (data?.kind === "unavailable")
    return { kind: "failure", reason: data.reason };
  return { kind: "pending" };
}
