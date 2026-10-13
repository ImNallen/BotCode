import type { Checkout } from "../ipc";

/** Whether a checkout's files live in a sandbox, with only a mirror on this Mac. */
export function inSandbox(checkout: Checkout | undefined): boolean {
  return checkout?.kind === "worktree" && checkout.sandbox !== undefined;
}

export type TerminalUnavailable = { hint: string; reason: string };

const NO_PROJECT: TerminalUnavailable = {
  hint: "Available when a project is open.",
  reason: "Terminal surfaces are only available from a project thread.",
};
const SANDBOX_TERMINAL = "The sandbox terminal is not available yet.";
const SANDBOX: TerminalUnavailable = {
  hint: SANDBOX_TERMINAL,
  reason: SANDBOX_TERMINAL,
};

/** Why a conversation or draft cannot open a terminal, or null when it can. */
export function terminalUnavailable({
  projectDraftOrThread,
  checkout,
}: {
  projectDraftOrThread: boolean;
  checkout: Checkout | undefined;
}): TerminalUnavailable | null {
  if (!projectDraftOrThread) return NO_PROJECT;
  // A Mac shell in the mirror would edit files the next sync overwrites.
  return inSandbox(checkout) ? SANDBOX : null;
}
