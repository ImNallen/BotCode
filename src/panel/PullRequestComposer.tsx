// Ported from T3 Code v0.0.45 PullRequestComposer.tsx (MIT).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MessageSquareIcon, Trash2Icon, XIcon } from "lucide-react";
import { Menu } from "../ui/menu";
import { Button, Toggle } from "../ui/controls";
import { SegmentedGroup } from "./chrome";
import { PullRequestCommentForm } from "./PullRequestCommentForm";
import { PullRequestReviewComposer } from "./PullRequestReviewComposer";
import { draftKey, reviewDrafts } from "./reviewDrafts";
import type { PrReviewDetail } from "./prReview";
import type { PrAccess } from "./prInbox";
export function PullRequestComposer({
  access,
  detail,
  disabled,
  onFollowUp,
  onSubmitted,
}: {
  access: PrAccess;
  detail: PrReviewDetail;
  disabled: boolean;
  onFollowUp: (action: "close" | "reopen") => Promise<void>;
  onSubmitted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [requestedMode, setMode] = useState<"comment" | "review">("comment");
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLTextAreaElement>(null);
  useSyncExternalStore(
    reviewDrafts.subscribe,
    reviewDrafts.snapshot,
    reviewDrafts.snapshot,
  );
  const key = draftKey(detail.observation);
  const draft = reviewDrafts.get(key);
  const count = draft.comments.length;
  const reviewStarted = count > 0 || !!draft.summary.body.trim();
  const canComment = detail.capabilities.comment;
  const canReview = detail.verdicts.length > 0;
  const mode = canComment ? (canReview ? requestedMode : "comment") : "review";
  useEffect(() => {
    if (open) (mode === "review" ? reviewRef : commentRef).current?.focus();
  }, [open, mode]);
  if (!canComment && !canReview) return null;
  return (
    <div className="pointer-events-none absolute right-4 bottom-4 z-20">
      <div className="pointer-events-auto">
        <Menu
          side="top"
          align="end"
          sideOffset={8}
          open={open}
          onOpenChange={(next) => {
            if (next) setMode(reviewStarted ? "review" : "comment");
            setOpen(next);
          }}
          popupKind={{ kind: "dialog", label: "Pull request composer" }}
          className="w-[min(32rem,calc(100vw-2rem))]"
          contentClassName="p-3"
          trigger={(props) => (
            <Button
              {...props}
              size="icon"
              variant="glass"
              aria-label={
                count > 0
                  ? `Review pull request, ${count} ${count === 1 ? "comment" : "comments"} pending`
                  : reviewStarted || !canComment
                    ? "Review pull request"
                    : "Comment on pull request"
              }
            >
              <MessageSquareIcon className="size-4" />
              {count > 0 ? (
                <span
                  aria-hidden
                  className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold tabular-nums text-white"
                >
                  {count}
                </span>
              ) : null}
            </Button>
          )}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            {canComment && canReview ? (
              <SegmentedGroup label="Composer mode">
                <Toggle
                  variant="segmented"
                  pressed={mode === "comment"}
                  onClick={() => setMode("comment")}
                >
                  Comment
                </Toggle>
                <Toggle
                  variant="segmented"
                  pressed={mode === "review"}
                  onClick={() => setMode("review")}
                >
                  {count > 0 ? `Review (${count})` : "Review"}
                </Toggle>
              </SegmentedGroup>
            ) : (
              <p>
                {mode === "review"
                  ? "Review pull request"
                  : "Comment on pull request"}
              </p>
            )}
            <div className="flex items-center gap-1">
              {mode === "review" && count > 0 ? (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Discard pending line comments"
                  title="Discard pending line comments"
                  disabled={!!draft.operation && !draft.operation.result}
                  onClick={() => reviewDrafts.clearComments(key)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              ) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Close composer"
                onClick={() => setOpen(false)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          </div>
          {canReview ? (
            <div hidden={mode !== "review"}>
              <PullRequestReviewComposer
                threadId={access}
                detail={detail}
                disabled={disabled}
                textareaRef={reviewRef}
                embedded
                onSubmitted={() => {
                  setOpen(false);
                  onSubmitted();
                }}
              />
            </div>
          ) : null}
          {canComment ? (
            <div hidden={mode !== "comment"}>
              <PullRequestCommentForm
                access={access}
                detail={detail}
                actionPending={disabled}
                textareaRef={commentRef}
                onFollowUp={onFollowUp}
                onCommented={onSubmitted}
                onClose={() => setOpen(false)}
              />
            </div>
          ) : null}
        </Menu>
      </div>
    </div>
  );
}
