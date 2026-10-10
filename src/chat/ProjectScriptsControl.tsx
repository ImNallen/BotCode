// Ported from T3 Code v0.0.45 components/ProjectScriptsControl.tsx (MIT).
import {
  ChevronDownIcon,
  PlusIcon,
  SettingsIcon,
  DownloadIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectScript } from "../ipc";
import { Button } from "../ui/controls";
import {
  Menu,
  MenuItem,
  MenuGroupLabel,
  MenuSeparator,
  MenuShortcut,
} from "../ui/menu";
import {
  commandShortcutLabel,
  registerScriptCommands,
  resolveCommand,
} from "../lib/actions";
import { useKeybindings } from "../keybindings/store";
import { isCommandPaletteOpen } from "../lib/commandPaletteBus";
import {
  commandForProjectScript,
  primaryProjectScript,
} from "./projectScripts";
import { ScriptIcon } from "../settings/ScriptIcon";
import { ProjectScriptEditorDialog } from "../settings/ProjectScriptEditorDialog";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  scriptEditorInput,
  type ProjectScriptEditorRequest,
} from "../settings/projectActions";
import { useProjectActions } from "../settings/useProjectActions";
export function ProjectScriptsControl({
  workspaceId,
  scripts,
  onRun,
}: {
  workspaceId: string;
  scripts: readonly ProjectScript[];
  onRun: (script: ProjectScript) => void;
}) {
  const bindings = useKeybindings();
  const { file, saving, submit, persist } = useProjectActions(workspaceId);
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const primary = primaryProjectScript(scripts);
  const scriptCommands = scripts
    .map((script) => commandForProjectScript(script.id))
    .join("\0");
  const add = () => {
    setOpen(false);
    setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT });
  };
  const edit = (script: ProjectScript) => {
    setOpen(false);
    setRequest({
      scriptId: script.id,
      initial: scriptEditorInput(
        script,
        bindings.rules.findLast(
          (rule) => rule.command === commandForProjectScript(script.id),
        )?.key ?? null,
      ),
    });
  };
  const importable = (file.data?.scripts ?? []).filter(
    (fileScript) =>
      !scripts.some(
        (script) =>
          script.command === fileScript.command ||
          script.name.toLowerCase() === fileScript.name.toLowerCase(),
      ),
  );
  useEffect(
    () =>
      registerScriptCommands(
        new Set(scriptCommands ? scriptCommands.split("\0") : []),
      ),
    [scriptCommands],
  );
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest("[data-keybinding-capture]")) ||
        document.querySelector("[data-chat-header]")?.closest("[inert]") ||
        event.repeat ||
        event.isComposing ||
        request ||
        isCommandPaletteOpen() ||
        document.querySelector("dialog[open]")
      )
        return;
      const command = resolveCommand(event);
      const script = scripts.find(
        (script) => commandForProjectScript(script.id) === command,
      );
      if (script) {
        event.preventDefault();
        event.stopPropagation();
        onRun(script);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [scripts, onRun, request]);
  return (
    <>
      <div className="flex shrink-0 items-center" aria-label="Project scripts">
        {primary ? (
          <Button
            size="xs"
            variant="outline"
            className="w-7 sm:w-6 @3xl/header-actions:w-auto!"
            aria-label={`Run ${primary.name}`}
            title={`Run ${primary.name}`}
            onClick={() => onRun(primary)}
          >
            <ScriptIcon icon={primary.icon} />
            <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
              {primary.name}
            </span>
          </Button>
        ) : null}
        {primary || importable.length ? (
          <Menu
            open={open}
            onOpenChange={setOpen}
            align="end"
            trigger={(props) => (
              <Button
                {...props}
                size={primary ? "icon-xs" : "xs"}
                variant="outline"
                aria-label={primary ? "Script actions" : "Project actions"}
              >
                {primary ? (
                  <ChevronDownIcon className="size-4" />
                ) : (
                  <>
                    <PlusIcon className="size-3.5" />
                    <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                      Add action
                    </span>
                    <ChevronDownIcon className="size-3.5" />
                  </>
                )}
              </Button>
            )}
          >
            {scripts.map((script) => (
              <div key={script.id} className="group relative flex items-center">
                <MenuItem
                  className="pr-9"
                  onClick={() => {
                    setOpen(false);
                    onRun(script);
                  }}
                >
                  <ScriptIcon icon={script.icon} className="size-4" />
                  <span>
                    {script.runOnWorktreeCreate
                      ? `${script.name} (setup)`
                      : script.name}
                  </span>
                  <span className="relative ms-auto flex h-6 min-w-6 items-center justify-end">
                    <span className="transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
                      <MenuShortcut className="ms-0">
                        {commandShortcutLabel(
                          commandForProjectScript(script.id),
                        )}
                      </MenuShortcut>
                    </span>
                  </span>
                </MenuItem>
                <span className="absolute right-1 top-1/2 flex -translate-y-1/2 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-6"
                    aria-label={`Edit ${script.name}`}
                    disabled={saving}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      edit(script);
                    }}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                </span>
              </div>
            ))}
            {importable.length ? (
              <>
                {primary ? <MenuSeparator /> : null}
                <MenuGroupLabel>From t3.json</MenuGroupLabel>
                {importable.map((script) => (
                  <MenuItem
                    key={script.id}
                    disabled={saving}
                    onClick={() => {
                      setOpen(false);
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
                    <ScriptIcon icon={script.icon} className="size-4" />
                    <span>{script.name}</span>
                    <MenuShortcut>
                      <DownloadIcon className="size-3.5" aria-label="Import" />
                    </MenuShortcut>
                  </MenuItem>
                ))}
              </>
            ) : null}
            <MenuItem disabled={saving} onClick={add}>
              <PlusIcon className="size-4" />
              Add action
            </MenuItem>
          </Menu>
        ) : (
          <Button
            size="xs"
            variant="outline"
            className="w-7 sm:w-6 @3xl/header-actions:w-auto!"
            aria-label="Add action"
            title="Add action"
            onClick={add}
          >
            <PlusIcon className="size-3.5" />
            <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
              Add action
            </span>
          </Button>
        )}
      </div>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
      <ProjectScriptEditorDialog
        request={request}
        scripts={scripts}
        onSubmit={submit}
        onDelete={(id) => {
          void persist(
            (current) => current.filter((script) => script.id !== id),
            id,
            null,
          ).catch((cause) =>
            setError(cause instanceof Error ? cause.message : String(cause)),
          );
        }}
        onClose={() => setRequest(null)}
      />
    </>
  );
}
