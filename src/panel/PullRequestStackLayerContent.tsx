// Ported from pingdotgg/t3code v0.0.45 apps/web/src/components/pullRequest/PullRequestStackLayerContent.tsx (MIT).
import { cn } from "../lib/cn";
import { pullRequestState } from "./pullRequestPresentation";
import type { PullRequestStack } from "./pullRequestStack";
export function PullRequestStackLayerContent({
  layer,
  compact = false,
}: {
  layer: PullRequestStack["layers"][number];
  compact?: boolean;
}) {
  const state = pullRequestState(
    layer.state === "open"
      ? { kind: "open", draft: layer.isDraft ?? false }
      : layer.state === "closed"
        ? { kind: "closed", closedAt: null }
        : { kind: "merged", mergedAt: null },
  );
  return (
    <>
      <state.Icon
        aria-hidden
        className={cn("size-4 shrink-0", state.toneClassName)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {layer.title || layer.headBranch}
        </span>
        <span className="block truncate text-xs font-normal text-muted-foreground">
          #{layer.number} · {compact ? null : `${layer.headBranch} · `}
          {state.label}
        </span>
      </span>
    </>
  );
}
