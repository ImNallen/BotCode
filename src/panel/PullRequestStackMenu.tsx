// Ported from pingdotgg/t3code v0.0.45 PullRequestStackMenu.tsx (MIT).
import { useState } from "react";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/controls";
import { Tooltip } from "../ui/tooltip";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import {
  Dialog,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Toast, ToastViewport, type ToastType } from "../ui/toast";
import { ipc } from "../ipc";
import type { PrAccess } from "./prInbox";
import type { PrObservation, MergeMethod } from "./prReview";
import {
  stackActionState,
  stackActionInput,
  type PullRequestStack,
  type PullRequestStackReference,
  type PrStackOperation,
} from "./pullRequestStack";
import { PullRequestStackLayers } from "./PullRequestStackLayers";
import { PullRequestStackHeader } from "./PullRequestStackHeader";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";
import { PullRequestGlyph } from "./pullRequestPresentation";

export function PullRequestStackMenu({
  stack,
  reference,
  access,
  observation,
  fresh,
  operations,
  operationsReady,
  canMerge,
  canRebase,
  mergeMethod,
  onSelect,
  onActed,
  notice,
  onRetry,
}: {
  notice?: string | null;
  onRetry?: (() => void) | undefined;
  stack: PullRequestStack;
  reference: PullRequestStackReference;
  access: PrAccess;
  observation?: PrObservation;
  fresh: boolean;
  operations: PrStackOperation[];
  operationsReady: boolean;
  canMerge: boolean;
  canRebase: boolean;
  mergeMethod: MergeMethod;
  onSelect?: ((reference: PullRequestStackReference) => void) | undefined;
  onActed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<
    "merge" | "update-branch" | null
  >(null);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<{
    type: ToastType;
    title: string;
    description?: string;
  }>();
  const blocked =
    pending ||
    !fresh ||
    !observation ||
    !operationsReady ||
    !!operations.length;
  const {
    position,
    mergeLayers,
    selectedLayer,
    mergeDisabled,
    rebaseDisabled,
  } = stackActionState(stack, reference, blocked);
  const run = async () => {
    if (
      pending ||
      !confirmation ||
      (confirmation === "merge"
        ? !canMerge || mergeDisabled
        : !canRebase || rebaseDisabled)
    )
      return;
    if (!observation || blocked) return;
    const action = confirmation;
    setPending(true);
    try {
      const operation = await ipc.changePullRequestStack(
        access,
        stackActionInput({
          stack,
          reference,
          target: observation,
          requestId: crypto.randomUUID(),
          action:
            action === "merge"
              ? { kind: "merge", method: mergeMethod }
              : { kind: "rebase" },
        }),
      );
      const success =
        operation.result.kind === "completed" ||
        operation.result.kind === "accepted";
      setToast({
        type: success ? "success" : "error",
        title: success
          ? action === "merge"
            ? "Stack merge request completed"
            : "Stack rebased"
          : "Stack operation did not complete",
        description: success
          ? action === "merge"
            ? "GitHub merged the stack or added it to its merge queue."
            : undefined
          : "message" in operation.result
            ? operation.result.message
            : undefined,
      });
    } catch (error) {
      setToast({
        type: "error",
        title: "Stack operation did not complete",
        description: String(error),
      });
    } finally {
      setPending(false);
      setConfirmation(null);
      onActed();
    }
  };
  return (
    <>
      <Menu
        open={open}
        onOpenChange={setOpen}
        trigger={(props) => (
          <Tooltip
            content={`View stack #${stack.number}, layer ${position} of ${stack.layers.length}${notice ? ` · ${notice}` : ""}`}
          >
            <span className="inline-flex">
              <Button
                {...props}
                variant="ghost"
                size="xs"
                aria-label={`Stack ${stack.number}, layer ${position} of ${stack.layers.length}`}
              >
                <PullRequestGlyph.stack aria-hidden className="size-3.5" />{" "}
                {position}/{stack.layers.length}
                {onRetry ? (
                  <TriangleAlertIcon
                    aria-hidden
                    className="size-3 text-warning"
                  />
                ) : null}
              </Button>
            </span>
          </Tooltip>
        )}
      >
        <div>
          <PullRequestStackHeader
            number={stack.number}
            notice={notice}
            stale={!!onRetry}
          />
          {onRetry ? (
            <MenuItem onClick={onRetry}>Retry stack refresh</MenuItem>
          ) : null}
          <PullRequestStackLayers
            stack={stack}
            reference={reference}
            pending={pending}
            onSelect={
              onSelect
                ? (target) => {
                    setOpen(false);
                    onSelect(target);
                  }
                : undefined
            }
          />
        </div>
        <PullRequestStackMenuActions
          stack={stack}
          reference={reference}
          pending={blocked}
          canMerge={canMerge}
          canRebase={canRebase}
          setConfirmation={setConfirmation}
        />
      </Menu>
      {canMerge && selectedLayer?.state === "open" ? (
        <Tooltip
          content={`Merge stack through #${reference.number} into ${stack.base} (${mergeLayers.length} ${mergeLayers.length === 1 ? "pull request" : "pull requests"})`}
        >
          <span className="inline-flex">
            <Button
              variant="default"
              size="xs"
              disabled={mergeDisabled}
              onClick={() => setConfirmation("merge")}
            >
              <PullRequestGlyph.merged aria-hidden className="size-3.5" />
              Merge stack
            </Button>
          </span>
        </Tooltip>
      ) : null}
      <PullRequestStackConfirmation
        stack={stack}
        reference={reference}
        confirmation={confirmation}
        mergeMethod={mergeMethod}
        pending={pending}
        setConfirmation={setConfirmation}
        run={() => void run()}
      />
      {toast ? (
        <ToastViewport>
          <Toast {...toast} onDismiss={() => setToast(undefined)} />
        </ToastViewport>
      ) : null}
    </>
  );
}

export function PullRequestStackConfirmation({
  stack,
  reference,
  confirmation,
  mergeMethod,
  pending,
  setConfirmation,
  run,
}: {
  stack: PullRequestStack;
  reference: PullRequestStackReference;
  confirmation: "merge" | "update-branch" | null;
  mergeMethod: MergeMethod;
  pending: boolean;
  setConfirmation: (value: "merge" | "update-branch" | null) => void;
  run: () => void;
}) {
  const { mergeLayers, unmerged } = stackActionState(stack, reference, pending);
  const confirmationLayers = confirmation === "merge" ? mergeLayers : unmerged;
  return (
    <Dialog
      showCloseButton={!pending}
      className="max-w-md"
      open={confirmation !== null}
      onOpenChange={(value) => {
        if (!value && !pending) setConfirmation(null);
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {confirmation === "merge"
            ? `Merge ${mergeLayers.length} pull requests?`
            : `Rebase ${unmerged.length} pull requests?`}
        </DialogTitle>
        <DialogDescription>
          {confirmation === "merge"
            ? `Merge #${reference.number} and its unmerged layers below into ${stack.base} using ${mergeMethod}. GitHub checks their rules before merging or queueing them and rebases the remaining stack after merging.`
            : `Rebase the remote branches from bottom to top onto ${stack.base}. This rewrites branch history and may restart checks. If a layer fails, earlier updates remain.`}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
          {confirmationLayers.map((layer) => (
            <li
              key={layer.number}
              className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2"
            >
              <PullRequestStackLayerContent layer={layer} compact />
            </li>
          ))}
        </ul>
      </DialogPanel>
      <DialogFooter>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => setConfirmation(null)}
        >
          Cancel
        </Button>
        <Button disabled={pending} onClick={() => void run()}>
          {pending
            ? "Working…"
            : confirmation === "merge"
              ? "Merge stack"
              : "Rebase stack"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function PullRequestStackMenuActions({
  stack,
  reference,
  pending,
  canMerge,
  canRebase,
  setConfirmation,
}: {
  stack: PullRequestStack;
  reference: PullRequestStackReference;
  pending: boolean;
  canMerge: boolean;
  canRebase: boolean;
  setConfirmation: (value: "merge" | "update-branch" | null) => void;
}) {
  const { mergeLayers, mergeHasClosed, mergeDisabled, rebaseDisabled } =
    stackActionState(stack, reference, pending);
  return canMerge || canRebase ? (
    <>
      <MenuSeparator />
      {canMerge ? (
        <MenuItem
          disabled={mergeDisabled}
          onClick={() => setConfirmation("merge")}
        >
          <PullRequestGlyph.merged aria-hidden />
          Merge stack ({mergeLayers.length})
        </MenuItem>
      ) : null}
      {canRebase ? (
        <MenuItem
          disabled={rebaseDisabled}
          onClick={() => setConfirmation("update-branch")}
        >
          <RefreshCwIcon aria-hidden />
          Rebase stack
        </MenuItem>
      ) : null}
      {mergeHasClosed || mergeLayers.some((layer) => layer.isDraft) ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          Every layer being merged must be open and ready for review.
        </p>
      ) : null}
    </>
  ) : null;
}
