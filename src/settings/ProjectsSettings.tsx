// Rows, copy and confirmation follow pingdotgg/t3code v0.0.45 settings/ProjectsSettings.tsx and
// ProjectSettingsPanel.tsx, with input classes from ui/input.tsx and alert classes from ui/alert.tsx (MIT).
import { followUps } from "../chat/followUps";
import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm } from "@tauri-apps/plugin-dialog";
import { InfoIcon, Trash2Icon } from "lucide-react";
import {
  checkoutKey,
  ipc,
  type Workspace,
  type ProjectIconOverride,
} from "../ipc";
import { workingSessions } from "../lib/sessions";
import { Alert } from "../ui/alert";
import { Button } from "../ui/controls";
import { ProjectSettingRow } from "./ProjectSettingRow";
import { usePreferences } from "./preferences";
import { projectRows } from "./settingsCatalog";
import { SettingsScopeNotice, type SettingsScope } from "./settingsScope";
const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectFaviconPickerDialog } from "./ProjectFaviconPickerDialog";
import { WorkspaceBadge } from "../ProjectBadge";
import {
  SettingsGroup,
  SettingsRow,
  SettingResetButton,
} from "./settingsLayout";

export function ProjectsSettings({
  scope,
  workspaces,
}: {
  scope: SettingsScope;
  workspaces: Workspace[];
}) {
  if (scope.kind === "project")
    return <ProjectSettings key={scope.workspace.id} scope={scope} />;
  if (scope.kind === "unavailable")
    return (
      <p className="text-sm text-muted-foreground">
        This project is no longer available.
      </p>
    );
  if (workspaces.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Add a project from the sidebar to configure it here.
      </p>
    );
  return (
    <SettingsScopeNotice>
      Choose a project to manage its name and new-thread defaults.
    </SettingsScopeNotice>
  );
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

function ProjectSettings({
  scope,
}: {
  scope: Extract<SettingsScope, { kind: "project" }>;
}) {
  const { workspace } = scope;
  const client = useQueryClient();
  const { forgetProject } = usePreferences();
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
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [faviconPickerOpen, setFaviconPickerOpen] = useState(false);
  const [savingIcon, setSavingIcon] = useState(false);
  const setProjectIcon = async (
    projectIcon: ProjectIconOverride | null,
    faviconPath: string | null,
  ) => {
    setSavingIcon(true);
    try {
      await ipc.updateProjectIcon(workspace.id, projectIcon, faviconPath);
      setError(undefined);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["workspaces"] }),
        client.invalidateQueries({ queryKey: ["workspace"] }),
        client.invalidateQueries({
          queryKey: ["project-favicon", workspace.id],
        }),
      ]);
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingIcon(false);
    }
  };
  const icon = workspace.projectIcon;
  const [name, setName] = useState(workspace.label);
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState(false);
  useEffect(() => setName(workspace.label), [workspace.label]);
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
      if (
        followUps
          .snapshot()
          .some(
            (queue) => queue.workspaceId === workspace.id && queue.rows.length,
          )
      )
        throw new Error(
          "Remove queued messages from this project before removing it.",
        );
      await ipc.removeWorkspace(workspace.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setRemoving(false);
      return;
    }
    forgetProject(workspace.id);
    const selected = selection.workspace === workspace.id;
    await navigate({
      to: "/",
      search: {
        workspace: selected ? undefined : selection.workspace,
        thread: selected ? undefined : selection.thread,
      },
      hash: "",
      replace: true,
      resetScroll: false,
    });
    await client.invalidateQueries({ queryKey: ["workspaces"] });
    for (const key of ["workspace", "file", "diff", "branches"])
      client.removeQueries({ queryKey: [key, workspace.id] });
    for (const thread of threads ?? [])
      client.removeQueries({ queryKey: ["thread", thread.id] });
  };
  return (
    <>
      <Alert variant="info" icon={<InfoIcon aria-hidden />}>
        Can't find a setting? Keep this project picked above and hop to any
        other settings page.
      </Alert>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-error/32 bg-error-surface px-3 py-2 text-sm text-error-foreground"
        >
          {error}
        </p>
      ) : null}
      {workspace.kind === "repository" ? (
        <SettingsGroup id="project-overview" title="Project" hideTitle>
          <SettingsRow
            {...projectRows.name}
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
          <SettingsRow
            {...projectRows.icon}
            description={
              icon?.kind === "lucide"
                ? `${icon.name} · ${icon.color}`
                : icon?.kind === "monogram"
                  ? `${icon.text} · ${icon.color}`
                  : icon?.kind === "emoji"
                    ? icon.emoji
                    : (workspace.faviconPath ?? "Automatic")
            }
            resetAction={
              icon || workspace.faviconPath ? (
                <SettingResetButton
                  label="project icon"
                  disabled={savingIcon}
                  onClick={() => void setProjectIcon(null, null)}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <WorkspaceBadge workspace={workspace} className="size-6" />
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Choose a project icon"
                  disabled={savingIcon}
                  onClick={() => setIconPickerOpen(true)}
                >
                  Choose icon
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Choose a project icon file"
                  disabled={savingIcon}
                  onClick={() => setFaviconPickerOpen(true)}
                >
                  Choose file
                </Button>
              </div>
            }
          />
        </SettingsGroup>
      ) : null}
      {iconPickerOpen ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={workspace.projectIcon}
            projectName={workspace.label}
            open={iconPickerOpen}
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon(icon, null)}
          />
        </Suspense>
      ) : null}
      {faviconPickerOpen ? (
        <ProjectFaviconPickerDialog
          workspace={workspace}
          onOpenChange={setFaviconPickerOpen}
          onSelect={(path) => void setProjectIcon(null, path)}
        />
      ) : null}
      <SettingsGroup id="project-new-threads" title="New threads">
        <ProjectSettingRow
          id={projectRows.workspace.id}
          setting="newThreadCheckout"
          scope={scope}
        />
      </SettingsGroup>
      {workspace.kind === "repository" ? (
        <ProjectActionsSettings workspaceId={workspace.id} />
      ) : null}
      <SettingsGroup id="project-danger" title="Danger">
        <SettingsRow
          {...projectRows.remove}
          description={
            working
              ? "Stop this project's running conversations before removing it."
              : projectRows.remove.description
          }
          control={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={working || removing}
              onClick={() => void remove()}
            >
              <Trash2Icon />
              Remove project
            </Button>
          }
        />
      </SettingsGroup>
    </>
  );
}
