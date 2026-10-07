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
  if (fileUrl) path = path.slice("file://".length);
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
  const absolute = path.startsWith("/");
  const relative =
    absolute && root && path.startsWith(`${root}/`)
      ? path.slice(root.length + 1)
      : absolute
        ? null
        : path.replace(/^\.\//, "");
  if (relative !== null && files.has(relative))
    return { kind: "workspace", path: relative, ...at };
  if (absolute && threadId !== undefined && source === "href")
    return { kind: "external", threadId, path, ...at };
  return null;
}
