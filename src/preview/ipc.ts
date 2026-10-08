// Adapted from T3 Code v0.0.45 apps/web/src/previewStateStore.ts (MIT).
import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { IpcError } from "../ipc";
import {
  discoveredServers,
  previewAttachment,
  previewEvent,
  previewState,
  type Navigation,
  type PreviewEvent,
  type PreviewScope,
  type ViewportSize,
} from "./model";
import type { PreviewLayout } from "./nativeHost";

async function call<S extends z.ZodType>(
  command: string,
  args: InvokeArgs,
  schema: S,
): Promise<z.infer<S>> {
  try {
    const result: unknown = await invoke(command, args);
    return schema.parse(result);
  } catch (error: unknown) {
    const parsed = z
      .object({ code: z.string(), message: z.string() })
      .safeParse(error);
    throw parsed.success
      ? new IpcError(parsed.data.code, parsed.data.message)
      : new Error(error instanceof Error ? error.message : String(error));
  }
}
export const previewIpc = {
  state: (scope: PreviewScope) =>
    call("preview_state", { scope }, previewState),
  open: (scope: PreviewScope, url: string) =>
    call("preview_open", { scope, url }, previewState),
  navigate: (scope: PreviewScope, action: Navigation) =>
    call("preview_navigate", { scope, action }, previewState),
  viewport: (scope: PreviewScope, viewport: ViewportSize | null) =>
    call("preview_viewport", { scope, viewport }, previewState),
  attach: (scope: PreviewScope) =>
    call("preview_attach", { scope }, previewAttachment),
  layout: (lease: number, sequence: number, layout: PreviewLayout) =>
    call("preview_layout", { lease, sequence, ...layout }, z.null()),
  detach: (lease: number) => call("preview_detach", { lease }, z.null()),
  discover: () => call("preview_discover", {}, discoveredServers),
};
export function subscribePreview(
  handler: (event: PreviewEvent) => void,
): Promise<() => void> {
  return listen<unknown>("botcode-preview", ({ payload }) => {
    const result = previewEvent.safeParse(payload);
    if (result.success) handler(result.data);
  });
}
