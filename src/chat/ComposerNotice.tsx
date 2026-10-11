// Notice shell copied from pingdotgg/t3code v0.0.45 components/chat/ComposerBannerStack.tsx (MIT).
import type { ReactNode } from "react";
import { ComposerBanner, type ComposerBannerVariant } from "./ComposerBanner";

export function ComposerNotice({
  variant,
  icon,
  title,
  description,
  dismissLabel,
  onDismiss,
  children,
}: {
  variant: ComposerBannerVariant;
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  dismissLabel: string;
  onDismiss: () => void;
  children?: ReactNode;
}) {
  return (
    <ComposerBanner.Dock>
      <ComposerBanner.Column>
        <ComposerBanner.Attachment>
          <ComposerBanner.Root
            role="alert"
            placement="attached"
            variant={variant}
            density="comfortable"
          >
            <ComposerBanner.Row layout="wrap-actions">
              <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
                {icon}
              </ComposerBanner.Icon>
              <ComposerBanner.Content className="whitespace-nowrap">
                <span className="min-w-0 truncate font-medium leading-7 sm:leading-6">
                  {title}
                </span>
                {description ? (
                  <span className="flex min-w-8 flex-1 items-center gap-1">
                    <span className="min-w-0 truncate text-muted-foreground">
                      {description}
                    </span>
                  </span>
                ) : null}
              </ComposerBanner.Content>
              <ComposerBanner.Actions>
                <ComposerBanner.Dismiss
                  aria-label={dismissLabel}
                  onClick={onDismiss}
                />
              </ComposerBanner.Actions>
            </ComposerBanner.Row>
            {children ? (
              <ComposerBanner.Children>{children}</ComposerBanner.Children>
            ) : null}
          </ComposerBanner.Root>
        </ComposerBanner.Attachment>
      </ComposerBanner.Column>
    </ComposerBanner.Dock>
  );
}
