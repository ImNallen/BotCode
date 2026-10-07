// Ported from T3 Code v0.0.45 apps/web/src/projectScripts.ts (MIT).
import type { ProjectScript } from "../ipc";
import { z } from "zod";
export const commandForProjectScript = (id: string) => `script.${id}.run`;
export function primaryProjectScript(scripts: readonly ProjectScript[]) {
  return (
    scripts.find((script) => !script.runOnWorktreeCreate) ?? scripts[0] ?? null
  );
}
export const scriptShortcut = z.object({
  key: z.string(),
  meta: z.boolean(),
  ctrl: z.boolean(),
  alt: z.boolean(),
  shift: z.boolean(),
});
export const scriptShortcuts = z.record(z.string(), scriptShortcut);
export type ScriptShortcut = z.infer<typeof scriptShortcut>;
export function matchesScriptShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
  binding: ScriptShortcut,
) {
  return (
    event.key.toLowerCase() === binding.key &&
    event.metaKey === binding.meta &&
    event.ctrlKey === binding.ctrl &&
    event.altKey === binding.alt &&
    event.shiftKey === binding.shift
  );
}
export function scriptShortcutLabel(binding: ScriptShortcut) {
  return [
    binding.meta ? "⌘" : "",
    binding.ctrl ? "Ctrl+" : "",
    binding.alt ? "⌥" : "",
    binding.shift ? "⇧" : "",
    binding.key.toUpperCase(),
  ].join("");
}
export function resolveThreadEnvMode({
  preference,
  configured,
  overridden,
  projectDefault,
}: {
  preference: "local" | "worktree";
  configured: boolean;
  overridden: boolean;
  projectDefault: "local" | "worktree" | null | undefined;
}) {
  return configured || overridden || preference === "worktree"
    ? preference
    : (projectDefault ?? preference);
}
