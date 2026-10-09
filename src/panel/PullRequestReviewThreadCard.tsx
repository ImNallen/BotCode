// Ported from pingdotgg/t3code v0.0.45 PullRequestReviewAnnotation.tsx (MIT).
import { CheckCircle2Icon, CircleIcon } from "lucide-react";
import { useState } from "react";
import { ChatMarkdown } from "../chat/ChatMarkdown";
import { formatRelativeTimeLabel } from "../lib/time";
import { ipc } from "../ipc";
import { Button } from "../ui/controls";
import { Textarea } from "../ui/textarea";
import type { PrReviewDetail } from "./prReview";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { usePullRequestConversation } from "./usePullRequestConversation";

export function PullRequestReviewThreadCard({
  entry,
  detail,
  threadId,
  refresh,
  disabled,
}: {
  entry: PrReviewDetail["findings"][number];
  detail: PrReviewDetail;
  threadId?: string;
  refresh?: () => void;
  disabled: boolean;
}) {
  const finding = entry.finding;
  const source = finding.source;
  const [expanded, setExpanded] = useState(
    source.kind === "thread" && !source.resolved,
  );
  const [replying, setReplying] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const conversation = usePullRequestConversation({
    target: detail.observation,
    findingId: finding.observation.findingId,
    threadId,
    refresh,
  });
  if (source.kind !== "thread") return null;
  const pending =
    disabled || !threadId || conversation.pending || conversation.uncertain;
  const send = async () => {
    if (pending || !conversation.reply.trim()) return;
    if (
      await conversation.change({
        kind: "reply",
        threadId: finding.observation.findingId,
        body: conversation.reply.trim(),
      })
    )
      setReplying(false);
  };
  return (
    <div
      className="mx-3 my-2 rounded-xl border border-border/70 bg-background p-3 text-sm shadow-sm"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {source.resolved ? (
          <CheckCircle2Icon className="size-3.5 text-success-foreground" />
        ) : (
          <CircleIcon className="size-3.5" />
        )}
        <button
          type="button"
          className="hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {source.resolved ? "Resolved" : "Open"} · {finding.comments.length}{" "}
          {finding.comments.length === 1 ? "comment" : "comments"}
        </button>
        {source.outdated ? <span>outdated</span> : null}
        {(source.resolved ? entry.canUnresolve : entry.canResolve) ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={pending}
            onClick={() =>
              void conversation.change({
                kind: "set_resolved",
                threadId: finding.observation.findingId,
                resolved: !source.resolved,
              })
            }
          >
            {source.resolved ? "Unresolve" : "Resolve"}
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <>
          <div className="mt-2 space-y-3">
            {finding.comments.map((comment) => (
              <article key={comment.id} className="group min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <PullRequestActorLabel
                    actor={
                      comment.author
                        ? { login: comment.author, avatarUrl: null }
                        : null
                    }
                  />
                  <span>{formatRelativeTimeLabel(comment.createdAt)}</span>
                  <button
                    className="ml-auto hover:text-foreground"
                    onClick={() =>
                      void ipc
                        .openUrl(comment.url)
                        .catch((error) => setLinkError(String(error)))
                    }
                  >
                    View on GitHub
                  </button>
                </div>
                <div className="mt-1 flex items-start gap-1">
                  <div className="min-w-0 flex-1 text-sm">
                    <ChatMarkdown text={comment.body} />
                  </div>
                </div>
              </article>
            ))}
          </div>
          {entry.canReply ? (
            replying ? (
              <div className="mt-2">
                <Textarea
                  autoFocus
                  size="sm"
                  value={conversation.reply}
                  placeholder="Reply"
                  aria-label="Reply to this conversation"
                  onChange={(event) => conversation.edit(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setReplying(false);
                    } else if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey) &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setReplying(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    disabled={pending || !conversation.reply.trim()}
                    onClick={() => void send()}
                  >
                    Reply
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                className="mt-2"
                onClick={() => setReplying(true)}
              >
                Reply
              </Button>
            )
          ) : null}
        </>
      ) : null}
      {conversation.error || linkError ? (
        <p role="alert" className="mt-2 text-xs text-muted-foreground">
          {conversation.error ?? linkError}
        </p>
      ) : null}
      {conversation.uncertain ? (
        <Button size="xs" variant="ghost" onClick={conversation.acknowledge}>
          I checked GitHub. Allow a new action
        </Button>
      ) : null}
    </div>
  );
}
