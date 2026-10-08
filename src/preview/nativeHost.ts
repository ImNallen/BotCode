// Adapted from T3 Code v0.0.45 apps/web/src/browser/HostedBrowserWebview.tsx (MIT).
import type { PreviewAttachment, PreviewScope, PreviewState } from "./model";

export type PreviewRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type PreviewLayout = {
  rect: PreviewRect | null;
  visible: boolean;
};
type HostTransport = {
  attach: (scope: PreviewScope) => Promise<PreviewAttachment>;
  layout: (
    lease: number,
    sequence: number,
    layout: PreviewLayout,
  ) => Promise<unknown>;
  detach: (lease: number) => Promise<unknown>;
};
let pendingAttachment = Promise.resolve();

export function intersectPreviewRect(
  rect: PreviewRect,
  bounds: PreviewRect,
): PreviewRect | null {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const width = Math.min(rect.x + rect.width, bounds.x + bounds.width) - x;
  const height = Math.min(rect.y + rect.height, bounds.y + bounds.height) - y;
  return width >= 1 && height >= 1 ? { x, y, width, height } : null;
}
export function attachPreviewHost({
  scope,
  transport,
  measure,
  onState,
  onError,
}: {
  scope: PreviewScope;
  transport: HostTransport;
  measure: () => PreviewLayout;
  onState: (state: PreviewState) => void;
  onError: (error: unknown) => void;
}): { refresh: () => void; dispose: () => void } {
  let disposed = false;
  let lease: number | null = null;
  let sequence = 0;
  let lastLayout = "";
  const report = (error: unknown) => {
    if (!disposed) onError(error);
  };
  const refresh = () => {
    if (disposed || lease === null) return;
    const layout = measure();
    const encoded = JSON.stringify(layout);
    if (lastLayout === encoded) return;
    lastLayout = encoded;
    const requestSequence = ++sequence;
    void transport
      .layout(lease, requestSequence, layout)
      .catch((error: unknown) => {
        if (sequence === requestSequence) lastLayout = "";
        report(error);
      });
  };
  const acquisition = pendingAttachment.then(async () => {
    if (disposed) return;
    const attachment = await transport.attach(scope);
    if (disposed) {
      void transport.detach(attachment.lease).catch(() => {});
      return;
    }
    lease = attachment.lease;
    onState(attachment.state);
    refresh();
  });
  pendingAttachment = acquisition.catch(() => {});
  void acquisition.catch(report);
  return {
    refresh,
    dispose: () => {
      disposed = true;
      if (lease !== null) void transport.detach(lease).catch(() => {});
    },
  };
}

export const coveringLayers =
  '[data-slot="menu-popup"],[role="dialog"],[aria-modal="true"],dialog[open]';
export function measurePreviewHost(host: HTMLElement): PreviewLayout {
  if (
    !host.isConnected ||
    document.querySelector(coveringLayers) ||
    host.closest('[inert],[aria-hidden="true"]')
  )
    return { rect: null, visible: false };
  const raw = host.getBoundingClientRect();
  let rect = intersectPreviewRect(
    { x: raw.x, y: raw.y, width: raw.width, height: raw.height },
    { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  );
  for (
    let parent = host.parentElement;
    parent && rect;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden")
      return { rect: null, visible: false };
    if (style.overflowX !== "visible" || style.overflowY !== "visible") {
      const bounds = parent.getBoundingClientRect();
      rect = intersectPreviewRect(rect, {
        x: style.overflowX === "visible" ? rect.x : bounds.x,
        y: style.overflowY === "visible" ? rect.y : bounds.y,
        width: style.overflowX === "visible" ? rect.width : bounds.width,
        height: style.overflowY === "visible" ? rect.height : bounds.height,
      });
    }
  }
  return { rect, visible: rect !== null };
}
