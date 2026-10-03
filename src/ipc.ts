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
    paths: z.array(z.string()),
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
const permissionMode = z.enum([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
const settings = z.object({
  model: z.string().nullable(),
  effort: z.string().nullable(),
  permissionMode,
});
const modelOption = z.object({
  model: z.string(),
  displayName: z.string(),
  description: z.string(),
  isDefault: z.boolean(),
  defaultReasoningEffort: z.string(),
  supportedReasoningEfforts: z.array(
    z.object({ reasoningEffort: z.string(), description: z.string() }),
  ),
});
const checkout = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("worktree"),
    path: z.string(),
    branch: z.string(),
  }),
]);
const thread = z.object({
  id,
  workspaceId: id,
  title: z.string(),
  nativeThreadId: z.string().nullable(),
  revision: z.number(),
  session,
  settings,
  checkout,
  turns: z.array(
    z.object({
      id,
      prompt: z.string(),
      nativeTurnId: z.string().nullable(),
      delivery,
      execution,
      items: z.array(item),
      settings: settings.nullable(),
      startedAtMs: z.number().nullable(),
      completedAtMs: z.number().nullable(),
    }),
  ),
  approvals: z.array(approval),
  diagnostic: z.string().nullable(),
});
const threadSummary = z.object({
  id,
  title: z.string(),
  session,
  checkout,
  updatedAtMs: z.number().nullable(),
  awaitingApproval: z.boolean(),
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
  threads: z.array(threadSummary),
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
export type SessionSettings = z.infer<typeof settings>;
export type ModelOption = z.infer<typeof modelOption>;
export type Approval = z.infer<typeof approval>;
export type Item = z.infer<typeof item>;
export type ApprovalDecision = "accept" | "decline" | "cancel";
export type Checkout = z.infer<typeof checkout>;
export type CheckoutMode = Checkout["kind"];
export type CheckoutRef = { workspaceId: string; threadId?: string };
export const checkoutKey = (
  scope: "workspace" | "file" | "diff",
  { workspaceId, threadId }: CheckoutRef,
) => [scope, workspaceId, threadId ?? null];
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
  workspace: ({ workspaceId, threadId }: CheckoutRef) =>
    call(
      "workspace_view",
      { workspaceId, threadId: threadId ?? null },
      workspaceView,
    ),
  file: ({ workspaceId, threadId }: CheckoutRef, path: string) =>
    call("read_file", { workspaceId, threadId: threadId ?? null, path }, file),
  diff: (
    { workspaceId, threadId }: CheckoutRef,
    path: string,
    basis: "staged" | "unstaged",
  ) =>
    call(
      "read_diff",
      { workspaceId, threadId: threadId ?? null, path, basis },
      diff,
    ),
  create: (workspaceId: string, mode: CheckoutMode) =>
    call("create_thread", { workspaceId, mode }, thread),
  thread: (threadId: string) => call("thread_snapshot", { threadId }, thread),
  resume: (threadId: string) => call("open_thread", { threadId }, thread),
  models: () => call("list_models", {}, z.array(modelOption)),
  settings: (threadId: string, value: SessionSettings) =>
    call("update_thread_settings", { threadId, settings: value }, thread),
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
        summary: threadSummary,
      })
      .safeParse(event.payload);
    if (hint.success) {
      const { summary } = hint.data;
      if (summary.session.kind === "unavailable")
        void client.resetQueries({ queryKey: ["models"] });
      client.setQueriesData<WorkspaceView>(
        { queryKey: ["workspace", hint.data.workspaceId] },
        (view) =>
          view && {
            ...view,
            threads: view.threads.some((thread) => thread.id === summary.id)
              ? view.threads.map((thread) =>
                  thread.id === summary.id ? summary : thread,
                )
              : [...view.threads, summary],
          },
      );
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
