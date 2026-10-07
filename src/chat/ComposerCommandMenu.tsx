// Ported from T3 Code v0.0.45 apps/web/src/components/chat/ComposerCommandMenu.tsx and components/ui/command.tsx (MIT).
import { FileEntryIcon } from "../panel/FileEntryIcon";
import { useLayoutEffect, useRef } from "react";
import { cn } from "../lib/cn";
import { ComposerBanner } from "./ComposerBanner";
import type {
  ComposerSlashCommand,
  ComposerTriggerKind,
} from "./composer-logic";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: ComposerSlashCommand;
      label: string;
      description: string;
    };

export function composerSuggestionOptionId(
  listId: string,
  itemId: string,
): string {
  return `${listId}-${encodeURIComponent(JSON.stringify(itemId))}`;
}

export function ComposerCommandMenu(props: {
  listId: string;
  items: ComposerCommandItem[];
  isLoading: boolean;
  triggerKind: ComposerTriggerKind;
  emptyStateText?: string;
  activeItemId: string | null;
  onHighlightedItemChange: (id: string) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!props.activeItemId) return;
    document
      .getElementById(
        composerSuggestionOptionId(props.listId, props.activeItemId),
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId, props.listId]);
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Surface
        ref={list}
        data-composer-command-drawer="true"
        className="flex min-h-0 w-full flex-col overflow-hidden pb-(--chat-composer-attachment-overlap) **:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4"
      >
        {props.items.length ? (
          <div
            id={props.listId}
            role="listbox"
            aria-label={
              props.triggerKind === "path" ? "Files and folders" : "Commands"
            }
            className="not-empty:scroll-py-2 not-empty:p-2 max-h-72 min-h-0 scroll-pb-6 overflow-y-auto"
          >
            {props.items.map((item) => (
              <div
                key={item.id}
                id={composerSuggestionOptionId(props.listId, item.id)}
                role="option"
                aria-selected={props.activeItemId === item.id}
                data-composer-item-id={item.id}
                data-slot="command-item"
                onMouseMove={() => props.onHighlightedItemChange(item.id)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.onSelect(item)}
                className={cn(
                  "flex min-h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-base outline-none hover:bg-accent data-disabled:pointer-events-none data-selected:bg-accent/50 data-selected:text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-accent [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='text-'])]:text-muted-foreground",
                  "py-1.5 data-selected:bg-foreground/[0.06] data-highlighted:bg-foreground/[0.09] data-highlighted:text-foreground [&[data-highlighted][data-selected]]:bg-foreground/[0.09] [&[data-highlighted][data-selected]]:text-foreground",
                  props.activeItemId === item.id &&
                    "bg-accent! text-accent-foreground!",
                )}
              >
                {item.type === "path" ? (
                  <FileEntryIcon path={item.path} />
                ) : null}
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium">
                    {item.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left text-secondary-label text-xs">
                    {item.description}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-5 pt-3.5 pb-7">
            <p className="text-secondary-label text-xs" role="status">
              {props.isLoading
                ? "Searching workspace files..."
                : (props.emptyStateText ??
                  (props.triggerKind === "path"
                    ? "No matching files or folders."
                    : "No matching command."))}
            </p>
          </div>
        )}
      </ComposerBanner.Surface>
    </ComposerBanner.Attachment>
  );
}
