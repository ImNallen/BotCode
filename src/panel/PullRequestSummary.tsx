// Copied from pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/PullRequestSummaryTab.tsx (MIT).
import { ChevronRightIcon, HammerIcon, TagIcon, UsersIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ChatMarkdown } from "../chat/ChatMarkdown";
import { cn } from "../lib/cn";
import { Button } from "../ui/controls";
import { isFailingCheck, type PrCheck } from "./prChecks";
import type { PrReviewDetail } from "./prReview";
import {
  PullRequestActorAvatar,
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  PullRequestLabelChip,
  PullRequestReviewDecisionGlyph,
  reviewOutcomePresentation,
} from "./pullRequestPresentation";

function MetaRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-7 min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs sm:min-h-6">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={title}>
      <div className="sticky top-0 z-10 flex w-full items-center bg-background pr-4">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <span>{title}</span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        </button>
      </div>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </section>
  );
}

export function PullRequestSummary({
  detail,
  checks,
  checksIncomplete,
  canFix,
  openSource,
  fixCheck,
}: {
  detail: PrReviewDetail;
  checks: ReadonlyArray<PrCheck>;
  checksIncomplete: boolean;
  canFix: boolean;
  openSource: (url: string) => void;
  fixCheck: (check: PrCheck) => void;
}) {
  return (
    <>
      <section className="px-4 pt-2.5 pb-1">
        <div className="space-y-2">
          <MetaRow icon={<UsersIcon className="size-3.5" />} label="Reviewers">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {detail.reviewers.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <span className="flex items-center -space-x-1">
                  {detail.reviewers.map((reviewer) => {
                    const outcome = reviewOutcomePresentation(reviewer.outcome);
                    return (
                      <span
                        key={reviewer.login}
                        title={
                          outcome
                            ? `${reviewer.login} — ${outcome.label}`
                            : reviewer.login
                        }
                        className={cn(
                          "relative rounded-full hover:z-10",
                          outcome?.ringClassName,
                        )}
                      >
                        <span className="flex min-w-0 items-center">
                          <PullRequestActorAvatar actor={reviewer} />
                          <span className="sr-only">{reviewer.login}</span>
                        </span>
                        {outcome ? (
                          <span className="sr-only">{outcome.label}</span>
                        ) : null}
                      </span>
                    );
                  })}
                </span>
              )}
              <PullRequestReviewDecisionGlyph
                decision={detail.reviewDecision}
              />
            </span>
          </MetaRow>
          <MetaRow icon={<TagIcon className="size-3.5" />} label="Labels">
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {detail.labels.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                detail.labels.map((label) => (
                  <PullRequestLabelChip
                    key={label.name}
                    label={label}
                    className="max-w-48"
                  />
                ))
              )}
            </span>
          </MetaRow>
        </div>
      </section>
      <Section title="Description">
        <ChatMarkdown
          text={
            detail.body.trim().length > 0
              ? detail.body
              : "_No description provided._"
          }
        />
      </Section>
      <Section title="Checks" defaultOpen={false}>
        {checks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {checksIncomplete
              ? "Checks could not be fully loaded."
              : "No checks reported."}
          </p>
        ) : (
          checks.map((check, index) => (
            <div
              key={`${index}:${check.name}:${check.url ?? ""}`}
              className="group flex items-center gap-2 rounded-md pr-1 hover:bg-accent/60"
            >
              <button
                type="button"
                disabled={!check.url}
                onClick={() => check.url && openSource(check.url)}
                className={cn(
                  "flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left text-xs leading-5 [&>svg]:mt-0.5",
                  check.url ? "cursor-pointer" : "cursor-default",
                )}
              >
                <PullRequestCheckStatusIcon status={check.status} />
                <span className="min-w-0 flex-1 wrap-anywhere">
                  {check.name}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {pullRequestCheckStatusLabel(check)}
                </span>
              </button>
              {isFailingCheck(check) ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="shrink-0"
                  disabled={!canFix}
                  onClick={() => fixCheck(check)}
                >
                  <HammerIcon className="size-3" />
                  Fix check
                </Button>
              ) : null}
            </div>
          ))
        )}
      </Section>
    </>
  );
}
