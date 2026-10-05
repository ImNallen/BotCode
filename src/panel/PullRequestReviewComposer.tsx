import { useState, useSyncExternalStore } from "react";
import { ipc } from "../ipc";
import { Button } from "../ui/controls";
import { Textarea } from "../ui/textarea";
import { draftKey, reviewDrafts } from "./reviewDrafts";
import type { PrReviewDetail, ReviewVerdict } from "./prReview";

export function PullRequestReviewComposer({
  threadId,
  detail,
  disabled,
  onSubmitted,
}: {
  threadId: string;
  detail: PrReviewDetail;
  disabled: boolean;
  onSubmitted: () => void;
}) {
  const key = draftKey(detail.observation);
  useSyncExternalStore(
    reviewDrafts.subscribe,
    reviewDrafts.snapshot,
    reviewDrafts.snapshot,
  );
  const draft = reviewDrafts.get(key);
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<ReviewVerdict>("comment");
  const offered =
    detail.verdicts.find((v) => v === verdict) ?? detail.verdicts[0];
  const pending = Boolean(draft.operation && !draft.operation.result);
  const uncertain = draft.operation?.result?.kind === "uncertain";
  const older = reviewDrafts.older(detail.observation);
  const submit = async () => {
    if (!offered || pending || uncertain) return;
    const input = {
      requestId: crypto.randomUUID(),
      target: detail.observation,
      action: {
        kind: "submit_review",
        verdict: offered,
        body: draft.summary.body,
        comments: draft.comments,
      },
    } satisfies Parameters<typeof ipc.changePullRequest>[1];
    const captured = reviewDrafts.start(key, input);
    try {
      const result = await ipc.changePullRequest(threadId, input);
      reviewDrafts.finish(key, captured, result);
      if (result.kind === "applied") onSubmitted();
    } catch (error) {
      reviewDrafts.finish(key, captured, {
        kind: "uncertain",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <div className="shrink-0 border-t border-border bg-background p-2">
      {older.map(([oldKey, oldDraft]) => (
        <div
          key={oldKey}
          role="status"
          className="mb-2 text-xs text-muted-foreground"
        >
          A draft for another head or account is retained. Refresh cannot
          transfer its anchors.
          <details>
            <summary>Inspect retained draft</summary>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap">
              {oldDraft.summary.body}
              {oldDraft.comments
                .map((c) => `\n${c.path}:${c.line}\n${c.body}`)
                .join("")}
            </pre>
            <Button
              size="compact"
              variant="outline"
              onClick={() => reviewDrafts.discard(oldKey)}
            >
              Discard this old draft
            </Button>
          </details>
        </div>
      ))}
      <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
        {open ? "Hide review" : "Review"}
        {draft.comments.length ? ` (${draft.comments.length})` : ""}
      </Button>
      {open ? (
        <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
          <Textarea
            aria-label="Review summary"
            rows={3}
            placeholder="Summarize your review"
            value={draft.summary.body}
            onChange={(e) => reviewDrafts.summary(key, e.target.value)}
          />
          {draft.comments.map((c) => (
            <div
              key={c.id}
              className="space-y-1 rounded border border-border p-2"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="min-w-0 break-all">
                  {c.path}:{c.line} ({c.side.toLowerCase()})
                </span>
                <Button
                  size="compact"
                  variant="ghost"
                  onClick={() => reviewDrafts.remove(key, c.id)}
                >
                  Remove
                </Button>
              </div>
              <Textarea
                aria-label={`Line comment ${c.path}:${c.line}`}
                rows={2}
                value={c.body}
                onChange={(e) => reviewDrafts.edit(key, c.id, e.target.value)}
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <select
              aria-label="Review verdict"
              value={offered ?? "comment"}
              onChange={(e) => {
                const value = detail.verdicts.find((v) => v === e.target.value);
                if (value) setVerdict(value);
              }}
              disabled={pending || !offered}
              className="rounded border border-border bg-background px-2 py-1 text-xs"
            >
              {detail.verdicts.map((v) => (
                <option key={v} value={v}>
                  {v === "comment"
                    ? "Comment"
                    : v === "approve"
                      ? "Approve"
                      : "Request changes"}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={
                disabled ||
                pending ||
                uncertain ||
                !offered ||
                draft.comments.some((c) => !c.body.trim()) ||
                (offered !== "approve" &&
                  !draft.summary.body.trim() &&
                  !draft.comments.length)
              }
              onClick={() => void submit()}
            >
              {pending ? "Submitting…" : "Submit review"}
            </Button>
          </div>
          {!offered ? (
            <p className="text-xs text-muted-foreground">
              Reviewing is unavailable for this pull request and account.
            </p>
          ) : null}
        </div>
      ) : null}
      {draft.operation?.result ? (
        <p role="status" className="mt-2 text-xs">
          {draft.operation.result.kind === "applied"
            ? `Review submitted (${draft.operation.result.hostId}).`
            : draft.operation.result.message}
        </p>
      ) : null}
      {uncertain ? (
        <Button
          size="compact"
          variant="outline"
          onClick={() => reviewDrafts.acknowledge(key)}
        >
          I checked GitHub. Allow a new submission
        </Button>
      ) : null}
    </div>
  );
}
