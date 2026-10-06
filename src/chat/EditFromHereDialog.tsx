// Ported from T3 Code v0.0.45 apps/web/src/components/ChatView.tsx Edit from here alert dialog (MIT).
import type { Thread } from "../ipc";
import { Button } from "../ui/controls";
import { Dialog, DialogDescription, DialogTitle } from "../ui/dialog";

export function EditFromHereDialog({
  thread,
  turnId,
  working,
  error,
  onClose,
  onRevert,
  checkoutAvailable,
}: {
  thread: Thread;
  turnId: string;
  working: boolean;
  error: string | undefined;
  onClose: () => void;
  onRevert: (files: boolean) => void;
  checkoutAvailable: boolean;
}) {
  const turn = thread.turns.find((turn) => turn.id === turnId);
  if (!turn) return null;
  const checkpoint = turn.checkpoint;
  const canRestoreFiles =
    checkoutAvailable &&
    thread.checkout.kind !== "folder" &&
    checkpoint.kind !== "pending" &&
    checkpoint.before !== null;
  const retry = thread.pendingRevert;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !working) onClose();
      }}
      className="row-start-2 max-h-full max-w-lg text-popover-foreground"
    >
      <div
        className="flex flex-col gap-2 p-6 text-center max-sm:pb-4 sm:text-left"
        data-slot="alert-dialog-header"
      >
        <DialogTitle>Edit from here?</DialogTitle>
        <DialogDescription>
          Rewind chat to before this message. Your prompt returns to the
          composer. Bot Code continues from a new Codex thread containing the
          earlier conversation.
        </DialogDescription>
        {canRestoreFiles ? (
          <DialogDescription>
            Revert files too restores tracked and non-ignored files to before
            this message, removes later non-ignored files, and leaves the
            restored changes unstaged when HEAD exists. Ignored files stay as
            they are. This replaces the current changes in this checkout.
          </DialogDescription>
        ) : !checkoutAvailable && thread.checkout.kind !== "folder" ? (
          <DialogDescription>
            Restore this thread's worktree before reverting files. Files stay as
            they are.
          </DialogDescription>
        ) : checkpoint.kind === "unavailable" ? (
          <DialogDescription>
            {checkpoint.reason} Files stay as they are.
          </DialogDescription>
        ) : null}
        {retry ? (
          <DialogDescription>
            A saved revert is waiting to finish. Retry continues the same
            operation.
          </DialogDescription>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : null}
      </div>
      <div
        className="flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)] border-t bg-muted/72 py-4"
        data-slot="alert-dialog-footer"
      >
        <Button variant="outline" disabled={working} onClick={onClose}>
          Cancel
        </Button>
        {(canRestoreFiles || retry?.files) && (!retry || retry.files) ? (
          <Button
            variant="destructive"
            disabled={working}
            onClick={() => onRevert(true)}
          >
            {working
              ? "Reverting..."
              : retry
                ? "Retry revert files too"
                : "Revert files too"}
          </Button>
        ) : null}
        {!retry || !retry.files ? (
          <Button disabled={working} onClick={() => onRevert(false)}>
            {working
              ? "Reverting..."
              : retry
                ? "Retry revert and keep changes"
                : "Revert and keep changes"}
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
