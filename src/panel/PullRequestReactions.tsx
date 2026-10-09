// Ported from T3 Code v0.0.45 PullRequestReactions.tsx (MIT).
import { useRef, useState } from "react";
import { SmilePlusIcon } from "lucide-react";
import { Tooltip } from "../ui/tooltip";
import { Menu } from "../ui/menu";
import { cn } from "../lib/cn";
import { ipc } from "../ipc";
import { Toast, ToastViewport } from "../ui/toast";
import type { PrAccess } from "./prInbox";
import type { PrObservation, PrReaction, PrReactionContent } from "./prReview";
import {
  applyPendingPullRequestReactions,
  PULL_REQUEST_REACTION_ORDER,
  pullRequestReactionEmoji,
  pullRequestReactionName,
  pullRequestReactionTooltip,
} from "./pullRequestReactions.logic";
const PILL_CLASS =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";
export function PullRequestReactionBar({
  reactions,
  canReact,
  subjectId,
  access,
  target,
  onRefresh,
  className,
}: {
  reactions: readonly PrReaction[];
  canReact: boolean;
  subjectId?: string;
  access: PrAccess;
  target: PrObservation;
  onRefresh: () => void;
  className?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState(false);
  const signature =
    JSON.stringify([target.key, target.viewer, subjectId ?? target.nodeId]) +
    reactions
      .map(
        (reaction) =>
          `${reaction.content}:${reaction.count}:${reaction.viewerHasReacted ? 1 : 0}`,
      )
      .join(" ");
  const [pending, setPending] = useState<{
    signature: string;
    values: ReadonlyMap<PrReactionContent, boolean>;
  }>({ signature: "", values: new Map() });
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const shown = applyPendingPullRequestReactions(
    reactions,
    pending.signature === signature ? pending.values : new Map(),
  );
  const toggle = async (content: PrReactionContent, reacted: boolean) => {
    if (busy.current || !canReact) return;
    busy.current = true;
    setWorking(true);
    setPending({ signature, values: new Map([[content, reacted]]) });
    try {
      const result = await ipc.changePullRequest(access, {
        requestId: crypto.randomUUID(),
        target,
        action: {
          kind: "set_reaction",
          subjectId: subjectId ?? null,
          content,
          reacted,
        },
      });
      if (result.kind !== "applied") {
        setPending({ signature, values: new Map() });
        setError(true);
      }
      onRefresh();
    } catch {
      setPending({ signature, values: new Map() });
      setError(true);
      onRefresh();
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };
  if (shown.length === 0 && !canReact) return null;
  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full flex-wrap items-center gap-1",
        className,
      )}
    >
      {shown.map((reaction) => (
        <Tooltip
          key={reaction.content}
          content={pullRequestReactionTooltip(reaction)}
        >
          <button
            type="button"
            aria-pressed={reaction.viewerHasReacted}
            aria-label={`${pullRequestReactionName(reaction.content)}, ${reaction.count}`}
            disabled={!canReact || working}
            className={cn(
              PILL_CLASS,
              reaction.viewerHasReacted
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-border/70 bg-muted/40 text-muted-foreground",
              canReact ? "hover:border-primary/60" : "cursor-default",
            )}
            onClick={() =>
              void toggle(reaction.content, !reaction.viewerHasReacted)
            }
          >
            <span aria-hidden>
              {pullRequestReactionEmoji(reaction.content)}
            </span>
            <span className="tabular-nums">{reaction.count}</span>
          </button>
        </Tooltip>
      ))}
      {canReact ? (
        <Menu
          side="top"
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          popupKind={{ kind: "dialog", label: "Add a reaction" }}
          trigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label="Add a reaction"
              disabled={working}
              className={cn(
                PILL_CLASS,
                "border-border/70 px-1.5 text-muted-foreground hover:border-primary/60 hover:text-foreground",
              )}
            >
              <SmilePlusIcon aria-hidden className="size-3.5" />
            </button>
          )}
        >
          <div className="flex items-center gap-0.5">
            {PULL_REQUEST_REACTION_ORDER.map((content) => {
              const reacted =
                shown.find((reaction) => reaction.content === content)
                  ?.viewerHasReacted ?? false;
              return (
                <button
                  key={content}
                  type="button"
                  aria-pressed={reacted}
                  aria-label={pullRequestReactionName(content)}
                  disabled={working}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md text-base outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    reacted && "bg-primary/10",
                  )}
                  onClick={() => {
                    setPickerOpen(false);
                    void toggle(content, !reacted);
                  }}
                >
                  <span aria-hidden>{pullRequestReactionEmoji(content)}</span>
                </button>
              );
            })}
          </div>
        </Menu>
      ) : null}
      {error ? (
        <ToastViewport>
          <Toast
            type="error"
            title="The reaction could not be saved"
            onDismiss={() => setError(false)}
            dismissAfterVisibleMs={10000}
          />
        </ToastViewport>
      ) : null}
    </div>
  );
}
