// Local CLI flow ported from T3 Code v0.0.45 apps/web/src/components/onboarding/WelcomeWizard.tsx (MIT).
import {
  ArrowRightIcon,
  CheckIcon,
  MonitorIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ipc, type CodexReadiness, type CodexSetupAction } from "../ipc";
import { storage } from "../lib/storage";
import { usePreferences } from "../settings/preferences";
import { TerminalViewport } from "../terminal/ThreadTerminalDrawer";
import { Button } from "../ui/controls";
import { Checkbox } from "../ui/checkbox";
import { OpenAI } from "../ui/icons";
import {
  WizardHeader,
  WizardPanel,
  WizardPopup,
  WizardSteps,
} from "../ui/wizard";
import { MacPermissions, isMac } from "../permissions/MacPermissions";
import { completeOnboarding } from "./firstRun";

type WizardStep = "connection" | "agents" | "permissions";
type Readiness = { kind: "checking" } | CodexReadiness;
type Completion = { kind: "idle" } | { kind: "saving" } | { kind: "failed" };
const ONBOARDING_STAGES = isMac
  ? ["Connect", "Agents", "Permissions"]
  : ["Connect", "Agents"];

export function WelcomeWizard({ onDone }: { readonly onDone: () => void }) {
  const [selected, setSelected] = useState(true);
  const [step, setStep] = useState<WizardStep>("connection");
  const [readiness, setReadiness] = useState<Readiness>({ kind: "checking" });
  const [scan, setScan] = useState(0);
  const [setup, setSetup] = useState<CodexSetupAction | null>(null);
  const [completion, setCompletion] = useState<Completion>({ kind: "idle" });
  useEffect(() => {
    if (step !== "agents") return;
    let active = true;
    setReadiness({ kind: "checking" });
    void ipc.codexReadiness().then(
      (result) => {
        if (active) setReadiness(result);
      },
      () => {
        if (active)
          setReadiness({
            kind: "attention",
            message: "Could not check Codex. Try again.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [step, scan]);
  const closeSetup = () => {
    setSetup(null);
    setScan((value) => value + 1);
  };
  const finish = async () => {
    if (completion.kind === "saving") return;
    setCompletion({ kind: "saving" });
    try {
      await completeOnboarding(storage);
      onDone();
    } catch {
      setCompletion({ kind: "failed" });
    }
  };
  const stageIndex = step === "connection" ? 0 : step === "agents" ? 1 : 2;
  return (
    <main className="h-dvh bg-background text-foreground">
      <WizardPopup
        open
        onOpenChange={() => {}}
        size="wide"
        bottomStickOnMobile={false}
      >
        <WizardHeader
          title="Set up Bot Code"
          identity={
            <div
              className="flex items-baseline gap-1.5"
              role="img"
              aria-label="Bot Code"
            >
              <span className="text-2xl font-medium tracking-tight">Bot</span>
              <span className="text-2xl font-medium tracking-tight text-muted-foreground">
                Code
              </span>
            </div>
          }
        >
          <WizardSteps
            steps={ONBOARDING_STAGES}
            currentStep={stageIndex}
            isStepDisabled={(index) =>
              completion.kind === "saving" || index >= stageIndex
            }
            onStepChange={(index) => {
              closeSetup();
              setStep(index === 0 ? "connection" : "agents");
            }}
          />
        </WizardHeader>
        <WizardPanel>
          {step === "connection" ? (
            <>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Connect your computers
              </h1>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                Choose one or more computers. We’ll set up agents and projects
                on each.
              </p>
              <fieldset className="mt-5 space-y-2">
                <legend className="sr-only">Computers to set up</legend>
                <label
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
                  onClick={(event) => {
                    if (event.defaultPrevented) return;
                    event.preventDefault();
                    setSelected((value) => !value);
                  }}
                >
                  <Checkbox
                    checked={selected}
                    label="This computer"
                    onCheckedChange={() => setSelected((value) => !value)}
                  />
                  <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 text-sm font-medium break-words">
                        This computer
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        Connected
                      </span>
                    </span>
                  </span>
                </label>
              </fieldset>
              <div className="mt-6 flex items-center justify-end gap-3">
                <Button
                  autoFocus
                  disabled={!selected}
                  onClick={() => setStep("agents")}
                >
                  Continue
                  <ArrowRightIcon className="size-3.5" />
                </Button>
              </div>
            </>
          ) : step === "permissions" ? (
            <>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Permissions
              </h1>
              <div className="mt-5">
                <MacPermissions />
              </div>
              {completion.kind === "failed" ? (
                <p role="alert" className="mt-4 text-sm text-destructive">
                  Could not finish setup. Your settings could not be saved. Try
                  again.
                </p>
              ) : null}
              <div className="mt-6 flex justify-end">
                <Button
                  autoFocus
                  disabled={completion.kind === "saving"}
                  onClick={() => void finish()}
                >
                  Continue
                  <ArrowRightIcon className="size-3.5" />
                </Button>
              </div>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Connect your agents
              </h1>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                Choose an agent to start coding. You can add more later.
              </p>
              <div className="mt-5 h-auto max-h-[min(32rem,55dvh)] overflow-y-auto">
                <div className="space-y-5 pr-3">
                  <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-4">
                    <OpenAI className="size-5 shrink-0 fill-foreground" />
                    <div className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">
                        Codex
                      </span>
                      <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
                        {readiness.kind === "ready"
                          ? "Ready to code."
                          : readiness.kind === "checking"
                            ? "Checking..."
                            : readiness.kind === "missing"
                              ? "Not found · CLI not detected on PATH."
                              : readiness.kind === "unauthenticated"
                                ? "Not authenticated"
                                : readiness.message}
                      </p>
                    </div>
                    <div className="shrink-0">
                      {readiness.kind === "ready" ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
                          <CheckIcon className="size-3.5" />
                          Ready
                        </span>
                      ) : readiness.kind === "missing" ||
                        readiness.kind === "unauthenticated" ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={setup !== null}
                          onClick={() =>
                            setSetup(
                              readiness.kind === "missing"
                                ? "install"
                                : "sign_in",
                            )
                          }
                        >
                          <TerminalIcon className="size-3.5" />
                          {readiness.kind === "missing" ? "Install" : "Sign in"}
                        </Button>
                      ) : readiness.kind === "attention" ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setScan((value) => value + 1)}
                        >
                          Retry
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Checking...
                        </span>
                      )}
                    </div>
                  </div>
                  {setup ? (
                    <AgentInstallTerminal action={setup} onClose={closeSetup} />
                  ) : null}
                </div>
              </div>
              {completion.kind === "failed" ? (
                <p role="alert" className="mt-4 text-sm text-destructive">
                  Could not finish setup. Your settings could not be saved. Try
                  again.
                </p>
              ) : null}
              <div className="mt-6 flex justify-end">
                <Button
                  autoFocus
                  disabled={completion.kind === "saving"}
                  onClick={() => {
                    closeSetup();
                    if (isMac) setStep("permissions");
                    else void finish();
                  }}
                >
                  Continue
                  <ArrowRightIcon className="size-3.5" />
                </Button>
              </div>
            </>
          )}
        </WizardPanel>
      </WizardPopup>
    </main>
  );
}

type TerminalSetup =
  | { kind: "preparing" }
  | { kind: "failed" }
  | { kind: "ready"; terminalId: string; command: string };
function AgentInstallTerminal({
  action,
  onClose,
}: {
  readonly action: CodexSetupAction;
  readonly onClose: () => void;
}) {
  const [state, setState] = useState<TerminalSetup>({ kind: "preparing" });
  const [attempt, setAttempt] = useState(0);
  const { preferences } = usePreferences();
  useEffect(() => {
    let active = true;
    const terminalId = `onboarding-codex-${crypto.randomUUID()}`;
    setState({ kind: "preparing" });
    const opened = ipc.setupTerminalOpen(terminalId, action);
    void opened.then(
      (command) => {
        if (active) setState({ kind: "ready", terminalId, command });
      },
      () => {
        if (active) setState({ kind: "failed" });
      },
    );
    return () => {
      active = false;
      void opened
        .catch(() => {})
        .then(() => ipc.terminalClose({ owner: "setup", terminalId }))
        .catch(() => {});
    };
  }, [action, attempt]);
  return (
    <div
      data-thread-terminal-drawer
      className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {state.kind === "ready"
            ? "Review the command, then press Enter to run it."
            : state.kind === "failed"
              ? "Could not open the setup terminal."
              : "Preparing command..."}
        </span>
        <div className="flex items-center gap-1">
          {state.kind === "failed" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div className="h-64">
        {state.kind === "ready" ? (
          <TerminalViewport
            target={{ owner: "setup", terminalId: state.terminalId }}
            fontSize={preferences.codeFontSize}
            fileLinks={undefined}
            onSessionExited={onClose}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={256}
          />
        ) : null}
      </div>
    </div>
  );
}
