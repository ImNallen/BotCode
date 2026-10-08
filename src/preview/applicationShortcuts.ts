// Adapted from T3 Code v0.0.45 apps/web/src/keybindings.ts and apps/desktop/src/preview/Manager.ts (MIT).
import { useEffect, useEffectEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { previewScope } from "./model";
import { measurePreviewHost } from "./nativeHost";
import { native } from "../ipc";
import {
  actions,
  isActionId,
  type ActionContext,
  type ActionId,
} from "../lib/actions";
import { currentShortcutContext } from "../lib/shortcutContext";
import { serial } from "../lib/serial";
import { isMacPlatform } from "../lib/utils";
import { keybindings, useKeybindings } from "../keybindings/store";
import { resolveShortcutCommand } from "../keybindings/keyboard";
import type { ResolvedKeybindingsConfig } from "../keybindings/rules";

const shortcut = z.object({
  key: z.string().min(1).max(64),
  code: z.string().max(64).optional(),
  metaKey: z.boolean(),
  ctrlKey: z.boolean(),
  altKey: z.boolean(),
  shiftKey: z.boolean(),
});
type Shortcut = z.infer<typeof shortcut>;
const shortcutEvent = shortcut.extend({ scope: previewScope });
const enqueue = serial();
const previewContext = (platform: string) => ({
  ...currentShortcutContext(platform),
  previewFocus: true,
  previewOpen: true,
  terminalFocus: false,
  editableFocus: true,
});

export function previewApplicationAction(
  event: Shortcut,
  bindings: ResolvedKeybindingsConfig,
  context: ActionContext,
  platform: string,
): ActionId | null {
  if (!(event.metaKey || event.ctrlKey)) return null;
  const command = resolveShortcutCommand(event, bindings, {
    platform,
    context: previewContext(platform),
  });
  if (!isActionId(command)) return null;
  const action = actions[command];
  return (!action.shortcutOwner || command === "terminal.toggle") &&
    action.run !== undefined &&
    action.available(context)
    ? command
    : null;
}

export function previewApplicationShortcuts(
  bindings: ResolvedKeybindingsConfig,
  context: ActionContext,
  platform: string,
): Shortcut[] {
  const result = new Map<string, Shortcut>();
  for (const binding of bindings) {
    const { shortcut } = binding;
    const mac = isMacPlatform(platform);
    const event = {
      key: shortcut.key,
      metaKey: shortcut.metaKey || (shortcut.modKey && mac),
      ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
      altKey: shortcut.altKey,
      shiftKey: shortcut.shiftKey,
    };
    if (!previewApplicationAction(event, bindings, context, platform)) continue;
    result.set(JSON.stringify(event), event);
  }
  return [...result.values()].slice(0, 128);
}

export function usePreviewApplicationShortcuts(
  context: ActionContext,
  execute: (action: ActionId) => void,
) {
  const snapshot = useKeybindings();
  const signature = JSON.stringify(
    previewApplicationShortcuts(snapshot.bindings, context, navigator.platform),
  );
  const receive = useEffectEvent((payload: unknown) => {
    const parsed = shortcutEvent.safeParse(payload);
    if (!parsed.success || context.pageOpen) return;
    const { scope } = parsed.data;
    if (
      scope.kind === "thread"
        ? scope.threadId !== context.thread?.id
        : scope.workspaceId !== context.workspace?.id ||
          context.thread !== undefined
    )
      return;
    const host = document.querySelector<HTMLElement>(
      "[data-preview-webview-host]",
    );
    if (!host || !measurePreviewHost(host).visible) return;
    const action = previewApplicationAction(
      parsed.data,
      keybindings.getSnapshot().bindings,
      context,
      navigator.platform,
    );
    if (action) execute(action);
  });
  useEffect(() => {
    if (!native) return;
    void enqueue(() =>
      invoke("preview_application_shortcuts", {
        shortcuts: JSON.parse(signature),
      }),
    ).catch(keybindings.reportError);
  }, [signature]);
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<unknown>("botcode-preview-shortcut", ({ payload }) => {
      if (!disposed) receive(payload);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(keybindings.reportError);
    return () => {
      disposed = true;
      unlisten?.();
      void enqueue(() =>
        invoke("preview_application_shortcuts", {
          shortcuts: [],
        }),
      ).catch(keybindings.reportError);
    };
  }, []);
}
