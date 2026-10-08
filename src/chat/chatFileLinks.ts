type Position = { line?: number; column?: number };
export type ChatFileLink =
  | ({ kind: "workspace"; path: string } & Position)
  // An absolute path outside the checkout, opened through the thread that named it.
  | ({ kind: "external"; threadId: string; path: string } & Position);

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

// Windows paths compare without case and may mix separators.
function within(path: string, root: string): string | null {
  if (!WINDOWS_ABSOLUTE.test(root))
    return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
  const slashed = path.replaceAll("\\", "/");
  const prefix = `${root.replaceAll("\\", "/").replace(/\/$/, "")}/`;
  return slashed.toLowerCase().startsWith(prefix.toLowerCase())
    ? slashed.slice(prefix.length)
    : null;
}

// Inline code stays a chip only for files in the checkout. A link href in a
// sent thread may also name an absolute path elsewhere.
export function parseChatFileLink(
  raw: string,
  {
    files,
    root,
    source,
    threadId,
  }: {
    files: ReadonlySet<string>;
    root: string | undefined;
    source: "code" | "href";
    threadId: string | undefined;
  },
): ChatFileLink | null {
  let path = raw.trim();
  const fileUrl = /^file:\/\//i.test(path);
  if (fileUrl)
    path = path.slice("file://".length).replace(/^\/(?=[A-Za-z]:\/)/, "");
  if (source === "href" || fileUrl) path = decode(path);
  let line: number | undefined;
  let column: number | undefined;
  const position =
    /#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/.exec(path) ??
    /:(\d+)(?::(\d+))?$/.exec(path);
  if (position) {
    path = path.slice(0, position.index);
    line = Number(position[1]) || undefined;
    if (line && position[2]) column = Number(position[2]) || undefined;
  }
  const at = {
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
  const absolute = path.startsWith("/") || WINDOWS_ABSOLUTE.test(path);
  const relative = absolute
    ? root
      ? within(path, root)
      : null
    : path.replace(/^\.[\\/]/, "").replaceAll("\\", "/");
  if (relative !== null && files.has(relative))
    return { kind: "workspace", path: relative, ...at };
  if (absolute && threadId !== undefined && source === "href")
    return { kind: "external", threadId, path, ...at };
  return null;
}
