// Rows, bars and pace glyphs copied from pingdotgg/t3code v0.0.45 components/usage/UsageLimits.tsx,
// usage/UsageLimitsPooled.tsx and usage/usageProviders.ts (MIT).
import { GaugeIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { Fragment } from "react";
import type { LimitWindow } from "../ipc";
import { formatUpcomingTimestamp } from "../lib/time";
import {
  elapsedShare,
  formatResetsIn,
  type LimitPace,
  paceOf,
  remainingPercent,
  windowLabel,
} from "./limits";

// T3's Codex series colour, so the limits read as the same provider everywhere.
const barColor = "var(--contrast-foreground)";

const PACE: Record<LimitPace, { label: string; icon: typeof GaugeIcon }> = {
  ahead: {
    label: "Ahead of pace: spending faster than the window elapses",
    icon: TrendingUpIcon,
  },
  on: { label: "On pace with the window", icon: GaugeIcon },
  under: {
    label: "Under pace: headroom left for the rest of the window",
    icon: TrendingDownIcon,
  },
};

/** Pace as a glyph with the words on hover. */
export function PaceIcon({ pace }: { pace: LimitPace }) {
  const Icon = PACE[pace].icon;
  return (
    <span
      role="img"
      aria-label={PACE[pace].label}
      title={PACE[pace].label}
      className="inline-flex text-muted-foreground"
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

/**
 * One window as a full-width bar from the moment it opened to its reset.
 * The fill is the share of quota left; the hairline is how far into the
 * window the clock is, which is also where even spending would have put the
 * fill. Hover for the exact figures and reset time.
 */
function WindowBar({ window, now }: { window: LimitWindow; now: number }) {
  const remaining = remainingPercent(window);
  const elapsed = elapsedShare(window, now);
  // The fill is quota left, so the even-spending mark is the time left.
  const timeLeft = elapsed === null ? null : Math.round((1 - elapsed) * 100);
  const resetsIn = formatResetsIn(window, now);
  const resetsAt =
    window.resetsAtMs === null
      ? null
      : formatUpcomingTimestamp(window.resetsAtMs, now);
  const summary = `${windowLabel(window.kind)}: ${remaining}% left${
    timeLeft === null ? "" : `, ${timeLeft}% of the window left`
  }${resetsIn ? `, ${resetsIn}` : ""}`;
  const details = [
    `${remaining}% left${timeLeft !== null ? ` · ${timeLeft}% of the window left` : ""}`,
    timeLeft !== null ? "The line is where even spending would be." : null,
    resetsAt ? `Resets ${resetsAt}${resetsIn ? ` · ${resetsIn}` : ""}` : null,
  ];
  return (
    <div
      role="img"
      aria-label={summary}
      title={details.filter(Boolean).join("\n")}
      tabIndex={0}
      className="relative h-6 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="absolute inset-x-0 inset-y-1.5 rounded-full bg-muted" />
      {remaining > 0 ? (
        <div
          className="absolute inset-y-1.5 left-0 rounded-full"
          style={{ width: `${remaining}%`, backgroundColor: barColor }}
        />
      ) : null}
      {timeLeft !== null ? (
        <span
          aria-hidden
          className="absolute inset-y-0.5 w-px -translate-x-1/2 bg-foreground/60"
          style={{ left: `${timeLeft}%` }}
        />
      ) : null}
    </div>
  );
}

/**
 * One account's windows as rows: label and percent, bar, pace and countdown.
 * Compact rows fit the composer panel with narrower columns.
 */
export function LimitWindows({
  windows,
  now,
  compact = false,
}: {
  windows: LimitWindow[];
  now: number;
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? "grid grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_auto] gap-x-3 gap-y-0.5"
          : "grid grid-cols-[11rem_minmax(0,1fr)_7rem] gap-x-4 gap-y-1"
      }
    >
      {windows.map((window) => {
        const pace = paceOf(window, now);
        const resetsIn = formatResetsIn(window, now);
        return (
          <Fragment key={window.slot}>
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground">
                {windowLabel(window.kind)}
              </span>
              <span className="ms-auto shrink-0 font-medium text-foreground tabular-nums">
                {remainingPercent(window)}% left
              </span>
            </span>
            <WindowBar window={window} now={now} />
            <span className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {pace ? <PaceIcon pace={pace} /> : null}
              <span className="ms-auto shrink-0">{resetsIn ?? ""}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}
