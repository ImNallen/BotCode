import type { Checkout, SandboxState } from "../ipc";

export function inSandbox(checkout: Checkout | undefined): boolean {
  return checkout?.kind === "worktree" && checkout.sandbox !== undefined;
}

export function sandboxLabel(state: SandboxState | undefined): string {
  return state === "paused" || state === "stopped"
    ? `Sandbox \u00b7 ${state}`
    : "Sandbox";
}
