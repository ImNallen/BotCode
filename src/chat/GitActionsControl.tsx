// Structure, labels and classes follow pingdotgg/t3code v0.0.45 components/GitActionsControl.tsx (MIT).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  ChevronDownIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  GitCommitIcon,
  InfoIcon,
} from "lucide-react";
import {
  checkoutKey,
  ipc,
  type CheckoutRef,
  type GitStatus,
  type ThreadSummary,
} from "../ipc";
import { Button } from "../ui/controls";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";
import { Group, GroupSeparator } from "../ui/group";
import { GitHub } from "../ui/icons";
import { Menu, MenuItem } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { Toast, ToastViewport } from "../ui/toast";
import type {
  DefaultBranchActionDialogCopy,
  GitActionIconName,
  GitQuickAction,
} from "./GitActionsControl.logic.ts";
import {
  codexBusy,
  commitButtonLabel,
  gitControl,
  nextStep,
  runToast,
  type GitRun,
  type GitTarget,
  type Pending,
} from "./gitActions";
import {
  initialCommitDraft,
  startCommitPreview,
  updateCommitDraft,
} from "./commitMessage";
import { dismissGitRun, startGitRun, useGitRun } from "./gitRuns";

const noteTone = {
  warning: "text-warning",
  destructive: "text-destructive",
} as const;

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <GitHub />;
}

function GitQuickActionIcon({ quickAction }: { quickAction: GitQuickAction }) {
  const className = "size-3.5";
  if (quickAction.kind === "open_pr") return <GitHub className={className} />;
  if (quickAction.kind === "run_pull")
    return <CloudDownloadIcon className={className} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit")
      return <GitCommitIcon className={className} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push")
      return <CloudUploadIcon className={className} />;
    return <GitHub className={className} />;
  }
  if (quickAction.label === "Commit")
    return <GitCommitIcon className={className} />;
  if (quickAction.label === "Push")
    return <CloudUploadIcon className={className} />;
  return <InfoIcon className={className} />;
}

export function GitActionsControl({
  checkout,
  thread,
  threads,
  onError,
  onOpenPullRequests,
}: {
  checkout: CheckoutRef;
  thread: Pick<ThreadSummary, "id" | "checkout" | "session">;
  threads: ThreadSummary[];
  onError: (message: string | undefined) => void;
  onOpenPullRequests: () => void;
}) {
  const client = useQueryClient();
  const currentThread = useRef<string | null>(thread.id);
  currentThread.current = thread.id;
  useEffect(() => {
    currentThread.current = thread.id;
    return () => {
      currentThread.current = null;
    };
  }, [thread.id]);
  const status = useQuery({
    queryKey: checkoutKey("git", checkout),
    queryFn: () => ipc.gitStatus(checkout),
  });
  const branch = status.data?.branch?.name ?? null;
  const pr = useQuery({
    queryKey: [...checkoutKey("pr", checkout), branch],
    queryFn: () => ipc.pullRequest(checkout, branch ?? ""),
    enabled: Boolean(branch && status.data?.origin),
    staleTime: 60_000,
  });
  const run = useGitRun(checkout);
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => setPending(null), [thread.id]);
  if (!status.data) return null;

  const model = gitControl({
    status: status.data,
    pr: pr.data,
    busy:
      run?.state === "running"
        ? { kind: "git" }
        : codexBusy(thread, threads)
          ? { kind: "codex" }
          : { kind: "idle" },
  });
  const { vcs, quick } = model;
  const step = pending ? nextStep(pending, vcs) : null;
  const dialog = step && step.kind !== "run" ? step : null;
  const running = run?.state === "running";

  const advance = (next: Pending) => {
    const following = nextStep(next, vcs);
    if (following.kind !== "run") {
      setPending(next);
      return;
    }
    setPending(null);
    startGitRun({
      client,
      checkout,
      originThreadId: thread.id,
      action: following.action,
      before: vcs,
      pr: pr.data,
      onPullRequest: () => {
        if (currentThread.current === thread.id) onOpenPullRequests();
      },
    });
  };
  const start = (target: GitTarget) => advance({ target });
  const openUrl = (url: string) => {
    void ipc
      .linkPullRequest(thread.id, url)
      .then(() => {
        if (currentThread.current === thread.id) onOpenPullRequests();
      })
      .catch((error: Error) => onError(error.message));
  };
  const openPr = () => {
    if (vcs.pr) openUrl(vcs.pr.url);
  };

  const runQuickAction = () => {
    if (quick.kind === "open_pr") openPr();
    else if (quick.kind === "run_pull") start("pull");
    else if (quick.kind === "run_action" && quick.action) start(quick.action);
  };
  const quickLabel = (
    <>
      <GitQuickActionIcon quickAction={quick} />
      <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
        {quick.label}
      </span>
    </>
  );

  return (
    <>
      <Group aria-label="Git actions" className="shrink-0">
        {quick.disabled ? (
          <Button
            aria-disabled="true"
            size="xs"
            variant="outline"
            title={quick.hint ?? "This action is currently unavailable."}
          >
            {quickLabel}
          </Button>
        ) : (
          <Button variant="outline" size="xs" onClick={runQuickAction}>
            {quickLabel}
          </Button>
        )}
        <GroupSeparator className="hidden @3xl/header-actions:block" />
        <Menu
          align="end"
          onOpenChange={(open) => {
            if (!open) return;
            void client.invalidateQueries({
              queryKey: checkoutKey("git", checkout),
            });
            void client.invalidateQueries({
              queryKey: checkoutKey("pr", checkout),
            });
          }}
          trigger={(props) => (
            <Button
              {...props}
              aria-label="Git action options"
              size="icon-xs"
              variant="outline"
              disabled={running}
            >
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            </Button>
          )}
        >
          {model.menu.map((item) => {
            const content = (
              <>
                <GitActionItemIcon icon={item.icon} />
                {item.label}
              </>
            );
            if (item.disabled) {
              return (
                <span
                  key={item.id}
                  className="block w-max cursor-not-allowed"
                  title={item.reason ?? undefined}
                >
                  <MenuItem className="w-full" disabled>
                    {content}
                  </MenuItem>
                </span>
              );
            }
            return (
              <MenuItem
                key={item.id}
                onClick={() => {
                  if (item.kind === "open_pr") openPr();
                  else if (item.dialogAction) start(item.dialogAction);
                }}
              >
                {content}
              </MenuItem>
            );
          })}
          {model.notes.map((note) => (
            <p
              key={note.text}
              className={`max-w-64 px-2 py-1.5 text-xs ${noteTone[note.tone]}`}
            >
              {note.text}
            </p>
          ))}
        </Menu>
      </Group>
      {pending && dialog?.kind === "compose" ? (
        <CommitDialog
          key={thread.id}
          threadId={thread.id}
          status={status.data}
          label={commitButtonLabel(pending.target)}
          onCancel={() => setPending(null)}
          onSubmit={(message) =>
            advance({ ...pending, message, composed: true })
          }
        />
      ) : null}
      {pending && dialog?.kind === "confirm" ? (
        <DefaultBranchDialog
          copy={dialog.copy}
          onAbort={() => setPending(null)}
          onContinue={() => advance({ ...pending, confirmed: true })}
        />
      ) : null}
      {run ? (
        // Remounting over an open dialog re-enters the top layer above it.
        <ToastViewport key={dialog?.kind ?? "page"}>
          <RunToast
            run={run}
            onDismiss={() => dismissGitRun(checkout)}
            onRun={start}
            onOpenUrl={openUrl}
          />
        </ToastViewport>
      ) : null}
    </>
  );
}

function RunToast({
  run,
  onDismiss,
  onRun,
  onOpenUrl,
}: {
  run: GitRun;
  onDismiss: () => void;
  onRun: (target: GitTarget) => void;
  onOpenUrl: (url: string) => void;
}) {
  const [now, setNow] = useState(Date.now);
  const running = run.state === "running";
  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [running]);
  const toast = runToast(run, now);
  const { cta } = toast;
  return (
    <Toast
      type={toast.type}
      title={toast.title}
      description={toast.description}
      action={
        cta.kind === "none"
          ? undefined
          : {
              label: cta.label,
              onClick: () => {
                onDismiss();
                if (cta.kind === "open_pr") onOpenUrl(cta.url);
                else onRun(cta.target);
              },
            }
      }
      onDismiss={running ? undefined : onDismiss}
      dismissAfterVisibleMs={
        toast.type === "success" || toast.type === "info" ? 10_000 : undefined
      }
    />
  );
}

function CommitDialog({
  threadId,
  status,
  label,
  onCancel,
  onSubmit,
}: {
  threadId: string;
  status: GitStatus;
  label: string;
  onCancel: () => void;
  onSubmit: (message: string) => void;
}) {
  const [draft, dispatch] = useReducer(updateCommitDraft, initialCommitDraft);
  const cancelPreview = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    const cancel = startCommitPreview({
      threadId,
      api: ipc,
      onGenerated: (message) => dispatch({ kind: "generated", message }),
      onFailed: () => dispatch({ kind: "failed" }),
    });
    cancelPreview.current = cancel;
    return cancel;
  }, [threadId]);
  const { branch, files } = status;
  const canCommit = files.length > 0;
  const submit = () => {
    if (!canCommit) return;
    cancelPreview.current?.();
    onSubmit(draft.message);
  };
  const cancel = () => {
    cancelPreview.current?.();
    onCancel();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogHeader>
        <DialogTitle>Commit changes</DialogTitle>
        <DialogDescription>
          Review and confirm your commit. Leave the message blank to
          auto-generate one.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-3 rounded-xl bg-zinc-25 p-3 text-sm ring-1 ring-black/5 dark:bg-white/[0.035] dark:ring-white/5">
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
            <span className="text-muted-foreground">Branch</span>
            <span className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {branch?.name ?? "(detached HEAD)"}
              </span>
              {branch?.isDefault && (
                <span className="text-right text-warning">Default branch</span>
              )}
            </span>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Files</span>
            </div>
            {files.length === 0 ? (
              <p className="font-medium">none</p>
            ) : (
              <div className="space-y-2">
                <div className="h-44 overflow-y-auto rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/[0.025] dark:ring-white/5">
                  <div className="space-y-1 p-1">
                    {files.map((file) => (
                      <div
                        key={file.path}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent/50"
                      >
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left">
                          <span
                            className="min-w-0 flex-1 truncate"
                            title={file.path}
                          >
                            {file.path}
                          </span>
                          <span className="shrink-0">
                            <span className="text-diff-addition">
                              +{file.insertions}
                            </span>
                            <span className="text-muted-foreground"> / </span>
                            <span className="text-diff-deletion">
                              -{file.deletions}
                            </span>
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex justify-end font-mono">
                  <span className="text-diff-addition">
                    +{files.reduce((sum, f) => sum + f.insertions, 0)}
                  </span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="text-diff-deletion">
                    -{files.reduce((sum, f) => sum + f.deletions, 0)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="space-y-1">
          <label
            htmlFor="git-commit-message"
            className="block text-sm font-medium"
          >
            Commit message (optional)
          </label>
          <Textarea
            id="git-commit-message"
            placeholder="Leave empty to auto-generate"
            value={draft.message}
            onChange={(event) =>
              dispatch({ kind: "edit", message: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
            size="sm"
          />
          <p className="text-xs text-muted-foreground" role="status">
            {draft.generation === "running"
              ? "Generating a commit message. You can edit or continue now."
              : draft.generation === "failed"
                ? "Could not generate a message. Enter one, or leave it empty to try again when committing."
                : draft.edited
                  ? draft.message.trim()
                    ? "Your message will be used."
                    : "A message will be generated when committing."
                  : "Generated from the changes shown above. You can edit it."}
          </p>
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!canCommit} onClick={submit}>
          {label}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function DefaultBranchDialog({
  copy,
  onAbort,
  onContinue,
}: {
  copy: DefaultBranchActionDialogCopy;
  onAbort: () => void;
  onContinue: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onAbort()}
      className="max-w-xl"
    >
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <DialogFooter variant="bare" className="sm:flex-wrap sm:items-center">
        <Button
          className="w-full sm:mr-auto sm:w-auto"
          variant="outline"
          size="sm"
          onClick={onAbort}
        >
          Abort
        </Button>
        <Button
          className="w-full max-w-full sm:w-auto"
          variant="outline"
          size="sm-multiline"
          onClick={onContinue}
        >
          {copy.continueLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
