import type { NewCheckout, SandboxAvailability } from "../ipc";
import type { CheckoutMode } from "../settings/preferences";

export const placementLabels = {
  mac: "This Mac",
  sandbox: "Sandbox",
} as const;
export type Placement = keyof typeof placementLabels;

/** A repository draft's choice of where its thread runs and which checkout it gets. */
export type DraftCheckout = {
  placement: Placement;
  // Kept while Sandbox is chosen, so choosing This Mac again restores it.
  mode: CheckoutMode;
  base: string | null;
  fromOrigin: boolean;
};

/** A sandbox always starts a new worktree, so it picks a base like a worktree draft. */
export function picksBase(draft: DraftCheckout): boolean {
  return draft.placement === "sandbox" || draft.mode === "worktree";
}

export function draftNewCheckout(
  draft: DraftCheckout,
  base: string,
  fromOrigin: boolean,
): NewCheckout {
  if (draft.placement === "sandbox")
    return { kind: "sandbox", base, fromOrigin };
  return draft.mode === "worktree"
    ? { kind: "worktree", base, fromOrigin }
    : { kind: "local" };
}

export type SandboxOption =
  | { kind: "checking" }
  | { kind: "ready"; note: string | null }
  | { kind: "unavailable"; reason: string };

export function sandboxOption(
  availability: SandboxAvailability | undefined,
  error: string | undefined,
): SandboxOption {
  if (error !== undefined) return { kind: "unavailable", reason: error };
  if (!availability) return { kind: "checking" };
  if (availability.kind === "unavailable") return availability;
  return {
    kind: "ready",
    note: availability.lowMemory
      ? `Docker has ${formatGigabytes(availability.memoryBytes)} of memory. Raise it in Docker Desktop > Settings > Resources > Memory.`
      : null,
  };
}

function formatGigabytes(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  return `${gigabytes < 10 ? gigabytes.toFixed(1) : Math.round(gigabytes)} GB`;
}
