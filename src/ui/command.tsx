// Classes ported from pingdotgg/t3code v0.0.45 components/ui/command.tsx, autocomplete.tsx and input.tsx (MIT).
import { SearchIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { Input } from "./input";
import { Button } from "./controls";
export function Command(props: ComponentProps<"div">) {
  return <div className="flex min-h-0 flex-1 flex-col" {...props} />;
}
export function CommandInput({
  className,
  startAddon = <SearchIcon className="translate-x-0.5 text-icon-muted" />,
  ...props
}: Omit<ComponentProps<"input">, "size"> & { startAddon?: ReactNode }) {
  return (
    <div className="px-[var(--command-shell-inset)] py-1.5 [&_[data-slot=autocomplete-start-addon]]:ps-[calc(var(--command-shell-inset)+0.0625rem)]">
      <div className="relative not-has-[>*.w-full]:w-fit w-full text-foreground has-disabled:opacity-64">
        <div
          data-slot="autocomplete-start-addon"
          className="[&_svg]:-mx-0.5 pointer-events-none has-[button]:pointer-events-auto absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 has-[+[data-size=sm]]:ps-[calc(--spacing(2.5)-1px)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
        >
          {startAddon}
        </div>
        <Input
          size="lg"
          autoFocus
          data-slot="autocomplete-input"
          className={cn(
            "border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0 placeholder:text-placeholder *:data-[slot=autocomplete-input]:ps-9! sm:*:data-[slot=autocomplete-input]:ps-[calc(var(--command-shell-inset)+1.5rem)]!",
            className,
          )}
          {...props}
        />
      </div>
    </div>
  );
}
export function CommandPanel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden rounded-t-xl not-has-[+[data-slot=command-footer]]:rounded-b-2xl bg-transparent **:data-[slot=scroll-area-scrollbar]:mt-2 [touch-action:pan-y]",
        "overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}
export function CommandList(props: ComponentProps<"div">) {
  return (
    <div
      className="not-empty:scroll-py-2 not-empty:p-2"
      data-slot="command-list"
      {...props}
    />
  );
}
export function CommandGroup(props: ComponentProps<"div">) {
  return (
    <div
      className="[[role=group]+&]:mt-1.5"
      data-slot="command-group"
      {...props}
    />
  );
}
export function CommandGroupLabel(props: ComponentProps<"div">) {
  return (
    <div
      className="px-2 py-1.5 font-medium text-muted-foreground text-xs"
      data-slot="command-group-label"
      {...props}
    />
  );
}
export function CommandItem({
  active,
  className,
  ...props
}: ComponentProps<"div"> & { active: boolean }) {
  return (
    <div
      className={cn(
        "flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-base outline-none hover:bg-accent data-disabled:pointer-events-none data-selected:bg-accent/50 data-selected:text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-accent [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='text-'])]:text-muted-foreground",
        "py-1.5 data-selected:bg-foreground/[0.06] data-highlighted:bg-foreground/[0.09] data-highlighted:text-foreground [&[data-highlighted][data-selected]]:bg-foreground/[0.09] [&[data-highlighted][data-selected]]:text-foreground",
        "cursor-pointer hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit data-selected:bg-transparent data-selected:text-inherit [&[data-highlighted][data-selected]]:bg-transparent [&[data-highlighted][data-selected]]:text-inherit",
        active && "bg-accent! text-accent-foreground!",
        className,
      )}
      data-active={active || undefined}
      data-slot="command-item"
      {...props}
    />
  );
}
export function CommandShortcut(props: ComponentProps<"kbd">) {
  return (
    <kbd
      className="ms-auto font-medium font-sans text-secondary-label text-xs tracking-widest"
      data-slot="command-shortcut"
      {...props}
    />
  );
}
export function CommandFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] bg-foreground/[0.025] px-[var(--command-content-inset)] py-2.5 font-medium text-sm text-muted-foreground [&_[data-slot=kbd-group]]:font-sans [&_[data-slot=kbd]]:bg-foreground/[0.08] [&_[data-slot=kbd]]:text-foreground [&_[data-slot=kbd]]:ring-0",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  );
}
export function CommandFooterAction({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "variant">) {
  return (
    <Button
      {...props}
      variant="ghost-muted"
      size="xs"
      className={cn("h-auto px-2 text-xs hover:bg-transparent", className)}
    />
  );
}
