// Ported from T3 Code v0.0.45 PullRequestCommentForm.tsx (MIT).
import { SendIcon } from "lucide-react";
import { useRef, useState, type RefObject } from "react";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/controls";
import type { PrAccess } from "./prInbox";
import type { PrReviewDetail } from "./prReview";
import { commentDrafts } from "./reviewDrafts";
import { PullRequestGlyph } from "./pullRequestPresentation";
import { usePullRequestConversation } from "./usePullRequestConversation";
import {
  commentSubmitShortcut,
  commentFollowUp,
} from "./pullRequestComment.logic";
export function PullRequestCommentForm({
  access,
  detail,
  actionPending,
  textareaRef,
  onFollowUp,
  onCommented,
  onClose,
}: {
  access: PrAccess;
  detail: PrReviewDetail;
  actionPending: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onFollowUp: (action: "close" | "reopen") => Promise<void>;
  onCommented: () => void;
  onClose: () => void;
}) {
  const current = usePullRequestConversation({
    target: detail.observation,
    findingId: "comment",
    threadId: access,
    store: commentDrafts,
    draftId: JSON.stringify([
      detail.observation.key,
      detail.observation.viewer,
      "comment",
    ]),
    refresh: onCommented,
  });
  const running = useRef(false);
  const [submitting, setSubmitting] = useState<
    "comment" | "close" | "reopen" | null
  >(null);
  const followUpAction = commentFollowUp(detail);
  const oversized = current.reply.trim().length > 64000;
  const disabled = actionPending || current.pending || current.uncertain;
  const submit = async (action: "comment" | "close" | "reopen") => {
    const body = current.reply.trim();
    if (!body || oversized || disabled || running.current) return;
    running.current = true;
    setSubmitting(action);
    try {
      if (await current.change({ kind: "add_comment", body })) {
        onClose();
        if (action !== "comment") await onFollowUp(action);
      }
    } finally {
      running.current = false;
      setSubmitting(null);
    }
  };
  return (
    <div className="space-y-2">
      <Textarea
        ref={textareaRef}
        disabled={disabled}
        value={current.reply}
        rows={3}
        placeholder="Leave a comment"
        aria-label="Comment on this pull request"
        onChange={(event) => current.edit(event.target.value)}
        onKeyDown={(event) => {
          if (commentSubmitShortcut(event)) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) void submit("comment");
          }
        }}
      />
      <div className="flex flex-wrap justify-end gap-2">
        {followUpAction ? (
          <Button
            size="xs"
            variant={
              followUpAction === "close" ? "destructive-outline" : "outline"
            }
            disabled={disabled || oversized || !current.reply.trim()}
            onClick={() => void submit(followUpAction)}
          >
            {followUpAction === "close" ? (
              <PullRequestGlyph.closed className="size-3.5" />
            ) : (
              <PullRequestGlyph.reopen className="size-3.5" />
            )}
            {submitting === followUpAction
              ? followUpAction === "close"
                ? "Closing..."
                : "Reopening..."
              : followUpAction === "close"
                ? "Close with comment"
                : "Reopen with comment"}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || oversized || !current.reply.trim()}
          onClick={() => void submit("comment")}
        >
          <SendIcon className="size-3.5" />
          {submitting === "comment" ? "Posting..." : "Comment"}
        </Button>
      </div>
      {oversized ? (
        <p role="alert" className="text-xs text-destructive">
          Comments must be 64,000 characters or fewer. Your draft has been
          retained.
        </p>
      ) : null}
      {current.persistenceError ? (
        <p role="alert" className="text-xs text-destructive">
          {current.persistenceError}
        </p>
      ) : null}
      {current.error ? (
        <p role="alert" className="text-xs text-destructive">
          Could not post the comment. {current.error}
        </p>
      ) : null}
      {current.uncertain ? (
        <Button size="xs" variant="outline" onClick={current.acknowledge}>
          I checked GitHub. Allow a new submission
        </Button>
      ) : null}
    </div>
  );
}
