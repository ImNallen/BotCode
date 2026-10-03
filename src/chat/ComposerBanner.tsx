// Copied from pingdotgg/t3code v0.0.45 components/chat/ComposerBanner.tsx (MIT).
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export type ComposerBannerVariant =
  | "default"
  | "error"
  | "info"
  | "success"
  | "warning";

const surfaceColors = cn(
  "[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--card))]",
  "dark:[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--surface-raised))]",
  "[html[data-theme-id]_&]:[--chat-composer-attached-surface:var(--app-theme-surface-raised)]",
);

const neutralOutline = cn(
  "[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--contrast-foreground)_8%,transparent))]",
  "dark:[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--color-white)_5%,transparent))]",
  "[html[data-theme-id]_&]:[--chat-composer-attached-outline:var(--chat-composer-outline,var(--app-theme-toolbar-border))]",
  "dark:[html[data-theme-id]:not([data-theme-id=t3-chat])_&]:[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--app-theme-input)_30%,var(--background)))]",
  "dark:[html[data-theme-id=t3-chat]_&]:[--chat-composer-attached-outline:#241e28]",
);

const variantColors: Record<ComposerBannerVariant, string> = {
  default: neutralOutline,
  error:
    "[--chat-composer-attached-outline:color-mix(in_srgb,var(--error)_32%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--error)_8%,transparent)]",
  info: neutralOutline,
  success: neutralOutline,
  warning:
    "[--chat-composer-attached-outline:color-mix(in_srgb,var(--warning)_28%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--warning)_8%,transparent)]",
};

function Surface({
  placement = "attached",
  variant = "default",
  className,
  ...props
}: ComponentProps<"div"> & {
  placement?: "attached" | "floating";
  variant?: ComposerBannerVariant;
}) {
  return (
    <div
      data-composer-banner-surface={placement}
      data-variant={variant}
      className={cn(
        surfaceColors,
        "relative isolate border-0 bg-transparent shadow-none [--chat-composer-attached-tint:transparent]",
        variantColors[variant],
        // The mask cut-off (1rem) bleeds one pixel past the seam (1rem + 1px): Chromium
        // drops the last device-pixel row of a filtered backdrop when the cut-off lands
        // off the device-pixel grid, and the composer's surface starts exactly there.
        // The composer's own glass covers the extra row, so the overlap never shows.
        placement === "attached"
          ? "[--chat-composer-attachment-overlap:calc(1rem+1px)] before:rounded-t-2xl before:mask-t-from-transparent before:mask-t-from-4 before:mask-t-to-black before:mask-t-to-4"
          : "[--chat-composer-attachment-overlap:0px] before:rounded-2xl",
        "before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:border before:border-(--chat-composer-attached-outline)",
        "before:bg-(--chat-composer-attached-surface)/(--glass-opacity) before:bg-linear-to-b before:from-(--chat-composer-attached-tint) before:to-(--chat-composer-attached-tint) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        "before:shadow-composer dark:before:shadow-composer-dark",
        "dark:supports-[(backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px))]:before:bg-composer-seam-above",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-attached-surface)",
        className,
      )}
      {...props}
    />
  );
}

function Attachment({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-banner-attachment"
      className={cn(
        "mx-auto -mb-[calc(1rem+1px)] w-[calc(100%-2*var(--chat-composer-drawer-inset))]",
        // Adjacent attachments share their outline, including notices outside the form.
        "[&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:rounded-none [&+[data-slot=composer-banner-attachment]_[data-composer-banner-surface=attached]]:before:border-t-0",
        "[&+:has([data-chat-composer-form])_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:rounded-none [&+:has([data-chat-composer-form])_[data-chat-composer-form]>[data-slot=composer-banner-attachment]:first-child_[data-composer-banner-surface=attached]]:before:border-t-0",
        className,
      )}
      {...props}
    />
  );
}

function Root({
  className,
  density = "default",
  placement = "attached",
  variant = "default",
  width = "fill",
  ...props
}: ComponentProps<"div"> & {
  density?: "default" | "comfortable" | "spacious";
  placement?: "attached" | "floating";
  variant?: ComposerBannerVariant;
  width?: "fill" | "content";
}) {
  return (
    <Surface
      className={cn(
        "min-w-0 px-1 py-(--composer-banner-padding-block) after:block after:h-(--chat-composer-attachment-overlap) text-xs/4 [--composer-banner-icon-column:--spacing(7)] [--composer-banner-padding-block:--spacing(1)] sm:[--composer-banner-icon-column:--spacing(6)]",
        density === "comfortable" &&
          "[--composer-banner-padding-block:--spacing(1.25)]",
        density === "spacious" &&
          "px-3 [--composer-banner-padding-block:--spacing(3)]",
        width === "content" ? "w-fit max-w-full flex-none" : "@container",
        className,
      )}
      data-slot="composer-banner"
      placement={placement}
      data-composer-banner-width={width}
      variant={variant}
      {...props}
    />
  );
}

function Row({
  className,
  layout = "inline",
  ...props
}: ComponentProps<"div"> & { layout?: "inline" | "approval" }) {
  return (
    <div
      data-composer-banner-row="true"
      data-composer-banner-layout={layout}
      className={cn(
        "group/banner-row grid min-h-(--composer-banner-icon-column) w-full min-w-0 grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)_auto] items-center gap-x-1 text-start",
        "not-has-[>[data-slot=composer-banner-actions]]:grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)]",
        layout === "approval" && "items-start gap-x-2 gap-y-3",
        className,
      )}
      {...props}
    />
  );
}

function Icon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="composer-banner-icon"
      className={cn(
        "col-start-1 row-start-1 flex w-(--composer-banner-icon-column) min-w-0 flex-none items-center justify-center text-muted-foreground [&>svg]:size-3",
        "group-data-[composer-banner-layout=approval]/banner-row:pt-0.5 group-data-[composer-banner-layout=approval]/banner-row:text-warning group-data-[composer-banner-layout=approval]/banner-row:[&>svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function Content({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-content"
      className={cn(
        "col-start-2 row-start-1 flex min-w-0 items-center gap-1 *:data-[slot=composer-banner-separator]:mx-0",
        "@max-[560px]:group-data-[composer-banner-layout=approval]/banner-row:col-end-4",
        "group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:col-[1/3] group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:ps-2 sm:group-not-has-[>[data-slot=composer-banner-icon]]/banner-row:ps-1.5",
        "group-not-has-[>[data-slot=composer-banner-icon],>[data-slot=composer-banner-actions]]/banner-row:pe-2 sm:group-not-has-[>[data-slot=composer-banner-icon],>[data-slot=composer-banner-actions]]/banner-row:pe-1.5",
        className,
      )}
      {...props}
    />
  );
}

function Actions({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-actions"
      className={cn(
        "col-start-3 row-start-1 flex flex-wrap items-center justify-end gap-1",
        "group-data-[composer-banner-layout=approval]/banner-row:self-center group-data-[composer-banner-layout=approval]/banner-row:gap-1.5 @max-[560px]:group-data-[composer-banner-layout=approval]/banner-row:col-start-2 @max-[560px]:group-data-[composer-banner-layout=approval]/banner-row:col-end-4 @max-[560px]:group-data-[composer-banner-layout=approval]/banner-row:row-start-2",
        "@max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:col-start-2 @max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:col-end-4 @max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:row-start-2 @max-[400px]:group-data-[composer-banner-layout=wrap-actions]/banner-row:has-[>:nth-child(2)]:justify-end",
        "@max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:col-start-2 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:col-end-4 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:row-start-2 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:-ms-2 @max-[320px]:group-data-[composer-banner-layout=wrap-actions-narrow]/banner-row:has-[>:nth-child(2)]:justify-start",
        className,
      )}
      {...props}
    />
  );
}

export const ComposerBanner = { Attachment, Root, Row, Icon, Content, Actions };
