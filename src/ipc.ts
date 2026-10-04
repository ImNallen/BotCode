import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
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
const workspace = z.object({
  id,
  root: z.string(),
  label: z.string(),
  kind: z.enum(["repository", "scratch"]),
});
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
  z.object({ kind: z.literal("folder"), path: z.string() }),
]);
const branches = z.object({
  branches: z.array(
    z.object({
      name: z.string(),
      remote: z.boolean(),
      current: z.boolean(),
      default: z.boolean(),
      worktree: z.string().nullable(),
    }),
  ),
  origin: z.boolean(),
});
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
  pinnedAtMs: z.number().nullable(),
  snoozedUntilMs: z.number().nullable(),
  settledAtMs: z.number().nullable(),
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
  unavailable: z.string().nullable().default(null),
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
const tracking = z.object({
  remote: z.string(),
  branch: z.string(),
  ahead: z.number().int(),
  behind: z.number().int(),
});
const gitStatus = z.object({
  branch: z
    .object({
      name: z.string(),
      isDefault: z.boolean(),
      base: z.string(),
      aheadOfBase: z.number().int(),
      upstream: tracking.nullable(),
    })
    .nullable(),
  origin: z.boolean(),
  files: z.array(
    z.object({
      path: z.string(),
      insertions: z.number().int(),
      deletions: z.number().int(),
    }),
  ),
});
const pullRequest = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  base: z.string(),
  head: z.string(),
});
const prLookup = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("open"), pr: pullRequest }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["missing", "unauthenticated", "failed"]),
    message: z.string(),
  }),
]);
const gitPhase = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit") }),
  z.object({ kind: z.literal("push"), remote: z.string() }),
  z.object({ kind: z.literal("pr") }),
  z.object({ kind: z.literal("pull") }),
]);
const gitOutcome = z.object({
  commit: z.object({ sha: z.string(), subject: z.string() }).nullable(),
  push: z
    .object({
      sha: z.string(),
      upstream: z.string(),
      setUpstream: z.boolean(),
    })
    .nullable(),
  pr: z.object({ pr: pullRequest, created: z.boolean() }).nullable(),
  pull: z.object({ upstream: z.string(), updated: z.boolean() }).nullable(),
  failure: z
    .object({
      phase: gitPhase,
      error: z.object({ code: z.string(), message: z.string() }),
    })
    .nullable(),
});
export type Workspace = z.infer<typeof workspace>;
export type WorkspaceView = z.infer<typeof workspaceView>;
export type Thread = z.infer<typeof thread>;
export type SessionSettings = z.infer<typeof settings>;
export type ModelOption = z.infer<typeof modelOption>;
export type Approval = z.infer<typeof approval>;
export type Item = z.infer<typeof item>;
export type ApprovalDecision = "accept" | "decline" | "cancel";
export type Arrange =
  | { kind: "pin" | "unpin" | "settle" | "unsettle" | "wake" }
  | { kind: "snooze"; untilMs: number };
export type Checkout = z.infer<typeof checkout>;
export type NewCheckout =
  | { kind: "local" }
  | { kind: "worktree"; base: string; fromOrigin: boolean }
  | { kind: "folder"; prompt: string };
export type CheckoutRef = { workspaceId: string; threadId?: string };
export type Branches = z.infer<typeof branches>;
export type Branch = Branches["branches"][number];
export type ThreadSummary = z.infer<typeof threadSummary>;
export type GitStatus = z.infer<typeof gitStatus>;
export type PullRequest = z.infer<typeof pullRequest>;
export type PrLookup = z.infer<typeof prLookup>;
export type GitPhase = z.infer<typeof gitPhase>;
export type GitOutcome = z.infer<typeof gitOutcome>;
export type GitAction =
  | { kind: "commit" | "commit_push" | "commit_push_pr"; message: string }
  | { kind: "push" | "create_pr" | "pull" };
export type CheckoutScope =
  | "workspace"
  | "file"
  | "diff"
  | "branches"
  | "git"
  | "pr";
export const checkoutKey = (
  scope: CheckoutScope,
  { workspaceId, threadId }: CheckoutRef,
) => [scope, workspaceId, threadId ?? null];
export function invalidateCheckouts(client: QueryClient, workspaceId: string) {
  const scopes: CheckoutScope[] = [
    "workspace",
    "file",
    "diff",
    "branches",
    "git",
    "pr",
  ];
  for (const scope of scopes)
    void client.invalidateQueries({ queryKey: [scope, workspaceId] });
}
export class IpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
async function call<S extends z.ZodType>(
  command: string,
  args: Record<string, unknown>,
  schema: S,
): Promise<z.infer<S>> {
  try {
    const result: unknown = await invoke(command, args);
    return schema.parse(result);
  } catch (error: unknown) {
    const parsed = z
      .object({ code: z.string(), message: z.string() })
      .safeParse(error);
    throw parsed.success
      ? new IpcError(parsed.data.code, parsed.data.message)
      : new IpcError(
          "ipc",
          error instanceof Error ? error.message : String(error),
        );
  }
}
export const ipc = {
  workspaces: () => call("list_workspaces", {}, z.array(workspace)),
  openWorkspace: (path: string) => call("open_workspace", { path }, workspace),
  renameWorkspace: (workspaceId: string, label: string) =>
    call("rename_workspace", { workspaceId, label }, workspace),
  removeWorkspace: (workspaceId: string) =>
    call("remove_workspace", { workspaceId }, z.null()),
  scratchAvailable: () => call("scratch_available", {}, z.boolean()),
  ensureScratch: () => call("ensure_scratch", {}, workspace),
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
  branches: ({ workspaceId, threadId }: CheckoutRef) =>
    call(
      "list_branches",
      { workspaceId, threadId: threadId ?? null },
      branches,
    ),
  switchBranch: (
    { workspaceId, threadId }: CheckoutRef,
    branch: string,
    create: boolean,
  ) =>
    call(
      "switch_branch",
      { workspaceId, threadId: threadId ?? null, branch, create },
      z.null(),
    ),
  gitStatus: ({ workspaceId, threadId }: CheckoutRef) =>
    call("git_status", { workspaceId, threadId: threadId ?? null }, gitStatus),
  pullRequest: ({ workspaceId, threadId }: CheckoutRef, branch: string) =>
    call(
      "pull_request",
      { workspaceId, threadId: threadId ?? null, branch },
      prLookup,
    ),
  runGitAction: (
    { workspaceId, threadId }: CheckoutRef,
    action: GitAction,
    onPhase: (phase: GitPhase) => void,
  ) => {
    const onProgress = new Channel<unknown>((message) => {
      const phase = gitPhase.safeParse(message);
      if (phase.success) onPhase(phase.data);
    });
    return call(
      "run_git_action",
      { workspaceId, threadId: threadId ?? null, action, onProgress },
      gitOutcome,
    );
  },
  openUrl: (url: string) => call("open_url", { url }, z.null()),
  create: (workspaceId: string, checkout: NewCheckout) =>
    call("create_thread", { workspaceId, checkout }, thread),
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
  arrange: (threadId: string, action: Arrange) =>
    call("arrange_thread", { threadId, action }, z.null()),
  uiState: () => call("ui_state", {}, z.record(z.string(), z.string())),
  setUiState: (key: string, value: string | null) =>
    call("set_ui_state", { key, value }, z.null()),
  settingsFile: () => call("settings", {}, z.string().nullable()),
  saveSettingsFile: (text: string) => call("save_settings", { text }, z.null()),
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
        void client.invalidateQueries({ queryKey: ["git", workspaceId] });
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
    void client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "pr" });
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
