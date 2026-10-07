// Ported from pingdotgg/t3code v0.0.45 components/settings/SettingsPanels.tsx ArchivedThreadsPanel (MIT).
import { useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, ArchiveXIcon, Trash2Icon } from "lucide-react";
import { ipc, type ThreadSummary } from "../ipc";
import { formatRelativeTimeLabel } from "../lib/time";
import { WorkspaceBadge } from "../ProjectBadge";
import { confirmAndDeleteThread, restoreThread } from "../threadActions";
import { Button } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import { SettingsGroup, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./settingsScope";

export function ArchivedThreadsPanel() {
  const { scope, workspaces } = useSettingsScope();
  const client = useQueryClient();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [menu, setMenu] = useState<{
    thread: ThreadSummary;
    point: { x: number; y: number };
    element: HTMLElement;
  }>();
  const views = useQueries({
    queries: workspaces.map((workspace) => ({
      queryKey: ["thread-summaries", workspace.id],
      queryFn: () => ipc.threadSummaries(workspace.id),
    })),
  });
  const groups = workspaces.flatMap((workspace, index) => {
    const summaries = views[index]?.data;
    if (
      !summaries ||
      scope?.kind === "unavailable" ||
      (scope?.kind === "project" && workspace.id !== scope.workspace.id)
    )
      return [];
    const threads = summaries
      .filter((thread) => thread.archivedAtMs !== null)
      .sort(
        (a, b) =>
          (b.archivedAtMs ?? b.createdAtMs ?? 0) -
            (a.archivedAtMs ?? a.createdAtMs ?? 0) || b.id.localeCompare(a.id),
      );
    return threads.length ? [{ workspace, threads }] : [];
  });
  const act = async (thread: ThreadSummary, action: "unarchive" | "delete") => {
    try {
      if (action === "delete") {
        const outcome = await confirmAndDeleteThread(thread, client);
        if (!outcome) return;
        setError(undefined);
        setStatus(
          outcome.kind === "retained"
            ? `Thread deleted. Worktree kept. ${outcome.reason}`
            : undefined,
        );
      } else {
        await restoreThread(thread.id, client);
        setError(undefined);
        setStatus(undefined);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <>
      {status ? (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-error-foreground">
          {error}
        </p>
      ) : null}
      {groups.length === 0 ? (
        <SettingsGroup id="archive" title="Archived threads">
          <SettingsRow
            id="archive-empty"
            title={
              views.some((query) => query.isPending) ? (
                "Loading archived threads"
              ) : views.some((query) => query.isError) ? (
                "Could not load archived threads"
              ) : (
                <span className="inline-flex items-center gap-2">
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                  No archived threads
                </span>
              )
            }
            description="Archived threads will appear here."
            control={null}
          />
        </SettingsGroup>
      ) : (
        groups.map(({ workspace, threads }, index) => (
          <SettingsGroup
            key={workspace.id}
            id={index === 0 ? "archive" : `archive-${workspace.id}`}
            title={
              <>
                <WorkspaceBadge workspace={workspace} className="size-3.5" />
                {workspace.label}
              </>
            }
          >
            {threads.map((thread) => (
              <SettingsRow
                key={thread.id}
                id={`archive-${thread.id}`}
                title={thread.title}
                description={`Archived ${relative(thread.archivedAtMs ?? thread.createdAtMs)} · Created ${relative(thread.createdAtMs)}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({
                    thread,
                    point: { x: event.clientX, y: event.clientY },
                    element: event.currentTarget,
                  });
                }}
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    onClick={() => void act(thread, "unarchive")}
                  >
                    <ArchiveXIcon className="size-3.5" />
                    <span>Unarchive</span>
                  </Button>
                }
              />
            ))}
          </SettingsGroup>
        ))
      )}
      {menu ? (
        <Menu
          open
          point={menu.point}
          returnFocus={menu.element}
          trigger={() => null}
          onOpenChange={(open) => {
            if (!open) setMenu(undefined);
          }}
        >
          <MenuItem onClick={() => void act(menu.thread, "unarchive")}>
            <ArchiveXIcon />
            Unarchive
          </MenuItem>
          <MenuItem
            variant="destructive"
            onClick={() => void act(menu.thread, "delete")}
          >
            <Trash2Icon />
            Delete
          </MenuItem>
        </Menu>
      ) : null}
    </>
  );
}

function relative(at: number | null): string {
  return at === null
    ? "unknown"
    : formatRelativeTimeLabel(new Date(at).toISOString());
}
