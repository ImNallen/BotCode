// Ported from T3 Code v0.0.45 apps/web/src/components/ContextChip.tsx (MIT).
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

const contextChipVariants = cva(
  "inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] border px-[0.5em] align-middle font-medium text-[0.86em] leading-none [&_svg]:block [&_svg]:size-[1.17em] [&_svg]:shrink-0 [&_svg]:self-center [button&,a&,[data-popup-open]&]:cursor-pointer [button&,a&]:transition-colors [button&,a&]:motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-default",
  {
    defaultVariants: { kind: "neutral" },
    variants: {
      kind: {
        neutral: "border-border/70 bg-accent/40 text-foreground",
        image: "[--context-chip-accent:oklch(0.62_0.16_16)]",
        video: "[--context-chip-accent:oklch(0.62_0.16_48)]",
        file: "[--context-chip-accent:oklch(0.62_0.136_237)]",
        mention: "[--context-chip-accent:oklch(0.62_0.11_215)]",
        terminal: "[--context-chip-accent:oklch(0.62_0.134_163)]",
        element: "[--context-chip-accent:oklch(0.62_0.134_70)]",
        "preview-annotation": "[--context-chip-accent:oklch(0.62_0.134_70)]",
        "review-comment": "[--context-chip-accent:oklch(0.62_0.16_292)]",
        "pull-request": "[--context-chip-accent:oklch(0.62_0.16_277)]",
        "pr-open": "[--context-chip-accent:oklch(0.62_0.134_163)]",
        "pr-draft": "[--context-chip-accent:oklch(0.62_0.02_259)]",
        "pr-merged": "[--context-chip-accent:oklch(0.62_0.16_292)]",
        "pr-closed": "[--context-chip-accent:oklch(0.62_0.16_16)]",
        skill: "[--context-chip-accent:oklch(0.62_0.16_322)]",
        citation: "[--context-chip-accent:oklch(0.62_0.16_259)]",
      },
      state: {
        unresolved: "border-dashed",
        invalid: "",
      },
    },
    compoundVariants: [
      {
        kind: [
          "image",
          "video",
          "file",
          "mention",
          "terminal",
          "element",
          "preview-annotation",
          "review-comment",
          "pull-request",
          "pr-open",
          "pr-draft",
          "pr-merged",
          "pr-closed",
          "skill",
          "citation",
        ],
        className:
          "[--context-chip-border:color-mix(in_oklab,var(--context-chip-accent)_34%,var(--contrast-border))] [--context-chip-border-hover:color-mix(in_oklab,var(--context-chip-accent)_48%,var(--contrast-border))] [--context-chip-foreground:color-mix(in_oklab,var(--context-chip-accent)_22%,var(--contrast-foreground))] border-(--context-chip-border) bg-(--context-chip-accent)/11 text-(--context-chip-foreground) [button:enabled&,a&]:hover:border-(--context-chip-border-hover) [button:enabled&,a&]:hover:bg-(--context-chip-accent)/17",
      },
      { state: "unresolved", className: "text-foreground" },
      {
        state: "invalid",
        className: "border-destructive/35 bg-destructive/8 text-destructive",
      },
    ],
  },
);

export function ContextChip({
  className,
  kind,
  state,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof contextChipVariants>) {
  return (
    <span
      data-slot="context-chip"
      data-state={state}
      className={cn(contextChipVariants({ kind, state }), className)}
      {...props}
    />
  );
}

export function ContextChipLabel({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "block min-w-0 self-center truncate leading-tight",
        className,
      )}
      data-slot="context-chip-label"
      {...props}
    />
  );
}
