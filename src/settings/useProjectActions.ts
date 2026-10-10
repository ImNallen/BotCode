// Ported from pingdotgg/t3code v0.0.45 components/settings/useProjectScriptSettings.ts (MIT).
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type ProjectScript } from "../ipc";
import { usePreferences } from "./preferences";
import {
  commandForProjectScript,
  nextProjectScriptId,
} from "../chat/projectScripts";
import { keybindings, useKeybindings } from "../keybindings/store";
import { compileResolvedKeybindingRule } from "../keybindings/rules";
import {
  updateProjectScripts,
  type ProjectScriptInput,
} from "./projectActions";

export function decodeScriptKeybinding(value: string | null, id: string) {
  const key = value?.trim();
  if (!key) return null;
  const rule = { key, command: commandForProjectScript(id) };
  if (!compileResolvedKeybindingRule(rule))
    throw new Error("Invalid keyboard shortcut.");
  return rule;
}
export function useProjectActions(workspaceId: string) {
  const client = useQueryClient();
  const { preferences, saveActions } = usePreferences();
  const bindings = useKeybindings();
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const config = useQuery({
    queryKey: ["project-config", workspaceId],
    queryFn: () => ipc.projectConfig(workspaceId),
    refetchInterval: 5000,
  });
  const file = useQuery({
    queryKey: ["project-file-config", workspaceId],
    queryFn: () => ipc.projectFileConfig(workspaceId),
    refetchInterval: 5000,
  });
  const scripts = config.data?.scripts ?? [];
  const persist = async (
    transform: (
      current: readonly ProjectScript[],
    ) => readonly ProjectScript[] | null,
    id?: string,
    keybinding?: string | null,
  ) => {
    if (busy.current)
      throw new Error(
        "No available machine, or another action change is saving.",
      );
    busy.current = true;
    setSaving(true);
    try {
      const current = (await ipc.projectConfig(workspaceId)).scripts;
      const next = transform(current);
      await saveActions(workspaceId, next);
      const changedIds = id
        ? [id]
        : current
            .filter(
              (script) =>
                !(next ?? preferences.defaultProjectScripts).some(
                  (other) => other.id === script.id,
                ),
            )
            .map((script) => script.id);
      for (const changed of changedIds) {
        const command = commandForProjectScript(changed);
        const previous = bindings.rules.findLast(
          (rule) => rule.command === command,
        );
        const rule = decodeScriptKeybinding(keybinding ?? null, changed);
        if (rule) await keybindings.upsert(rule, previous);
        else if (previous) {
          let retained = false;
          if (!next?.some((script) => script.id === changed)) {
            const others = await ipc.workspaces();
            retained =
              preferences.defaultProjectScripts.some(
                (script) => script.id === changed,
              ) ||
              (
                await Promise.all(
                  others
                    .filter(
                      (project) =>
                        project.kind === "repository" &&
                        project.id !== workspaceId,
                    )
                    .map(
                      async (project) =>
                        await ipc.projectConfig(project.id).then(
                          (config) =>
                            config.scripts.some(
                              (script) => script.id === changed,
                            ),
                          () => true,
                        ),
                    ),
                )
              ).some(Boolean);
          }
          if (!retained) await keybindings.reset(command);
        }
      }
    } finally {
      await client.invalidateQueries({
        queryKey: ["project-config", workspaceId],
      });
      busy.current = false;
      setSaving(false);
    }
  };
  const submit = async (scriptId: string | null, input: ProjectScriptInput) => {
    const projects = await ipc.workspaces();
    const projectScripts = await Promise.all(
      projects
        .filter((project) => project.kind === "repository")
        .map((project) => ipc.projectConfig(project.id).catch(() => null)),
    );
    const ids = [
      ...projectScripts.flatMap(
        (config) => config?.scripts.map((script) => script.id) ?? [],
      ),
      ...preferences.defaultProjectScripts.map((script) => script.id),
      ...Object.values(preferences.projectSettingsOverrides).flatMap(
        (entry) =>
          entry.defaultProjectScripts?.map((script) => script.id) ?? [],
      ),
    ];
    const id = scriptId ?? nextProjectScriptId(input.name, ids);
    await persist(
      (current) => updateProjectScripts(current, id, input, scriptId === null),
      id,
      input.keybinding,
    );
  };
  return {
    scripts,
    file,
    saving,
    config,
    persist,
    submit,
    overridden:
      preferences.projectSettingsOverrides[workspaceId]
        ?.defaultProjectScripts !== undefined,
  };
}
