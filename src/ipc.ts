import {
  acknowledgeUncertainUpdate,
  type AcknowledgeUncertainUpdate,
  prReviewDetail,
  prChangeResult,
  prOperation,
  type PrReviewChange,
} from "./panel/prReview";
import { threadPrSummary, type PullRequestKey } from "./panel/pullRequests";
import {
  Channel,
  type InvokeArgs,
  type InvokeOptions,
  invoke,
  isTauri,
} from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { normalizeSkillMentions } from "./chat/composerSkillTokens";
import { savedDisposition, setReviewDisposition } from "./panel/reviews";
import type { SetReviewDisposition } from "./panel/reviews";
import { notificationHistory } from "./notifications/observer";
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
const imageAttachment = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  name: z.string(),
  sizeBytes: z.number(),
});
const item = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user_input"),
    id: z.string(),
    text: z.string(),
    attachments: z.array(imageAttachment),
    delivery,
  }),
  z.object({
    kind: z.literal("assistant"),
    id: z.string(),
    text: z.string(),
    complete: z.boolean(),
  }),
  z.object({
    kind: z.literal("plan"),
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
const userQuestions = z.object({
  id,
  turnId: id,
  itemId: z.string(),
  state: z.enum(["pending", "answering", "answered", "expired", "uncertain"]),
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      isOther: z.boolean(),
      isSecret: z.boolean(),
      options: z
        .array(z.object({ label: z.string(), description: z.string() }))
        .nullable(),
    }),
  ),
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
  interactionMode: z.enum(["default", "plan"]).default("default"),
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
const contextUsage = z.object({
  usedTokens: z.number(),
  maxTokens: z.number().nullable(),
  totalProcessedTokens: z.number().nullable(),
});
const limitWindow = z.object({
  slot: z.enum(["primary", "secondary"]),
  kind: z.enum(["session", "weekly", "monthly"]),
  usedPercent: z.number(),
  durationMins: z.number(),
  resetsAtMs: z.number().nullable(),
});
const usageLimits = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("reported"),
    plan: z.string().nullable(),
    windows: z.array(limitWindow),
  }),
  z.object({ kind: z.literal("unsupported") }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
]);
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
const checkpoint = z.object({ reference: z.string(), commit: z.string() });
const turnDiffFile = z.object({
  path: z.string(),
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
});
const turnCheckpoint = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }),
  z.object({ kind: z.literal("before"), before: checkpoint }),
  z.object({
    kind: z.literal("complete"),
    before: checkpoint,
    after: checkpoint,
    files: z.array(turnDiffFile),
  }),
  z.object({
    kind: z.literal("unavailable"),
    before: checkpoint.nullable(),
    reason: z.string(),
  }),
]);
const fileText = z.object({ name: z.string(), contents: z.string() });
const turnDiff = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    old: fileText.nullable(),
    new: fileText.nullable(),
  }),
  reason,
]);
const thread = z.object({
  placement: z
    .object({ kind: z.enum(["auto", "kept", "pinned", "settled", "archived"]) })
    .optional(),
  id,
  workspaceId: id,
  title: z.string(),
  nativeThreadId: z.string().nullable(),
  revision: z.number(),
  session,
  settings,
  checkout,
  userQuestions: z.array(userQuestions).default([]),
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
      attachments: z.array(imageAttachment).default([]),
      checkpoint: turnCheckpoint.default({
        kind: "unavailable",
        before: null,
        reason: "This turn predates checkpoints.",
      }),
    }),
  ),
  approvals: z.array(approval),
  diagnostic: z.string().nullable(),
  pendingRevert: z
    .object({ requestId: z.string(), turnId: id, files: z.boolean() })
    .nullable()
    .default(null),
  lastRevert: z
    .object({
      requestId: z.string(),
      turnId: id,
      prompt: z.string(),
      turnCount: z.number().int(),
      attachments: z.array(imageAttachment).default([]),
    })
    .nullable()
    .default(null),
  context: contextUsage.nullable().default(null),
});
const threadSummary = z.object({
  revision: z.number().int().nonnegative(),
  latestTurn: z
    .object({ id, execution, completedAtMs: z.number().nullable() })
    .nullable(),
  pendingApprovalIds: z.array(id),
  pendingUserQuestionIds: z.array(id).default([]),
  pullRequests: threadPrSummary.default({
    sequence: 0,
    links: [],
    discovering: false,
    discoveryError: null,
  }),
  id,
  title: z.string(),
  session,
  checkout,
  createdAtMs: z.number().nullable().default(null),
  archivedAtMs: z.number().nullable().default(null),
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
  title: z.string().nullable(),
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
  warnings: z.array(z.string()).default([]),
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
const terminalEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), history: z.string() }),
  z.object({ type: z.literal("output"), data: z.string() }),
  z.object({ type: z.literal("exited"), exitCode: z.number().nullable() }),
]);
const TERMINAL_WRITE_MAX_BYTES = 65536;
export function chunkTerminalInput(
  data: string,
  maxBytes = TERMINAL_WRITE_MAX_BYTES,
): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const char of data) {
    const point = char.codePointAt(0) ?? 0;
    const size =
      point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += char;
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));
export type Workspace = z.infer<typeof workspace>;
export type WorkspaceView = z.infer<typeof workspaceView>;
export type Thread = z.infer<typeof thread>;
export type SessionSettings = z.infer<typeof settings>;
export type ModelOption = z.infer<typeof modelOption>;
export type ContextUsage = z.infer<typeof contextUsage>;
export type LimitWindow = z.infer<typeof limitWindow>;
export type UsageLimits = z.infer<typeof usageLimits>;
export type Approval = z.infer<typeof approval>;
export type UserQuestionRequest = z.infer<typeof userQuestions>;
export type UserQuestionAnswers = Record<string, { answers: string[] }>;
export type Item = z.infer<typeof item>;
export type ImageAttachment = z.infer<typeof imageAttachment>;
export type TurnDiffFile = z.infer<typeof turnDiffFile>;
export type ApprovalDecision = "accept" | "decline" | "cancel";
export type Arrange =
  | {
      kind:
        | "pin"
        | "unpin"
        | "settle"
        | "unsettle"
        | "wake"
        | "archive"
        | "unarchive";
    }
  | { kind: "snooze"; untilMs: number };
export type Checkout = z.infer<typeof checkout>;
export type NewCheckout =
  | { kind: "existing"; threadId: string }
  | { kind: "local" }
  | { kind: "worktree"; base: string; fromOrigin: boolean }
  | { kind: "folder"; prompt: string };
export type CheckoutRef = { workspaceId: string; threadId?: string };
export type TerminalEvent = z.infer<typeof terminalEvent>;
export type TerminalTarget = {
  workspaceId: string;
  threadId: string | null;
  terminalId: string;
};
export type Branches = z.infer<typeof branches>;
export type Branch = Branches["branches"][number];
export type ThreadSummary = z.infer<typeof threadSummary>;
export type GitStatus = z.infer<typeof gitStatus>;
export type PullRequest = z.infer<typeof pullRequest>;
export type PrLookup = z.infer<typeof prLookup>;
export type GitPhase = z.infer<typeof gitPhase>;
export type GitOutcome = z.infer<typeof gitOutcome>;
export type GitAction =
  | {
      kind: "commit" | "commit_push" | "commit_push_pr";
      message: string | null;
    }
  | { kind: "push" | "create_pr" | "pull" };
const skill = z.object({
  name: z.string(),
  path: z.string(),
  enabled: z.boolean(),
  scope: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  shortDescription: z.string().nullable().optional(),
});
export type Skill = z.infer<typeof skill>;

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
  args: InvokeArgs,
  schema: S,
  options?: InvokeOptions,
): Promise<z.infer<S>> {
  try {
    const result: unknown = await invoke(command, args, options);
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
  threadPullRequests: (threadId: string, refresh = false) =>
    call("list_thread_pull_requests", { threadId, refresh }, threadPrSummary),
  linkPullRequest: (threadId: string, url: string) =>
    call("link_pull_request", { threadId, url }, threadPrSummary),
  unlinkPullRequest: (threadId: string, key: PullRequestKey) =>
    call("unlink_pull_request", { threadId, key }, threadPrSummary),
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
  turnDiff: (threadId: string, turnId: string, path: string) =>
    call("read_turn_diff", { threadId, turnId, path }, turnDiff),
  revert: (
    threadId: string,
    requestId: string,
    turnId: string,
    files: boolean,
  ) => call("revert_thread", { threadId, requestId, turnId, files }, thread),
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
  readPullRequest: (threadId: string, key: PullRequestKey) =>
    call("read_pull_request", { threadId, key }, prReviewDetail),
  pullRequestOperations: (threadId: string, key: PullRequestKey) =>
    call("pull_request_operations", { threadId, key }, z.array(prOperation)),
  reconcilePullRequest: (
    threadId: string,
    key: PullRequestKey,
    requestId: string,
  ) =>
    call(
      "reconcile_pull_request",
      { threadId, key, requestId },
      prChangeResult,
    ),
  acknowledgeUncertainUpdate: (
    threadId: string,
    input: AcknowledgeUncertainUpdate,
  ) =>
    call(
      "acknowledge_uncertain_update",
      { threadId, input: acknowledgeUncertainUpdate.parse(input) },
      prChangeResult,
    ),
  changePullRequest: (threadId: string, input: PrReviewChange) =>
    call("change_pull_request", { threadId, input }, prChangeResult),
  setReviewDisposition: (
    threadId: string,
    key: PullRequestKey,
    input: SetReviewDisposition,
  ) =>
    call(
      "set_review_disposition",
      { threadId, key, input: setReviewDisposition.parse(input) },
      savedDisposition.nullable(),
    ),
  pullRequest: ({ workspaceId, threadId }: CheckoutRef, branch: string) =>
    call(
      "current_branch_pull_request",
      { workspaceId, threadId: threadId ?? null, branch },
      prLookup,
    ),
  beginCommitMessage: (threadId: string) =>
    call("begin_commit_message", { threadId }, z.string()),
  awaitCommitMessage: (job: string) =>
    call("await_commit_message", { job }, z.string()),
  cancelCommitMessage: (job: string) =>
    call("cancel_commit_message", { job }, z.null()),
  runGitAction: (
    { workspaceId }: CheckoutRef,
    originThreadId: string,
    action: GitAction,
    onPhase: (phase: GitPhase) => void,
  ) => {
    const onProgress = new Channel<unknown>((message) => {
      const phase = gitPhase.safeParse(message);
      if (phase.success) onPhase(phase.data);
    });
    return call(
      "run_git_action",
      { workspaceId, originThreadId, action, onProgress },
      gitOutcome,
    );
  },
  terminalAttach: (
    { workspaceId, threadId, terminalId }: TerminalTarget,
    size: { cols: number; rows: number },
    onEvent: (event: TerminalEvent) => void,
  ) => {
    const channel = new Channel<unknown>((message) => {
      const event = terminalEvent.safeParse(message);
      if (event.success) onEvent(event.data);
    });
    return call(
      "terminal_attach",
      {
        workspaceId,
        threadId,
        terminalId,
        cols: clamp(size.cols, 1, 1000),
        rows: clamp(size.rows, 1, 500),
        onEvent: channel,
      },
      z.number(),
    );
  },
  terminalDetach: (subscription: number) =>
    call("terminal_detach", { subscription }, z.null()),
  terminalWrite: async (
    { workspaceId, threadId, terminalId }: TerminalTarget,
    data: string,
  ) => {
    for (const chunk of chunkTerminalInput(data))
      await call(
        "terminal_write",
        { workspaceId, threadId, terminalId, data: chunk },
        z.null(),
      );
  },
  terminalResize: (
    { workspaceId, threadId, terminalId }: TerminalTarget,
    cols: number,
    rows: number,
  ) =>
    call(
      "terminal_resize",
      {
        workspaceId,
        threadId,
        terminalId,
        cols: clamp(cols, 1, 1000),
        rows: clamp(rows, 1, 500),
      },
      z.null(),
    ),
  terminalClose: ({ workspaceId, threadId, terminalId }: TerminalTarget) =>
    call("terminal_close", { workspaceId, threadId, terminalId }, z.null()),
  openUrl: (url: string) => call("open_url", { url }, z.null()),
  create: (workspaceId: string, checkout: NewCheckout) =>
    call("create_thread", { workspaceId, checkout }, thread),
  thread: (threadId: string) => call("thread_snapshot", { threadId }, thread),
  resume: (threadId: string) => call("open_thread", { threadId }, thread),
  models: () => call("list_models", {}, z.array(modelOption)),
  skills: (cwd: string) => call("list_skills", { cwd }, z.array(skill)),
  collaborationModes: () =>
    call("collaboration_modes", {}, z.array(z.enum(["default", "plan"]))),
  usageLimits: (refresh = false) =>
    call("usage_limits", { refresh }, usageLimits),
  settings: (threadId: string, value: SessionSettings) =>
    call("update_thread_settings", { threadId, settings: value }, thread),
  stageAttachment: async (file: File) =>
    call(
      "stage_attachment",
      new Uint8Array(await file.arrayBuffer()),
      imageAttachment,
      { headers: { "x-attachment-name": encodeURIComponent(file.name) } },
    ),
  submit: (
    threadId: string,
    text: string,
    requestId: string,
    attachments: ImageAttachment[],
    expectedTurnId?: string,
  ) =>
    call(
      "submit",
      {
        threadId,
        text: normalizeSkillMentions(text),
        requestId,
        attachments,
        ...(expectedTurnId ? { expectedTurnId } : {}),
      },
      z.object({ turnId: id }),
    ),
  approval: (approvalId: string, decision: ApprovalDecision) =>
    call("answer_approval", { approvalId, decision }, z.null()),
  answerUserQuestions: (requestId: string, answers: UserQuestionAnswers) =>
    call("answer_user_questions", { requestId, answers }, z.null()),
  interrupt: (threadId: string) => call("interrupt", { threadId }, z.null()),
  arrange: (threadId: string, action: Arrange) =>
    call("arrange_thread", { threadId, action }, z.null()),
  threadSummaries: (workspaceId: string) =>
    call("list_thread_summaries", { workspaceId }, z.array(threadSummary)),
  renameThread: (threadId: string, title: string) =>
    call("rename_thread", { threadId, title }, thread),
  deleteThread: (threadId: string) =>
    call(
      "delete_thread",
      { threadId },
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("not_requested") }),
        z.object({ kind: z.literal("removed") }),
        z.object({ kind: z.literal("retained"), reason: z.string() }),
      ]),
    ),
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
      for (const workspaceId of workspaces)
        invalidateCheckouts(client, workspaceId);
      workspaces.clear();
    }, 160);
  };
  const offChanged = await listen<unknown>("bot:changed", (event) => {
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
      if (
        summary.id !== hint.data.threadId ||
        summary.revision !== hint.data.revision
      )
        return;
      notificationHistory.observe(hint.data.workspaceId, summary);
      void client.invalidateQueries({
        queryKey: ["thread-summaries", hint.data.workspaceId],
      });
      client.setQueryData(
        ["thread-prs", hint.data.threadId],
        summary.pullRequests,
      );
      if (summary.session.kind === "unavailable")
        void client.resetQueries({ queryKey: ["models"] });
      client.setQueriesData<WorkspaceView>(
        { queryKey: ["workspace", hint.data.workspaceId] },
        (view) =>
          view && {
            ...view,
            threads: view.threads.some((thread) => thread.id === summary.id)
              ? view.threads.map((thread) =>
                  thread.id === summary.id &&
                  thread.revision <= summary.revision
                    ? summary
                    : thread,
                )
              : [...view.threads, summary],
          },
      );
      if (hint.data.refreshWorkspace) workspaces.add(hint.data.workspaceId);
      schedule(hint.data.threadId);
    }
  });
  const offLimits = await listen<unknown>("bot:usage-limits", (event) => {
    const limits = usageLimits.safeParse(event.payload);
    if (limits.success) client.setQueryData(["usage-limits"], limits.data);
  });
  const offRefresh = await listen("bot:refresh", () => {
    void client.invalidateQueries();
  });
  const focus = () => {
    void client.invalidateQueries({
      predicate: (q) =>
        q.queryKey[0] !== "pr" &&
        q.queryKey[0] !== "pr-detail" &&
        q.queryKey[0] !== "usage-limits",
    });
  };
  window.addEventListener("focus", focus);
  return () => {
    offChanged();
    offLimits();
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

export async function readThreadSnapshot(
  client: QueryClient,
  threadId: string,
): Promise<Thread> {
  const incoming = await ipc.thread(threadId);
  const current = client.getQueryData<Thread>(["thread", threadId]);
  return current && current.revision > incoming.revision ? current : incoming;
}

export function configurePullRequestQueries(client: QueryClient): void {
  const newest = (incoming: unknown, prior: unknown) => {
    const next = threadPrSummary.parse(incoming);
    const previous = threadPrSummary.safeParse(prior);
    return previous.success && previous.data.sequence > next.sequence
      ? previous.data
      : next;
  };
  client.setQueryDefaults(["thread-prs"], {
    structuralSharing: (prior, incoming) => newest(incoming, prior),
  });
  client.setQueryDefaults(["workspace"], {
    structuralSharing: (prior, incoming) => {
      const next = workspaceView.parse(incoming);
      const previous = workspaceView.safeParse(prior);
      return {
        ...next,
        threads: next.threads.map((incomingThread) => {
          const priorThread = previous.success
            ? previous.data.threads.find((row) => row.id === incomingThread.id)
            : undefined;
          const thread =
            priorThread && priorThread.revision > incomingThread.revision
              ? priorThread
              : incomingThread;
          return {
            ...thread,
            pullRequests: newest(
              newest(
                thread.pullRequests,
                previous.success
                  ? previous.data.threads.find((row) => row.id === thread.id)
                      ?.pullRequests
                  : undefined,
              ),
              client.getQueryData(["thread-prs", thread.id]),
            ),
          };
        }),
      };
    },
  });
}
