// Copied from pingdotgg/t3code v0.0.45 components/chat/ComposerUsageLimits.tsx (MIT).
import { useQuery } from "@tanstack/react-query";
import { GaugeIcon } from "lucide-react";
import { LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { accountLabel, limitsNotice, usageLimitsQuery } from "../usage/limits";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerNotice } from "./ComposerNotice";

export function ComposerUsageLimits({
  now,
  onDismiss,
}: {
  now: number;
  onDismiss: () => void;
}) {
  const limits = useQuery(usageLimitsQuery);
  const notice = limits.data
    ? limitsNotice(limits.data)
    : (limits.error?.message ?? "Reading usage limits…");
  return (
    <ComposerNotice
      variant="info"
      icon={<GaugeIcon />}
      title="Usage limits"
      description={accountLabel(limits.data)}
      dismissLabel="Dismiss usage limits"
      onDismiss={onDismiss}
    >
      <ComposerBanner.Scroll>
        <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
          <div className="flex min-w-0 flex-col gap-1">
            {limits.data?.kind === "reported" && notice === null ? (
              <LimitWindows compact windows={limits.data.windows} now={now} />
            ) : (
              <span className="text-xs text-muted-foreground">{notice}</span>
            )}
            {limits.data?.kind === "reported" && limits.data.resetCredits ? (
              <ResetCredits credits={limits.data.resetCredits} now={now} />
            ) : null}
          </div>
        </ComposerBanner.Body>
      </ComposerBanner.Scroll>
    </ComposerNotice>
  );
}
