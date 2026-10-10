// Ported from pingdotgg/t3code v0.0.45 components/Sidebar.tsx delete confirmation (MIT).
import { confirm } from "@tauri-apps/plugin-dialog";
import type { QueryClient } from "@tanstack/react-query";
import { ipc, type ThreadSummary } from "./ipc";
import { forgetThreadTerminals } from "./terminal/terminalStore";

// Ported from T3 v0.0.45 worktreeCleanup.ts and hooks/useThreadActions.ts.
export function orphanedWorktreePath(
  thread: Pick<ThreadSummary, "id" | "checkout">,
  rows: readonly ThreadSummary[],
) {
  if (thread.checkout.kind !== "worktree") return null;
  const path = thread.checkout.path.trim();
  return path &&
    !rows.some(
      (other) =>
        other.id !== thread.id &&
        other.checkout.kind === "worktree" &&
        other.checkout.path.trim() === path,
    )
    ? path
    : null;
}
export function formatWorktreePathForDisplay(path: string) {
  const trimmed = path.trim();
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").at(-1)?.trim() || trimmed || path;
}
export async function manualWorktreePath(
  thread: Pick<ThreadSummary, "id" | "checkout">,
  automaticCleanup: boolean,
): Promise<string | null> {
  if (automaticCleanup || thread.checkout.kind !== "worktree") return null;
  const workspaces = await ipc.workspaces();
  const groups = await Promise.all(
    workspaces.map(async (workspace) => ({
      workspace,
      threads: await ipc.threadSummaries(workspace.id),
    })),
  );
  const owner = groups.find((group) =>
    group.threads.some((other) => other.id === thread.id),
  );
  if (owner?.workspace.kind !== "repository") return null;
  return orphanedWorktreePath(
    thread,
    groups.flatMap((group) => group.threads),
  );
}
export async function confirmAndDeleteThread(
  thread: Pick<ThreadSummary, "id" | "title" | "checkout">,
  client: QueryClient,
  automaticWorktreeCleanup: boolean,
) {
  if (
    !(await confirm(
      `Delete thread "${thread.title}"?\nThis permanently clears conversation history for this thread.`,
      {
        title: "Delete thread",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      },
    ))
  )
    return undefined;
  const path = await manualWorktreePath(thread, automaticWorktreeCleanup);
  const deleteWorktree =
    path !== null &&
    (await confirm(
      [
        "This thread is the only one linked to this worktree:",
        formatWorktreePathForDisplay(path),
        "",
        "Delete the worktree too?",
      ].join("\n"),
      {
        title: "Delete worktree",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Keep",
      },
    ));
  const outcome = await ipc.deleteThread(thread.id, deleteWorktree);
  forgetThreadTerminals(thread.id);
  client.removeQueries({
    predicate: (query) => query.queryKey.includes(thread.id),
  });
  await Promise.all([
    client.invalidateQueries({ queryKey: ["workspace"] }),
    client.invalidateQueries({ queryKey: ["thread-summaries"] }),
  ]);
  return outcome;
}

export async function restoreThread(threadId: string, client: QueryClient) {
  await ipc.arrange(threadId, { kind: "unarchive" });
  await Promise.all([
    client.invalidateQueries({ queryKey: ["thread-summaries"] }),
    client.invalidateQueries({ queryKey: ["workspace"] }),
  ]);
}
