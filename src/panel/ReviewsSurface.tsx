import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { checkoutKey, ipc, type CheckoutRef } from "../ipc";
import { cn } from "../lib/cn";
import { Button } from "../ui/controls";
import { Textarea } from "../ui/textarea";
import { ChatMarkdown } from "../chat/ChatMarkdown";
import {
  choiceLabel,
  dispositionState,
  sourceLabel,
  validDismissReason,
  type ReviewChoice,
  type ReviewDraftRequest,
  type ReviewFinding,
  type ReviewFindings,
} from "./reviews";

type ReadyReviews = Extract<ReviewFindings, { kind: "ready" }>;
export type ReviewsState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; data: ReviewFindings };

type DraftHandoff = {
  conversationId: string | undefined;
  canAskCodex: boolean;
  onAskCodex: (request: ReviewDraftRequest) => void;
};
export function ReviewsSurface({
  checkout,
  branch,
  ...handoff
}: { checkout: CheckoutRef; branch: string | undefined } & DraftHandoff) {
  const client = useQueryClient();
  const key = [...checkoutKey("reviews", checkout), branch ?? null];
  const identity = JSON.stringify(key);
  const current = useRef(identity);
  current.current = identity;
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const result = await ipc.reviewFindings(checkout);
      if (branch !== result.branch)
        throw new Error(
          "The checkout branch changed. Refresh the checkout and reviews.",
        );
      return result;
    },
    enabled: Boolean(branch),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    staleTime: Infinity,
  });
  const mutation = useMutation({
    mutationFn: ({
      finding,
      choice,
    }: {
      finding: ReviewFinding;
      choice: ReviewChoice | null;
    }) =>
      ipc.setReviewDisposition(checkout, {
        branch: query.data?.branch ?? "",
        observation: finding.observation,
        expected: finding.saved,
        choice,
      }),
    onSuccess: (saved, { finding }) => {
      if (current.current !== identity) return;
      client.setQueryData<ReviewFindings>(key, (previous) =>
        previous?.kind === "ready"
          ? {
              ...previous,
              findings: previous.findings.map((item) =>
                item.observation.findingId === finding.observation.findingId &&
                item.observation.contentDigest ===
                  finding.observation.contentDigest &&
                item.observation.headSha === finding.observation.headSha
                  ? { ...item, saved }
                  : item,
              ),
            }
          : previous,
      );
    },
  });
  const state: ReviewsState = query.isError
    ? { kind: "error", message: query.error.message }
    : query.isPending || !query.data
      ? { kind: "loading" }
      : { kind: "loaded", data: query.data };
  return (
    <ReviewsContent
      key={
        state.kind === "loaded" && state.data.kind === "ready"
          ? `${identity}:${state.data.pr.id}`
          : identity
      }
      state={state}
      refreshing={query.isFetching}
      onRefresh={() => {
        mutation.reset();
        void query.refetch();
      }}
      saving={mutation.isPending}
      saveError={mutation.error?.message}
      onSave={(finding, choice) => mutation.mutate({ finding, choice })}
      onClearError={() => mutation.reset()}
      workspaceId={checkout.workspaceId}
      {...handoff}
    />
  );
}

export function ReviewsContent({
  state,
  refreshing,
  onRefresh,
  saving,
  saveError,
  onSave,
  onClearError,
  workspaceId,
  conversationId,
  canAskCodex,
  onAskCodex,
}: {
  state: ReviewsState;
  refreshing: boolean;
  onRefresh: () => void;
  saving: boolean;
  saveError: string | undefined;
  onSave: (finding: ReviewFinding, choice: ReviewChoice | null) => void;
  onClearError: () => void;
  workspaceId: string;
} & DraftHandoff) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string>();
  const openUrl = (url: string) => {
    setLinkError(undefined);
    void ipc
      .openUrl(url)
      .catch((error) =>
        setLinkError(error instanceof Error ? error.message : String(error)),
      );
  };
  const data = state.kind === "loaded" ? state.data : undefined;
  const selected =
    data?.kind === "ready"
      ? (data.findings.find(
          (finding) => finding.observation.findingId === selectedId,
        ) ?? data.findings[0])
      : undefined;
  return (
    <section
      aria-label="PR reviews"
      className="flex min-h-0 flex-1 flex-col text-sm"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {data?.kind === "ready"
            ? `PR #${data.pr.number} · ${data.pr.title}`
            : "PR reviews"}
        </p>
        {data?.kind === "ready" ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Open pull request on GitHub"
            onClick={() => openUrl(data.pr.url)}
          >
            <ExternalLinkIcon />
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Refresh PR reviews"
          disabled={refreshing || saving}
          onClick={onRefresh}
        >
          <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
        </Button>
      </div>
      {linkError ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {linkError}
        </p>
      ) : null}
      {state.kind === "error" ? (
        <div role="alert" className="space-y-3 p-4 text-sm">
          <p>{state.message}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={refreshing}
            onClick={onRefresh}
          >
            Retry loading reviews
          </Button>
        </div>
      ) : state.kind === "loading" ? (
        <p role="status" className="p-4 text-xs text-muted-foreground">
          Loading PR reviews…
        </p>
      ) : state.data.kind === "none" ? (
        <p className="p-4 text-sm text-muted-foreground">
          No open PR for {state.data.branch}.
        </p>
      ) : (
        <>
          <ReviewHeads data={state.data} />
          {state.data.findings.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              This PR has no review feedback.
            </p>
          ) : (
            <>
              <div
                aria-label="Review findings"
                className="max-h-48 shrink-0 overflow-y-auto border-b border-border p-2"
              >
                {state.data.findings.map((finding) => (
                  <button
                    key={finding.observation.findingId}
                    type="button"
                    disabled={saving}
                    aria-pressed={selected === finding}
                    onClick={() => {
                      setSelectedId(finding.observation.findingId);
                      onClearError();
                    }}
                    className={cn(
                      "mb-0.5 flex w-full cursor-pointer flex-col gap-1 rounded-md px-2 py-2 text-left text-xs hover:bg-accent/60",
                      selected === finding && "bg-accent",
                    )}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">
                        {finding.comments[0]?.author ?? "Unknown author"} ·{" "}
                        {sourceLabel(finding.source)}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {finding.saved
                          ? `${dispositionState(finding) === "stale" ? "Stale · " : ""}${choiceLabel(finding.saved.choice)}`
                          : "Untouched"}
                      </span>
                    </span>
                    <span className="line-clamp-2 break-words text-muted-foreground">
                      {finding.comments[0]?.body || "Empty comment"}
                    </span>
                  </button>
                ))}
              </div>
              {selected ? (
                <ReviewDetails
                  key={selected.observation.findingId}
                  finding={selected}
                  saving={saving}
                  disabled={refreshing}
                  saveError={saveError}
                  onSave={(choice) => onSave(selected, choice)}
                  canAskCodex={
                    canAskCodex &&
                    Boolean(conversationId) &&
                    !refreshing &&
                    !saving
                  }
                  onAskCodex={() => {
                    if (conversationId)
                      onAskCodex({
                        workspaceId,
                        threadId: conversationId,
                        branch: state.data.branch,
                        finding: selected,
                      });
                  }}
                  openUrl={openUrl}
                />
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  );
}
function ReviewHeads({ data }: { data: ReadyReviews }) {
  return (
    <div className="shrink-0 space-y-1 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
      <p className="truncate" title={data.branch}>
        Branch {data.branch}
      </p>
      <p className="truncate" title={data.checkoutHead}>
        Checkout HEAD at fetch <code>{data.checkoutHead.slice(0, 12)}</code>
      </p>
      <p className="truncate" title={data.pr.headSha}>
        PR head at fetch <code>{data.pr.headSha.slice(0, 12)}</code>
      </p>
    </div>
  );
}
export function ReviewDetails({
  finding,
  saving,
  disabled,
  saveError,
  onSave,
  canAskCodex,
  onAskCodex,
  openUrl,
}: {
  finding: ReviewFinding;
  saving: boolean;
  disabled: boolean;
  saveError: string | undefined;
  onSave: (choice: ReviewChoice | null) => void;
  canAskCodex: boolean;
  onAskCodex: () => void;
  openUrl: (url: string) => void;
}) {
  const [dismiss, setDismiss] = useState(false);
  const [reason, setReason] = useState("");
  const unavailable = disabled || saving;
  const saved = finding.saved;
  const stale = dispositionState(finding) === "stale";
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {finding.source.kind === "thread" ? (
        <p className="mb-3 text-xs text-muted-foreground">
          GitHub thread {finding.source.resolved ? "resolved" : "unresolved"} ·{" "}
          {finding.source.outdated ? "outdated" : "current"}
        </p>
      ) : null}
      <div
        aria-label="Local triage"
        className="mb-4 space-y-2 rounded-md border border-border p-2.5"
      >
        <p className="text-xs">
          Local intent {saved ? choiceLabel(saved.choice) : "Untouched"}. Fix
          means planned work.
        </p>
        {stale && saved ? (
          <p role="status" className="text-xs text-muted-foreground">
            Stale decision. The PR head or finding changed since this choice.
            Saved PR head <code>{saved.observation.headSha.slice(0, 12)}</code>.
          </p>
        ) : null}
        {saved?.choice.kind === "dismiss" ? (
          <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
            Reason: {saved.choice.reason}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="compact"
            variant="outline"
            disabled={unavailable}
            onClick={() => {
              setDismiss(false);
              onSave({ kind: "fix" });
            }}
          >
            Fix
          </Button>
          <Button
            size="compact"
            variant="outline"
            disabled={unavailable}
            onClick={() => {
              setDismiss(true);
              setReason(
                saved?.choice.kind === "dismiss" ? saved.choice.reason : "",
              );
            }}
          >
            Dismiss
          </Button>
          <Button
            size="compact"
            variant="outline"
            disabled={unavailable}
            onClick={() => {
              setDismiss(false);
              onSave({ kind: "needs_decision" });
            }}
          >
            Needs decision
          </Button>
          {saved ? (
            <Button
              size="compact"
              variant="ghost-muted"
              disabled={unavailable}
              onClick={() => {
                setDismiss(false);
                onSave(null);
              }}
            >
              Clear decision
            </Button>
          ) : null}
        </div>
        {dismiss ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!unavailable && validDismissReason(reason)) {
                onSave({ kind: "dismiss", reason });
              }
            }}
          >
            <label htmlFor="review-dismiss-reason" className="text-xs">
              Dismissal reason
            </label>
            <Textarea
              id="review-dismiss-reason"
              aria-describedby="review-dismiss-help"
              size="sm"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={unavailable}
              placeholder="Explain why this finding does not need a fix"
              autoFocus
            />
            <p
              id="review-dismiss-help"
              className="text-xs text-muted-foreground"
            >
              {reason.trim() && !validDismissReason(reason)
                ? "The reason is too long."
                : "Add a short reason."}
            </p>
            <div className="flex gap-1.5">
              <Button
                type="submit"
                size="compact"
                variant="outline"
                disabled={unavailable || !validDismissReason(reason)}
              >
                Save dismissal
              </Button>
              <Button
                type="button"
                size="compact"
                variant="ghost-muted"
                disabled={saving}
                onClick={() => setDismiss(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        {saving ? (
          <p role="status" className="text-xs text-muted-foreground">
            Saving decision…
          </p>
        ) : null}
        {saveError ? (
          <p role="alert" className="text-xs text-destructive">
            {saveError}
          </p>
        ) : null}
        <Button
          size="compact"
          variant="outline"
          disabled={!canAskCodex}
          onClick={onAskCodex}
          title={
            canAskCodex
              ? "Append this finding to the current conversation draft"
              : "Available in an existing conversation when the composer is ready"
          }
        >
          Ask Codex
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Adds to your draft. You send it.
        </p>
      </div>
      <div className="space-y-4">
        {finding.comments.map((comment, index) => (
          <article
            key={comment.id}
            className="min-w-0 space-y-2 border-b border-border pb-4 last:border-b-0"
          >
            <div className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">
                {comment.author ?? "Unknown author"}
                {index ? " · Reply" : ""}
              </span>
              <Button
                size="compact"
                variant="ghost-muted"
                onClick={() => openUrl(comment.url)}
              >
                Source
                <ExternalLinkIcon className="size-3" />
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {comment.createdAt}
            </p>
            <ChatMarkdown text={comment.body || "Empty comment"} />
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="break-all">
                Original reviewed commit{" "}
                <code>{comment.context?.originalCommit ?? "Unavailable"}</code>
              </p>
              {comment.context?.path ? (
                <p className="break-all">
                  {comment.context.path}
                  {comment.context.originalLine === null
                    ? ""
                    : `:${comment.context.originalLine}`}
                </p>
              ) : null}
            </div>
            {comment.context?.diffHunk ? (
              <pre
                aria-label="Original review diff hunk"
                className="max-h-64 overflow-auto rounded-md border border-border bg-code-background p-2 text-[11px] text-code-foreground"
              >
                <code>{comment.context.diffHunk}</code>
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">
                Original diff hunk unavailable.
              </p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
