// Ported from T3 Code v0.0.45 apps/web/src/components/onboarding/FirstRunGate.tsx (MIT).
import { useEffect, useState, type ReactNode } from "react";
import { ipc } from "../ipc";
import { storage } from "../lib/storage";
import { Button } from "../ui/controls";
import {
  ONBOARDING_COMPLETED_KEY,
  resolveFirstRun,
  type FirstRunState,
} from "./firstRun";
import { WelcomeWizard } from "./WelcomeWizard";

export function FirstRunGate({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<FirstRunState>(() =>
    storage.getItem(ONBOARDING_COMPLETED_KEY) !== null
      ? { kind: "app" }
      : { kind: "pending", stalled: false },
  );
  useEffect(() => {
    if (storage.getItem(ONBOARDING_COMPLETED_KEY) !== null) return;
    let active = true;
    setState({ kind: "pending", stalled: false });
    const timer = window.setTimeout(() => {
      if (active)
        setState((current) =>
          current.kind === "pending"
            ? { kind: "pending", stalled: true }
            : current,
        );
    }, 4000);
    void resolveFirstRun(storage, ipc.workspaces).then(
      (decision) => {
        if (active) setState({ kind: decision });
      },
      (error: unknown) => {
        if (active) setState({ kind: "failed", error });
      },
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);
  if (state.kind === "app") return children;
  if (state.kind === "wizard")
    return <WelcomeWizard onDone={() => setState({ kind: "app" })} />;
  if (state.kind === "failed" || state.stalled)
    return (
      <main className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-foreground">
        <div className="flex max-w-sm flex-col items-center text-center">
          <h1 className="text-lg font-semibold">Still connecting</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            L1 Code could not confirm this workspace.
          </p>
          <Button
            className="mt-5"
            size="sm"
            variant="outline"
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
        </div>
      </main>
    );
  return (
    <main
      role="status"
      className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground"
    >
      Connecting to L1 Code...
    </main>
  );
}
