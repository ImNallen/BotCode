// Adapted from pingdotgg/t3code v0.0.45 state/projects.ts, state/filesystem.ts and Sidebar.logic.ts (MIT).
import type { BrowseDirectory, Workspace } from "../ipc";

export function newThreadDestination({
  scopeId,
  currentId,
  workspaces,
  scratchAvailable,
  shiftKey,
}: {
  scopeId?: string;
  currentId?: string;
  workspaces: readonly Workspace[];
  scratchAvailable: boolean;
  shiftKey: boolean;
}):
  | { kind: "workspace"; id: string }
  | { kind: "picker" | "scratch" | "unavailable" } {
  if (scopeId) return { kind: "workspace", id: scopeId };
  const repositories = workspaces.filter(
    (workspace) => workspace.kind === "repository",
  );
  if (!shiftKey && repositories.length > 1) return { kind: "picker" };
  const current = workspaces.find((workspace) => workspace.id === currentId);
  if (current?.kind === "scratch" && scratchAvailable)
    return { kind: "scratch" };
  const id = current?.id ?? repositories[0]?.id;
  if (id) return { kind: "workspace", id };
  return { kind: scratchAvailable ? "scratch" : "unavailable" };
}

export function browsePath(
  query: string,
  cwd: string | undefined,
):
  | { kind: "path"; directory: string; leaf: string; exact: string }
  | { kind: "error"; message: string } {
  const exact = query.trim();
  if (exact.startsWith("./") || exact.startsWith("../")) {
    if (!cwd)
      return {
        kind: "error",
        message: "Select a project to use a relative path.",
      };
  } else if (
    !exact.startsWith("/") &&
    !exact.startsWith("~/") &&
    exact !== "~"
  ) {
    return {
      kind: "error",
      message:
        "Enter an absolute path, ~/ path, or ./ or ../ path from the current project.",
    };
  }
  const normalized = exact === "~" ? "~/" : exact;
  const split = normalized.lastIndexOf("/") + 1;
  return {
    kind: "path",
    exact: normalized,
    directory: normalized.slice(0, split),
    leaf: normalized.slice(split),
  };
}

export function filterBrowseEntries(
  entries: BrowseDirectory["entries"],
  leaf: string,
) {
  const lowerQuery = leaf.toLowerCase();
  const showHidden = leaf.startsWith(".");
  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerQuery) &&
      (showHidden || !entry.name.startsWith(".")),
  );
}

export function directoryQuery(path: string) {
  return path.endsWith("/") ? path : `${path}/`;
}
