// Classes copied from pingdotgg/t3code v0.0.45 components/ui/input.tsx (MIT).
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

export function Input({
  className,
  size = "default",
  ...props
}: Omit<ComponentProps<"input">, "size"> & { size?: "sm" | "default" | "lg" }) {
  return (
    <span
      className={cn(
        "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        className,
      )}
      data-size={size}
      data-slot="input-control"
    >
      <input
        className={cn(
          "h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s]",
          size === "lg" && "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5",
          size === "sm" &&
            "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5",
        )}
        data-slot="input"
        {...props}
      />
    </span>
  );
}
