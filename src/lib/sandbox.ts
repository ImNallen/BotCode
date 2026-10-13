import type { Checkout, SandboxState } from "../ipc";

/** Whether a checkout's files live in a sandbox, with only a mirror on this Mac. */
export function inSandbox(checkout: Checkout | undefined): boolean {
  return checkout?.kind === "worktree" && checkout.sandbox !== undefined;
}

/** The strip label: a paused or stopped sandbox says so; starting and running read as before. */
export function sandboxLabel(state: SandboxState | undefined): string {
  return state === "paused" || state === "stopped"
    ? `Sandbox \u00b7 ${state}`
    : "Sandbox";
}
