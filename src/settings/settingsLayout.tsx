// Classes copied from pingdotgg/t3code v0.0.45 settings/settingsLayout.tsx and SettingsGroup.tsx (MIT).
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export function SettingsGroup({
  id,
  title,
  hideTitle = false,
  children,
}: {
  id: string;
  title: ReactNode;
  hideTitle?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      tabIndex={-1}
      className={cn(
        !hideTitle && "space-y-2.5",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {hideTitle ? (
        <h2 className="sr-only">{title}</h2>
      ) : (
        <div
          data-settings-scroll-target
          className="flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4"
        >
          <div className="min-w-0">
            <h2 className="flex min-h-7 items-center gap-2 text-sm font-normal text-foreground/70">
              {title}
            </h2>
          </div>
        </div>
      )}
      <div className="relative overflow-visible text-foreground rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none">
        {children}
      </div>
    </section>
  );
}

export function SettingsRow({
  id,
  title,
  description,
  control,
}: {
  id: string;
  title: string;
  description: string;
  control: ReactNode;
}) {
  return (
    <div
      id={id}
      tabIndex={-1}
      data-slot="settings-row"
      className="@container/settings-row rounded-xl px-3 sm:px-4 aria-disabled:opacity-64 aria-disabled:[&_*]:text-muted-foreground py-3 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
          </div>
          <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">
            {description}
          </p>
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {control}
          </div>
        ) : null}
      </div>
    </div>
  );
}
