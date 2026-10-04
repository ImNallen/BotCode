// Classes copied from pingdotgg/t3code v0.0.45 components/ui/alert.tsx (MIT).
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

const variants = {
  default: "bg-transparent dark:bg-input/32 [&_svg]:text-muted-foreground",
  info: "border-info/32 bg-info/4 [&_svg]:text-info",
} as const;

export function Alert({
  variant = "default",
  role = "alert",
  icon,
  children,
}: {
  variant?: keyof typeof variants;
  role?: "alert" | "status";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative rounded-xl border px-3.5 py-3 text-card-foreground text-sm",
        variants[variant],
      )}
      data-slot="alert"
      data-variant={variant}
      role={role}
    >
      <div className="flex gap-2 items-center">
        {icon ? (
          <div className="flex shrink-0 items-center justify-center size-4 [&>svg]:size-full">
            {icon}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div
            className="flex flex-col gap-2.5 text-muted-foreground"
            data-slot="alert-description"
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AlertAction({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex gap-1", className)} data-slot="alert-action">
      {children}
    </div>
  );
}
