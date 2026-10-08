// Dialog and option classes follow T3 Code v0.0.45 components/ui/dialog.tsx and PullRequestDetailPanel.tsx (MIT).
import { useState } from "react";
import { FolderGit2Icon, GitBranchIcon } from "lucide-react";
import type {
  PullRequestDestination,
  RegisteredWorktree,
  Thread,
} from "../ipc";
import type { PrObservation } from "../panel/prReview";
import { Button } from "../ui/controls";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function PullRequestCheckoutDialog({
  target,
  worktrees,
  loading,
  discoveryError,
  busy,
  prepared,
  error,
  repair,
  onClose,
  onPrepare,
  onOpen,
}: {
  target: PrObservation;
  worktrees: RegisteredWorktree[];
  loading: boolean;
  discoveryError: string | undefined;
  busy: boolean;
  prepared: Thread | null;
  error: string | undefined;
  repair: boolean;
  onClose: () => void;
  onPrepare: (destination: PullRequestDestination) => void;
  onOpen: () => void;
}) {
  const [destination, setDestination] = useState<PullRequestDestination>({
    kind: "dedicated",
  });
  const options = [
    {
      destination: { kind: "dedicated" } satisfies PullRequestDestination,
      label: "In a separate worktree",
      description: "Its own folder and conversation.",
      unavailable: null,
    },
    ...worktrees.map((row) => ({
      destination: {
        kind: "existing",
        path: row.path,
      } satisfies PullRequestDestination,
      label: row.branch ?? "Detached HEAD",
      description: row.path,
      unavailable: row.unavailable,
    })),
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {prepared ? "Pull request checkout ready" : "Check out pull request"}
        </DialogTitle>
        <DialogDescription>
          {target.key} at {target.headOid.slice(0, 7)}.{" "}
          {repair
            ? "Open a conversation for this checkout, then add the captured task to its draft."
            : "Open a conversation for this checkout."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {prepared ? (
          <p className="text-sm text-muted-foreground">
            {prepared.checkout.kind === "local"
              ? "Current checkout"
              : prepared.checkout.path}
          </p>
        ) : (
          <fieldset
            disabled={busy}
            className="space-y-2"
            aria-label="Pull request checkout destination"
          >
            {options.map((option) => {
              const selected =
                destination.kind === option.destination.kind &&
                (destination.kind === "dedicated" ||
                  (option.destination.kind === "existing" &&
                    destination.path === option.destination.path));
              return (
                <label
                  key={
                    option.destination.kind === "dedicated"
                      ? "dedicated"
                      : option.destination.path
                  }
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 p-3 has-checked:bg-accent/50 has-disabled:cursor-not-allowed has-disabled:opacity-64"
                >
                  <input
                    type="radio"
                    name="pr-checkout"
                    checked={selected}
                    disabled={Boolean(option.unavailable)}
                    onChange={() => setDestination(option.destination)}
                    className="mt-1 accent-current"
                  />
                  {option.destination.kind === "dedicated" ? (
                    <GitBranchIcon className="mt-1 size-3.5 shrink-0" />
                  ) : (
                    <FolderGit2Icon className="mt-1 size-3.5 shrink-0" />
                  )}
                  <span className="flex min-w-0 flex-col text-sm">
                    <span>{option.label}</span>
                    <span className="break-all text-xs text-muted-foreground">
                      {option.description}
                    </span>
                    {option.unavailable ? (
                      <span className="text-xs text-muted-foreground">
                        {option.unavailable}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
            {loading ? (
              <p className="text-xs text-muted-foreground">
                Loading registered worktrees...
              </p>
            ) : null}
            {discoveryError ? (
              <p className="text-xs text-muted-foreground">{discoveryError}</p>
            ) : null}
          </fieldset>
        )}
        {error ? (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={busy}
          onClick={() => (prepared ? onOpen() : onPrepare(destination))}
        >
          {busy ? "Preparing..." : prepared ? "Open conversation" : "Check out"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
