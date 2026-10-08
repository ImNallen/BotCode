// Project script command IDs ported from T3 Code v0.0.45 apps/web/src/projectScripts.ts (MIT).
import { z } from "zod";
import { storage } from "../lib/storage";
import { keybindings } from "./store";
import { keybindingFromKeyboardEvent } from "./keyboard";
import type { KeybindingRule } from "./rules";

const legacyKey = "z1:project-script-keybindings";
const legacySchema = z.record(
  z.string(),
  z.object({
    key: z.string(),
    meta: z.boolean(),
    ctrl: z.boolean(),
    alt: z.boolean(),
    shift: z.boolean(),
  }),
);
export function legacyScriptRules(
  text: string,
  platform: string,
): readonly KeybindingRule[] {
  const legacy = legacySchema.parse(JSON.parse(text));
  return Object.entries(legacy).map(([command, binding]) => {
    const key = keybindingFromKeyboardEvent(
      {
        key: binding.key,
        code: "",
        metaKey: binding.meta,
        ctrlKey: binding.ctrl,
        altKey: binding.alt,
        shiftKey: binding.shift,
      },
      platform,
    );
    if (!key) throw new Error(`The saved shortcut for ${command} has no key.`);
    return { command, key, when: "!terminalFocus" };
  });
}
export async function migrateLegacyScriptShortcuts() {
  const text = storage.getItem(legacyKey);
  if (text === null) return;
  try {
    for (const rule of legacyScriptRules(text, navigator.platform)) {
      if (
        !keybindings
          .getSnapshot()
          .rules.some((existing) => existing.command === rule.command)
      )
        await keybindings.upsert(rule);
    }
    await storage.removeItemDurable(legacyKey);
  } catch (cause) {
    keybindings.reportError(cause);
  }
}
