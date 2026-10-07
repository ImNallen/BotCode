// Ported from pingdotgg/t3code v0.0.45 components/Sidebar.tsx delete confirmation (MIT).
import { confirm } from "@tauri-apps/plugin-dialog";
import type { QueryClient } from "@tanstack/react-query";
import { ipc, type ThreadSummary } from "./ipc";
import { forgetThreadTerminals } from "./terminal/terminalStore";

export async function confirmAndDeleteThread(
  thread: Pick<ThreadSummary, "id" | "title">,
  client: QueryClient,
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
  const outcome = await ipc.deleteThread(thread.id);
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
