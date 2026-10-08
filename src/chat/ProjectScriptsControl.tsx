// Ported from T3 Code v0.0.45 apps/web/src/components/ProjectScriptsControl.tsx and projectScriptEditor.tsx (MIT).
import {
  ChevronDownIcon,
  PlayIcon,
  BugIcon,
  FlaskConicalIcon,
  ListChecksIcon,
  WrenchIcon,
  HammerIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectScript } from "../ipc";
import { Button } from "../ui/controls";
import { Menu, MenuItem } from "../ui/menu";
import { Dialog, DialogTitle, DialogFooter } from "../ui/dialog";
import {
  commandShortcutLabel,
  registerScriptCommands,
  resolveCommand,
} from "../lib/actions";
import { keybindings, useKeybindings } from "../keybindings/store";
import {
  compileResolvedKeybindingRule,
  type KeybindingRule,
} from "../keybindings/rules";
import {
  formatShortcutLabel,
  keybindingFromKeyboardEvent,
  shortcutConflictKey,
} from "../keybindings/keyboard";
import { isCommandPaletteOpen } from "../lib/commandPaletteBus";
import {
  commandForProjectScript,
  primaryProjectScript,
} from "./projectScripts";
function ScriptIcon({ icon }: { icon: string }) {
  const Icon =
    icon === "test"
      ? FlaskConicalIcon
      : icon === "lint"
        ? ListChecksIcon
        : icon === "configure"
          ? WrenchIcon
          : icon === "build"
            ? HammerIcon
            : icon === "debug"
              ? BugIcon
              : PlayIcon;
  return <Icon className="size-3.5" />;
}
export function ProjectScriptsControl({
  scripts,
  onRun,
}: {
  scripts: readonly ProjectScript[];
  onRun: (script: ProjectScript) => void;
}) {
  const bindings = useKeybindings();
  const [editing, setEditing] = useState<ProjectScript | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [shortcutError, setShortcutError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const primary = primaryProjectScript(scripts);
  const scriptCommands = scripts
    .map((script) => commandForProjectScript(script.id))
    .join("\0");
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
        editing ||
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
  }, [scripts, onRun, editing]);
  const save = (key: string | null) => {
    if (!editing) return;
    const command = commandForProjectScript(editing.id);
    const previous = bindings.rules.findLast(
      (rule) => rule.command === command,
    );
    setSaving(true);
    setShortcutError(undefined);
    void (
      key
        ? keybindings.upsert({ key, command, when: "!terminalFocus" }, previous)
        : keybindings.reset(command)
    )
      .then(() => setEditing(null))
      .catch((cause: unknown) =>
        setShortcutError(
          cause instanceof Error
            ? cause.message
            : "Could not save the shortcut.",
        ),
      )
      .finally(() => setSaving(false));
  };
  const candidateRule: KeybindingRule | null =
    candidate && editing
      ? {
          key: candidate,
          command: commandForProjectScript(editing.id),
          when: "!terminalFocus",
        }
      : null;
  const compiledCandidate =
    candidateRule && compileResolvedKeybindingRule(candidateRule);
  const conflicts = compiledCandidate
    ? bindings.bindings.filter(
        (binding) =>
          binding.command !== candidateRule?.command &&
          shortcutConflictKey(binding.shortcut, navigator.platform) ===
            shortcutConflictKey(
              compiledCandidate.shortcut,
              navigator.platform,
            ) &&
          (!binding.whenAst || binding.command.startsWith("script.")),
      )
    : [];
  if (!primary) return null;
  return (
    <>
      <div className="flex shrink-0 items-center" aria-label="Project scripts">
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
        <Menu
          open={open}
          onOpenChange={setOpen}
          align="end"
          trigger={(props) => (
            <Button
              {...props}
              size="icon-xs"
              variant="outline"
              aria-label="Script actions"
            >
              <ChevronDownIcon className="size-4" />
            </Button>
          )}
        >
          {scripts.map((script) => {
            const shortcut = commandShortcutLabel(
              commandForProjectScript(script.id),
            );
            return (
              <div key={script.id}>
                <MenuItem
                  onClick={() => {
                    setOpen(false);
                    onRun(script);
                  }}
                >
                  <ScriptIcon icon={script.icon} />
                  <span>
                    {script.name}
                    {script.runOnWorktreeCreate ? " (setup)" : ""}
                  </span>
                  <span className="ms-auto text-xs text-muted-foreground">
                    {shortcut ?? ""}
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setOpen(false);
                    setShortcutError(undefined);
                    setEditing(script);
                    setCandidate(
                      bindings.rules.findLast(
                        (rule) =>
                          rule.command === commandForProjectScript(script.id),
                      )?.key ?? null,
                    );
                  }}
                >
                  Set keyboard shortcut for {script.name}…
                </MenuItem>
              </div>
            );
          })}
        </Menu>
      </div>
      <Dialog open={editing !== null} onOpenChange={() => setEditing(null)}>
        <DialogTitle>Set keyboard shortcut</DialogTitle>
        <p className="text-sm text-muted-foreground">{editing?.name}</p>
        <input
          aria-label="Keyboard shortcut"
          autoFocus
          readOnly
          data-keybinding-capture
          value={
            compiledCandidate
              ? formatShortcutLabel(
                  compiledCandidate.shortcut,
                  navigator.platform,
                )
              : "Press a shortcut"
          }
          className="my-4 rounded-md border p-2"
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat || event.nativeEvent.isComposing) return;
            setShortcutError(undefined);
            setCandidate(
              keybindingFromKeyboardEvent(
                event.nativeEvent,
                navigator.platform,
              ),
            );
          }}
        />
        {conflicts.length ? (
          <p className="text-sm text-warning">
            This key is also assigned to{" "}
            {conflicts.map((binding) => binding.command).join(", ")}. The last
            matching rule wins.
          </p>
        ) : null}
        {shortcutError ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {shortcutError}
          </p>
        ) : null}
        <DialogFooter>
          <Button disabled={saving} variant="ghost" onClick={() => save(null)}>
            Remove
          </Button>
          <Button variant="outline" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button
            disabled={!candidate || saving}
            onClick={() => save(candidate)}
          >
            Save
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
