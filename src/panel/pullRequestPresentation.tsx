// Copied from pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/pullRequestPresentation.tsx and pullRequestIcons.tsx (MIT).
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  UserCheckIcon,
  UserRoundIcon,
  UserRoundXIcon,
} from "lucide-react";
import {
  Children,
  type CSSProperties,
  isValidElement,
  type ReactNode,
  useState,
} from "react";
import { cn } from "../lib/cn";
import { Badge } from "../ui/badge";
import {
  isWorkflowApprovalCheck,
  type CheckStatus,
  type ChecksRollup,
  type PrCheck,
} from "./prChecks";
import type { PrActor, PrReviewDetail } from "./prReview";

export const PullRequestGlyph = {
  pullRequest: GitPullRequestArrowIcon,
  reopen: GitPullRequestArrowIcon,
  draft: GitPullRequestDraftIcon,
  closed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
  conflicting: TriangleAlertIcon,
} as const;

const PULL_REQUEST_STATE_PRESENTATION = {
  open: {
    label: "Open",
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
    Icon: PullRequestGlyph.pullRequest,
  },
  draft: {
    label: "Draft",
    toneClassName: "text-zinc-500 dark:text-zinc-400/80",
    Icon: PullRequestGlyph.draft,
  },
  closed: {
    label: "Closed",
    toneClassName: "text-red-600 dark:text-red-300/90",
    Icon: PullRequestGlyph.closed,
  },
  merged: {
    label: "Merged",
    toneClassName: "text-violet-600 dark:text-violet-300/90",
    Icon: PullRequestGlyph.merged,
  },
} as const;

export function pullRequestState(
  lifecycle: PrReviewDetail["snapshot"]["lifecycle"],
) {
  return PULL_REQUEST_STATE_PRESENTATION[
    lifecycle.kind === "open" && lifecycle.draft ? "draft" : lifecycle.kind
  ];
}

function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircleIcon
      aria-label="Loading"
      role="status"
      className={cn("motion-safe:animate-spin", className)}
    />
  );
}

const CHECK_STATUS_PRESENTATION = {
  pending: { label: "Running", Icon: Spinner, toneClassName: "text-amber-500" },
  "action-required": {
    label: "Awaiting action",
    Icon: CircleDotIcon,
    toneClassName: "text-amber-600 dark:text-amber-400/90",
  },
  success: {
    label: "Passed",
    Icon: CircleCheckIcon,
    toneClassName: "text-emerald-600 dark:text-emerald-300/90",
  },
  failure: {
    label: "Failed",
    Icon: CircleXIcon,
    toneClassName: "text-destructive",
  },
  cancelled: {
    label: "Cancelled",
    Icon: CircleXIcon,
    toneClassName: "text-destructive",
  },
  skipped: {
    label: "Skipped",
    Icon: CircleDashedIcon,
    toneClassName: "text-muted-foreground/70",
  },
  neutral: {
    label: "Neutral",
    Icon: CircleDashedIcon,
    toneClassName: "text-muted-foreground/70",
  },
} as const satisfies Record<
  CheckStatus,
  {
    label: string;
    Icon: typeof CircleCheckIcon | typeof Spinner;
    toneClassName: string;
  }
>;

export function pullRequestCheckStatusLabel(
  check: Pick<PrCheck, "status" | "url">,
): string {
  return isWorkflowApprovalCheck(check)
    ? "Awaiting approval"
    : CHECK_STATUS_PRESENTATION[check.status].label;
}

export function PullRequestCheckStatusIcon({
  status,
}: {
  status: CheckStatus;
}) {
  const presentation = CHECK_STATUS_PRESENTATION[status];
  return (
    <presentation.Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", presentation.toneClassName)}
    />
  );
}

const CHECKS_STATE_PRESENTATION = {
  passing: {
    label: "All checks have passed",
    Icon: CircleCheckIcon,
    toneClassName: CHECK_STATUS_PRESENTATION.success.toneClassName,
  },
  failing: {
    label: "Some checks were not successful",
    Icon: CircleXIcon,
    toneClassName: "text-destructive",
  },
  pending: {
    label: "Some checks haven't completed yet",
    Icon: CircleDotIcon,
    toneClassName: "text-amber-600 dark:text-amber-400/90",
  },
} as const satisfies Record<
  ChecksRollup,
  { label: string; Icon: typeof CircleCheckIcon; toneClassName: string }
>;

export function pullRequestChecksStatePresentation(state: ChecksRollup) {
  return CHECKS_STATE_PRESENTATION[state];
}

const REVIEW_DECISION_PRESENTATION = new Map([
  [
    "APPROVED",
    {
      Icon: UserCheckIcon,
      label: "Approved",
      toneClassName: CHECK_STATUS_PRESENTATION.success.toneClassName,
    },
  ],
  [
    "CHANGES_REQUESTED",
    {
      Icon: UserRoundXIcon,
      label: "Changes requested",
      toneClassName: "text-amber-600/90 dark:text-amber-400/80",
    },
  ],
  [
    "REVIEW_REQUIRED",
    {
      Icon: UserRoundIcon,
      label: "Awaiting review",
      toneClassName: "text-muted-foreground/60",
    },
  ],
]);

export function PullRequestReviewDecisionGlyph({
  decision,
}: {
  decision: string | null;
}) {
  const presentation =
    decision === null ? undefined : REVIEW_DECISION_PRESENTATION.get(decision);
  if (!presentation) return null;
  return (
    <span className="inline-flex shrink-0" title={presentation.label}>
      <presentation.Icon
        aria-hidden
        className={cn("size-3.5", presentation.toneClassName)}
      />
      <span className="sr-only">{presentation.label}</span>
    </span>
  );
}

const REVIEW_OUTCOME_PRESENTATION = new Map([
  [
    "APPROVED",
    {
      label: "Approved",
      ringClassName: "ring-2 ring-emerald-500 dark:ring-emerald-400",
    },
  ],
  [
    "CHANGES_REQUESTED",
    {
      label: "Changes requested",
      ringClassName: "ring-2 ring-destructive",
    },
  ],
  [
    "DISMISSED",
    {
      label: "Review dismissed",
      ringClassName: "ring-2 ring-muted-foreground/60",
    },
  ],
]);

// GitHub review states without a verdict, such as COMMENTED, draw no ring.
export function reviewOutcomePresentation(outcome: string | null) {
  return outcome === null
    ? undefined
    : REVIEW_OUTCOME_PRESENTATION.get(outcome);
}

export function PullRequestActorAvatar({
  actor,
  className,
}: {
  actor: PrActor | null;
  className?: string;
}) {
  const login = actor?.login ?? "ghost";
  const avatarUrl = actor?.avatarUrl ?? null;
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  return avatarUrl === null || failedAvatarUrl === avatarUrl ? (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground",
        className,
      )}
    >
      {login.slice(0, 1).toUpperCase()}
    </span>
  ) : (
    <img
      aria-hidden
      alt=""
      src={avatarUrl}
      loading="lazy"
      className={cn(
        "size-4 shrink-0 rounded-full bg-muted object-cover",
        className,
      )}
      onError={() => setFailedAvatarUrl(avatarUrl)}
    />
  );
}

export function PullRequestActorLabel({ actor }: { actor: PrActor | null }) {
  const login = actor?.login ?? "ghost";
  return (
    <span className="flex min-w-0 shrink" title={login}>
      <span className="flex min-w-0 items-center gap-1.5">
        <PullRequestActorAvatar actor={actor} />
        <span className="truncate font-medium text-foreground">{login}</span>
      </span>
    </span>
  );
}

export function PullRequestDiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span
      className={cn("inline-flex items-baseline gap-1 tabular-nums", className)}
    >
      <span className="text-diff-addition-foreground">
        +{additions.toLocaleString()}
      </span>
      <span className="text-diff-deletion">-{deletions.toLocaleString()}</span>
    </span>
  );
}

function separatorKey(segment: ReactNode): string {
  return `separator:${isValidElement(segment) ? String(segment.key) : String(segment)}`;
}

export function PullRequestMetaLine({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const segments = Children.toArray(children);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {segments.flatMap((segment, index) =>
        index === 0
          ? segment
          : [
              <span
                aria-hidden
                className="shrink-0 text-muted-foreground/50"
                key={separatorKey(segment)}
              >
                ·
              </span>,
              segment,
            ],
      )}
    </span>
  );
}

function labelColor(color: string): string | null {
  const hex = color.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

export function PullRequestLabelChip({
  label,
  className,
}: {
  label: PrReviewDetail["labels"][number];
  className?: string;
}) {
  const color = labelColor(label.color);
  return (
    <Badge
      size="default"
      variant={color ? "label" : "secondary"}
      className={cn("min-w-0 max-w-40 shrink justify-start", className)}
      {...(color ? { style: { "--label": color } as CSSProperties } : {})}
    >
      <span className="truncate">{label.name}</span>
    </Badge>
  );
}
