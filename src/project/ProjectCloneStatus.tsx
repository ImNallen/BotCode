// Ports T3 Code v0.0.45 ProjectCloneToastCoordinator.tsx and ChatView.tsx clone banners (MIT).
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon } from "lucide-react";
import { ipc, native } from "../ipc";
import { ComposerBanner } from "../chat/ComposerBanner";
import { Button } from "../ui/controls";
import { Toast, ToastViewport } from "../ui/toast";
import { notifyProject } from "./ProjectToasts";
import { cloneName, cloneProgress, type ProjectCloneSnapshot } from "./clones";
import { usePreferences } from "../settings/preferences";

export function useProjectClones() {
  return useQuery({
    queryKey: ["project-clones"],
    queryFn: ipc.projectClones,
    enabled: native,
    refetchInterval: (query) =>
      query.state.data?.some((clone) => clone.phase === "running") ? 250 : 2000,
    refetchIntervalInBackground: true,
  });
}
function useCloneActions() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const selected = useSearch({ from: "__root__" });
  const { forgetProject } = usePreferences();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const run = async (
    clone: ProjectCloneSnapshot,
    kind: "cancel" | "retry" | "remove",
  ) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      if (kind === "remove") {
        await ipc.removeWorkspace(clone.workspaceId);
        forgetProject(clone.workspaceId);
        await client.invalidateQueries({ queryKey: ["workspaces"] });
        if (selected.workspace === clone.workspaceId)
          await navigate({ to: "/", search: {} });
      } else if (kind === "cancel")
        await ipc.cancelProjectClone(clone.workspaceId);
      else await ipc.retryProjectClone(clone.workspaceId);
      await client.invalidateQueries({ queryKey: ["project-clones"] });
    } catch (error: unknown) {
      notifyProject(
        "error",
        `Failed to ${kind === "remove" ? "remove project" : `${kind} clone`}`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return { pending, run };
}
export function ProjectCloneBanner({ clone }: { clone: ProjectCloneSnapshot }) {
  const { pending, run } = useCloneActions();
  if (clone.phase === "done") return null;
  const running = clone.phase === "running";
  const cancelled = clone.phase === "cancelled";
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        variant={running ? "info" : cancelled ? "warning" : "error"}
        role="status"
      >
        <ComposerBanner.Row layout="wrap-actions">
          <ComposerBanner.Icon>
            <DownloadIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="truncate">
              {running
                ? `Cloning ${cloneName(clone)}`
                : cancelled
                  ? `Cancelled cloning ${cloneName(clone)}`
                  : `Failed to clone ${cloneName(clone)}`}
            </span>
            <ComposerBanner.Separator />
            <span className="truncate text-muted-foreground">
              {running
                ? cloneProgress(clone)
                : cancelled
                  ? "Retry to bring in the repository."
                  : clone.error}
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            {running ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={pending}
                onClick={() => void run(clone, "cancel")}
              >
                Cancel
              </Button>
            ) : (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void run(clone, "remove")}
                >
                  Remove project
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void run(clone, "retry")}
                >
                  Retry
                </Button>
              </>
            )}
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
export function ProjectCloneToastCoordinator() {
  const clones = useProjectClones();
  const selected = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const client = useQueryClient();
  const { pending, run } = useCloneActions();
  const previous = useRef(new Map<string, string>());
  const [dismissed, setDismissed] = useState(new Set<string>());
  useEffect(() => {
    for (const clone of clones.data ?? []) {
      if (previous.current.get(clone.workspaceId) !== clone.phase) {
        previous.current.set(clone.workspaceId, clone.phase);
        void client.invalidateQueries({
          queryKey: ["workspace", clone.workspaceId],
        });
        void client.invalidateQueries({
          queryKey: ["worktrees", clone.workspaceId],
        });
        void client.invalidateQueries({
          queryKey: ["project-config", clone.workspaceId],
        });
      }
    }
  }, [clones.data, client]);
  const visible = (clones.data ?? []).filter(
    (clone) =>
      !(selected.workspace === clone.workspaceId && !selected.thread) &&
      !(clone.phase === "done" && dismissed.has(clone.workspaceId)),
  );
  if (!visible.length) return null;
  return (
    <ToastViewport>
      <div className="flex w-full flex-col gap-2">
        {visible.map((clone) => (
          <Toast
            key={clone.workspaceId}
            type={
              clone.phase === "running"
                ? "loading"
                : clone.phase === "done"
                  ? "success"
                  : clone.phase === "cancelled"
                    ? "info"
                    : "error"
            }
            title={
              clone.phase === "running"
                ? `Cloning ${cloneName(clone)}`
                : clone.phase === "done"
                  ? `Cloned ${cloneName(clone)}`
                  : clone.phase === "cancelled"
                    ? `Cancelled cloning ${cloneName(clone)}`
                    : `Failed to clone ${cloneName(clone)}`
            }
            description={
              clone.phase === "running"
                ? cloneProgress(clone)
                : clone.phase === "failed"
                  ? (clone.error ?? "The clone failed.")
                  : clone.destinationPath
            }
            dismissAfterVisibleMs={clone.phase === "done" ? 8000 : undefined}
            onDismiss={
              clone.phase === "done"
                ? () =>
                    setDismissed((current) =>
                      new Set(current).add(clone.workspaceId),
                    )
                : undefined
            }
            action={{
              label:
                clone.phase === "running"
                  ? "Cancel"
                  : clone.phase === "done"
                    ? "Open project"
                    : "Retry",
              onClick: () => {
                if (clone.phase === "done") {
                  setDismissed((current) =>
                    new Set(current).add(clone.workspaceId),
                  );
                  void navigate({
                    to: "/",
                    search: { workspace: clone.workspaceId },
                  });
                } else
                  void run(
                    clone,
                    clone.phase === "running" ? "cancel" : "retry",
                  );
              },
            }}
          >
            {clone.phase === "failed" || clone.phase === "cancelled" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={pending}
                onClick={() => void run(clone, "remove")}
              >
                Remove project
              </Button>
            ) : null}
          </Toast>
        ))}
      </div>
    </ToastViewport>
  );
}
