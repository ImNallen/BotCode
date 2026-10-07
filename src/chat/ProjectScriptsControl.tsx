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
import { actionIds, matchesAction } from "../lib/actions";
import { storage } from "../lib/storage";
import { isCommandPaletteOpen } from "../lib/commandPaletteBus";
import {
  commandForProjectScript,
  primaryProjectScript,
  scriptShortcuts,
  matchesScriptShortcut,
  scriptShortcutLabel,
  type ScriptShortcut,
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
const STORAGE_KEY = "z1:project-script-keybindings";
export function ProjectScriptsControl({
  scripts,
  onRun,
}: {
  scripts: readonly ProjectScript[];
  onRun: (script: ProjectScript) => void;
}) {
  const [bindings, setBindings] = useState(() => {
    try {
      return scriptShortcuts.parse(
        JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}"),
      );
    } catch {
      return {};
    }
  });
  const [editing, setEditing] = useState<ProjectScript | null>(null);
  const [candidate, setCandidate] = useState<ScriptShortcut | null>(null);
  const [shortcutError, setShortcutError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const primary = primaryProjectScript(scripts);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        document.querySelector("[data-chat-header]")?.closest("[inert]") ||
        event.repeat ||
        event.isComposing ||
        editing ||
        isCommandPaletteOpen() ||
        document.querySelector("dialog[open]")
      )
        return;
      const script = scripts.find((script) => {
        const binding = bindings[commandForProjectScript(script.id)];
        return binding && matchesScriptShortcut(event, binding);
      });
      if (script) {
        event.preventDefault();
        event.stopPropagation();
        onRun(script);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [bindings, scripts, onRun, editing]);
  const save = (binding: ScriptShortcut | null) => {
    if (!editing) return;
    const next = { ...bindings };
    const command = commandForProjectScript(editing.id);
    if (binding) next[command] = binding;
    else delete next[command];
    setSaving(true);
    setShortcutError(undefined);
    void storage
      .setItem(STORAGE_KEY, JSON.stringify(next))
      .then(() => {
        setBindings(next);
        setEditing(null);
      })
      .catch((error) => {
        setBindings(next);
        setShortcutError(
          `The shortcut applies for this session but could not be saved. ${
            error instanceof Error ? error.message : "Try saving again."
          }`,
        );
      })
      .finally(() => setSaving(false));
  };
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
            const binding = bindings[commandForProjectScript(script.id)];
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
                    {binding ? scriptShortcutLabel(binding) : ""}
                  </span>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setOpen(false);
                    setShortcutError(undefined);
                    setEditing(script);
                    setCandidate(
                      bindings[commandForProjectScript(script.id)] ?? null,
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
          value={
            candidate ? scriptShortcutLabel(candidate) : "Press a shortcut"
          }
          className="my-4 rounded-md border p-2"
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat || event.nativeEvent.isComposing) return;
            if (actionIds.some((id) => matchesAction(event.nativeEvent, id))) {
              setCandidate(null);
              setShortcutError(
                "This shortcut is reserved for a built-in action.",
              );
              return;
            }
            setShortcutError(undefined);
            if (
              Object.entries(bindings).some(
                ([command, binding]) =>
                  command !== commandForProjectScript(editing?.id ?? "") &&
                  matchesScriptShortcut(event, binding),
              )
            ) {
              setCandidate(null);
              setShortcutError(
                "This shortcut already runs another project script.",
              );
              return;
            }
            if (
              event.key.length === 1 &&
              (event.metaKey || event.ctrlKey || event.altKey)
            )
              setCandidate({
                key: event.key.toLowerCase(),
                meta: event.metaKey,
                ctrl: event.ctrlKey,
                alt: event.altKey,
                shift: event.shiftKey,
              });
          }}
        />
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
