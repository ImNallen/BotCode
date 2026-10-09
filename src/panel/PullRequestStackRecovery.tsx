import { useState } from "react";
import { ipc } from "../ipc";
import { Button } from "../ui/controls";
import { Toast, ToastViewport, type ToastType } from "../ui/toast";
import type { PrAccess } from "./prInbox";
import type { PullRequestKey } from "./pullRequestKey";
import type { PrStackOperation } from "./pullRequestStack";
export function PullRequestStackRecovery({
  access,
  prKey,
  operations,
  onActed,
}: {
  access: PrAccess;
  prKey: PullRequestKey;
  operations: PrStackOperation[];
  onActed: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<{
    type: ToastType;
    title: string;
    description?: string;
  }>();
  const reconcile = async () => {
    if (pending) return;
    setPending(true);
    try {
      for (const operation of operations) {
        const result = await ipc.reconcilePullRequestStack(
          access,
          prKey,
          operation.input.requestId,
        );
        const success =
          result.result.kind === "completed" ||
          result.result.kind === "accepted";
        setToast({
          type: success ? "success" : "info",
          title: success
            ? "Stack merge request completed"
            : "Stack operation did not complete",
          description:
            "message" in result.result
              ? result.result.message
              : "GitHub merged the stack or added it to its merge queue.",
        });
      }
    } catch (error) {
      setToast({
        type: "error",
        title: "Stack operation did not complete",
        description: String(error),
      });
    } finally {
      setPending(false);
      onActed();
    }
  };
  return (
    <>
      {operations.length ? (
        <Button
          variant="outline"
          size="xs"
          disabled={pending}
          onClick={() => void reconcile()}
        >
          Check stack operation
        </Button>
      ) : null}
      {toast ? (
        <ToastViewport>
          <Toast {...toast} onDismiss={() => setToast(undefined)} />
        </ToastViewport>
      ) : null}
    </>
  );
}
