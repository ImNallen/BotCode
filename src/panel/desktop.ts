import type { SandboxDesktop } from "../ipc";
import type { PanelState } from "./RightPanel";

export function streamingDesktop(
  panel: PanelState,
  sandbox: boolean,
  threadId: string | undefined,
): string | null {
  const active =
    panel.active === null ? undefined : panel.surfaces[panel.active];
  return sandbox && threadId && active?.kind === "desktop" ? threadId : null;
}

export function desktopUrl(endpoint: SandboxDesktop, control: boolean): string {
  const fragment = new URLSearchParams({ secret: endpoint.secret });
  if (control) fragment.set("control", "1");
  return `http://127.0.0.1:${endpoint.port}/#${fragment}`;
}
