// Notice shell copied from pingdotgg/t3code v0.0.45 components/chat/ComposerBannerStack.tsx
// and ComposerUsageLimits.tsx (MIT).
import { useQuery } from "@tanstack/react-query";
import { GaugeIcon } from "lucide-react";
import { LimitWindows } from "../usage/UsageLimits";
import { accountLabel, limitsNotice, usageLimitsQuery } from "../usage/limits";
import { ComposerBanner } from "./ComposerBanner";

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
    <ComposerBanner.Dock>
      <ComposerBanner.Column>
        <ComposerBanner.Attachment>
          <ComposerBanner.Root
            role="alert"
            placement="attached"
            variant="info"
            density="comfortable"
          >
            <ComposerBanner.Row layout="wrap-actions">
              <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
                <GaugeIcon />
              </ComposerBanner.Icon>
              <ComposerBanner.Content className="whitespace-nowrap">
                <span className="min-w-0 truncate font-medium leading-7 sm:leading-6">
                  Usage limits
                </span>
                <span className="flex min-w-8 flex-1 items-center gap-1">
                  <span className="min-w-0 truncate text-muted-foreground">
                    {accountLabel(limits.data)}
                  </span>
                </span>
              </ComposerBanner.Content>
              <ComposerBanner.Actions>
                <ComposerBanner.Dismiss
                  aria-label="Dismiss usage limits"
                  onClick={onDismiss}
                />
              </ComposerBanner.Actions>
            </ComposerBanner.Row>
            <ComposerBanner.Children>
              <ComposerBanner.Scroll>
                <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    {limits.data?.kind === "reported" && notice === null ? (
                      <LimitWindows
                        compact
                        windows={limits.data.windows}
                        now={now}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {notice}
                      </span>
                    )}
                  </div>
                </ComposerBanner.Body>
              </ComposerBanner.Scroll>
            </ComposerBanner.Children>
          </ComposerBanner.Root>
        </ComposerBanner.Attachment>
      </ComposerBanner.Column>
    </ComposerBanner.Dock>
  );
}
