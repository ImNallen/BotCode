// Classes copied from pingdotgg/t3code v0.0.45 components/ui/dialog.tsx, command.tsx and dialog-styles.ts (MIT).
import {
  type ComponentProps,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "../lib/cn";

const DIALOG_BACKDROP_CLASS =
  "dialog-backdrop fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0";

const DIALOG_POPUP_CLASS =
  "dialog-glass -translate-y-[calc(1.25rem*var(--nested-dialogs))] relative flex min-h-0 w-full min-w-0 scale-[calc(1-0.1*var(--nested-dialogs))] flex-col opacity-[calc(1-0.1*var(--nested-dialogs))] outline-none transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 [-webkit-app-region:no-drag] rounded-2xl border";

const DIALOG_MOBILE_SHEET_CLASS =
  "max-sm:max-w-none max-sm:rounded-none max-sm:border-x-0 max-sm:border-t max-sm:border-b-0 max-sm:opacity-[calc(1-min(var(--nested-dialogs),1))] max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4";

export function Dialog({
  open,
  onOpenChange,
  className,
  children,
  variant = "default",
  projectSearch,
}: {
  variant?: "default" | "command";
  projectSearch?: "filePicker.toggle" | "projectSearch.toggle";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <ModalDialog
      onClose={() => onOpenChange(false)}
      className={className}
      variant={variant}
      projectSearch={projectSearch}
    >
      {children}
    </ModalDialog>
  );
}

function ModalDialog({
  variant,
  projectSearch,
  onClose,
  className,
  children,
}: {
  variant: "default" | "command";
  projectSearch?: "filePicker.toggle" | "projectSearch.toggle";
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={
        projectSearch === "filePicker.toggle"
          ? "File picker"
          : projectSearch === "projectSearch.toggle"
            ? "Search project contents"
            : variant === "command"
              ? "Command palette"
              : undefined
      }
      data-command-palette={
        variant === "command" && !projectSearch ? "true" : undefined
      }
      data-project-search={projectSearch}
      className="m-0 size-full max-h-none max-w-none overflow-visible border-0 bg-transparent p-0 backdrop:bg-transparent"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        className={DIALOG_BACKDROP_CLASS}
        data-slot="dialog-backdrop"
        onPointerDown={variant === "command" ? onClose : undefined}
      />
      <div
        className={
          variant === "command"
            ? "pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(--spacing(4),4vh)] sm:py-[10vh]"
            : "fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4 max-sm:grid-rows-[1fr_auto] max-sm:p-0 max-sm:pt-12"
        }
        data-slot="dialog-viewport"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          className={cn(
            DIALOG_POPUP_CLASS,
            "row-start-2 text-popover-foreground",
            variant === "command"
              ? "pointer-events-auto max-h-105 max-w-xl text-foreground"
              : "max-h-full max-w-lg",
            variant === "command" && "overflow-hidden",
            variant !== "command" && DIALOG_MOBILE_SHEET_CLASS,
            className,
          )}
          data-slot="dialog-popup"
        >
          {children}
        </div>
      </div>
    </dialog>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="dialog-header"
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  variant = "default",
  ...props
}: ComponentProps<"div"> & { variant?: "default" | "bare" }) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)]",
        variant === "default" && "border-t bg-muted/72 py-4",
        variant === "bare" && "py-4",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn(
        "wrap-anywhere font-semibold text-xl leading-none",
        className,
      )}
      data-slot="dialog-title"
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<"p">) {
  return (
    <p
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

export function DialogPanel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className="relative min-h-0 overflow-y-auto overscroll-contain">
      <div
        className={cn(
          "space-y-4 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1 in-[[data-slot=dialog-popup]:has([data-slot=dialog-footer]:not(.border-t))]:pb-1",
          className,
        )}
        data-slot="dialog-panel"
        {...props}
      />
    </div>
  );
}
