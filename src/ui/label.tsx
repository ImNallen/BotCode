// Classes copied from pingdotgg/t3code v0.0.45 components/ui/label.tsx (MIT).
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 text-base/4.5 sm:text-sm/4 font-medium text-foreground",
        className,
      )}
      data-slot="label"
      {...props}
    />
  );
}
