// Ported from pingdotgg/t3code v0.0.45 components/projectScriptEditor.tsx (MIT).
import React, {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ProjectScript } from "../ipc";
import type {
  ProjectScriptInput,
  ProjectScriptEditorRequest,
} from "./projectActions";
import { ScriptIcon, SCRIPT_ICONS } from "./ScriptIcon";
import { nextProjectScriptId } from "../chat/projectScripts";
import { keybindingFromKeyboardEvent } from "../keybindings/keyboard";
import { decodeScriptKeybinding } from "./useProjectActions";
import { Button, Switch } from "../ui/controls";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Menu } from "../ui/menu";
export function ProjectScriptEditorDialog({
  request,
  scripts,
  onSubmit,
  onDelete,
  onClose,
}: {
  request: ProjectScriptEditorRequest | null;
  scripts: ReadonlyArray<ProjectScript>;
  onSubmit: (
    scriptId: string | null,
    input: ProjectScriptInput,
  ) => Promise<void>;
  onDelete: (scriptId: string) => void;
  onClose: () => void;
}) {
  const formId = React.useId();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScript["icon"]>("play");
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [waitForSetup, setWaitForSetup] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [autoOpenPreview, setAutoOpenPreview] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [savingRequest, setSavingRequest] =
    useState<ProjectScriptEditorRequest | null>(null);
  const pendingSubmissionRef = useRef<{
    request: ProjectScriptEditorRequest;
  } | null>(null);

  const isOpen = request !== null;
  const isEditing = request?.scriptId != null;
  const isSaving = request !== null && savingRequest === request;

  useLayoutEffect(
    () => () => {
      if (pendingSubmissionRef.current?.request === request) {
        pendingSubmissionRef.current = null;
      }
    },
    [request],
  );

  useLayoutEffect(() => {
    if (request) document.getElementById("script-name")?.focus();
  }, [request]);

  useEffect(() => {
    if (!request) return;
    setName(request.initial.name);
    setCommand(request.initial.command);
    setIcon(request.initial.icon);
    setIconPickerOpen(false);
    setRunOnWorktreeCreate(request.initial.runOnWorktreeCreate);
    setWaitForSetup(request.initial.waitForSetup);
    setKeybinding(request.initial.keybinding ?? "");
    setPreviewUrl(request.initial.previewUrl ?? "");
    setAutoOpenPreview(request.initial.autoOpenPreview);
    setValidationError(request.error ?? null);
    setSavingRequest(null);
  }, [request]);

  const close = () => {
    pendingSubmissionRef.current = null;
    setSavingRequest(null);
    setIconPickerOpen(false);
    onClose();
  };

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromKeyboardEvent(
      event.nativeEvent,
      navigator.platform,
    );
    if (!next) return;
    setKeybinding(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || pendingSubmissionRef.current !== null) return;
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError("Command is required.");
      return;
    }

    setValidationError(null);
    let payload: ProjectScriptInput;
    try {
      const scriptIdForValidation =
        request.scriptId ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeScriptKeybinding(
        keybinding,
        scriptIdForValidation,
      );
      const trimmedPreviewUrl = previewUrl.trim();
      payload = {
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        waitForSetup: runOnWorktreeCreate && waitForSetup,
        keybinding: keybindingRule?.key ?? null,
        previewUrl: trimmedPreviewUrl.length > 0 ? trimmedPreviewUrl : null,
        autoOpenPreview: trimmedPreviewUrl.length > 0 ? autoOpenPreview : false,
      } satisfies ProjectScriptInput;
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : "Failed to save action.",
      );
      return;
    }

    const submission = { request };
    pendingSubmissionRef.current = submission;
    setSavingRequest(request);
    setIconPickerOpen(false);
    try {
      await onSubmit(request.scriptId, payload);
      if (pendingSubmissionRef.current === submission) close();
    } catch (error) {
      if (pendingSubmissionRef.current === submission) {
        setValidationError(
          error instanceof Error ? error.message : "Failed to save action.",
        );
      }
    }
    if (pendingSubmissionRef.current === submission) {
      pendingSubmissionRef.current = null;
      setSavingRequest(null);
    }
  };

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            close();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Action" : "Add Action"}</DialogTitle>
          <DialogDescription>
            Actions are project-scoped commands you can run from the top bar or
            keybindings.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} onSubmit={submit}>
            <fieldset className="space-y-4" disabled={isSaving}>
              <div className="space-y-1.5">
                <label
                  className="inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground"
                  htmlFor="script-name"
                >
                  Name
                </label>
                <div className="flex items-center gap-2">
                  <Menu
                    open={iconPickerOpen}
                    onOpenChange={setIconPickerOpen}
                    align="start"
                    contentClassName="py-4 px-4"
                    trigger={(props) => (
                      <Button
                        {...props}
                        variant="outline"
                        className="size-9 shrink-0"
                        aria-label="Choose icon"
                      >
                        <ScriptIcon icon={icon} className="size-4.5" />
                      </Button>
                    )}
                  >
                    <div className="grid grid-cols-3 gap-2">
                      {SCRIPT_ICONS.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          role="menuitem"
                          className={`relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-xs dark:border-transparent ${entry.id === icon ? "border-primary/70 bg-primary/10 dark:ring-1 dark:ring-primary/30" : "border-border/70 hover:bg-accent/60 dark:bg-white/[0.035]"}`}
                          onClick={() => {
                            setIcon(entry.id);
                            setIconPickerOpen(false);
                          }}
                        >
                          <ScriptIcon icon={entry.id} className="size-4" />
                          <span>{entry.label}</span>
                        </button>
                      ))}
                    </div>
                  </Menu>
                  <Input
                    id="script-name"
                    autoFocus
                    placeholder="Test"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label
                  className="inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground"
                  htmlFor="script-keybinding"
                >
                  Keybinding
                </label>
                <Input
                  data-keybinding-capture
                  id="script-keybinding"
                  placeholder="Press shortcut"
                  value={keybinding}
                  readOnly
                  onKeyDown={captureKeybinding}
                />
                <p className="text-xs text-muted-foreground">
                  Press a shortcut. Use <code>Backspace</code> to clear.
                  Shortcuts are environment-wide. Projects using the same action
                  share its shortcut.
                </p>
              </div>
              <div className="space-y-1.5">
                <label
                  className="inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground"
                  htmlFor="script-command"
                >
                  Command
                </label>
                <Textarea
                  id="script-command"
                  placeholder="bun test"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label
                  className="inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground"
                  htmlFor="script-preview-url"
                >
                  Preview URL (optional)
                </label>
                <Input
                  id="script-preview-url"
                  placeholder="http://localhost:5173"
                  value={previewUrl}
                  onChange={(event) => setPreviewUrl(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Open this URL in the in-app preview when this action runs.
                </p>
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
                <span>Run automatically on worktree creation</span>
                <Switch
                  checked={runOnWorktreeCreate}
                  onCheckedChange={(checked) =>
                    setRunOnWorktreeCreate(Boolean(checked))
                  }
                />
              </label>
              <label
                className={`flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035] ${
                  runOnWorktreeCreate ? "" : "opacity-60"
                }`}
              >
                <span>Wait for it to finish before the agent starts</span>
                <Switch
                  checked={waitForSetup}
                  disabled={!runOnWorktreeCreate}
                  onCheckedChange={(checked) =>
                    setWaitForSetup(Boolean(checked))
                  }
                />
              </label>
              <label
                className={`flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035] ${
                  previewUrl.trim().length === 0 ? "opacity-60" : ""
                }`}
              >
                <span>Open preview automatically when this action runs</span>
                <Switch
                  checked={autoOpenPreview}
                  disabled={previewUrl.trim().length === 0}
                  onCheckedChange={(checked) =>
                    setAutoOpenPreview(Boolean(checked))
                  }
                />
              </label>
              {validationError && (
                <p className="text-sm text-destructive">{validationError}</p>
              )}
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          {isEditing && (
            <Button
              type="button"
              variant="destructive-outline"
              className="mr-auto"
              disabled={isSaving}
              onClick={() => setDeleteConfirmOpen(true)}
            >
              Delete
            </Button>
          )}
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button form={formId} type="submit" disabled={isSaving}>
            {isSaving ? "Saving…" : isEditing ? "Save changes" : "Save action"}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogHeader>
          <DialogTitle>Delete action "{name}"?</DialogTitle>
          <DialogDescription>This action cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={isSaving}
            onClick={() => {
              if (!request?.scriptId) return;
              setDeleteConfirmOpen(false);
              close();
              onDelete(request.scriptId);
            }}
          >
            Delete action
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
