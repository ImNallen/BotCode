// Ported from pingdotgg/t3code v0.0.45 components/settings/ProjectActionsSettings.tsx and ProjectActionsList.tsx (MIT).
import { useState } from "react";
import { ChevronDownIcon, PlusIcon, SettingsIcon } from "lucide-react";
import type { ProjectScript } from "../ipc";
import { commandForProjectScript } from "../chat/projectScripts";
import { commandShortcutLabel } from "../lib/actions";
import { useKeybindings } from "../keybindings/store";
import { Button } from "../ui/controls";
import { Menu, MenuItem, MenuGroupLabel, MenuSeparator } from "../ui/menu";
import {
  SettingsGroup,
  SettingsRow,
  SettingResetButton,
} from "./settingsLayout";
import { ScriptIcon } from "./ScriptIcon";
import { ProjectScriptEditorDialog } from "./ProjectScriptEditorDialog";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  scriptEditorInput,
  type ProjectScriptEditorRequest,
} from "./projectActions";
import { useProjectActions } from "./useProjectActions";

export function ProjectActionsSettings({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const { scripts, file, saving, config, persist, submit, overridden } =
    useProjectActions(workspaceId);
  const bindings = useKeybindings();
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(
    null,
  );
  const [error, setError] = useState<string>();
  const edit = (script: ProjectScript) =>
    setRequest({
      scriptId: script.id,
      initial: scriptEditorInput(
        script,
        bindings.rules.findLast(
          (rule) => rule.command === commandForProjectScript(script.id),
        )?.key ?? null,
      ),
    });
  const handleError = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  const importable = (file.data?.scripts ?? []).filter(
    (fileScript) =>
      !scripts.some(
        (script) =>
          script.command === fileScript.command ||
          script.name.toLowerCase() === fileScript.name.toLowerCase(),
      ),
  );
  return (
    <SettingsGroup id="project-actions" title="Actions">
      <SettingsRow
        id="project-actions-list"
        title="Actions"
        description="Commands that run in this project's checkout or its worktree, with optional shortcuts."
        resetAction={
          overridden ? (
            <SettingResetButton
              label="actions"
              disabled={saving}
              onClick={() => {
                setError(undefined);
                void persist(() => null).catch(handleError);
              }}
            />
          ) : null
        }
        control={
          <div className="flex flex-wrap items-center gap-1.5">
            {importable.length > 0 ? (
              <Menu
                align="end"
                trigger={(props) => (
                  <Button
                    {...props}
                    id="import-scripts"
                    size="xs"
                    variant="ghost"
                    disabled={saving}
                  >
                    Import scripts
                    <ChevronDownIcon className="size-3.5" />
                  </Button>
                )}
              >
                <MenuGroupLabel>Import from t3.json</MenuGroupLabel>
                <p className="px-2 pb-2 text-pretty text-sm text-muted-foreground">
                  Add actions declared by this checkout without editing them
                  first.
                </p>
                <MenuSeparator />
                {importable.map((script) => (
                  <MenuItem
                    key={script.id}
                    onClick={() => {
                      const initial = scriptEditorInput(script, null);
                      void submit(null, initial).catch((cause) =>
                        setRequest({
                          scriptId: null,
                          initial,
                          error:
                            cause instanceof Error
                              ? cause.message
                              : "Failed to import action.",
                        }),
                      );
                    }}
                  >
                    <ScriptIcon
                      icon={script.icon}
                      className="size-4 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{script.name}</div>
                      <div className="truncate font-mono text-muted-foreground">
                        {script.command}
                      </div>
                    </div>
                  </MenuItem>
                ))}
              </Menu>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={saving || config.isPending}
              onClick={() =>
                setRequest({
                  scriptId: null,
                  initial: EMPTY_PROJECT_SCRIPT_INPUT,
                })
              }
            >
              <PlusIcon className="size-3.5" />
              Add action
            </Button>
          </div>
        }
      />
      {scripts.length === 0 ? (
        <p className="px-3 py-2 text-base text-muted-foreground sm:px-4 sm:text-sm">
          No actions configured.
        </p>
      ) : (
        scripts.map((script) => (
          <SettingsRow
            key={script.id}
            className="group py-2"
            title={
              <span className="flex min-w-0 items-center gap-2">
                <ScriptIcon
                  icon={script.icon}
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 truncate">{script.name}</span>
                {script.runOnWorktreeCreate ? (
                  <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground">
                    setup
                  </span>
                ) : null}
                {script.previewUrl ? (
                  <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-2xs font-normal text-muted-foreground max-sm:hidden">
                    preview · desktop only
                  </span>
                ) : null}
              </span>
            }
            description={
              <code className="block max-w-full truncate font-mono">
                {script.command}
              </code>
            }
            control={
              <>
                {commandShortcutLabel(commandForProjectScript(script.id)) ? (
                  <span className="text-xs text-muted-foreground">
                    {commandShortcutLabel(commandForProjectScript(script.id))}
                  </span>
                ) : null}
                <span className="flex shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Edit ${script.name}`}
                    disabled={saving}
                    onClick={() => edit(script)}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                </span>
              </>
            }
          />
        ))
      )}
      {file.isError ? (
        <SettingsRow
          title="t3.json is invalid"
          description="A t3.json exists in this checkout but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values."
          className="text-warning"
        />
      ) : null}
      {error || config.error ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {error ?? config.error?.message}
        </p>
      ) : null}
      <ProjectScriptEditorDialog
        request={request}
        scripts={scripts}
        onSubmit={async (id, input) => {
          await submit(id, input);
          setError(undefined);
        }}
        onDelete={(id) => {
          setError(undefined);
          void persist(
            (current) => current.filter((script) => script.id !== id),
            id,
            null,
          ).catch(handleError);
        }}
        onClose={() => setRequest(null)}
      />
    </SettingsGroup>
  );
}
