// Adapted from T3 Code v0.0.45 packages/contracts/src/preview.ts and packages/shared/src/previewViewport.ts (MIT).
import { z } from "zod";

export const previewScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.uuid() }).strict(),
  z.object({ kind: z.literal("draft"), workspaceId: z.uuid() }).strict(),
]);
export type PreviewScope = z.infer<typeof previewScope>;
export const viewportSize = z
  .object({
    width: z.number().int().min(240).max(3840),
    height: z.number().int().min(160).max(2160),
  })
  .strict()
  .refine(({ width, height }) => width * height <= 3840 * 2160);
export type ViewportSize = z.infer<typeof viewportSize>;
const measuredSize = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});
export const previewState = z.object({
  url: z.string().nullable(),
  title: z.string(),
  loading: z.boolean(),
  error: z.string().nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  viewport: viewportSize.nullable(),
  measuredViewport: measuredSize.nullable(),
});
export type PreviewState = z.infer<typeof previewState>;
export const previewEvent = z.object({
  scope: previewScope,
  state: previewState,
  openPanel: z.boolean(),
});
export type PreviewEvent = z.infer<typeof previewEvent>;
export const previewAttachment = z.object({
  lease: z.number().int().nonnegative(),
  state: previewState,
});
export type PreviewAttachment = z.infer<typeof previewAttachment>;
export const discoveredServers = z.array(
  z.object({
    port: z.number().int().min(1).max(65535),
    url: z.string(),
    title: z.string().nullable(),
  }),
);
export type DiscoveredServer = z.infer<typeof discoveredServers>[number];
export type Navigation =
  | { kind: "url"; url: string }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" };
export const initialPreview: PreviewState = {
  url: null,
  title: "",
  loading: false,
  error: null,
  canGoBack: false,
  canGoForward: false,
  viewport: null,
  measuredViewport: null,
};
export function scopeForPreview(
  workspaceId: string,
  threadId: string | undefined,
): PreviewScope {
  return threadId
    ? { kind: "thread", threadId }
    : { kind: "draft", workspaceId };
}
export function previewScopeKey(scope: PreviewScope): string {
  return scope.kind === "thread"
    ? `thread:${scope.threadId}`
    : `draft:${scope.workspaceId}`;
}
export function acceptsPreviewEvent(
  scope: PreviewScope,
  event: PreviewEvent,
): boolean {
  return previewScopeKey(scope) === previewScopeKey(event.scope);
}
export function normalizePreviewUrl(input: string): string {
  const trimmed = input.trim();
  const value =
    /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ||
    /^(?:about|data|javascript|file):/i.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
  const url = new URL(value);
  if (
    !trimmed ||
    value.length > 8192 ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Enter an HTTP or HTTPS URL without credentials.");
  return url.href;
}
export const viewportPresets = [
  { id: "desktop", label: "Desktop", width: 1280, height: 720 },
  { id: "tablet", label: "Tablet", width: 768, height: 1024 },
  { id: "mobile", label: "Mobile", width: 375, height: 667 },
] satisfies Array<ViewportSize & { id: string; label: string }>;
export function viewportLabel(size: ViewportSize | null): string {
  if (!size) return "Fit panel";
  return (
    viewportPresets.find(
      (preset) => preset.width === size.width && preset.height === size.height,
    )?.label ?? "Custom"
  );
}
export function parseViewport(
  width: string,
  height: string,
): ViewportSize | null {
  const result = viewportSize.safeParse({
    width: Number(width),
    height: Number(height),
  });
  return result.success ? result.data : null;
}
