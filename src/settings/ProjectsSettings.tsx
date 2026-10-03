// Rows, copy and confirmation follow pingdotgg/t3code v0.0.45 settings/ProjectSettingsPanel.tsx,
// with input classes from ui/input.tsx (MIT).
import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm } from "@tauri-apps/plugin-dialog";
import { Trash2Icon } from "lucide-react";
import {
  checkoutKey,
  ipc,
  native,
  workingSessions,
  type Workspace,
} from "../ipc";
import { WorkspaceBadge } from "../ProjectBadge";
import { Button } from "../ui/controls";
import { SettingsGroup, SettingsRow } from "./settingsLayout";

export function ProjectsSettings() {
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: ipc.workspaces,
    enabled: native,
  });
  const list = workspaces.data ?? [];
  const ordered = [
    ...list.filter((workspace) => workspace.kind === "scratch"),
    ...list.filter((workspace) => workspace.kind === "repository"),
  ];
  if (workspaces.isPending) return null;
  if (ordered.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Add a project from the sidebar to configure it here.
      </p>
    );
  return ordered.map((workspace) => (
    <ProjectSettings key={workspace.id} workspace={workspace} />
  ));
}

function removalMessage(workspace: Workspace, threads: number | undefined) {
  const name = `"${workspace.label}"`;
  const path = `Path: ${workspace.root}`;
  if (threads === 0)
    return [
      `Remove project ${name}?`,
      path,
      "This removes only this project entry.",
    ].join("\n");
  return [
    threads === undefined
      ? `Remove project ${name} and delete its threads?`
      : `Remove project ${name} and delete its ${threads} thread${threads === 1 ? "" : "s"}?`,
    path,
    "This permanently clears conversation history for those threads.",
    "This removes only this project entry.",
    "This action cannot be undone.",
  ].join("\n");
}

function ProjectSettings({ workspace }: { workspace: Workspace }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const selection = useSearch({ from: "__root__" });
  const view = useQuery({
    queryKey: checkoutKey("workspace", { workspaceId: workspace.id }),
    queryFn: () => ipc.workspace({ workspaceId: workspace.id }),
  });
  // The view is unavailable when the folder is gone or too large to inspect, and
  // removal must still work then, so the thread count stays unknown.
  const threads = view.data?.threads;
  const working = threads?.some((thread) =>
    workingSessions.has(thread.session.kind),
  );
  const [name, setName] = useState(workspace.label);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setName(workspace.label), [workspace.label]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const rename = async () => {
    if (name.trim() === workspace.label) {
      setName(workspace.label);
      return;
    }
    try {
      await ipc.renameWorkspace(workspace.id, name);
      setError(undefined);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["workspaces"] }),
        client.invalidateQueries({ queryKey: ["workspace"] }),
      ]);
    } catch (e: unknown) {
      setName(workspace.label);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = async () => {
    const confirmed = await confirm(
      removalMessage(workspace, threads?.length),
      {
        title: "Remove project",
        kind: "warning",
        okLabel: "Remove",
        cancelLabel: "Cancel",
      },
    );
    if (!confirmed) return;
    setRemoving(true);
    try {
      await ipc.removeWorkspace(workspace.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setRemoving(false);
      return;
    }
    if (selection.workspace === workspace.id)
      await navigate({
        to: "/settings/$section",
        params: { section: "projects" },
        search: { ...selection, workspace: undefined, thread: undefined },
        hash: "",
        replace: true,
        resetScroll: false,
      });
    await client.invalidateQueries({ queryKey: ["workspaces"] });
    for (const scope of ["workspace", "file", "diff", "branches"])
      client.removeQueries({ queryKey: [scope, workspace.id] });
    for (const thread of threads ?? [])
      client.removeQueries({ queryKey: ["thread", thread.id] });
  };
  return (
    <SettingsGroup
      id={`project-${workspace.id}`}
      title={
        <>
          <WorkspaceBadge workspace={workspace} className="size-4" />
          <span className="min-w-0 truncate">{workspace.label}</span>
        </>
      }
    >
      {error ? (
        <div className="px-3 py-3 sm:px-4">
          <p
            role="alert"
            className="rounded-lg border border-error/32 bg-error-surface px-3 py-2 text-sm text-error-foreground"
          >
            {error}
          </p>
        </div>
      ) : null}
      {workspace.kind === "repository" ? (
        <SettingsRow
          id={`project-${workspace.id}-name`}
          title="Name"
          description="The name for this project in the sidebar and thread lists."
          control={
            <span
              data-size="sm"
              data-slot="input-control"
              className="relative inline-flex rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)] w-full sm:w-64"
            >
              <input
                data-slot="input"
                aria-label="Project name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                onBlur={() => void rename()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape" && name !== workspace.label) {
                    // An edit consumes Escape before settings closes.
                    event.preventDefault();
                    event.stopPropagation();
                    setName(workspace.label);
                  }
                }}
                className="w-full min-w-0 rounded-[inherit] outline-none placeholder:text-placeholder [transition:background-color_5000000s_ease-in-out_0s] h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5"
              />
            </span>
          }
        />
      ) : null}
      <SettingsRow
        id={`project-${workspace.id}-location`}
        title="Location"
        description="Where this project lives on disk."
        control={
          <>
            <span
              title={workspace.root}
              className="min-w-0 truncate font-mono text-xs text-muted-foreground"
            >
              {workspace.root}
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(workspace.root)
                  .then(() => setCopied(true))
              }
            >
              {copied ? "Copied" : "Copy path"}
            </Button>
          </>
        }
      />
      <SettingsRow
        id={`project-${workspace.id}-remove`}
        title="Remove project"
        description="Deletes the project entry and its threads. Files on disk are not touched."
        control={
          // Disabled buttons ignore the pointer, so the wrapper carries the reason.
          <span
            title={
              working
                ? "Stop this project's running conversations before removing it."
                : undefined
            }
          >
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={working || removing}
              onClick={() => void remove()}
            >
              <Trash2Icon />
              Remove project
            </Button>
          </span>
        }
      />
    </SettingsGroup>
  );
}
