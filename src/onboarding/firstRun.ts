// First-run decision adapted from T3 Code v0.0.45 onboarding/firstRun.logic.ts (MIT).
import type { Storage } from "../lib/storage";

export const ONBOARDING_COMPLETED_KEY = "onboardingCompletedAt";
export type FirstRunDecision = "app" | "wizard";
export type FirstRunState =
  | { kind: "pending"; stalled: boolean }
  | { kind: "failed"; error: unknown }
  | { kind: "app" }
  | { kind: "wizard" };

export async function completeOnboarding(store: Storage): Promise<void> {
  await store.setItemDurable(
    ONBOARDING_COMPLETED_KEY,
    new Date().toISOString(),
  );
}
export async function resolveFirstRun(
  store: Storage,
  readWorkspaces: () => Promise<readonly unknown[]>,
): Promise<FirstRunDecision> {
  if (store.getItem(ONBOARDING_COMPLETED_KEY) !== null) return "app";
  const workspaces = await readWorkspaces();
  if (workspaces.length === 0) return "wizard";
  await completeOnboarding(store);
  return "app";
}
