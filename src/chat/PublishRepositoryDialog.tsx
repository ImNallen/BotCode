// Ported from T3 Code v0.0.45 components/GitActionsControl.tsx (MIT).
import { Spinner } from "../ui/spinner";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, GlobeIcon, LockIcon } from "lucide-react";
import { checkoutKey, ipc, IpcError, type CheckoutRef } from "../ipc";
import { cn } from "../lib/cn";
import { Button, Toggle } from "../ui/controls";
import { Tooltip } from "../ui/tooltip";
import { Input } from "../ui/input";
import { GitHub } from "../ui/icons";
import {
  WizardPopup,
  WizardHeader,
  WizardSteps,
  WizardPanel,
  WizardFooter,
} from "../ui/wizard";
import { useGitHubReadiness } from "./githubReadiness";
import {
  canPublish,
  publishDefaults,
  publishFailure,
  type PublishAttempt,
  type PublishInput,
} from "./publishRepository";

export function PublishRepositoryDialog({
  checkout,
  onClose,
  onBusyChange,
}: {
  checkout: CheckoutRef;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const readiness = useGitHubReadiness();
  const ready = readiness.data?.kind === "ready";
  const [publishRepositoryOverride, setPublishRepositoryOverride] = useState<
    string | null
  >(null);
  const publishRepository =
    publishRepositoryOverride ??
    (readiness.data?.kind === "ready" ? `${readiness.data.account}/` : "");
  const [publishVisibility, setPublishVisibility] = useState<
    PublishInput["visibility"]
  >(publishDefaults.visibility);
  const [publishProtocol, setPublishProtocol] = useState<
    PublishInput["protocol"]
  >(publishDefaults.protocol);
  const [publishRemoteName, setPublishRemoteName] = useState(
    publishDefaults.remoteName,
  );
  const [publishAdvancedOpen, setPublishAdvancedOpen] = useState(false);
  const [publishWizardStep, setPublishWizardStep] = useState(0);
  const [attempt, setAttempt] = useState<PublishAttempt>({ kind: "idle" });
  const [linkError, setLinkError] = useState<string | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const running = attempt.kind === "running";
  const publishResult =
    attempt.kind === "finished" && attempt.outcome.kind === "succeeded"
      ? attempt.outcome.result
      : null;
  const publishError = publishFailure(attempt);
  const canSubmitPublishRepository = canPublish(
    attempt,
    ready,
    publishRepository,
  );
  const publishWizardSteps = ["Provider", "Repository", "Summary"];
  const publishWizardStepSummaries = [
    "GitHub",
    publishResult?.repository.nameWithOwner ?? null,
    null,
  ];
  const handleOpenChange = (open: boolean) => {
    if (!open && !inFlight.current) onClose();
  };
  const openSourceControlSettings = () => {
    handleOpenChange(false);
    void navigate({
      to: "/settings/$section",
      params: { section: "source-control" },
    });
  };
  const submitPublishRepository = () => {
    if (!canSubmitPublishRepository || inFlight.current) return;
    inFlight.current = true;
    setAttempt({ kind: "running" });
    onBusyChange(true);
    void ipc
      .publishRepository(checkout, {
        repository: publishRepository.trim(),
        visibility: publishVisibility,
        remoteName: publishRemoteName.trim() || "origin",
        protocol: publishProtocol,
      })
      .then((outcome) => {
        if (!active.current) return;
        setAttempt({ kind: "finished", outcome });
        if (outcome.kind === "succeeded") setPublishWizardStep(2);
      })
      .catch((error: Error) => {
        if (active.current)
          setAttempt(
            error instanceof IpcError && error.code !== "ipc"
              ? { kind: "refused", message: error.message }
              : {
                  kind: "finished",
                  outcome: {
                    kind: "creation_uncertain",
                    repository: publishRepository.trim(),
                    message:
                      "Publication could not be confirmed. Check GitHub and this checkout's remotes before retrying.",
                  },
                },
          );
      })
      .finally(() => {
        inFlight.current = false;
        if (active.current) onBusyChange(false);
        void client.invalidateQueries({
          queryKey: checkoutKey("git", checkout),
        });
        void client.invalidateQueries({
          queryKey: checkoutKey("pr", checkout),
        });
      });
  };
  return (
    <WizardPopup open onOpenChange={handleOpenChange}>
      <WizardHeader
        title="Publish repository"
        description="Pick where to host it, then point us at a repo to push to."
      >
        <WizardSteps
          steps={publishWizardSteps}
          currentStep={publishWizardStep}
          summaries={publishWizardStepSummaries}
          showSummaries
          isStepDisabled={(index) =>
            running ||
            publishWizardStep === 2 ||
            index >= publishWizardSteps.length - 1 ||
            index > publishWizardStep
          }
          onStepChange={setPublishWizardStep}
        />
      </WizardHeader>

      <WizardPanel>
        <div className={cn("space-y-2", publishWizardStep !== 0 && "hidden")}>
          <span
            id="publish-provider-cards-label"
            className="text-xs font-medium text-foreground"
          >
            Provider
          </span>
          <div
            role="radiogroup"
            aria-labelledby="publish-provider-cards-label"
            className="grid grid-cols-2 gap-3"
          >
            {ready ? (
              <button
                type="button"
                role="radio"
                aria-checked="true"
                className="relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-[background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background border-primary bg-background shadow-sm ring-2 ring-primary/35 dark:border-transparent dark:bg-primary/10 dark:shadow-none dark:ring-1 dark:ring-primary/30"
              >
                <GitHub className="size-5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  GitHub
                </span>
              </button>
            ) : (
              <div className="relative flex cursor-not-allowed items-center gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left opacity-64 dark:border-transparent dark:bg-white/[0.035]">
                <GitHub
                  className="size-5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  GitHub
                </span>
                {readiness.isFetching ? (
                  <Spinner size="sm" aria-label="Checking GitHub" />
                ) : (
                  <Tooltip
                    content={
                      readiness.data?.kind === "unavailable"
                        ? readiness.data.hint
                        : "Open Settings -> Source Control to configure this provider."
                    }
                  >
                    <Button
                      variant="warning-outline"
                      size="micro"
                      onClick={openSourceControlSettings}
                    >
                      Setup Required
                    </Button>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        </div>

        <div className={cn("space-y-5", publishWizardStep !== 1 && "hidden")}>
          <div className="space-y-2">
            <label
              htmlFor="publish-repository-path"
              className="text-xs font-medium text-foreground"
            >
              Repository
            </label>
            <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ring">
              <span className="flex shrink-0 items-center gap-1.5 border-r border-input bg-muted/50 px-2.5 font-mono text-xs text-muted-foreground">
                <GitHub className="size-3.5" />
                github.com/
              </span>
              <input
                id="publish-repository-path"
                name="publish-repository-path"
                value={publishRepository}
                onChange={(event) => {
                  setPublishRepositoryOverride(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitPublishRepository();
                  }
                }}
                placeholder="owner/repo"
                disabled={running}
                className="w-full bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground/60 focus:outline-none"
              />
            </div>
          </div>

          <div className="space-y-2">
            <span
              id="publish-visibility-cards-label"
              className="text-xs font-medium text-foreground"
            >
              Visibility
            </span>
            <div
              role="radiogroup"
              onKeyDown={(event) => {
                if (
                  !running &&
                  ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                    event.key,
                  )
                ) {
                  event.preventDefault();
                  const next =
                    publishVisibility === "private" ? "public" : "private";
                  setPublishVisibility(next);
                  event.currentTarget
                    .querySelector<HTMLButtonElement>(`button[value="${next}"]`)
                    ?.focus();
                }
              }}
              aria-labelledby="publish-visibility-cards-label"
              className="grid grid-cols-2 gap-3"
            >
              {[
                {
                  value: "private" as const,
                  label: "Private",
                  description: "Only invited people",
                  Icon: LockIcon,
                },
                {
                  value: "public" as const,
                  label: "Public",
                  description: "Anyone on the web",
                  Icon: GlobeIcon,
                },
              ].map((option) => {
                const isSelected = publishVisibility === option.value;
                return (
                  <button
                    type="button"
                    role="radio"
                    tabIndex={isSelected ? 0 : -1}
                    aria-checked={isSelected}
                    disabled={running}
                    onClick={() => setPublishVisibility(option.value)}
                    key={option.value}
                    value={option.value}
                    className={cn(
                      "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
                      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                      isSelected
                        ? "border-primary bg-background shadow-sm ring-2 ring-primary/35 dark:border-transparent dark:bg-primary/10 dark:shadow-none dark:ring-1 dark:ring-primary/30"
                        : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
                    )}
                  >
                    <option.Icon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">
                        {option.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <button
              type="button"
              disabled={running}
              onClick={() => setPublishAdvancedOpen((prev) => !prev)}
              aria-expanded={publishAdvancedOpen}
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDownIcon
                className={cn(
                  "size-3.5 transition-transform",
                  publishAdvancedOpen ? "" : "-rotate-90",
                )}
              />
              Advanced
            </button>
            {publishAdvancedOpen ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5" htmlFor="publish-remote-name">
                  <span className="text-xs font-medium text-foreground">
                    Remote
                  </span>
                  <Input
                    id="publish-remote-name"
                    value={publishRemoteName}
                    onChange={(event) =>
                      setPublishRemoteName(event.target.value)
                    }
                    placeholder="origin"
                    disabled={running}
                  />
                </label>
                <div className="space-y-1.5">
                  <span
                    id="publish-protocol-label"
                    className="text-xs font-medium text-foreground"
                  >
                    Protocol
                  </span>
                  <div
                    role="group"
                    aria-labelledby="publish-protocol-label"
                    className="flex w-fit *:focus-visible:z-10 dark:*:[[data-slot=separator]:has(+[data-slot=toggle]:hover)]:before:bg-input/64 dark:*:[[data-slot=separator]:has(+[data-slot=toggle][data-pressed])]:before:bg-input dark:*:[[data-slot=toggle]:hover+[data-slot=separator]]:before:bg-input/64 dark:*:[[data-slot=toggle][data-pressed]+[data-slot=separator]]:before:bg-input *:pointer-coarse:after:min-w-auto gap-0.5 rounded-lg bg-input/40 p-0.5"
                  >
                    <Toggle
                      variant="segmented"
                      size="segmented"
                      disabled={running}
                      pressed={publishProtocol === "ssh"}
                      onClick={() => setPublishProtocol("ssh")}
                    >
                      SSH
                    </Toggle>
                    <Toggle
                      variant="segmented"
                      size="segmented"
                      disabled={running}
                      pressed={publishProtocol === "https"}
                      onClick={() => setPublishProtocol("https")}
                    >
                      HTTPS
                    </Toggle>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {running ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]"
            >
              <Spinner size="sm" aria-hidden />
              Publishing repository to {"GitHub"}...
            </div>
          ) : null}
          {publishError && !running ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <p className="font-medium">Publish failed</p>
              <p className="mt-0.5 text-destructive/90">{publishError}</p>
            </div>
          ) : null}
        </div>

        <div className={cn("space-y-4", publishWizardStep !== 2 && "hidden")}>
          {linkError ? (
            <p role="alert" className="text-xs text-destructive">
              {linkError}
            </p>
          ) : null}
          {publishResult ? (
            <>
              <div className="flex flex-col items-center gap-2 py-1 text-center">
                <span className="grid size-8 place-items-center rounded-full bg-success/15 text-success">
                  <CheckIcon className="size-4" aria-hidden />
                </span>
                <h3 className="text-sm font-semibold text-foreground">
                  {publishResult.status === "pushed"
                    ? "Repository published"
                    : "Repository created"}
                </h3>
                <p className="max-w-xs text-pretty text-xs text-muted-foreground">
                  {publishResult.status === "pushed"
                    ? `${publishResult.branch} is now live on ${"GitHub"}.`
                    : `Remote "${publishResult.remoteName}" is set up. Make a commit and push it to share your code.`}
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2 dark:border-transparent dark:bg-white/[0.035]">
                <GitHub className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  {publishResult.repository.nameWithOwner}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  void ipc
                    .openUrl(publishResult.repository.url)
                    .catch((error: Error) => setLinkError(error.message));
                }}
              >
                Open on {"GitHub"}
              </Button>
            </>
          ) : (
            <div className="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]">
              Publish result unavailable.
            </div>
          )}
        </div>
      </WizardPanel>

      <WizardFooter>
        {publishWizardStep === 2 ? (
          <Button onClick={() => handleOpenChange(false)}>Done</Button>
        ) : (
          <>
            <Button
              variant="outline"
              disabled={running}
              onClick={() => {
                if (publishWizardStep === 0) {
                  handleOpenChange(false);
                  return;
                }
                setPublishWizardStep((step) => Math.max(0, step - 1));
              }}
            >
              {publishWizardStep === 0 ? "Cancel" : "Back"}
            </Button>
            {publishWizardStep < 1 ? (
              <Button
                disabled={!ready}
                onClick={() =>
                  setPublishWizardStep((step) => Math.min(1, step + 1))
                }
              >
                Next
              </Button>
            ) : (
              <Button
                disabled={!canSubmitPublishRepository}
                onClick={submitPublishRepository}
              >
                {running ? (
                  <>
                    <Spinner size="sm" aria-hidden />
                    Publishing...
                  </>
                ) : (
                  "Publish"
                )}
              </Button>
            )}
          </>
        )}
      </WizardFooter>
    </WizardPopup>
  );
}
