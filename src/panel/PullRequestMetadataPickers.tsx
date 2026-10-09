// Ported from T3 Code v0.0.45 PullRequestLabelPicker.tsx and PullRequestReviewerPicker.tsx (MIT).
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, TagIcon, UserPlusIcon } from "lucide-react";
import { ipc } from "../ipc";
import { Toast, ToastViewport, type ToastType } from "../ui/toast";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { pullRequestLabelColor } from "./pullRequestList.logic";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import type { PrAccess } from "./prInbox";
import { changeResultText } from "./prLifecycle";
import type { PrObservation, PrReviewAction } from "./prReview";
import {
  matchesLabelCandidate,
  matchesReviewerCandidate,
  toggleLabel,
  toggleReviewer,
  pickerFailureTitle,
  candidateReadState,
  pickerSuccessTitle,
} from "./pullRequestPickers.logic";

export function PullRequestMetadataPicker({
  access,
  target,
  kind,
  allowed,
  disabled,
  refresh,
}: {
  access: PrAccess;
  target: PrObservation;
  kind: "labels" | "reviewers";
  allowed: boolean;
  disabled: boolean;
  refresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [toast, setToast] = useState<{
    type: ToastType;
    title: string;
    description?: string;
  }>();
  const client = useQueryClient();
  const queryKey = ["pr-candidates", access, target.key, target.viewer, kind];
  const candidates = useQuery({
    queryKey,
    queryFn: () => ipc.readPullRequestCandidates(access, target, kind),
    enabled: open && allowed,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const readState = candidateReadState(candidates);
  const apply = async (action: PrReviewAction) => {
    const title = pickerFailureTitle(action);
    const success = pickerSuccessTitle(action);
    if (busy.current || disabled || readState.locked) return;
    busy.current = true;
    setPending(true);
    try {
      const result = await ipc.changePullRequest(access, {
        requestId: crypto.randomUUID(),
        target,
        action,
      });
      if (result.kind !== "applied") {
        setToast({
          type: "error",
          title,
          description: changeResultText(result),
        });
        return;
      }
      if (success) setToast({ type: "success", title: success });
    } catch (error) {
      setToast({ type: "error", title, description: String(error) });
    } finally {
      await client.invalidateQueries({
        queryKey: ["pr-candidates", access, target.key],
      });
      busy.current = false;
      setPending(false);
      refresh();
    }
  };
  const common = {
    allowed,
    open,
    onOpenChange: setOpen,
    query,
    onQueryChange: setQuery,
    isPending: candidates.isPending && !candidates.data,
    error: readState.error,
    onRetry: () => void candidates.refetch(),
    truncated: candidates.data?.truncated === true,
    disabled: disabled || pending || readState.locked,
  };
  return (
    <>
      {kind === "labels" ? (
        <PullRequestCandidatePicker
          {...common}
          icon={<TagIcon className="size-3.5" />}
          label="Change labels"
          disabledReason="Changing labels needs triage access on this repository"
          searchLabel="Search labels"
          emptyLabel="This repository has no labels."
          noMatchLabel="No label matches that."
          errorLabel="The labels could not be read."
          truncatedLabel="This repository has more labels than are listed here. Apply the rest on the host."
          candidates={(candidates.data?.labels ?? []).filter((candidate) =>
            matchesLabelCandidate(candidate, query),
          )}
          candidateKey={(candidate) => candidate.name}
          onSelect={(candidate) => void apply(toggleLabel(candidate))}
        >
          {(candidate) => (
            <>
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full bg-muted-foreground"
                style={
                  pullRequestLabelColor(candidate.color)
                    ? {
                        backgroundColor:
                          pullRequestLabelColor(candidate.color) ?? undefined,
                      }
                    : undefined
                }
              />
              <span className="min-w-0 flex-1 truncate">
                {candidate.name}
                {candidate.description ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {candidate.description}
                  </span>
                ) : null}
              </span>
              {candidate.isApplied ? (
                <CheckIcon aria-label="Applied" className="size-3.5 shrink-0" />
              ) : null}
            </>
          )}
        </PullRequestCandidatePicker>
      ) : (
        <PullRequestCandidatePicker
          {...common}
          icon={<UserPlusIcon className="size-3.5" />}
          label="Request a review"
          disabledReason="Asking someone to review needs write access on this repository"
          searchLabel="Search people with access"
          emptyLabel="Nobody else has access to this repository."
          noMatchLabel="Nobody with access matches that."
          errorLabel="The people with access could not be read."
          truncatedLabel="This repository has more people with access than are listed here. Ask for the rest on the host."
          candidates={(candidates.data?.reviewers ?? []).filter((candidate) =>
            matchesReviewerCandidate(candidate, query),
          )}
          candidateKey={(candidate) => `${candidate.kind}:${candidate.id}`}
          onSelect={(candidate) => void apply(toggleReviewer(candidate))}
        >
          {(candidate) => (
            <>
              <span className="flex-1">
                <PullRequestActorLabel actor={candidate} />
              </span>
              {candidate.kind === "team" ? (
                <span className="shrink-0 text-muted-foreground">team</span>
              ) : null}
              {candidate.isRequested ? (
                <CheckIcon
                  aria-label="Already asked"
                  className="size-3.5 shrink-0"
                />
              ) : null}
            </>
          )}
        </PullRequestCandidatePicker>
      )}
      {toast ? (
        <ToastViewport>
          <Toast
            {...toast}
            onDismiss={() => setToast(undefined)}
            dismissAfterVisibleMs={toast.type === "error" ? 10000 : 5000}
          />
        </ToastViewport>
      ) : null}
    </>
  );
}
