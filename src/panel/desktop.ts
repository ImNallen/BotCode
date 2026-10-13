import type { SandboxDesktop } from "../ipc";
import type { PanelState } from "./RightPanel";

/**
 * The thread whose desktop streams, or null. It streams only while the Desktop tab is the
 * visible surface of a sandbox thread. The panel renders the Desktop surface for this thread
 * alone and keys it by the thread, so hiding the tab, closing the panel, which unmounts it, or
 * changing threads closes the connection, and showing the tab again opens a new one.
 */
export function streamingDesktop(
  panel: PanelState,
  sandbox: boolean,
  threadId: string | undefined,
): string | null {
  const active =
    panel.active === null ? undefined : panel.surfaces[panel.active];
  return sandbox && threadId && active?.kind === "desktop" ? threadId : null;
}

/**
 * The desktop page with its secret in the fragment, which never reaches the server or a log.
 * `control` lets the user's input reach the desktop; without it the page is view-only.
 */
export function desktopUrl(endpoint: SandboxDesktop, control: boolean): string {
  const fragment = new URLSearchParams({ secret: endpoint.secret });
  if (control) fragment.set("control", "1");
  return `http://127.0.0.1:${endpoint.port}/#${fragment}`;
}
