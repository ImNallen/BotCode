// Ported from T3 Code v0.0.45 apps/web/src/components/chat/ProposedPlanCard.tsx (MIT).
import { useState } from "react";
import { cn } from "../lib/cn";
import { Button } from "../ui/controls";
import { ChatMarkdown } from "./ChatMarkdown";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "./proposedPlan";

export function ProposedPlanCard({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const canCollapse = text.length > 900 || text.split("\n").length > 20;
  return (
    <div
      className="rounded-3xl border border-border/80 bg-card/70 p-4 sm:p-5"
      aria-label="Proposed plan"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0 [button&,a&]:cursor-pointer [button&,a&]:pointer-coarse:after:absolute [button&,a&]:pointer-coarse:after:size-full [button&,a&]:pointer-coarse:after:min-h-11 [button&,a&]:pointer-coarse:after:min-w-11 h-5.5 min-w-5.5 px-[calc(--spacing(1)-1px)] text-sm sm:h-4.5 sm:min-w-4.5 sm:text-xs bg-secondary text-secondary-foreground [button&,a&]:hover:bg-secondary/90">
            Plan
          </span>
          <h3 className="truncate text-sm font-medium text-foreground">
            {proposedPlanTitle(text) ?? "Proposed plan"}
          </h3>
        </div>
        {streaming ? (
          <span role="status" className="text-secondary-label text-xs">
            Planning...
          </span>
        ) : null}
      </div>
      <div className="mt-4">
        <div
          className={cn(
            "relative",
            canCollapse && !expanded && "max-h-104 overflow-hidden",
          )}
        >
          <ChatMarkdown
            text={
              canCollapse && !expanded
                ? buildCollapsedProposedPlanPreviewMarkdown(text, {
                    maxLines: 10,
                  })
                : stripDisplayedPlanMarkdown(text)
            }
          />
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
