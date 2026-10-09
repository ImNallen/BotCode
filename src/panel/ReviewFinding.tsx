import { useId, useState, type ReactNode } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "../ui/controls";
import { Textarea } from "../ui/textarea";
import { ChatMarkdown } from "../chat/ChatMarkdown";
import {
  choiceLabel,
  dispositionState,
  validDismissReason,
  type ReviewChoice,
  type ReviewFinding,
} from "./reviews";

export function ReviewDetails({
  finding,
  saving,
  disabled,
  saveError,
  onSave,
  canAskCodex,
  onAskCodex,
  onFixCodex,
  openUrl,
  commentFooter,
}: {
  finding: ReviewFinding;
  saving: boolean;
  disabled: boolean;
  saveError: string | undefined;
  onSave: (choice: ReviewChoice | null) => void;
  canAskCodex: boolean;
  onAskCodex: () => void;
  onFixCodex: () => void;
  openUrl: (url: string) => void;
  commentFooter?: (id: string) => ReactNode;
}) {
  const reasonId = useId();
  const helpId = useId();
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
            <label htmlFor={reasonId} className="text-xs">
              Dismissal reason
            </label>
            <Textarea
              id={reasonId}
              aria-describedby={helpId}
              size="sm"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={unavailable}
              placeholder="Explain why this finding does not need a fix"
              autoFocus
            />
            <p id={helpId} className="text-xs text-muted-foreground">
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
        <Button
          size="compact"
          variant="outline"
          disabled={!canAskCodex}
          onClick={onFixCodex}
        >
          Fix finding
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
            {commentFooter?.(comment.id)}
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
