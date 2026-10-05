// Copied from pingdotgg/t3code 3e6b450 apps/web/src/components/pullRequest/PullRequestChecksPopover.tsx (MIT).
import { useState } from "react";
import { cn } from "../lib/cn";
import { Button } from "../ui/controls";
import { Menu } from "../ui/menu";
import {
  groupChecks,
  summarizeChecks,
  type ChecksRollup,
  type PrCheck,
} from "./prChecks";
import {
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";

function ChecksBody({
  checks,
  openSource,
}: {
  checks: ReadonlyArray<PrCheck>;
  openSource: (url: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const { attention, running, completed } = groupChecks(checks);
  const canCollapse =
    attention.length + running.length > 0 && completed.length > 0;
  const visibleChecks = [
    ...attention,
    ...running,
    ...(showAll || !canCollapse ? completed : []),
  ];
  if (checks.length === 0) {
    return <p className="text-muted-foreground text-xs">No checks reported</p>;
  }
  return (
    <>
      <div className="max-h-64 overflow-y-auto">
        <ul className="flex flex-col gap-1">
          {visibleChecks.map((check, index) => (
            <li
              key={`${index}:${check.name}`}
              className="flex items-center gap-2 text-xs"
            >
              <PullRequestCheckStatusIcon status={check.status} />
              <span className="min-w-0 flex-1 truncate" title={check.name}>
                {check.name}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {pullRequestCheckStatusLabel(check)}
              </span>
              {check.url === null ? null : (
                <button
                  type="button"
                  className="shrink-0 text-primary hover:underline"
                  onClick={() => check.url && openSource(check.url)}
                >
                  Details
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {canCollapse ? (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </>
  );
}

export function PullRequestChecksPopover({
  checksState,
  checks,
  openSource,
}: {
  checksState: ChecksRollup;
  checks: ReadonlyArray<PrCheck>;
  openSource: (url: string) => void;
}) {
  const presentation = pullRequestChecksStatePresentation(checksState);
  return (
    <Menu
      align="end"
      popupKind={{ kind: "dialog", label: "Checks" }}
      className="w-80"
      contentClassName="max-h-none px-4 py-4"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          aria-label={`Checks: ${presentation.label}`}
          title={presentation.label}
          className="inline-flex shrink-0 cursor-pointer items-center"
        >
          <presentation.Icon
            aria-hidden
            className={cn("size-3.5", presentation.toneClassName)}
          />
        </button>
      )}
    >
      <p className="mb-2 font-medium text-sm">{presentation.label}</p>
      <p className="mb-2 text-muted-foreground text-xs">
        {summarizeChecks(checks)}
      </p>
      <ChecksBody checks={checks} openSource={openSource} />
    </Menu>
  );
}
