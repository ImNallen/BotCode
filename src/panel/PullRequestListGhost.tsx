// Copied from T3 Code v0.0.45 components/pullRequest/PullRequestGhosts.tsx (MIT).
import { cn } from "../lib/cn";
function GhostBar({ className }: { className?: string | undefined }) {
  return (
    <div
      aria-hidden
      className={cn("h-3 rounded bg-muted-foreground/15", className)}
    />
  );
}

const TITLE_WIDTHS = [
  "w-3/5",
  "w-2/5",
  "w-1/2",
  "w-2/3",
  "w-2/5",
  "w-3/5",
  "w-1/2",
];
const META_WIDTHS = [
  "w-2/5",
  "w-1/3",
  "w-2/5",
  "w-1/4",
  "w-1/3",
  "w-2/5",
  "w-1/3",
];

export function PullRequestListGhost({
  rows = 7,
  caption,
}: {
  rows?: number;

  caption?: string;
}) {
  return (
    <div
      role="status"
      aria-label={caption ?? "Loading pull requests"}
      className="motion-safe:animate-skeleton space-y-0.5"
    >
      {caption ? (
        <p className="px-3 pb-1 text-xs font-medium text-muted-foreground/70">
          {caption}
        </p>
      ) : null}
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 py-2.5"
        >
          <GhostBar className="size-4 rounded-full" />
          <div className="min-w-0 space-y-1.5">
            <GhostBar
              className={cn("h-4", TITLE_WIDTHS[index % TITLE_WIDTHS.length])}
            />
            <GhostBar
              className={cn("h-3.5", META_WIDTHS[index % META_WIDTHS.length])}
            />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <GhostBar className="w-12" />
            <GhostBar className="w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}
