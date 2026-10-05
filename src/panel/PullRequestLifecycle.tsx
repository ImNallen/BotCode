// Confirmation follows pingdotgg/t3code v0.0.45 PullRequestDetailPanel.tsx (MIT).
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "../ipc";
import { Button } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import type {
  PrReviewChange,
  PrReviewDetail,
  LifecycleAction,
} from "./prReview";
import type { PullRequestKey } from "./pullRequests";
import {
  captureLifecycle,
  captureUpdateContinuation,
  updateContinuationWarning,
  type UpdateContinuation,
  changeResultText,
  lifecycleLabel,
  type LifecycleConfirmation,
} from "./prLifecycle";

export function PullRequestLifecycle({
  threadId,
  prKey,
  detail,
  disabled,
  refresh,
  resolveConflicts,
  canAskCodex,
}: {
  threadId: string;
  prKey: PullRequestKey;
  detail: PrReviewDetail | undefined;
  disabled: boolean;
  refresh: () => void;
  resolveConflicts: () => void;
  canAskCodex: boolean;
}) {
  const [confirmation, setConfirmation] = useState<LifecycleConfirmation>();
  const [continuation, setContinuation] = useState<UpdateContinuation>();
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const operations = useQuery({
    queryKey: ["pr-operations", threadId, prKey],
    queryFn: () => ipc.pullRequestOperations(threadId, prKey),
    retry: false,
  });
  const refreshOperations = operations.refetch;
  useEffect(() => {
    if (detail) void refreshOperations();
  }, [detail, refreshOperations]);
  const perform = async (input: PrReviewChange) => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setConfirmation(undefined);
    try {
      setMessage(
        changeResultText(await ipc.changePullRequest(threadId, input)),
      );
    } catch (error) {
      setMessage(
        `Outcome uncertain. ${String(error)} Reconcile the saved operation.`,
      );
    } finally {
      running.current = false;
      setPending(false);
      void operations.refetch();
      refresh();
    }
  };
  const choose = (action: LifecycleAction) => {
    if (!detail || disabled || running.current) return;
    setConfirmation(
      captureLifecycle(detail.observation, action, crypto.randomUUID()),
    );
  };
  const reconcile = async (requestId: string) => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    try {
      setMessage(
        changeResultText(
          await ipc.reconcilePullRequest(threadId, prKey, requestId),
        ),
      );
    } catch (error) {
      setMessage(String(error));
    } finally {
      running.current = false;
      setPending(false);
      void operations.refetch();
      refresh();
    }
  };
  const continueUpdate = async (captured: UpdateContinuation) => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setContinuation(undefined);
    try {
      setMessage(
        changeResultText(
          await ipc.acknowledgeUncertainUpdate(threadId, captured.input),
        ),
      );
    } catch (error) {
      setMessage(String(error));
    } finally {
      running.current = false;
      setPending(false);
      void operations.refetch();
      refresh();
    }
  };
  const caps = detail?.capabilities;
  const primary =
    caps?.actions.filter((action) => {
      switch (caps.primary) {
        case "merge":
          return action.kind === "merge" || action.kind === "enqueue";
        case "enable_auto_merge":
          return action.kind === "enable_auto_merge";
        case "ready":
          return action.kind === "set_draft" && !action.draft;
        case "auto_merge_armed":
          return action.kind === "disable_auto_merge";
        default:
          return false;
      }
    }) ?? [];
  const allowed = (action: LifecycleAction) =>
    !disabled &&
    !pending &&
    (!operations.data?.length || action.kind === "disable_auto_merge");
  return (
    <div
      className="space-y-2 border-b border-border/60 p-2 text-xs"
      aria-label="Pull request actions"
    >
      <div className="flex flex-wrap gap-1">
        {caps?.primary === "resolve_conflicts" ? (
          <Button
            size="sm"
            disabled={disabled || !canAskCodex}
            onClick={resolveConflicts}
          >
            Resolve conflicts
          </Button>
        ) : null}
        {primary.map((action) => (
          <Button
            key={lifecycleLabel(action)}
            size="sm"
            disabled={!allowed(action)}
            onClick={() => choose(action)}
          >
            {lifecycleLabel(action)}
          </Button>
        ))}
        {caps?.actions.length ? (
          <Menu
            align="start"
            trigger={(props) => (
              <Button
                {...props}
                size="sm"
                variant="outline"
                disabled={disabled || pending}
              >
                Actions
              </Button>
            )}
          >
            {caps.actions.map((action) => (
              <MenuItem
                key={lifecycleLabel(action)}
                disabled={!allowed(action)}
                onClick={() => choose(action)}
              >
                {lifecycleLabel(action)}
              </MenuItem>
            ))}
          </Menu>
        ) : null}
      </div>
      {caps?.primary === "queued" ? (
        <p>Queued. Waiting for GitHub to merge.</p>
      ) : null}
      {caps?.primary === "auto_merge_armed" ? (
        <p>Auto-merge enabled. GitHub may merge when ready.</p>
      ) : null}
      {caps?.explanation ? (
        <p className="text-muted-foreground">{caps.explanation}</p>
      ) : null}
      {pending ? <p role="status">Waiting for GitHub…</p> : null}
      {message ? (
        <p role="status" className="break-words">
          {message}
        </p>
      ) : null}
      {operations.error ? <p role="alert">{operations.error.message}</p> : null}
      {operations.data?.map((operation) => (
        <div
          key={operation.input.requestId}
          className="rounded-md border border-border p-2"
        >
          <p>{changeResultText(operation.result)}</p>
          <p className="break-all text-muted-foreground">
            Pull request {operation.input.target.key}
          </p>
          {operation.input.action.kind === "update_branch" ? (
            <p>{lifecycleLabel(operation.input.action)}</p>
          ) : null}
          <p className="break-all text-muted-foreground">
            Captured account {operation.input.target.viewer}
          </p>
          <p className="break-all text-muted-foreground">
            Captured head {operation.input.target.headOid}
          </p>
          <Button
            size="compact"
            variant="outline"
            disabled={pending}
            onClick={() => void reconcile(operation.input.requestId)}
          >
            Reconcile
          </Button>
          {!disabled && captureUpdateContinuation(operation, detail) ? (
            <>
              <p className="break-all">
                Current head {detail?.observation.headOid}
              </p>
              <p className="break-all">
                Current account {detail?.observation.viewer}
              </p>
              <p>{updateContinuationWarning}</p>
              <Button
                size="compact"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  setContinuation(captureUpdateContinuation(operation, detail))
                }
              >
                Continue from inspected head…
              </Button>
            </>
          ) : null}
        </div>
      ))}
      {continuation ? (
        <UncertainUpdateConfirmation
          confirmation={continuation}
          onCancel={() => setContinuation(undefined)}
          onConfirm={() => void continueUpdate(continuation)}
        />
      ) : null}
      {confirmation ? (
        <PullRequestConfirmation
          confirmation={confirmation}
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() => void perform(confirmation)}
        />
      ) : null}
    </div>
  );
}

export function PullRequestConfirmation({
  confirmation,
  onCancel,
  onConfirm,
}: {
  confirmation: LifecycleConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          Confirm {lifecycleLabel(confirmation.action).toLowerCase()}?
        </DialogTitle>
        <DialogDescription>
          <span className="block break-all">
            Pull request {confirmation.target.key}
          </span>
          <span className="block break-all">
            Head {confirmation.target.headOid}
          </span>
          <span className="block break-all">
            Account {confirmation.target.viewer}
          </span>
          {confirmation.action.kind === "enable_auto_merge" ? (
            <span className="block">
              GitHub may merge immediately when auto-merge is enabled.
            </span>
          ) : null}
          {confirmation.action.kind === "enqueue" ? (
            <span className="block">
              GitHub's required merge queue chooses the merge method.
            </span>
          ) : null}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConfirm}>Confirm</Button>
      </DialogFooter>
    </Dialog>
  );
}

export function UncertainUpdateConfirmation({
  confirmation,
  onCancel,
  onConfirm,
}: {
  confirmation: UpdateContinuation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogHeader>
        <DialogTitle>Continue from inspected head?</DialogTitle>
        <DialogDescription>
          <span className="block break-all">
            Pull request {confirmation.original.target.key}
          </span>
          <span className="block">
            Original action {lifecycleLabel(confirmation.original.action)}
          </span>
          <span className="block break-all">
            Captured head {confirmation.original.target.headOid}
          </span>
          <span className="block break-all">
            Captured account {confirmation.original.target.viewer}
          </span>
          <span className="block break-all">
            Current head {confirmation.input.inspected.headOid}
          </span>
          <span className="block break-all">
            Current account {confirmation.input.inspected.viewer}
          </span>
          <span className="block">{updateContinuationWarning}</span>
        </DialogDescription>
      </DialogHeader>
      <DialogFooter variant="bare">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConfirm}>Continue</Button>
      </DialogFooter>
    </Dialog>
  );
}
