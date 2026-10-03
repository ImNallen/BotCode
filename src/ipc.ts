import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
export const native = isTauri();
const id = z.uuid();
const reason = z.object({ kind: z.literal("unavailable"), reason: z.string() });
const session = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("draft") }),
  z.object({ kind: z.literal("connecting") }),
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("running") }),
  z.object({ kind: z.literal("interrupting") }),
  z.object({ kind: z.literal("dormant") }),
  reason,
]);
const delivery = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preparing") }),
  z.object({ kind: z.literal("sending") }),
  z.object({ kind: z.literal("accepted") }),
  z.object({ kind: z.literal("not_sent"), reason: z.string() }),
  z.object({ kind: z.literal("uncertain"), reason: z.string() }),
]);
const execution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_started") }),
  z.object({ kind: z.literal("running") }),
  z.object({ kind: z.literal("completed") }),
  z.object({ kind: z.literal("interrupted") }),
  z.object({ kind: z.literal("failed"), reason: z.string() }),
  z.object({ kind: z.literal("lost"), reason: z.string() }),
]);
const item = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("assistant"),
    id: z.string(),
    text: z.string(),
    complete: z.boolean(),
  }),
  z.object({
    kind: z.literal("command"),
    id: z.string(),
    command: z.string(),
    output: z.string(),
    status: z.string(),
  }),
  z.object({
    kind: z.literal("file_change"),
    id: z.string(),
    text: z.string(),
    status: z.string(),
  }),
  z.object({
    kind: z.literal("other"),
    id: z.string(),
    label: z.string(),
    text: z.string(),
  }),
]);
const approval = z.object({
  id,
  turnId: id,
  state: z.enum(["pending", "answering", "answered", "expired", "uncertain"]),
  action: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("command"),
      command: z.string(),
      cwd: z.string(),
      reason: z.string(),
    }),
    z.object({
      kind: z.literal("file_change"),
      text: z.string(),
      reason: z.string(),
    }),
  ]),
});
const workspace = z.object({ id, root: z.string(), label: z.string() });
const thread = z.object({
  id,
  workspaceId: id,
  title: z.string(),
  nativeThreadId: z.string().nullable(),
  revision: z.number(),
  session,
  turns: z.array(
    z.object({
      id,
      prompt: z.string(),
      nativeTurnId: z.string().nullable(),
      delivery,
      execution,
      items: z.array(item),
    }),
  ),
  approvals: z.array(approval),
  diagnostic: z.string().nullable(),
});
const workspaceView = z.object({
  workspace,
  branch: z.string(),
  files: z.array(z.string()),
  changes: z.array(
    z.object({
      path: z.string(),
      originalPath: z.string().nullable(),
      staged: z.boolean(),
      unstaged: z.boolean(),
      status: z.string(),
    }),
  ),
  threads: z.array(z.object({ id, title: z.string(), session })),
});
const file = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), name: z.string(), contents: z.string() }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);
const diff = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    old_name: z.string(),
    old_contents: z.string(),
    new_name: z.string(),
    new_contents: z.string(),
  }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);
export type Workspace = z.infer<typeof workspace>;
export type WorkspaceView = z.infer<typeof workspaceView>;
export type Thread = z.infer<typeof thread>;
export type Approval = z.infer<typeof approval>;
export type Item = z.infer<typeof item>;
export type ApprovalDecision = "accept" | "decline" | "cancel";
async function call<S extends z.ZodType>(
  command: string,
  args: Record<string, unknown>,
  schema: S,
): Promise<z.infer<S>> {
  try {
    const result: unknown = await invoke(command, args);
    return schema.parse(result);
  } catch (error: unknown) {
    const parsed = z.object({ message: z.string() }).safeParse(error);
    throw new Error(
      parsed.success
        ? parsed.data.message
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}
export const ipc = {
  workspaces: () => call("list_workspaces", {}, z.array(workspace)),
  openWorkspace: (path: string) => call("open_workspace", { path }, workspace),
  workspace: (workspaceId: string) =>
    call("workspace_view", { workspaceId }, workspaceView),
  file: (workspaceId: string, path: string) =>
    call("read_file", { workspaceId, path }, file),
  diff: (workspaceId: string, path: string, basis: "staged" | "unstaged") =>
    call("read_diff", { workspaceId, path, basis }, diff),
  create: (workspaceId: string) =>
    call("create_thread", { workspaceId }, thread),
  thread: (threadId: string) => call("thread_snapshot", { threadId }, thread),
  resume: (threadId: string) => call("open_thread", { threadId }, thread),
  submit: (threadId: string, text: string, requestId: string) =>
    call("submit", { threadId, text, requestId }, z.object({ turnId: id })),
  approval: (approvalId: string, decision: ApprovalDecision) =>
    call("answer_approval", { approvalId, decision }, z.null()),
  interrupt: (threadId: string) => call("interrupt", { threadId }, z.null()),
};
export async function subscribe(client: QueryClient): Promise<() => void> {
  const hints = new Set<string>();
  const workspaces = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (threadId?: string) => {
    if (threadId) hints.add(threadId);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      for (const threadId of hints)
        void client.invalidateQueries({ queryKey: ["thread", threadId] });
      hints.clear();
      for (const workspaceId of workspaces) {
        void client.invalidateQueries({ queryKey: ["workspace", workspaceId] });
        void client.invalidateQueries({ queryKey: ["file", workspaceId] });
        void client.invalidateQueries({ queryKey: ["diff", workspaceId] });
      }
      workspaces.clear();
    }, 160);
  };
  const offChanged = await listen<unknown>("z1:changed", (event) => {
    const hint = z
      .object({
        threadId: id,
        workspaceId: id,
        revision: z.number(),
        refreshWorkspace: z.boolean(),
      })
      .safeParse(event.payload);
    if (hint.success) {
      if (hint.data.refreshWorkspace) workspaces.add(hint.data.workspaceId);
      schedule(hint.data.threadId);
    }
  });
  const offRefresh = await listen("z1:refresh", () => {
    void client.invalidateQueries();
  });
  const focus = () => {
    void client.invalidateQueries();
  };
  window.addEventListener("focus", focus);
  return () => {
    offChanged();
    offRefresh();
    window.removeEventListener("focus", focus);
    if (timer) clearTimeout(timer);
  };
}

export function setThreadSnapshot(client: QueryClient, incoming: Thread): void {
  client.setQueryData<Thread>(["thread", incoming.id], (current) =>
    current && current.revision > incoming.revision ? current : incoming,
  );
}
