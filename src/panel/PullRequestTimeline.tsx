import { changeResultText } from "./prLifecycle";
import { conversationDrafts, draftKey } from "./reviewDrafts";
import { useState, useSyncExternalStore } from "react";
import { ipc } from "../ipc";
import { sectionProblemText } from "./prCoverage";
import { Button } from "../ui/controls";
import { Textarea } from "../ui/textarea";
import { ReviewDetails } from "./ReviewFinding";
import type { PrReviewAction, PrReviewDetail } from "./prReview";
import type { ReviewDraftRequest } from "./reviews";

export type ReviewHandoff = {
  workspaceId: string;
  threadId: string;
  canAskCodex: boolean;
  onAskCodex: (request: ReviewDraftRequest) => void;
};
export function PullRequestTimeline({
  detail,
  disabled,
  refresh,
  ...handoff
}: {
  detail: PrReviewDetail;
  disabled: boolean;
  refresh: () => void;
} & ReviewHandoff) {
  return (
    <div>
      {detail.timeline.map(({ at, event }, index) => {
        const date = at ? new Date(at) : null;
        const time =
          date && Number.isFinite(date.getTime())
            ? date.toLocaleString()
            : "Date unavailable";
        if (event.kind === "comment" || event.kind === "review") {
          const entry = detail.findings.find(
            (entry) => entry.finding.observation.findingId === event.findingId,
          );
          return entry ? (
            <div key={`${event.kind}:${event.findingId}`}>
              <p className="px-3 pt-3 text-xs text-muted-foreground">{time}</p>
              <Finding
                entry={entry}
                detail={detail}
                disabled={disabled}
                refresh={refresh}
                {...handoff}
              />
            </div>
          ) : null;
        }
        const title = (() => {
          switch (event.kind) {
            case "opened":
              return `${event.author ?? "Unknown author"} opened this pull request`;
            case "commit":
              return `Commit ${event.oid.slice(0, 7)}`;
            case "merged":
              return "Pull request merged";
            case "closed":
              return "Pull request closed";
          }
        })();
        return (
          <article
            key={`${event.kind}:${index}`}
            className="space-y-1 border-b border-border/60 p-3 text-xs"
          >
            <p className="text-muted-foreground">{time}</p>
            <p className="font-medium">{title}</p>
            {event.kind === "commit" ? (
              <>
                <p>{event.headline}</p>
                <p className="text-muted-foreground">
                  {event.author ?? "Unknown author"}
                </p>
              </>
            ) : null}
          </article>
        );
      })}
      {detail.problems
        .filter((problem) =>
          ["threads", "conversation_comments", "reviews", "commits"].includes(
            problem.section,
          ),
        )
        .map((problem) => (
          <p
            key={problem.section}
            className="p-3 text-xs text-muted-foreground"
          >
            {sectionProblemText(problem)}
          </p>
        ))}
    </div>
  );
}
function Finding({
  entry,
  detail,
  disabled,
  refresh,
  workspaceId,
  threadId,
  canAskCodex,
  onAskCodex,
}: {
  entry: PrReviewDetail["findings"][number];
  detail: PrReviewDetail;
  disabled: boolean;
  refresh: () => void;
} & ReviewHandoff) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const key = `${draftKey(detail.observation)}:${entry.finding.observation.findingId}`;
  const draft = useSyncExternalStore(
    conversationDrafts.subscribe,
    () => conversationDrafts.get(key),
    () => conversationDrafts.get(key),
  );
  const reply = draft.body;
  const uncertain = draft.operation?.result?.kind === "uncertain";
  const pending = Boolean(draft.operation && !draft.operation.result);
  const change = async (action: PrReviewAction) => {
    if (pending || uncertain) return;
    setError(undefined);
    const input = {
      requestId: crypto.randomUUID(),
      target: detail.observation,
      action,
    };
    const revision = conversationDrafts.start(key, input);
    try {
      const result = await ipc.changePullRequest(threadId, input);
      conversationDrafts.finish(key, revision, result);
      if (result.kind === "applied") refresh();
    } catch (error) {
      conversationDrafts.finish(key, revision, {
        kind: "uncertain",
        message: String(error),
      });
    }
  };
  const finding = entry.finding;
  return (
    <article className="border-b border-border/60">
      {entry.outcome ? (
        <p className="px-3 pt-3 text-xs font-medium">
          {entry.outcome.replaceAll("_", " ")}
        </p>
      ) : null}
      <ReviewDetails
        finding={finding}
        saving={saving}
        disabled={disabled}
        saveError={
          error ??
          (draft.operation?.result && draft.operation.result.kind !== "applied"
            ? changeResultText(draft.operation.result)
            : undefined)
        }
        onSave={(choice) => {
          setSaving(true);
          setError(undefined);
          void ipc
            .setReviewDisposition(threadId, detail.observation.key, {
              observation: finding.observation,
              expected: finding.saved,
              choice,
            })
            .then(refresh)
            .catch((error) => setError(String(error)))
            .finally(() => setSaving(false));
        }}
        canAskCodex={canAskCodex && !disabled && !saving}
        onAskCodex={() =>
          onAskCodex({
            workspaceId,
            threadId,
            key: detail.observation.key,
            intent: "ask",
            problems: detail.problems,
            finding,
          })
        }
        onFixCodex={() =>
          onAskCodex({
            workspaceId,
            threadId,
            key: detail.observation.key,
            intent: "fix",
            problems: detail.problems,
            finding,
          })
        }
        openUrl={(url) =>
          void ipc.openUrl(url).catch((error) => setError(String(error)))
        }
      />
      {finding.source.kind === "thread" ? (
        <div className="space-y-2 px-3 pb-3">
          {entry.canReply ? (
            <>
              <Textarea
                rows={2}
                aria-label={`Reply to ${finding.observation.findingId}`}
                placeholder="Reply to this conversation"
                value={reply}
                onChange={(e) => conversationDrafts.edit(key, e.target.value)}
              />
              <Button
                size="compact"
                variant="outline"
                disabled={
                  disabled || saving || pending || uncertain || !reply.trim()
                }
                onClick={() =>
                  void change({
                    kind: "reply",
                    threadId: finding.observation.findingId,
                    body: reply,
                  })
                }
              >
                Reply
              </Button>
            </>
          ) : null}
          {(finding.source.resolved ? entry.canUnresolve : entry.canResolve) ? (
            <Button
              size="compact"
              variant="outline"
              disabled={disabled || saving || pending || uncertain}
              onClick={() =>
                void change({
                  kind: "set_resolved",
                  threadId: finding.observation.findingId,
                  resolved:
                    finding.source.kind === "thread" &&
                    !finding.source.resolved,
                })
              }
            >
              {finding.source.resolved ? "Unresolve" : "Resolve conversation"}
            </Button>
          ) : null}
          {uncertain ? (
            <Button
              size="compact"
              variant="outline"
              onClick={() => conversationDrafts.acknowledge(key)}
            >
              I checked GitHub. Allow a new action
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
