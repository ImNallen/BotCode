// Ported from pingdotgg/t3code v0.0.45 apps/server/src/keybindings.ts and apps/web/src/state/server.ts (MIT).
import { useEffect, useSyncExternalStore } from "react";
import { ipc, IpcError, native } from "../ipc";
import { serial } from "../lib/serial";
import {
  editKeybindings,
  parseKeybindings,
  type KeybindingEdit,
} from "./config";
import { compileResolvedKeybindingsConfig, type KeybindingRule } from "./rules";

type FileState = { path: string | null; text: string | null };
type Persistence = {
  read: () => Promise<FileState>;
  write: (text: string, expected: string | null) => Promise<unknown>;
};
export function createKeybindings(
  persistence: Persistence,
  initialDefaults: readonly KeybindingRule[] = [],
  initialExtensions: ReadonlySet<string> = new Set(),
) {
  let defaults = initialDefaults;
  let extensions = initialExtensions;
  const listeners = new Set<() => void>();
  const scriptOwners = new Map<symbol, ReadonlySet<string>>();
  const scriptCommands = () =>
    new Set([...scriptOwners.values()].flatMap((commands) => [...commands]));
  const enqueue = serial();
  const snapshot = (file: FileState, error: string | null = null) => {
    const parsed = parseKeybindings(file.text, extensions);
    const overridden = new Set(parsed.rules.map((rule) => rule.command));
    const effective = [
      ...defaults.filter((rule) => !overridden.has(rule.command)),
      ...parsed.rules,
    ];
    return {
      ...file,
      ...parsed,
      defaults,
      effective,
      bindings: compileResolvedKeybindingsConfig(effective),
      scriptCommands: scriptCommands(),
      error,
    };
  };
  let current = snapshot({ path: null, text: null });
  const publish = (next: typeof current) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const report = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    publish({ ...current, error: message });
  };
  const edit = (change: KeybindingEdit) =>
    enqueue(async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const file = await persistence.read();
          const text = editKeybindings(
            parseKeybindings(file.text, extensions),
            change,
            extensions,
          );
          try {
            await persistence.write(text, file.text);
          } catch (cause) {
            if (
              cause instanceof IpcError &&
              cause.code === "keybindings_changed" &&
              attempt < 2
            )
              continue;
            throw cause;
          }
          publish(snapshot({ ...file, text }));
          return;
        }
      } catch (cause) {
        report(cause);
        throw cause;
      }
    });
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    configure: (
      rules: readonly KeybindingRule[],
      commands: ReadonlySet<string>,
    ) => {
      defaults = rules;
      extensions = commands;
      publish(snapshot(current));
    },
    registerScriptCommands: (commands: ReadonlySet<string>) => {
      const owner = Symbol();
      scriptOwners.set(owner, commands);
      publish({ ...current, scriptCommands: scriptCommands() });
      return () => {
        scriptOwners.delete(owner);
        publish({ ...current, scriptCommands: scriptCommands() });
      };
    },
    reload: () =>
      enqueue(async () => {
        try {
          const file = await persistence.read();
          if (
            current.path !== file.path ||
            current.text !== file.text ||
            current.error !== null
          )
            publish(snapshot(file));
        } catch (cause) {
          report(cause);
        }
      }),
    upsert: (rule: KeybindingRule, replace?: KeybindingRule) =>
      edit({ kind: "upsert", rule, replace }),
    remove: (rule: KeybindingRule) => edit({ kind: "remove", rule }),
    reset: (command: string) => edit({ kind: "reset", command }),
    reportError: report,
  };
}
const browserKey = "bot-code:keybindings";
export const keybindings = createKeybindings({
  read: () =>
    native
      ? ipc.keybindingsFile()
      : Promise.resolve({ path: null, text: localStorage.getItem(browserKey) }),
  write: (text, expected) =>
    native
      ? ipc.saveKeybindingsFile(text, expected)
      : Promise.resolve(localStorage.setItem(browserKey, text)),
});
export const loadKeybindings = () => keybindings.reload();
export function useKeybindings() {
  return useSyncExternalStore(
    keybindings.subscribe,
    keybindings.getSnapshot,
    keybindings.getSnapshot,
  );
}
export function useKeybindingsSync() {
  useEffect(() => {
    const reload = () => {
      void keybindings.reload();
    };
    window.addEventListener("focus", reload);
    const timer = window.setInterval(reload, 2000);
    return () => {
      window.removeEventListener("focus", reload);
      window.clearInterval(timer);
    };
  }, []);
}
