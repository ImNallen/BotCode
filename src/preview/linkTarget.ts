// Ported from T3 Code v0.0.45 apps/web/src/browser/browserLinkTarget.ts and components/preview/openTerminalLinkInPreview.ts (MIT).
import { z } from "zod";
import { ipc, native } from "../ipc";
import { previewIpc } from "./ipc";
import { previewScopeKey, type PreviewScope } from "./model";

export const linkTargetSchema = z.enum(["system", "app"]);
export type LinkTarget = z.infer<typeof linkTargetSchema>;
export const DEFAULT_LINK_TARGET: LinkTarget = "system";

type LinkClick = { readonly metaKey: boolean; readonly ctrlKey: boolean };

export interface ResolveLinkTargetInput {
  readonly url: string;
  readonly event: LinkClick;
  readonly preference: LinkTarget;
  readonly canOpenInApp: boolean;
}

export function resolveLinkTarget(input: ResolveLinkTargetInput): LinkTarget {
  if (input.event.metaKey || input.event.ctrlKey) return "system";
  if (input.preference !== "app") return "system";
  if (!input.canOpenInApp) return "system";
  if (!isWebUrl(input.url)) return "system";
  return "app";
}

export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

type OpenPreview = (scope: PreviewScope, url: string) => Promise<unknown>;
const defaultOpenPreview: OpenPreview | null = native ? previewIpc.open : null;

export interface OpenLinkInput {
  readonly url: string;
  readonly event: LinkClick;
  readonly preference: LinkTarget;
  readonly scope: PreviewScope | null;
  readonly openPreview?: OpenPreview;
  readonly openExternal?: (url: string) => Promise<unknown>;
}

export async function openLink(input: OpenLinkInput): Promise<LinkTarget> {
  const openPreview = input.openPreview ?? defaultOpenPreview;
  const openExternal = input.openExternal ?? ipc.openUrl;
  const { scope } = input;
  const target = resolveLinkTarget({
    url: input.url,
    event: input.event,
    preference: input.preference,
    canOpenInApp: openPreview !== null && scope !== null,
  });
  if (target === "app" && openPreview && scope) {
    try {
      await openPreview(scope, input.url);
      return "app";
    } catch (error: unknown) {
      console.error(
        `Failed to open link ${new URL(input.url).origin} in preview for ${previewScopeKey(scope)}.`,
        error,
      );
    }
  }
  await openExternal(input.url);
  return "system";
}
