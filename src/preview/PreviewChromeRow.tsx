// Ported from T3 Code v0.0.45 apps/web/src/components/preview/PreviewChromeRow.tsx and components/ui/input-group.tsx (MIT).
import { ArrowLeftIcon, ArrowRightIcon, RefreshCwIcon } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "../ui/controls";
import { Input } from "../ui/input";
import type { Navigation, PreviewState } from "./model";

export function PreviewChromeRow({
  state,
  pending,
  onOpen,
  onNavigate,
}: {
  state: PreviewState;
  pending: boolean;
  onOpen: (url: string) => void;
  onNavigate: (action: Navigation) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim()) {
      onOpen(draft);
      input.current?.blur();
    }
  };
  return (
    <div className="relative">
      <form
        onSubmit={submit}
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <div
          className="flex items-center gap-0.5"
          role="group"
          aria-label="Navigation"
        >
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Back"
            title="Back"
            disabled={pending || !state.canGoBack}
            onClick={() => onNavigate({ kind: "back" })}
          >
            <ArrowLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Forward"
            title="Forward"
            disabled={pending || !state.canGoForward}
            onClick={() => onNavigate({ kind: "forward" })}
          >
            <ArrowRightIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Refresh preview"
            title={state.loading ? "Loading…" : "Refresh"}
            disabled={pending || !state.url}
            onClick={() => onNavigate({ kind: "reload" })}
          >
            <RefreshCwIcon
              className={state.loading ? "animate-spin" : undefined}
            />
          </Button>
        </div>
        <div
          className="relative inline-flex w-full min-w-0 items-center rounded-[var(--control-radius)] border text-base text-foreground ring-ring/24 transition-shadow has-[input:focus-visible,textarea:focus-visible]:has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/64 has-[input:focus-visible,textarea:focus-visible]:has-[input[aria-invalid],textarea[aria-invalid]]:ring-destructive/16 has-[textarea]:h-auto has-data-[align=block-end]:h-auto has-data-[align=block-start]:h-auto has-data-[align=block-end]:flex-col has-data-[align=block-start]:flex-col has-[input:focus-visible,textarea:focus-visible]:border-ring has-[input[aria-invalid],textarea[aria-invalid]]:border-destructive/36 has-autofill:bg-foreground/4 has-[input:disabled,textarea:disabled]:opacity-64 has-[input:disabled,textarea:disabled,input:focus-visible,textarea:focus-visible,input[aria-invalid],textarea[aria-invalid]]:shadow-none has-[input:focus-visible,textarea:focus-visible]:ring-[3px] sm:text-sm dark:has-autofill:bg-foreground/8 dark:has-[input[aria-invalid],textarea[aria-invalid]]:ring-destructive/24 has-data-[align=inline-start]:**:[[data-size=sm]_input]:ps-1.5 has-data-[align=inline-end]:**:[[data-size=sm]_input]:pe-1.5 *:[[data-slot=input-control],[data-slot=textarea-control]]:contents *:[[data-slot=input-control],[data-slot=textarea-control]]:before:hidden has-[[data-align=block-start],[data-align=block-end]]:**:[input]:h-auto has-data-[align=inline-start]:**:[input]:ps-2 has-data-[align=inline-end]:**:[input]:pe-2 has-data-[align=block-end]:**:[input]:pt-1.5 has-data-[align=block-start]:**:[input]:pb-1.5 **:[textarea]:min-h-20.5 **:[textarea]:resize-none **:[textarea]:py-[calc(--spacing(3)-1px)] **:[textarea]:max-sm:min-h-23.5 **:[textarea_button]:rounded-[calc(var(--control-radius)-1px)] border-transparent bg-transparent shadow-none hover:bg-muted/40 has-[input:focus-visible,textarea:focus-visible]:bg-background group/address h-7 flex-1"
          data-slot="input-group"
        >
          <Input
            ref={input}
            size="sm"
            aria-label="Preview URL"
            value={focused ? draft : (state.url ?? "")}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => {
              setDraft(state.url ?? "");
              setFocused(true);
              queueMicrotask(() => input.current?.select());
            }}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                input.current?.blur();
              }
            }}
            placeholder="Enter URL"
            spellCheck={false}
            disabled={pending}
            data-preview-url-input
          />
        </div>
      </form>
    </div>
  );
}
