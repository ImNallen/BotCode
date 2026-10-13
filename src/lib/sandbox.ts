import type { Checkout } from "../ipc";

/** Whether a checkout's files live in a sandbox, with only a mirror on this Mac. */
export function inSandbox(checkout: Checkout | undefined): boolean {
  return checkout?.kind === "worktree" && checkout.sandbox !== undefined;
}
