// Ported from pingdotgg/t3code v0.0.45 projectScripts.ts and components/projectScriptEditor.tsx (MIT).
import type { ProjectScript } from "../ipc";
export type ProjectScriptInput = {
  name: string;
  command: string;
  icon: ProjectScript["icon"];
  runOnWorktreeCreate: boolean;
  waitForSetup: boolean;
  keybinding: string | null;
  previewUrl: string | null;
  autoOpenPreview: boolean;
};
export const EMPTY_PROJECT_SCRIPT_INPUT: ProjectScriptInput = {
  name: "",
  command: "",
  icon: "play",
  runOnWorktreeCreate: false,
  waitForSetup: false,
  keybinding: null,
  previewUrl: null,
  autoOpenPreview: false,
};
export type ProjectScriptEditorRequest = {
  scriptId: string | null;
  initial: ProjectScriptInput;
  error?: string;
};
export function scriptEditorInput(
  script: ProjectScript,
  keybinding: string | null,
): ProjectScriptInput {
  return {
    name: script.name,
    command: script.command,
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
    waitForSetup: script.runOnWorktreeCreate && !script.async,
    keybinding,
    previewUrl: script.previewUrl,
    autoOpenPreview: script.autoOpenPreview,
  };
}
export function buildProjectScript(
  id: string,
  input: ProjectScriptInput,
): ProjectScript {
  return {
    id,
    name: input.name.trim(),
    command: input.command.trim(),
    icon: input.icon,
    runOnWorktreeCreate: input.runOnWorktreeCreate,
    async: !(input.runOnWorktreeCreate && input.waitForSetup),
    previewUrl: input.previewUrl?.trim() || null,
    autoOpenPreview: !!input.previewUrl?.trim() && input.autoOpenPreview,
  };
}
export function updateProjectScripts(
  scripts: readonly ProjectScript[],
  id: string,
  input: ProjectScriptInput,
  adding: boolean,
): ProjectScript[] {
  const next = buildProjectScript(id, input);
  const updated = scripts.map((script) =>
    script.id === id
      ? next
      : input.runOnWorktreeCreate
        ? { ...script, runOnWorktreeCreate: false }
        : script,
  );
  return adding ? [...updated, next] : updated;
}
